import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {afterEach, describe, expect, test} from 'vitest';

import {buildDemoFixture} from '../../../scripts/build-demo-fixture.js';
import {
	AgentInvocationResultSchema,
	RawExecutionAttemptSchema,
	RawVerificationEvidenceSchema,
	RecoveryCandidateSchema,
	VerificationRequestSchema,
	type AgentInvocationV1,
	type AgentSessionPort,
	type RawExecutionAttemptV1,
	type VerificationExecutionPort,
	type VerificationRequestV1,
} from '../../../src/contracts/index.js';
import {CodexAuthoringModule} from '../../../src/core/authoring/codex-authoring.js';
import {sha256Bytes} from '../../../src/core/digest.js';
import {TestOnlyPatchPolicy} from '../../../src/core/patch-policy/patch-policy.js';
import {CausalRecoveryVerifier} from '../../../src/core/recovery/causal-recovery.js';
import {buildReceipt} from '../../../src/core/receipts/receipt-builder.js';

const temporaryDirectories: string[] = [];
const runId = '11111111-1111-4111-8111-111111111111';

const candidate = RecoveryCandidateSchema.parse({
	schemaVersion: 'antibody.candidate/v1',
	candidateId: `sha256:${'a'.repeat(64)}`,
	repository: {
		slug: 'example/antibody-demo',
		cloneUrl: 'https://github.com/example/antibody-demo.git',
	},
	parentSha: '66e82fb6b511eccffc879042c61bf45100067881',
	fixSha: 'e2398bf45efca03a24dbb9101a52cf1c70ea0fe0',
	headSha: '1bcd48e2eba3a5ed823460b6763c90f49efca6b3',
	commit: {
		subject: 'fix repeated whitespace',
		authoredAt: '2024-01-03T00:00:00.000Z',
		changedProductionPaths: ['src/slug.js'],
		changedTestPaths: [],
		additions: 1,
		deletions: 1,
		diffSha256: `sha256:${'b'.repeat(64)}`,
	},
	signals: [],
	score: 65,
});

function artifact(name: string, text: string) {
	const bytes = Buffer.from(text, 'utf8');
	return {
		name,
		mediaType: 'text/plain; charset=utf-8',
		sha256: sha256Bytes(bytes),
		sizeBytes: bytes.byteLength,
		contentBase64: bytes.toString('base64'),
	};
}

class FakeAgent implements AgentSessionPort {
	invocations = 0;
	stops = 0;

	constructor(private readonly finalText: string) {}

	invoke(request: AgentInvocationV1) {
		this.invocations += 1;
		return Promise.resolve(AgentInvocationResultSchema.parse({
			schemaVersion: 'antibody.agent-result/v1',
			invocationId: request.invocationId,
			continuationId: 'continuation-e2e',
			finalText: this.finalText,
			provider: {name: 'reflex', agentId: 'fake-agent'},
			startedAt: '2024-01-01T00:00:00.000Z',
			finishedAt: '2024-01-01T00:00:01.000Z',
		}));
	}

	stop() {
		this.stops += 1;
		return Promise.resolve();
	}
}

class FakeVerification implements VerificationExecutionPort {
	requests: VerificationRequestV1[] = [];

	execute(request: VerificationRequestV1) {
		this.requests.push(request);
		const pass = 'TAP version 13\nok 1 - collapses repeated whitespace\n1..1';
		const fail = [
			'TAP version 13',
			'not ok 1 - collapses repeated whitespace',
			'  error: |-',
			'    Expected values to be strictly equal:',
			"  name: 'AssertionError'",
			"  operator: 'strictEqual'",
			'  stack: |-',
			'    at TestContext.<anonymous> (test/slug.test.js:8:10)',
			'1..1',
		].join('\n');
		const makeAttempt = (
			lane: RawExecutionAttemptV1['lane'],
			phase: RawExecutionAttemptV1['phase'],
			attempt: number,
			report: string,
		): RawExecutionAttemptV1 => RawExecutionAttemptSchema.parse({
			lane,
			phase,
			attempt,
			checkoutSha: lane === 'parent'
				? candidate.parentSha
				: lane === 'fix' ? candidate.fixSha : candidate.headSha,
			...(phase === 'candidate' || phase === 'full-suite'
				? {patchSha256: request.patch.sha256}
				: {}),
			command: phase === 'baseline'
				? request.commands.baseline
				: phase === 'full-suite'
					? request.commands.fullSuite
					: request.commands.targeted,
			startedAt: '2024-01-01T00:00:00.000Z',
			finishedAt: '2024-01-01T00:00:01.000Z',
			durationMs: 1000,
			termination: 'exited',
			exitCode: report === fail ? 1 : 0,
			stdout: artifact(`${lane}-${phase}-${String(attempt)}.stdout`, report),
			stderr: artifact(`${lane}-${phase}-${String(attempt)}.stderr`, ''),
			provider: {devboxId: `${lane}-devbox`},
		});
		return Promise.resolve(RawVerificationEvidenceSchema.parse({
			schemaVersion: 'antibody.raw-evidence/v1',
			runId: request.runId,
			candidateId: request.candidate.candidateId,
			patchSha256: request.patch.sha256,
			environmentEquivalence: {
				equivalent: true,
				comparedFields: ['snapshot', 'architecture'],
				mismatchFields: [],
			},
			attempts: [
				makeAttempt('parent', 'baseline', 0, pass),
				makeAttempt('fix', 'baseline', 0, pass),
				makeAttempt('parent', 'candidate', 0, fail),
				makeAttempt('parent', 'candidate', 1, fail),
				makeAttempt('fix', 'candidate', 0, pass),
				makeAttempt('fix', 'candidate', 1, pass),
				makeAttempt('head', 'candidate', 0, pass),
				makeAttempt('head', 'full-suite', 0, pass),
			],
			cleanup: [],
		}));
	}
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(async directory =>
		rm(directory, {recursive: true, force: true})));
});

