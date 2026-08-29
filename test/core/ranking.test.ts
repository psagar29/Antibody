import {describe, expect, it} from 'vitest';

import {RecoveryCandidateSchema} from '../../src/contracts/index.js';
import {rankRecoveryCandidates} from '../../src/core/ranking/ranker.js';

function candidate(fixSha: string, score: number, authoredAt: string) {
  return RecoveryCandidateSchema.parse({
    schemaVersion: 'antibody.candidate/v1',
    candidateId: `sha256:${fixSha.padEnd(64, '0').slice(0, 64)}`,
    repository: {slug: 'owner/repo', cloneUrl: 'https://github.com/owner/repo.git'},
    parentSha: '0'.repeat(40),
    fixSha,
    headSha: 'f'.repeat(40),
    commit: {
      subject: 'fix: candidate',
      authoredAt,
      changedProductionPaths: ['src/index.ts'],
      changedTestPaths: [],
      additions: 1,
      deletions: 1,
      diffSha256: `sha256:${'d'.repeat(64)}`,
    },
    signals: [],
    score,
  });
}

describe('rankRecoveryCandidates', () => {
  it('uses score desc, authored time desc, then SHA asc', () => {
    const lowSha = '1'.repeat(40);
    const highSha = '2'.repeat(40);
    const older = candidate(highSha, 50, '2026-01-01T00:00:00.000Z');
    const newerHighSha = candidate(highSha, 50, '2026-02-01T00:00:00.000Z');
    const newerLowSha = candidate(lowSha, 50, '2026-02-01T00:00:00.000Z');
    const top = candidate('3'.repeat(40), 80, '2025-01-01T00:00:00.000Z');

    expect(
      rankRecoveryCandidates([older, newerHighSha, top, newerLowSha]).map(
        (entry) => entry.fixSha,
      ),
    ).toEqual([top.fixSha, lowSha, highSha, highSha]);
  });
});
