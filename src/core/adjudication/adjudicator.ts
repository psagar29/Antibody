import type {
  ClassifiedAttemptV1,
  RawExecutionAttemptV1,
  RawVerificationEvidenceV1,
  VerdictV1,
  VerificationRequestV1,
} from '../../contracts/index.js';
import {
  ClassifiedAttemptSchema,
  RawVerificationEvidenceSchema,
  VerificationRequestSchema,
  VerdictSchema,
} from '../../contracts/index.js';

import type {PatchPolicyResult} from '../policy/patch-policy.js';

const infrastructureOutcomes = new Set([
  'collection-failure',
  'build-failure',
  'dependency-failure',
  'timeout',
  'crash',
  'platform-failure',
  'unknown-failure',
]);

export interface AdjudicationResult {
  readonly verdict: VerdictV1;
  readonly reasonCodes: readonly string[];
}

export function adjudicateVerification(options: {
  readonly request: VerificationRequestV1;
  readonly evidence: RawVerificationEvidenceV1;
  readonly classifications: readonly ClassifiedAttemptV1[];
  readonly policy: Pick<PatchPolicyResult, 'testOnly' | 'violations'>;
}): AdjudicationResult {
  const request = VerificationRequestSchema.parse(options.request);
  const evidence = RawVerificationEvidenceSchema.parse(options.evidence);
  const classifications = options.classifications.map((entry) => ClassifiedAttemptSchema.parse(entry));
  const byAttempt = new Map(classifications.map((entry) => [entry.rawAttemptIndex, entry]));

  if (!options.policy.testOnly || options.policy.violations.length > 0) {
    return result('rejected', ['POLICY_TEST_ONLY']);
  }
  if (
    evidence.runId !== request.runId ||
    evidence.candidateId !== request.candidate.candidateId ||
    evidence.patchSha256 !== request.patch.sha256
  ) {
    return result('inconclusive', ['EVIDENCE_IDENTITY_MISMATCH']);
  }
  if (!evidence.environmentEquivalence.equivalent) {
    return result('inconclusive', ['ENVIRONMENT_MISMATCH']);
  }
  const devboxIds = new Set(evidence.attempts.map((attempt) => attempt.provider.devboxId));
  const completedCleanup = new Set(
    evidence.cleanup
      .filter((entry) => entry.requested && entry.completed)
      .map((entry) => entry.devboxId),
  );
  if (
    devboxIds.size === 0 ||
    evidence.cleanup.some((entry) => !entry.requested || !entry.completed) ||
    [...devboxIds].some((devboxId) => !completedCleanup.has(devboxId))
  ) {
    return result('inconclusive', ['CLEANUP_INCOMPLETE']);
  }
  if (classifications.length !== evidence.attempts.length) {
    return result('inconclusive', ['CLASSIFICATION_MISSING']);
  }

  const setup = select(evidence.attempts, byAttempt, ['parent', 'fix', 'head'], 'setup');
  if (setup.some((entry) => entry.classification.outcome !== 'pass')) {
    return result('inconclusive', ['SETUP_NOT_GREEN']);
  }

  const baseline = select(evidence.attempts, byAttempt, ['parent', 'fix'], 'baseline');
  if (baseline.length < 2 || baseline.some((entry) => entry.classification.outcome !== 'pass')) {
    return result('inconclusive', ['BASELINE_NOT_GREEN']);
  }
  const parent = select(evidence.attempts, byAttempt, ['parent'], 'candidate');
  const fix = select(evidence.attempts, byAttempt, ['fix'], 'candidate');
  if (parent.length !== request.repetitions || fix.length !== request.repetitions) {
    return result('inconclusive', ['REPETITION_COUNT']);
  }
  if (parent.some((entry) => entry.classification.outcome === 'pass')) {
    return result('rejected', ['PARENT_PASSED']);
  }
  if (parent.some((entry) => entry.classification.outcome === 'unrelated-test-failure')) {
    return result('rejected', ['PARENT_UNRELATED_FAILURE']);
  }
  if (parent.some((entry) => infrastructureOutcomes.has(entry.classification.outcome))) {
    return result('inconclusive', ['PARENT_INFRASTRUCTURE']);
  }
  if (
    parent.some(
      (entry) =>
        entry.classification.outcome !== 'assertion-failure' &&
        entry.classification.outcome !== 'behavioral-failure',
    )
  ) {
    return result('rejected', ['PARENT_SEMANTIC_FAILURE']);
  }
  const parentSignatures = new Set(parent.map((entry) => entry.classification.signature));
  if (parentSignatures.size !== 1 || parentSignatures.has(undefined)) {
    return result('inconclusive', ['PARENT_UNSTABLE_SIGNATURE']);
  }

  if (fix.some((entry) => infrastructureOutcomes.has(entry.classification.outcome))) {
    return result('inconclusive', ['FIX_INFRASTRUCTURE']);
  }
  if (fix.some((entry) => entry.classification.outcome !== 'pass')) {
    return result('rejected', ['FIX_NOT_GREEN']);
  }

  const headTargeted = select(evidence.attempts, byAttempt, ['head'], 'candidate');
  if (headTargeted.length === 0) return result('inconclusive', ['HEAD_EVIDENCE_MISSING']);
  if (headTargeted.some((entry) => infrastructureOutcomes.has(entry.classification.outcome))) {
    return result('inconclusive', ['HEAD_INFRASTRUCTURE']);
  }
  if (headTargeted.some((entry) => entry.classification.outcome !== 'pass')) {
    return result('rejected', ['HEAD_NOT_GREEN']);
  }
  if (request.commands.fullSuite !== undefined) {
    const headFull = select(evidence.attempts, byAttempt, ['head'], 'full-suite');
    if (headFull.length === 0) return result('inconclusive', ['FULL_SUITE_MISSING']);
    if (headFull.some((entry) => infrastructureOutcomes.has(entry.classification.outcome))) {
      return result('inconclusive', ['FULL_SUITE_INFRASTRUCTURE']);
    }
    if (headFull.some((entry) => entry.classification.outcome !== 'pass')) {
      return result('rejected', ['FULL_SUITE_NOT_GREEN']);
    }
  }
  return result('verified', ['CAUSAL_PARENT_FAIL_FIX_PASS', 'CURRENT_HEAD_GREEN']);
}

function select(
  attempts: readonly RawExecutionAttemptV1[],
  classifications: ReadonlyMap<number, ClassifiedAttemptV1>,
  lanes: readonly RawExecutionAttemptV1['lane'][],
  phase: RawExecutionAttemptV1['phase'],
): {attempt: RawExecutionAttemptV1; classification: ClassifiedAttemptV1}[] {
  const selected: {attempt: RawExecutionAttemptV1; classification: ClassifiedAttemptV1}[] = [];
  attempts.forEach((attempt, index) => {
    const classification = classifications.get(index);
    if (lanes.includes(attempt.lane) && attempt.phase === phase && classification !== undefined) {
      selected.push({attempt, classification});
    }
  });
  return selected;
}

function result(verdict: VerdictV1, reasonCodes: readonly string[]): AdjudicationResult {
  return {verdict: VerdictSchema.parse(verdict), reasonCodes};
}
