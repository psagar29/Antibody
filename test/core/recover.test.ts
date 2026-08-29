import {createHash} from 'node:crypto';

import {describe, expect, it, vi} from 'vitest';

import type {
  AgentInvocationV1,
  AgentSessionPort,
  RawExecutionAttemptV1,
  VerificationExecutionPort,
} from '../../src/contracts/index.js';
import {
  AgentInvocationResultSchema,
  ArtifactSchema,
  RawExecutionAttemptSchema,
  RawVerificationEvidenceSchema,
  RecoveryCandidateSchema,
  RepoPathSchema,
} from '../../src/contracts/index.js';
import type {PatchApplicabilityChecker} from '../../src/core/policy/patch-policy.js';
import {RecoveryCoordinator} from '../../src/core/recover.js';

const patch = [
  'diff --git a/test/a.test.js b/test/a.test.js',
  '--- a/test/a.test.js',
  '+++ b/test/a.test.js',
  '@@ -1 +1,2 @@',
  ' old();',
  '+test();',
  '',
].join('\n');
const candidate = RecoveryCandidateSchema.parse({
  schemaVersion: 'antibody.candidate/v1',
  candidateId: `sha256:${'a'.repeat(64)}`,
  repository: {slug: 'owner/repo', cloneUrl: 'https://github.com/owner/repo.git'},
  parentSha: '1'.repeat(40),
  fixSha: '2'.repeat(40),
  headSha: '3'.repeat(40),
  commit: {
    subject: 'fix: behavior',
    authoredAt: '2026-08-29T00:00:00.000Z',
    changedProductionPaths: ['src/index.js'],
    changedTestPaths: [],
    additions: 1,
    deletions: 1,
    diffSha256: `sha256:${'b'.repeat(64)}`,
  },
  signals: [],
  score: 50,
});

function artifact(name: string, content: string) {
  const bytes = Buffer.from(content);
  return ArtifactSchema.parse({
    name,
    mediaType: 'text/plain',
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    sizeBytes: bytes.byteLength,
    contentBase64: bytes.toString('base64'),
  });
}

function rawAttempt(
  request: Parameters<VerificationExecutionPort['execute']>[0],
  lane: RawExecutionAttemptV1['lane'],
  phase: RawExecutionAttemptV1['phase'],
  attempt: number,
  report: string,
  exitCode: number,
) {
  const checkoutSha = lane === 'parent' ? candidate.parentSha : lane === 'fix' ? candidate.fixSha : candidate.headSha;
  const command = phase === 'baseline' ? request.commands.baseline : phase === 'full-suite' ? request.commands.fullSuite ?? request.commands.targeted : request.commands.targeted;
  return RawExecutionAttemptSchema.parse({
    lane,
    phase,
    attempt,
    checkoutSha,
    ...(phase === 'baseline' ? {} : {patchSha256: request.patch.sha256}),
    command,
    startedAt: '2026-08-29T00:00:00.000Z',
    finishedAt: '2026-08-29T00:00:01.000Z',
    durationMs: 1000,
    termination: 'exited' as const,
    exitCode,
    stdout: artifact('stdout', ''),
    stderr: artifact('stderr', ''),
    ...(phase === 'baseline' || phase === 'full-suite'
      ? {}
      : {report: artifact('report', report)}),
    provider: {devboxId: `${lane}-box`},
  });
}

