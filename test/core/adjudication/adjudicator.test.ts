import {describe, expect, test} from 'vitest';

import {
	ClassifiedAttemptSchema,
	RawExecutionAttemptSchema,
	RawVerificationEvidenceSchema,
	type ClassifiedAttemptV1,
	type OutcomeKindV1,
	type RawExecutionAttemptV1,
	type RawVerificationEvidenceV1,
} from '../../../src/contracts/index.js';
import {adjudicateEvidence} from '../../../src/core/adjudication/adjudicator.js';
import {sha256Bytes} from '../../../src/core/digest.js';

const stableSignature = `sha256:${'d'.repeat(64)}`;

function artifact(name: string) {
	const bytes = Buffer.from('', 'utf8');
	return {
		name,
		mediaType: 'text/plain',
		sha256: sha256Bytes(bytes),
		sizeBytes: 0,
		contentBase64: '',
	};
}

function rawAttempt(
	lane: RawExecutionAttemptV1['lane'],
	phase: RawExecutionAttemptV1['phase'],
	attempt: number,
): RawExecutionAttemptV1 {
	return RawExecutionAttemptSchema.parse({
		lane,
		phase,
		attempt,
		checkoutSha: '66e82fb6b511eccffc879042c61bf45100067881',
		...(phase === 'candidate' ? {patchSha256: `sha256:${'a'.repeat(64)}`} : {}),
		command: {argv: ['node', '--test'], cwd: '.', env: {}, timeoutMs: 10_000},
		startedAt: '2024-01-01T00:00:00.000Z',
		finishedAt: '2024-01-01T00:00:01.000Z',
		durationMs: 1000,
		termination: 'exited',
		exitCode: 0,
		stdout: artifact('stdout'),
		stderr: artifact('stderr'),
		provider: {devboxId: `${lane}-${phase}-${String(attempt)}`},
	});
}

const rawAttempts = [
	rawAttempt('parent', 'baseline', 0),
	rawAttempt('fix', 'baseline', 0),
	rawAttempt('parent', 'candidate', 0),
	rawAttempt('parent', 'candidate', 1),
	rawAttempt('fix', 'candidate', 0),
	rawAttempt('fix', 'candidate', 1),
	rawAttempt('head', 'candidate', 0),
	rawAttempt('head', 'full-suite', 0),
];

function classification(
	rawAttemptIndex: number,
	outcome: OutcomeKindV1,
	signature?: string,
): ClassifiedAttemptV1 {
	return ClassifiedAttemptSchema.parse({
		rawAttemptIndex,
		outcome,
		...(signature === undefined ? {} : {signature}),
		targetTestNames: ['target behavior'],
		explanation: `classified as ${outcome}`,
		confidence: 'high',
	});
}

function baseClassifications(): ClassifiedAttemptV1[] {
	return [
		classification(0, 'pass'),
		classification(1, 'pass'),
		classification(2, 'assertion-failure', stableSignature),
		classification(3, 'assertion-failure', stableSignature),
		classification(4, 'pass'),
		classification(5, 'pass'),
		classification(6, 'pass'),
		classification(7, 'pass'),
	];
}

function evidence(equivalent = true, attempts = rawAttempts): RawVerificationEvidenceV1 {
	return RawVerificationEvidenceSchema.parse({
		schemaVersion: 'antibody.raw-evidence/v1',
		runId: '11111111-1111-4111-8111-111111111111',
		candidateId: `sha256:${'b'.repeat(64)}`,
		patchSha256: `sha256:${'a'.repeat(64)}`,
		environmentEquivalence: {
			equivalent,
			comparedFields: ['snapshot', 'architecture'],
			mismatchFields: equivalent ? [] : ['snapshot'],
		},
		attempts,
		cleanup: [],
	});
}

const gates = {
	policyPassed: true,
	currentHeadApplies: true,
	expectedRepetitions: 2,
	requireFullSuite: true,
} as const;

function replaceOutcome(
	classifications: readonly ClassifiedAttemptV1[],
	index: number,
	outcome: OutcomeKindV1,
	signature?: string,
): ClassifiedAttemptV1[] {
	return classifications.map(item =>
		item.rawAttemptIndex === index ? classification(index, outcome, signature) : item);
}

