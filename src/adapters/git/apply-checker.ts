import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import type {FullGitSha} from '../../contracts/index.js';
import {runGit} from './git-process.js';

export type ApplyCheckLane = 'parent' | 'fix' | 'head';

export type ApplyCheckResult = Readonly<{
	lane: ApplyCheckLane;
	applies: boolean;
}>;

export async function checkPatchAgainstTrees(
	repositoryRoot: string,
	patch: string,
	commits: Readonly<Record<ApplyCheckLane, FullGitSha>>,
): Promise<readonly ApplyCheckResult[]> {
	const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'antibody-git-apply-'));
	const patchPath = path.join(temporaryRoot, 'candidate.diff');
	const indexPath = path.join(temporaryRoot, 'index');
	try {
		await writeFile(patchPath, patch, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
		const results: ApplyCheckResult[] = [];
		for (const lane of ['parent', 'fix', 'head'] as const) {
			const environment = {GIT_INDEX_FILE: indexPath};
			await runGit(repositoryRoot, ['read-tree', commits[lane]], {environment});
			try {
				await runGit(repositoryRoot, [
					'apply',
					'--check',
					'--cached',
					'--whitespace=nowarn',
					'--',
					patchPath,
				], {environment, maxOutputBytes: 1_048_576});
				results.push({lane, applies: true});
			} catch {
				results.push({lane, applies: false});
			}
		}

		return results;
	} finally {
		await rm(temporaryRoot, {recursive: true, force: true});
	}
}