describe('Person B core flow', () => {
	test('authors, gates, verifies, classifies, adjudicates, and receipts through fake ports', async () => {
		const repositoryRoot = await mkdtemp(path.join(tmpdir(), 'antibody-core-e2e-'));
		temporaryDirectories.push(repositoryRoot);
		await buildDemoFixture(repositoryRoot);
		const expectedPatch = await readFile('fixtures/demo-history/recovered-test.diff', 'utf8');
		const finalText = JSON.stringify({
			schemaVersion: 'antibody.agent-output/v1',
			candidateId: candidate.candidateId,
			patchBase64: Buffer.from(expectedPatch, 'utf8').toString('base64'),
			testCommandHint: ['ignored-by-core'],
			summary: 'Adds repeated whitespace coverage',
		});
		const agent = new FakeAgent(finalText);
		const patchPolicy = new TestOnlyPatchPolicy();
		const authoring = new CodexAuthoringModule(agent, async proposedPatch => {
			const policy = await patchPolicy.evaluate({
				repositoryRoot,
				patch: proposedPatch,
				commits: {
					parent: candidate.parentSha,
					fix: candidate.fixSha,
					head: candidate.headSha,
				},
				testGlobs: ['test/**'],
				allowedSupportGlobs: ['test/**'],
				policy: {
					maxPatchBytes: 100_000,
					maxPatchFiles: 3,
					maxAddedLines: 30,
					forbidBinary: true,
					forbidSymlinks: true,
					forbidSubmodules: true,
					requireCurrentHeadPass: true,
				},
			});
			return policy.accepted
				? {decision: 'accept'}
				: {decision: 'retry', category: 'policy', feedback: policy.reasons.join(', ')};
		});
		const authored = await authoring.authorCandidate(candidate, {
			commitMessage: candidate.commit.subject,
			parentFixDiff: 'diff --git a/src/slug.js b/src/slug.js\n-old\n+new',
			affectedSources: [{path: 'src/slug.js', parent: 'old', fix: 'new'}],
			testFramework: 'node:test',
			testConfiguration: 'node --test',
			nearbyTests: [{path: 'test/slug.test.js', content: 'existing test'}],
		}, {
			maxAttempts: 3,
			timeoutMs: 10_000,
			maxOutputBytes: 100_000,
			maxPromptBytes: 20_000,
		});
		expect(authored.status).toBe('authored');
		if (authored.status !== 'authored') return;

		const command = {argv: ['node', '--test'], cwd: '.', env: {}, timeoutMs: 10_000};
		const verificationRequest = VerificationRequestSchema.parse({
			schemaVersion: 'antibody.verification-request/v1',
			runId,
			candidate,
			patch: {
				unifiedDiffBase64: Buffer.from(authored.patch, 'utf8').toString('base64'),
				sha256: authored.patchSha256,
				changedPaths: ['test/slug.test.js'],
			},
			environment: {
				source: {kind: 'snapshot', id: 'snapshot-1'},
				architecture: 'x86_64',
				maxParallel: 2,
			},
			commands: {setup: [], baseline: command, targeted: command, fullSuite: command},
			report: {format: 'tap'},
			repetitions: 2,
		});
		const execution = new FakeVerification();
		const verified = await new CausalRecoveryVerifier(execution).verify(
			verificationRequest,
			{
				policyPassed: true,
				currentHeadApplies: true,
				targetTestNames: ['collapses repeated whitespace'],
			},
		);
		expect(verified.adjudication).toEqual({
			verdict: 'verified',
			reasonCodes: ['causal-red-green-confirmed'],
		});
		const receipt = buildReceipt({
			candidate,
			patch: authored.patch,
			changedPaths: ['test/slug.test.js'],
			policy: {testOnly: true, allowedGlobs: ['test/**'], violations: []},
			rawEvidence: verified.rawEvidence,
			classifications: [...verified.classifications],
			environment: {source: {kind: 'snapshot', id: 'snapshot-1'}},
			verdict: verified.adjudication.verdict,
			reasonCodes: [...verified.adjudication.reasonCodes],
			createdAt: '2024-01-01T00:00:02.000Z',
			redactionSecrets: [],
		});
		expect(receipt.receipt.verdict).toBe('verified');
		expect(agent).toMatchObject({invocations: 1, stops: 1});
		expect(execution.requests).toHaveLength(1);
	});
});
