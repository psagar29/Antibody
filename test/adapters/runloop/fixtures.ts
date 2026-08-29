import {createHash} from 'node:crypto';

import {
  RawVerificationEvidenceSchema,
  VerificationRequestSchema,
  type RawVerificationEvidenceV1,
  type VerificationRequestV1,
} from '../../../src/contracts/schemas.js';

const parentSha = '1111111111111111111111111111111111111111';
const fixSha = '2222222222222222222222222222222222222222';
const headSha = '3333333333333333333333333333333333333333';
const emptySha256 = `sha256:${'0'.repeat(64)}`;

export const runloopFixturePatch = Buffer.from(
  [
    'diff --git a/test/regression.test.js b/test/regression.test.js',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/test/regression.test.js',
    '@@ -0,0 +1 @@',
    "+console.log('regression');",
    '',
  ].join('\n'),
  'utf8',
);

export const runloopFixturePatchSha256 = `sha256:${createHash('sha256')
  .update(runloopFixturePatch)
  .digest('hex')}`;

export function makeRunloopFixtureRequest(): VerificationRequestV1 {
  return VerificationRequestSchema.parse({
    schemaVersion: 'antibody.verification-request/v1',
    runId: '00000000-0000-4000-8000-000000000001',
    candidate: {
      schemaVersion: 'antibody.candidate/v1',
      candidateId: `sha256:${'1'.repeat(64)}`,
      repository: {
        slug: 'example/project',
        cloneUrl: 'https://github.com/example/project.git',
      },
      parentSha,
      fixSha,
      headSha,
      commit: {
        subject: 'fix: example regression',
        authoredAt: '2026-08-29T12:00:00.000Z',
        changedProductionPaths: ['src/example.js'],
        changedTestPaths: [],
        additions: 1,
        deletions: 1,
        diffSha256: emptySha256,
      },
      signals: [],
      score: 75,
    },
    patch: {
      unifiedDiffBase64: runloopFixturePatch.toString('base64'),
      sha256: runloopFixturePatchSha256,
      changedPaths: ['test/regression.test.js'],
    },
    environment: {
      source: {kind: 'snapshot', id: 'snap_fixture'},
      networkPolicyId: 'npol_fixture',
      architecture: 'x86_64',
      shape: 'SMALL',
      maxParallel: 2,
    },
    commands: {
      setup: [
        {
          argv: ['npm', 'install'],
          cwd: '.',
          env: {CI: '1'},
          timeoutMs: 60_000,
        },
      ],
      baseline: {
        argv: ['npm', 'test'],
        cwd: '.',
        env: {CI: '1'},
        timeoutMs: 60_000,
      },
      targeted: {
        argv: ['node', '--test'],
        cwd: '.',
        env: {CI: '1', NO_COLOR: '1'},
        timeoutMs: 30_000,
      },
      fullSuite: {
        argv: ['npm', 'test'],
        cwd: '.',
        env: {CI: '1'},
        timeoutMs: 60_000,
      },
    },
    report: {format: 'tap', path: 'artifacts/report.tap'},
    repetitions: 2,
  });
}

export function makeRunloopFixtureEvidence(): RawVerificationEvidenceV1 {
  const request = makeRunloopFixtureRequest();
  return RawVerificationEvidenceSchema.parse({
    schemaVersion: 'antibody.raw-evidence/v1',
    runId: request.runId,
    candidateId: request.candidate.candidateId,
    patchSha256: request.patch.sha256,
    environmentEquivalence: {
      equivalent: true,
      comparedFields: ['source', 'networkPolicy', 'architecture', 'shape'],
      mismatchFields: [],
    },
    attempts: [],
    cleanup: [
      {devboxId: 'devbox_parent', requested: true, completed: true},
      {devboxId: 'devbox_fix', requested: true, completed: true},
    ],
  });
}
