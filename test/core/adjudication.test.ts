import {createHash, randomUUID} from 'node:crypto';

import {describe, expect, it} from 'vitest';

import type {OutcomeKindV1} from '../../src/contracts/index.js';
import {
  ClassifiedAttemptSchema,
  RawVerificationEvidenceSchema,
  RecoveryCandidateSchema,
  Sha256Schema,
  VerificationRequestSchema,
} from '../../src/contracts/index.js';
import {adjudicateVerification} from '../../src/core/adjudication/adjudicator.js';

const digest = `sha256:${'a'.repeat(64)}`;
const signature = `sha256:${'b'.repeat(64)}`;
const candidate = RecoveryCandidateSchema.parse({
  schemaVersion: 'antibody.candidate/v1',
  candidateId: digest,
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
    diffSha256: digest,
  },
  signals: [],
  score: 50,
});

function artifact(name: string) {
  const bytes = Buffer.from('ok');
  return {
    name,
    mediaType: 'text/plain',
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    sizeBytes: bytes.byteLength,
    contentBase64: bytes.toString('base64'),
  };
}

function buildCase(overrides: Record<string, OutcomeKindV1> = {}, signatureOverride?: string) {
  const runId = randomUUID();
  const specs = [
    ['parent', 'baseline', 0, 'pass'],
    ['fix', 'baseline', 0, 'pass'],
    ['parent', 'candidate', 0, 'assertion-failure'],
    ['parent', 'candidate', 1, 'assertion-failure'],
    ['fix', 'candidate', 0, 'pass'],
    ['fix', 'candidate', 1, 'pass'],
    ['head', 'candidate', 0, 'pass'],
    ['head', 'full-suite', 0, 'pass'],
  ] as const;
  const attempts = specs.map(([lane, phase, attempt, defaultOutcome]) => ({
    lane,
    phase,
    attempt,
    checkoutSha: lane === 'parent' ? candidate.parentSha : lane === 'fix' ? candidate.fixSha : candidate.headSha,
    ...(phase === 'baseline' ? {} : {patchSha256: digest}),
    command: {argv: ['node', '--test'], cwd: '.', env: {}, timeoutMs: 60_000},
    startedAt: '2026-08-29T00:00:00.000Z',
    finishedAt: '2026-08-29T00:00:01.000Z',
    durationMs: 1000,
    termination: 'exited',
    exitCode: defaultOutcome === 'pass' ? 0 : 1,
    stdout: artifact('stdout'),
    stderr: artifact('stderr'),
    provider: {devboxId: `${lane}-box`},
  }));
  const classifications = specs.map(([lane, phase, attempt, defaultOutcome], index) => {
    const key = `${lane}:${phase}:${String(attempt)}`;
    const outcome = overrides[key] ?? defaultOutcome;
    return ClassifiedAttemptSchema.parse({
      rawAttemptIndex: index,
      outcome,
      ...(outcome === 'assertion-failure' || outcome === 'behavioral-failure'
        ? {signature: signatureOverride ?? signature}
        : {}),
      targetTestNames: phase === 'candidate' ? ['target'] : [],
      explanation: 'test fixture',
      confidence: 'high',
    });
  });
  const request = VerificationRequestSchema.parse({
    schemaVersion: 'antibody.verification-request/v1',
    runId,
    candidate,
    patch: {unifiedDiffBase64: 'ZGlmZg==', sha256: digest, changedPaths: ['test/a.test.js']},
    environment: {source: {kind: 'snapshot', id: 'snapshot-1'}, maxParallel: 2},
    commands: {
      setup: [],
      baseline: {argv: ['node', '--test'], cwd: '.', env: {}, timeoutMs: 60_000},
      targeted: {argv: ['node', '--test'], cwd: '.', env: {}, timeoutMs: 60_000},
      fullSuite: {argv: ['node', '--test'], cwd: '.', env: {}, timeoutMs: 60_000},
    },
    report: {format: 'tap'},
    repetitions: 2,
  });
  const evidence = RawVerificationEvidenceSchema.parse({
    schemaVersion: 'antibody.raw-evidence/v1',
    runId,
    candidateId: candidate.candidateId,
    patchSha256: digest,
    environmentEquivalence: {equivalent: true, comparedFields: ['snapshot'], mismatchFields: []},
    attempts,
    cleanup: [
      {devboxId: 'parent-box', requested: true, completed: true},
      {devboxId: 'fix-box', requested: true, completed: true},
    ],
  });
  return {request, evidence, classifications};
}

const passingPolicy = {testOnly: true, violations: []};

describe('causal adjudication truth table', () => {
  it('verifies only stable parent target failures with green fix and head', () => {
    const input = buildCase();
    expect(adjudicateVerification({...input, policy: passingPolicy})).toEqual({
      verdict: 'verified',
      reasonCodes: ['CAUSAL_PARENT_FAIL_FIX_PASS', 'CURRENT_HEAD_GREEN'],
    });
  });

  it.each([
    ['parent pass', {'parent:candidate:0': 'pass'}, 'rejected'],
    ['unrelated parent failure', {'parent:candidate:0': 'unrelated-test-failure'}, 'rejected'],
    ['parent dependency', {'parent:candidate:0': 'dependency-failure'}, 'inconclusive'],
    ['fix assertion', {'fix:candidate:0': 'assertion-failure'}, 'rejected'],
    ['fix timeout', {'fix:candidate:0': 'timeout'}, 'inconclusive'],
    ['head assertion', {'head:candidate:0': 'assertion-failure'}, 'rejected'],
    ['head platform', {'head:candidate:0': 'platform-failure'}, 'inconclusive'],
    ['full suite failure', {'head:full-suite:0': 'unrelated-test-failure'}, 'rejected'],
    ['baseline failure', {'parent:baseline:0': 'build-failure'}, 'inconclusive'],
  ] as const)('%s is %s', (_name, overrides, expectedVerdict) => {
    const input = buildCase(overrides);
    expect(adjudicateVerification({...input, policy: passingPolicy}).verdict).toBe(expectedVerdict);
  });

  it('marks environment, cleanup, policy, identity, missing evidence, and unstable repetitions conservatively', () => {
    const input = buildCase();
    expect(
      adjudicateVerification({
        ...input,
        evidence: {...input.evidence, environmentEquivalence: {equivalent: false, comparedFields: [], mismatchFields: ['snapshot']}},
        policy: passingPolicy,
      }).verdict,
    ).toBe('inconclusive');
    expect(
      adjudicateVerification({
        ...input,
        evidence: {...input.evidence, cleanup: [{devboxId: 'x', requested: true, completed: false}]},
        policy: passingPolicy,
      }).verdict,
    ).toBe('inconclusive');
    expect(adjudicateVerification({...input, policy: {testOnly: false, violations: []}}).verdict).toBe('rejected');
    expect(
      adjudicateVerification({
        ...input,
        evidence: {
          ...input.evidence,
          patchSha256: Sha256Schema.parse(`sha256:${'f'.repeat(64)}`),
        },
        policy: passingPolicy,
      }).verdict,
    ).toBe('inconclusive');
    expect(
      adjudicateVerification({...input, classifications: input.classifications.slice(1), policy: passingPolicy}).verdict,
    ).toBe('inconclusive');

    const unstable = buildCase();
    const changed = unstable.classifications.map((entry, index) =>
      index === 3 ? ClassifiedAttemptSchema.parse({...entry, signature: `sha256:${'c'.repeat(64)}`}) : entry,
    );
    expect(adjudicateVerification({...unstable, classifications: changed, policy: passingPolicy}).verdict).toBe('inconclusive');
  });
});
