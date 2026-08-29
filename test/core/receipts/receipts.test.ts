import {mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {afterEach, describe, expect, test} from 'vitest';

import {
	ClassifiedAttemptSchema,
	RawExecutionAttemptSchema,
	RawVerificationEvidenceSchema,
	ReceiptSchema,
	RecoveryCandidateSchema,
} from '../../../src/contracts/index.js';
import {sha256Bytes, sha256Canonical} from '../../../src/core/digest.js';
import {
	AtomicFileWriter,
	type AtomicFileOperations,
} from '../../../src/core/receipts/atomic-writer.js';
import {buildReceipt, redactSensitiveText} from '../../../src/core/receipts/receipt-builder.js';
import {persistReceiptBundle, verifyPersistedRun} from '../../../src/core/receipts/receipt-store.js';

const temporaryDirectories: string[] = [];

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

async function makeBundle() {
	const patch = await readFile('fixtures/demo-history/recovered-test.diff', 'utf8');
	const patchSha256 = sha256Bytes(Buffer.from(patch, 'utf8'));
	const rawAttempt = RawExecutionAttemptSchema.parse({
		lane: 'parent',
		phase: 'candidate',
		attempt: 0,
		checkoutSha: candidate.parentSha,
		patchSha256,
		command: {argv: ['node', '--test'], cwd: '.', env: {}, timeoutMs: 10_000},
		startedAt: '2024-01-01T00:00:00.000Z',
		finishedAt: '2024-01-01T00:00:01.000Z',
		durationMs: 1000,
		termination: 'exited',
		exitCode: 1,
		stdout: artifact('parent-candidate.stdout', 'token=super-secret-value'),
		stderr: artifact('parent-candidate.stderr', `Authorization: Bearer ${'x'.repeat(30)}`),
		report: artifact('parent-candidate.tap', 'not ok 1 - target'),
		provider: {devboxId: 'devbox-1'},
	});
	const rawEvidence = RawVerificationEvidenceSchema.parse({
		schemaVersion: 'antibody.raw-evidence/v1',
		runId: '11111111-1111-4111-8111-111111111111',
		candidateId: candidate.candidateId,
		patchSha256,
		environmentEquivalence: {
			equivalent: true,
			comparedFields: ['snapshot', 'architecture'],
			mismatchFields: [],
		},
		attempts: [rawAttempt],
		runloopCostUsd: 0.42,
		cleanup: [{devboxId: 'devbox-1', requested: true, completed: true}],
	});
	const classification = ClassifiedAttemptSchema.parse({
		rawAttemptIndex: 0,
		outcome: 'assertion-failure',
		signature: `sha256:${'c'.repeat(64)}`,
		targetTestNames: ['target'],
		explanation: 'stable target assertion',
		confidence: 'high',
	});
	const bundle = buildReceipt({
		candidate,
		patch,
		changedPaths: ['test/slug.test.js'],
		policy: {testOnly: true, allowedGlobs: ['test/**'], violations: []},
		rawEvidence,
		classifications: [classification],
		environment: {source: {kind: 'snapshot', id: 'snapshot-1'}},
		verdict: 'verified',
		reasonCodes: ['causal-red-green-confirmed'],
		createdAt: '2024-01-01T00:00:02.000Z',
		modelUsd: 0.11,
		redactionSecrets: ['super-secret-value'],
	});
	return {bundle, patch};
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(async directory =>
		rm(directory, {recursive: true, force: true})));
});

