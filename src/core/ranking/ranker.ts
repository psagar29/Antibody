import type {RecoveryCandidateV1} from '../../contracts/index.js';

export function rankRecoveryCandidates(
  candidates: readonly RecoveryCandidateV1[],
): RecoveryCandidateV1[] {
  return [...candidates].sort((left, right) => {
    const scoreDifference = right.score - left.score;
    if (scoreDifference !== 0) return scoreDifference;
    const authoredDifference = right.commit.authoredAt.localeCompare(left.commit.authoredAt);
    if (authoredDifference !== 0) return authoredDifference;
    return left.fixSha.localeCompare(right.fixSha);
  });
}
