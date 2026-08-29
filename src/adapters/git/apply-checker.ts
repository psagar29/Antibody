import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import type {FullGitSha, RepoPath} from '../../contracts/index.js';
import {runGit} from './git-process.js';

export type ApplyCheckLane = 'parent' | 'fix' | 'head';

export type ApplyCheckResult = Readonly<{
	lane: ApplyCheckLane;
	applies: boolean;
}>;

export type MaterializedPatchFile = Readonly<{
	path: RepoPath;
	content: Uint8Array;
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

export async function materializePatchFiles(
	repositoryRoot: string,
	patch: string,
	commit: FullGitSha,
	changedPaths: readonly RepoPath[],
): Promise<readonly MaterializedPatchFile[]> {
	const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'antibody-git-materialize-'));
	const patchPath = path.join(temporaryRoot, 'candidate.diff');
	const indexPath = path.join(temporaryRoot, 'index');
	const environment = {GIT_INDEX_FILE: indexPath};
	try {
		await writeFile(patchPath, patch, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
		await runGit(repositoryRoot, ['read-tree', commit], {environment});
		await runGit(repositoryRoot, [
			'apply',
			'--cached',
			'--whitespace=nowarn',
			'--',
			patchPath,
		], {environment, maxOutputBytes: 1_048_576});
		const files: MaterializedPatchFile[] = [];
		for (const repositoryPath of changedPaths) {
			const result = await runGit(repositoryRoot, ['show', `:${repositoryPath}`], {
				environment,
				maxOutputBytes: 10_485_760,
			});
			files.push({path: repositoryPath, content: result.stdout});
		}
		return files;
	} finally {
		await rm(temporaryRoot, {recursive: true, force: true});
	}
}