describe('canonical receipt construction', () => {
	test('matches an RFC 8785 canonical digest golden vector', () => {
		expect(sha256Canonical({nested: {z: 3, y: 2}, b: 1, a: 'x'})).toBe(
			'sha256:d374b349f047828c577678d8f449ff2b8d2ccd94bdde0e2a9ce67de3c1a5d33a',
		);
	});

	test('redacts configured and high-risk token values before hashing artifacts', async () => {
		const {bundle} = await makeBundle();
		const stdout = bundle.rawEvidence.attempts[0]?.stdout.contentBase64;
		const stderr = bundle.rawEvidence.attempts[0]?.stderr.contentBase64;
		expect(stdout === undefined ? '' : Buffer.from(stdout, 'base64').toString('utf8')).toBe(
			'token=[REDACTED]',
		);
		expect(stderr === undefined ? '' : Buffer.from(stderr, 'base64').toString('utf8')).toBe(
			'Authorization: [REDACTED]',
		);
		expect(redactSensitiveText('safe', [])).toBe('safe');
		expect(bundle.receipt.evidence.rawEvidenceSha256).toBe(
			sha256Canonical(bundle.rawEvidence),
		);
	});
});

describe('receipt persistence and verification', () => {
	test('atomically persists and verifies a complete immutable bundle', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'antibody-receipt-'));
		temporaryDirectories.push(root);
		const {bundle, patch} = await makeBundle();
		const runDirectory = await persistReceiptBundle(root, bundle, patch);

		await expect(verifyPersistedRun(runDirectory)).resolves.toEqual({valid: true, reasons: []});
		await expect(persistReceiptBundle(root, bundle, patch)).resolves.toBe(runDirectory);
		if (process.platform !== 'win32') {
			expect(((await stat(path.join(runDirectory, 'receipt.json'))).mode & 0o077)).toBe(0);
		}
	});

	test('detects receipt, patch, raw evidence, and artifact tampering', async () => {
		const roots = await Promise.all(['receipt', 'patch', 'raw', 'artifact'].map(async label => {
			const root = await mkdtemp(path.join(tmpdir(), `antibody-tamper-${label}-`));
			temporaryDirectories.push(root);
			return root;
		}));
		for (const root of roots) {
			const {bundle, patch} = await makeBundle();
			await persistReceiptBundle(root, bundle, patch);
		}
		const run = (root: string) => path.join(
			root,
			'.antibody',
			'runs',
			'11111111-1111-4111-8111-111111111111',
		);
		const receiptPath = path.join(run(roots[0] ?? ''), 'receipt.json');
		const receipt = ReceiptSchema.parse(JSON.parse(await readFile(receiptPath, 'utf8')));
		await writeFile(receiptPath, JSON.stringify({...receipt, verdict: 'rejected'}), 'utf8');
		await writeFile(path.join(run(roots[1] ?? ''), 'patch.diff'), 'tampered patch', 'utf8');
		await writeFile(path.join(run(roots[2] ?? ''), 'raw-evidence.json'), '{}', 'utf8');
		await writeFile(
			path.join(run(roots[3] ?? ''), 'artifacts', 'parent-candidate-0.stdout'),
			'tampered artifact',
			'utf8',
		);

		expect((await verifyPersistedRun(run(roots[0] ?? ''))).valid).toBe(false);
		expect((await verifyPersistedRun(run(roots[1] ?? ''))).reasons).toContain('patch-digest-mismatch');
		expect((await verifyPersistedRun(run(roots[2] ?? ''))).valid).toBe(false);
		expect((await verifyPersistedRun(run(roots[3] ?? ''))).reasons).toContain('artifact-digest-mismatch');
	});

	test('cleans its temporary file when the atomic rename fails', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'antibody-atomic-failure-'));
		temporaryDirectories.push(root);
		const operations: AtomicFileOperations = {
			mkdir: async directory => {
				await mkdir(directory, {recursive: true});
			},
			openExclusive: async filePath => open(filePath, 'wx', 0o600),
			readExisting: () => Promise.resolve(undefined),
			rename: () => Promise.reject(new Error('injected rename failure')),
			remove: async filePath => {
				await rm(filePath, {force: true});
			},
		};
		const destination = path.join(root, 'receipt.json');
		await expect(new AtomicFileWriter(operations).write(
			destination,
			Buffer.from('{}', 'utf8'),
		)).rejects.toThrow('injected rename failure');
		expect(await readdir(root)).toEqual([]);
	});
});
