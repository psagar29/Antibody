import {z} from 'zod';

import {
	ClassifiedAttemptSchema,
	RawVerificationEvidenceSchema,
	VerdictSchema,
	type ClassifiedAttemptV1,
	type OutcomeKindV1,
	type RawVerificationEvidenceV1,
	type VerdictV1,
} from '../../contracts/index.js';

const AdjudicationGatesSchema = z
	.object({
		policyPassed: z.boolean(),
		currentHeadApplies: z.boolean(),
		expectedRepetitions: z.union([
			z.literal(2),
			z.literal(3),
			z.literal(4),
			z.literal(5),
		]),
		requireFullSuite: z.boolean(),
	})
	.strict();

export type AdjudicationResult = Readonly<{
	verdict: VerdictV1;
	reasonCodes: readonly string[];
}>;

const infrastructureOutcomes = new Set<OutcomeKindV1>([
	'collection-failure',
	'build-failure',
	'dependency-failure',
	'timeout',
	'crash',
	'platform-failure',
	'unknown-failure',
]);
const targetFailureOutcomes = new Set<OutcomeKindV1>([
	'assertion-failure',
	'behavioral-failure',
]);

function result(verdict: VerdictV1, ...reasonCodes: string[]): AdjudicationResult {
	return {verdict: VerdictSchema.parse(verdict), reasonCodes};
}

export function adjudicateEvidence(
	rawInput: RawVerificationEvidenceV1,
	classificationsInput: readonly ClassifiedAttemptV1[],
	gatesInput: z.input<typeof AdjudicationGatesSchema>,
): AdjudicationResult {
	const raw = RawVerificationEvidenceSchema.parse(rawInput);
	const classifications = z.array(ClassifiedAttemptSchema).parse(classificationsInput);
	const gates = AdjudicationGatesSchema.parse(gatesInput);
	if (!gates.policyPassed) {
		return result('rejected', 'patch-policy-failed');
	}

	if (!gates.currentHeadApplies) {
		return result('rejected', 'current-head-conflict');
	}

	if (!raw.environmentEquivalence.equivalent) {
		return result('inconclusive', 'environment-mismatch');
	}

	const byRawIndex = new Map<number, ClassifiedAttemptV1>();
	for (const classification of classifications) {
		if (byRawIndex.has(classification.rawAttemptIndex)
			|| classification.rawAttemptIndex >= raw.attempts.length) {
			return result('inconclusive', 'malformed-classification-index');
		}
		byRawIndex.set(classification.rawAttemptIndex, classification);
	}

	const selected = (
		predicate: (attempt: RawVerificationEvidenceV1['attempts'][number]) => boolean,
	): ClassifiedAttemptV1[] | undefined => {
		const indices = raw.attempts
			.map((attempt, index) => ({attempt, index}))
			.filter(entry => predicate(entry.attempt))
			.map(entry => entry.index);
		const matches: ClassifiedAttemptV1[] = [];
		for (const index of indices) {
			const classification = byRawIndex.get(index);
			if (classification === undefined) {
				return undefined;
			}
			matches.push(classification);
		}
		return matches;
	};

	const prerequisites = selected(attempt =>
		attempt.phase === 'setup' || attempt.phase === 'baseline');
	if (prerequisites === undefined) {
		return result('inconclusive', 'missing-prerequisite-classification');
	}
	const failedPrerequisite = prerequisites.find(attempt => attempt.outcome !== 'pass');
	if (failedPrerequisite !== undefined) {
		return infrastructureOutcomes.has(failedPrerequisite.outcome)
			? result('inconclusive', 'prerequisite-infrastructure-failure')
			: result('rejected', 'baseline-not-clean');
	}

	const parent = selected(attempt => attempt.lane === 'parent' && attempt.phase === 'candidate');
	const fix = selected(attempt => attempt.lane === 'fix' && attempt.phase === 'candidate');
	const head = selected(attempt => attempt.lane === 'head' && attempt.phase === 'candidate');
	if (parent === undefined || fix === undefined || head === undefined) {
		return result('inconclusive', 'missing-candidate-classification');
	}
	if (parent.length !== gates.expectedRepetitions || fix.length !== gates.expectedRepetitions
		|| head.length === 0) {
		return result('inconclusive', 'missing-repetition-evidence');
	}

	if (parent.some(attempt => attempt.outcome === 'pass')) {
		return result('rejected', 'parent-passes');
	}
	if (parent.some(attempt => attempt.outcome === 'unrelated-test-failure')) {
		return result('rejected', 'parent-failure-unrelated');
	}
	if (parent.some(attempt => infrastructureOutcomes.has(attempt.outcome))) {
		return result('inconclusive', 'parent-infrastructure-failure');
	}
	if (!parent.every(attempt => targetFailureOutcomes.has(attempt.outcome))) {
		return result('inconclusive', 'parent-outcome-not-causal');
	}

	const parentSignatures = new Set(parent.map(attempt => attempt.signature));
	if (parentSignatures.has(undefined) || parentSignatures.size !== 1) {
		return result('inconclusive', 'parent-signature-unstable');
	}

	const failedFix = fix.find(attempt => attempt.outcome !== 'pass');
	if (failedFix !== undefined) {
		return infrastructureOutcomes.has(failedFix.outcome)
			? result('inconclusive', 'fix-infrastructure-failure')
			: result('rejected', 'test-fails-on-fix');
	}

	const failedHead = head.find(attempt => attempt.outcome !== 'pass');
	if (failedHead !== undefined) {
		return infrastructureOutcomes.has(failedHead.outcome)
			? result('inconclusive', 'head-infrastructure-failure')
			: result('rejected', 'current-head-target-fails');
	}

	if (gates.requireFullSuite) {
		const fullSuite = selected(attempt =>
			attempt.lane === 'head' && attempt.phase === 'full-suite');
		if (fullSuite === undefined || fullSuite.length === 0) {
			return result('inconclusive', 'missing-full-suite-evidence');
		}
		const failedFullSuite = fullSuite.find(attempt => attempt.outcome !== 'pass');
		if (failedFullSuite !== undefined) {
			return infrastructureOutcomes.has(failedFullSuite.outcome)
				? result('inconclusive', 'full-suite-infrastructure-failure')
				: result('rejected', 'current-head-full-suite-fails');
		}
	}

	return result('verified', 'causal-red-green-confirmed');
}
