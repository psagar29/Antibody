import {z} from 'zod';

import {
	RawVerificationEvidenceSchema,
	VerificationRequestSchema,
	type ClassifiedAttemptV1,
	type RawVerificationEvidenceV1,
	type VerificationExecutionPort,
	type VerificationRequestV1,
} from '../../contracts/index.js';
import {
	adjudicateEvidence,
	type AdjudicationResult,
} from '../adjudication/adjudicator.js';
import {classifyAttempt} from '../classification/classifier.js';

const RecoveryGatesSchema = z
	.object({
		policyPassed: z.boolean(),
		currentHeadApplies: z.boolean(),
		targetTestNames: z.array(z.string().min(1).max(1024)).min(1).max(128),
	})
	.strict();

export type CausalRecoveryResult = Readonly<{
	rawEvidence: RawVerificationEvidenceV1;
	classifications: readonly ClassifiedAttemptV1[];
	adjudication: AdjudicationResult;
}>;

export class CausalRecoveryVerifier {
	constructor(private readonly execution: VerificationExecutionPort) {}

	async verify(
		requestInput: VerificationRequestV1,
		gatesInput: z.input<typeof RecoveryGatesSchema>,
		options: Readonly<{signal?: AbortSignal}> = {},
	): Promise<CausalRecoveryResult> {
		const request = VerificationRequestSchema.parse(requestInput);
		const gates = RecoveryGatesSchema.parse(gatesInput);
		const rawEvidence = RawVerificationEvidenceSchema.parse(
			await this.execution.execute(request, options),
		);
		if (rawEvidence.runId !== request.runId
			|| rawEvidence.candidateId !== request.candidate.candidateId
			|| rawEvidence.patchSha256 !== request.patch.sha256) {
			throw new Error('Verification evidence identity does not match its request');
		}

		const classifications = rawEvidence.attempts.map((attempt, index) =>
			classifyAttempt(index, attempt, request.report.format, gates.targetTestNames));
		const adjudication = adjudicateEvidence(rawEvidence, classifications, {
			policyPassed: gates.policyPassed,
			currentHeadApplies: gates.currentHeadApplies,
			expectedRepetitions: request.repetitions,
			requireFullSuite: request.commands.fullSuite !== undefined,
		});
		return {rawEvidence, classifications, adjudication};
	}
}