describe('causal adjudication truth table', () => {
	test('verifies only stable parent failure followed by fix and HEAD passes', () => {
		expect(adjudicateEvidence(evidence(), baseClassifications(), gates)).toEqual({
			verdict: 'verified',
			reasonCodes: ['causal-red-green-confirmed'],
		});
	});

	test.each([
		{
			name: 'policy rejection',
			raw: evidence(),
			items: baseClassifications(),
			gateOverrides: {policyPassed: false},
			expected: ['rejected', 'patch-policy-failed'],
		},
		{
			name: 'current HEAD conflict',
			raw: evidence(),
			items: baseClassifications(),
			gateOverrides: {currentHeadApplies: false},
			expected: ['rejected', 'current-head-conflict'],
		},
		{
			name: 'environment mismatch',
			raw: evidence(false),
			items: baseClassifications(),
			gateOverrides: {},
			expected: ['inconclusive', 'environment-mismatch'],
		},
		{
			name: 'parent pass',
			raw: evidence(),
			items: replaceOutcome(baseClassifications(), 2, 'pass'),
			gateOverrides: {},
			expected: ['rejected', 'parent-passes'],
		},
		{
			name: 'unrelated parent failure',
			raw: evidence(),
			items: replaceOutcome(baseClassifications(), 2, 'unrelated-test-failure', stableSignature),
			gateOverrides: {},
			expected: ['rejected', 'parent-failure-unrelated'],
		},
		{
			name: 'parent collection failure',
			raw: evidence(),
			items: replaceOutcome(baseClassifications(), 2, 'collection-failure', stableSignature),
			gateOverrides: {},
			expected: ['inconclusive', 'parent-infrastructure-failure'],
		},
		{
			name: 'flaky parent signature',
			raw: evidence(),
			items: replaceOutcome(baseClassifications(), 3, 'assertion-failure', `sha256:${'e'.repeat(64)}`),
			gateOverrides: {},
			expected: ['inconclusive', 'parent-signature-unstable'],
		},
		{
			name: 'fix semantic failure',
			raw: evidence(),
			items: replaceOutcome(baseClassifications(), 4, 'assertion-failure', stableSignature),
			gateOverrides: {},
			expected: ['rejected', 'test-fails-on-fix'],
		},
		{
			name: 'fix timeout',
			raw: evidence(),
			items: replaceOutcome(baseClassifications(), 4, 'timeout'),
			gateOverrides: {},
			expected: ['inconclusive', 'fix-infrastructure-failure'],
		},
		{
			name: 'HEAD semantic failure',
			raw: evidence(),
			items: replaceOutcome(baseClassifications(), 6, 'behavioral-failure', stableSignature),
			gateOverrides: {},
			expected: ['rejected', 'current-head-target-fails'],
		},
		{
			name: 'HEAD platform failure',
			raw: evidence(),
			items: replaceOutcome(baseClassifications(), 6, 'platform-failure'),
			gateOverrides: {},
			expected: ['inconclusive', 'head-infrastructure-failure'],
		},
		{
			name: 'full-suite semantic failure',
			raw: evidence(),
			items: replaceOutcome(baseClassifications(), 7, 'unrelated-test-failure', stableSignature),
			gateOverrides: {},
			expected: ['rejected', 'current-head-full-suite-fails'],
		},
		{
			name: 'full-suite dependency failure',
			raw: evidence(),
			items: replaceOutcome(baseClassifications(), 7, 'dependency-failure'),
			gateOverrides: {},
			expected: ['inconclusive', 'full-suite-infrastructure-failure'],
		},
		{
			name: 'dirty baseline',
			raw: evidence(),
			items: replaceOutcome(baseClassifications(), 0, 'assertion-failure', stableSignature),
			gateOverrides: {},
			expected: ['rejected', 'baseline-not-clean'],
		},
		{
			name: 'baseline build failure',
			raw: evidence(),
			items: replaceOutcome(baseClassifications(), 0, 'build-failure'),
			gateOverrides: {},
			expected: ['inconclusive', 'prerequisite-infrastructure-failure'],
		},
	] as const)('$name', scenario => {
		const adjudicated = adjudicateEvidence(
			scenario.raw,
			scenario.items,
			{...gates, ...scenario.gateOverrides},
		);
		expect([adjudicated.verdict, adjudicated.reasonCodes[0]]).toEqual(scenario.expected);
	});

	test('requires every repetition, classification, and configured full-suite result', () => {
		expect(adjudicateEvidence(
			evidence(),
			baseClassifications().filter(item => item.rawAttemptIndex !== 3),
			gates,
		).reasonCodes).toEqual(['missing-candidate-classification']);
		expect(adjudicateEvidence(
			evidence(true, rawAttempts.filter((_item, index) => index !== 3)),
			baseClassifications()
				.filter(item => item.rawAttemptIndex !== 3)
				.map((item, index) => classification(
					index,
					item.outcome,
					item.signature,
				)),
			gates,
		).reasonCodes).toEqual(['missing-repetition-evidence']);
		expect(adjudicateEvidence(
			evidence(true, rawAttempts.slice(0, 7)),
			baseClassifications().slice(0, 7),
			gates,
		).reasonCodes).toEqual(['missing-full-suite-evidence']);
	});
});
