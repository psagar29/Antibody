import {
	RecoveryCandidateSchema,
	type RecoveryCandidateV1,
} from '../../contracts/index.js';
import type {MinedCommit} from '../../adapters/git/history-miner.js';

export type CandidateEnrichment = Readonly<{
	bugLabel: boolean;
}>;

const fixSubject = /\b(?:fix|bug|regression|crash|incorrect|error)\b/iu;

function addSignal(
	signals: {code: string; weight: number; evidence: string}[],
	condition: boolean,
	code: string,
	weight: number,
	evidence: string,
): void {
	if (condition) {
		signals.push({code, weight, evidence});
	}
}

export function rankCandidates(
	commits: readonly MinedCommit[],
	enrichment: ReadonlyMap<string, CandidateEnrichment> = new Map(),
): readonly RecoveryCandidateV1[] {
	return commits
		.map(commit => {
			const signals: {code: string; weight: number; evidence: string}[] = [];
			addSignal(
				signals,
				fixSubject.test(commit.subject),
				'fix-subject',
				35,
				'Commit subject contains a fix-related word',
			);
			addSignal(
				signals,
				enrichment.get(commit.fixSha)?.bugLabel === true,
				'bug-label',
				20,
				'Linked closed issue or pull request has a bug/regression label',
			);
			addSignal(
				signals,
				commit.additions + commit.deletions <= 100,
				'small-diff',
				15,
				'Diff changes at most 100 lines',
			);
			addSignal(
				signals,
				commit.changedProductionPaths.length <= 3,
				'focused-production-files',
				10,
				'Diff changes one to three production files',
			);
			addSignal(
				signals,
				commit.modifiesBranchLogic,
				'branch-logic',
				10,
				'Diff modifies conditional, validation, or error-handling logic',
			);
			addSignal(
				signals,
				commit.referencesIssue,
				'issue-reference',
				5,
				'Commit subject references an issue',
			);
			addSignal(
				signals,
				commit.headContainsFixedRegion,
				'fixed-region-retained',
				5,
				'Current HEAD retains an added fixed-code line',
			);
			const score = Math.min(100, Math.max(0, signals.reduce(
				(total, signal) => total + signal.weight,
				0,
			)));
			return RecoveryCandidateSchema.parse({
				schemaVersion: 'antibody.candidate/v1',
				candidateId: commit.candidateId,
				repository: commit.repository,
				parentSha: commit.parentSha,
				fixSha: commit.fixSha,
				headSha: commit.headSha,
				commit: {
					subject: commit.subject,
					authoredAt: commit.authoredAt,
					changedProductionPaths: commit.changedProductionPaths,
					changedTestPaths: commit.changedTestPaths,
					additions: commit.additions,
					deletions: commit.deletions,
					diffSha256: commit.diffSha256,
				},
				signals,
				score,
			});
		})
		.sort((left, right) =>
			right.score - left.score
			|| right.commit.authoredAt.localeCompare(left.commit.authoredAt)
			|| left.fixSha.localeCompare(right.fixSha));
}