describe('RecoveryCoordinator', () => {
  it('composes fake agent and execution ports into a schema-valid verified receipt', async () => {
    const stop = vi.fn(() => Promise.resolve());
    const agent: AgentSessionPort = {
      invoke(request: AgentInvocationV1) {
        return Promise.resolve(AgentInvocationResultSchema.parse({
          schemaVersion: 'antibody.agent-result/v1',
          invocationId: request.invocationId,
          continuationId: 'opaque-session',
          finalText: JSON.stringify({
            schemaVersion: 'antibody.agent-output/v1',
            candidateId: candidate.candidateId,
            patchBase64: Buffer.from(patch).toString('base64'),
            testCommandHint: ['node', '--test'],
            summary: 'Adds a regression test.',
          }),
          provider: {name: 'reflex', agentId: 'agent-1'},
          startedAt: '2026-08-29T00:00:00.000Z',
          finishedAt: '2026-08-29T00:00:01.000Z',
        }));
      },
      stop,
    };
    const verifier: VerificationExecutionPort = {
      execute(request) {
        const failing = [
          'TAP version 13',
          'not ok 1 - target regression',
          'AssertionError: Expected values to be strictly equal',
          "operator: 'strictEqual'",
          'at /tmp/work/test/a.test.js:5:2',
          '1..1',
        ].join('\n');
        const passing = 'TAP version 13\nok 1 - target regression\n1..1';
        const attempts = [
          rawAttempt(request, 'parent', 'baseline', 0, '', 0),
          rawAttempt(request, 'fix', 'baseline', 0, '', 0),
          rawAttempt(request, 'parent', 'candidate', 0, failing, 1),
          rawAttempt(request, 'parent', 'candidate', 1, failing, 1),
          rawAttempt(request, 'fix', 'candidate', 0, passing, 0),
          rawAttempt(request, 'fix', 'candidate', 1, passing, 0),
          rawAttempt(request, 'head', 'candidate', 0, passing, 0),
          rawAttempt(request, 'head', 'full-suite', 0, '', 0),
        ];
        return Promise.resolve(RawVerificationEvidenceSchema.parse({
          schemaVersion: 'antibody.raw-evidence/v1',
          runId: request.runId,
          candidateId: request.candidate.candidateId,
          patchSha256: request.patch.sha256,
          environmentEquivalence: {equivalent: true, comparedFields: ['snapshot'], mismatchFields: []},
          attempts,
          cleanup: [
            {devboxId: 'parent-box', requested: true, completed: true},
            {devboxId: 'fix-box', requested: true, completed: true},
            {devboxId: 'head-box', requested: true, completed: true},
          ],
        }));
      },
    };
    const applicability: PatchApplicabilityChecker = {check: () => Promise.resolve(true)};
    const coordinator = new RecoveryCoordinator({agent, verifier, applicability});
    const result = await coordinator.recover({
      repositoryPath: '.',
      candidate,
      context: {
        commitMessage: 'fix: behavior',
        parentFixDiff: 'diff',
        parentSources: [{path: RepoPathSchema.parse('src/index.js'), content: 'old'}],
        fixSources: [{path: RepoPathSchema.parse('src/index.js'), content: 'new'}],
        frameworkConfig: 'node:test',
        nearbyTests: [],
      },
      authoringBudget: {maxAttempts: 3, timeoutMs: 60_000, maxOutputBytes: 100_000, maxPromptBytes: 100_000},
      patchPolicy: {
        maxPatchBytes: 100_000,
        maxPatchFiles: 4,
        maxAddedLines: 100,
        forbidBinary: true,
        forbidSymlinks: true,
        forbidSubmodules: true,
        requireCurrentHeadPass: true,
      },
      testGlobs: ['test/**'],
      allowedSupportGlobs: [],
      verificationPlan: {
        environment: {source: {kind: 'snapshot', id: 'snapshot-1'}, maxParallel: 2},
        commands: {
          setup: [],
          baseline: {argv: ['node', '--test'], cwd: RepoPathSchema.parse('.'), env: {}, timeoutMs: 60_000},
          targeted: {argv: ['node', '--test'], cwd: RepoPathSchema.parse('.'), env: {}, timeoutMs: 60_000},
          fullSuite: {argv: ['node', '--test'], cwd: RepoPathSchema.parse('.'), env: {}, timeoutMs: 60_000},
        },
        report: {format: 'tap'},
        repetitions: 2,
      },
      targetTestNames: ['target regression'],
      runIdFactory: () => '00000000-0000-4000-8000-000000000001',
      now: () => '2026-08-29T00:00:02.000Z',
    });

    expect(result.receipt.verdict).toBe('verified');
    expect(result.receiptSha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.request.patch.sha256).toBe(result.policy.patchSha256);
    expect(stop).toHaveBeenCalledWith('opaque-session');
  });
});
