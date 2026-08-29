import path from 'node:path';

import {z} from 'zod';

import {
	ConfigSchema,
	FullGitShaSchema,
	RepoPathSchema,
	RepositoryRefSchema,
	type FullGitSha,
	type RepoPath,
	type RepositoryRefV1,
} from '../../contracts/index.js';
import {normalizeLf, sha256Canonical, sha256Text} from '../../core/digest.js';
import {matchesAnyGlob} from '../../core/globs.js';
import {decodeUtf8, runGit, splitNull} from './git-process.js';

const ScanRequestSchema = z
	.object({
		repositoryRoot: z.string().min(1).max(32_768),
		repository: RepositoryRefSchema,
		scan: ConfigSchema.shape.scan,
	})
	.strict();

const rawChangeHeader = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])([0-9]{0,3})$/u;
const statusToken = /^([A-Z])([0-9]{0,3})$/u;
const dependencyOrConfigBasenames = new Set([
	'package.json',
	'package-lock.json',
	'npm-shrinkwrap.json',
	'pnpm-lock.yaml',
	'yarn.lock',
	'bun.lock',
	'bun.lockb',
	'tsconfig.json',
	'vite.config.js',
	'vite.config.ts',
	'vitest.config.js',
	'vitest.config.ts',
	'jest.config.js',
	'jest.config.ts',
]);

type CommitRecord = Readonly<{
	sha: FullGitSha;
	parents: readonly FullGitSha[];
	authoredAt: string;
	subject: string;
}>;

export type GitPathChange = Readonly<{
	status: string;
	oldPath?: RepoPath;
	newPath?: RepoPath;
	oldMode?: string;
	newMode?: string;
}>;

export type MinedCommit = Readonly<{
	repository: RepositoryRefV1;
	parentSha: FullGitSha;
	fixSha: FullGitSha;
	headSha: FullGitSha;
	subject: string;
	authoredAt: string;
	changedProductionPaths: readonly RepoPath[];
	changedTestPaths: readonly RepoPath[];
	additions: number;
	deletions: number;
	diff: string;
	diffSha256: ReturnType<typeof sha256Text>;
	candidateId: ReturnType<typeof sha256Canonical>;
	modifiesBranchLogic: boolean;
	referencesIssue: boolean;
	headContainsFixedRegion: boolean;
}>;

function parseCommitRecords(output: Uint8Array): CommitRecord[] {
	const fields = splitNull(output);
	if (fields.length % 4 !== 0) {
		throw new Error('Malformed NUL-delimited git log output');
	}

	const commits: CommitRecord[] = [];
	for (let index = 0; index < fields.length; index += 4) {
		const sha = FullGitShaSchema.parse(fields[index]);
		const parentField = fields[index + 1] ?? '';
		const parents = parentField === ''
			? []
			: parentField.split(' ').map(parent => FullGitShaSchema.parse(parent));
		const authoredAt = z.iso.datetime().parse(fields[index + 2]);
		const subject = z.string().min(1).max(512).parse(fields[index + 3]);
		commits.push({sha, parents, authoredAt, subject});
	}

	return commits;
}

export function parseNameStatus(output: Uint8Array): GitPathChange[] {
	const fields = splitNull(output);
	const changes: GitPathChange[] = [];
	for (let index = 0; index < fields.length;) {
		const token = fields[index];
		const match = token === undefined ? null : statusToken.exec(token);
		if (match === null) {
			throw new Error('Malformed NUL-delimited git name-status output');
		}

		const kind = z.string().length(1).parse(match[1]);
		const status = z.string().parse(token);
		if (kind === 'R' || kind === 'C') {
			const oldPath = RepoPathSchema.parse(fields[index + 1]);
			const newPath = RepoPathSchema.parse(fields[index + 2]);
			changes.push({status, oldPath, newPath});
			index += 3;
		} else {
			const changedPath = RepoPathSchema.parse(fields[index + 1]);
			changes.push({
				status,
				...(kind === 'A' ? {newPath: changedPath} : {oldPath: changedPath, newPath: changedPath}),
			});
			index += 2;
		}
	}

	return changes;
}

export function parseRawChanges(output: Uint8Array): GitPathChange[] {
	const fields = splitNull(output);
	const changes: GitPathChange[] = [];
	for (let index = 0; index < fields.length;) {
		const header = fields[index];
		const match = header === undefined ? null : rawChangeHeader.exec(header);
		if (match === null) {
			throw new Error('Malformed NUL-delimited git raw diff output');
		}

		const oldMode = z.string().length(6).parse(match[1]);
		const newMode = z.string().length(6).parse(match[2]);
		const kind = z.string().length(1).parse(match[5]);
		const score = match[6] ?? '';
		const status = `${kind}${score}`;
		if (kind === 'R' || kind === 'C') {
			const oldPath = RepoPathSchema.parse(fields[index + 1]);
			const newPath = RepoPathSchema.parse(fields[index + 2]);
			changes.push({status, oldPath, newPath, oldMode, newMode});
			index += 3;
		} else {
			const changedPath = RepoPathSchema.parse(fields[index + 1]);
			changes.push({
				status,
				...(kind === 'A' ? {newPath: changedPath} : {oldPath: changedPath, newPath: changedPath}),
				oldMode,
				newMode,
			});
			index += 2;
		}
	}

	return changes;
}

function parseNumstat(output: Uint8Array): Readonly<{
	additions: number;
	deletions: number;
	binary: boolean;
}> {
	let additions = 0;
	let deletions = 0;
	let binary = false;
	for (const record of splitNull(output)) {
		const firstTab = record.indexOf('\t');
		const secondTab = record.indexOf('\t', firstTab + 1);
		if (firstTab <= 0 || secondTab <= firstTab) {
			throw new Error('Malformed NUL-delimited git numstat output');
		}

		const added = record.slice(0, firstTab);
		const deleted = record.slice(firstTab + 1, secondTab);
		if (added === '-' || deleted === '-') {
			binary = true;
			continue;
		}

		additions += z.coerce.number().int().nonnegative().parse(added);
		deletions += z.coerce.number().int().nonnegative().parse(deleted);
	}

	return {additions, deletions, binary};
}

function pathForChange(change: GitPathChange): RepoPath {
	const changedPath = change.newPath ?? change.oldPath;
	if (changedPath === undefined) {
		throw new Error('Git change omitted both paths');
	}

	return changedPath;
}

function isGeneratedOrVendor(repositoryPath: string): boolean {
	return /(^|\/)(?:vendor|vendors|dist|build|coverage|node_modules|generated)(?:\/|$)/u.test(
		repositoryPath,
	) || /(?:\.min\.(?:js|css)|\.map)$/u.test(repositoryPath);
}

function isDependencyOrConfiguration(repositoryPath: string): boolean {
	const basename = path.posix.basename(repositoryPath);
	return dependencyOrConfigBasenames.has(basename)
		|| repositoryPath.startsWith('.github/')
		|| /(?:^|\/)(?:config|configs)(?:\/|$)/u.test(repositoryPath)
		|| /(?:^|\.)config\.(?:js|cjs|mjs|ts|json|yaml|yml)$/u.test(basename);
}

function isDocumentation(repositoryPath: string): boolean {
	return /^(?:docs?\/|README(?:\.|$)|CHANGELOG(?:\.|$))/iu.test(repositoryPath)
		|| /\.(?:md|mdx|rst|txt)$/iu.test(repositoryPath);
}

function addedCodeLines(diff: string): string[] {
	return normalizeLf(diff)
		.split('\n')
		.filter(line => line.startsWith('+') && !line.startsWith('+++'))
		.map(line => line.slice(1).trim())
		.filter(line => line.length >= 4 && !line.startsWith('//') && !line.startsWith('#'))
		.slice(0, 32);
}

async function headContainsAddedRegion(
	repositoryRoot: string,
	headSha: FullGitSha,
	productionPaths: readonly RepoPath[],
	diff: string,
): Promise<boolean> {
	const additions = addedCodeLines(diff);
	if (additions.length === 0) {
		return false;
	}

	for (const repositoryPath of productionPaths) {
		try {
			const output = await runGit(repositoryRoot, [
				'show',
				`${headSha}:${repositoryPath}`,
			], {maxOutputBytes: 2 * 1_048_576});
			const content = decodeUtf8(output.stdout);
			if (additions.some(line => content.includes(line))) {
				return true;
			}
		} catch {
			// A removed path cannot retain the fixed region at current HEAD.
		}
	}

	return false;
}

export class GitHistoryMiner {
	async scan(input: z.input<typeof ScanRequestSchema>): Promise<readonly MinedCommit[]> {
		const request = ScanRequestSchema.parse(input);
		const repositoryRoot = path.resolve(request.repositoryRoot);
		const headResult = await runGit(repositoryRoot, ['rev-parse', '--verify', 'HEAD']);
		const headSha = FullGitShaSchema.parse(decodeUtf8(headResult.stdout).trim());
		const logArguments = [
			'log',
			'-z',
			'--format=%H%x00%P%x00%aI%x00%s',
			`--max-count=${String(request.scan.maxCommits)}`,
		];
		if (request.scan.since !== undefined) {
			logArguments.push(`--since=${request.scan.since}`);
		}

		const logResult = await runGit(repositoryRoot, logArguments);
		const records = parseCommitRecords(logResult.stdout);
		const candidates: MinedCommit[] = [];
		for (const record of records) {
			if (record.parents.length !== 1) {
				continue;
			}

			const parentSha = record.parents[0];
			if (parentSha === undefined) {
				continue;
			}

			let nameChanges: GitPathChange[];
			let rawChanges: GitPathChange[];
			try {
				const [nameStatus, raw, numstat, diffResult] = await Promise.all([
					runGit(repositoryRoot, [
						'diff-tree', '-r', '--no-commit-id', '--name-status', '-z', '-M', '-C',
						parentSha, record.sha,
					]),
					runGit(repositoryRoot, [
						'diff-tree', '-r', '--no-commit-id', '--raw', '-z', parentSha, record.sha,
					]),
					runGit(repositoryRoot, [
						'diff', '--numstat', '--no-renames', '-z', parentSha, record.sha,
					]),
					runGit(repositoryRoot, [
						'diff', '--binary', '--full-index', '--no-ext-diff', parentSha, record.sha, '--',
					], {maxOutputBytes: 16 * 1_048_576}),
				]);
				nameChanges = parseNameStatus(nameStatus.stdout);
				rawChanges = parseRawChanges(raw.stdout);
				const stats = parseNumstat(numstat.stdout);
				const diff = normalizeLf(decodeUtf8(diffResult.stdout));
				const changedPaths = nameChanges.map(pathForChange);

				const invalidShape = stats.binary
					|| /GIT binary patch|Binary files .* differ/u.test(diff)
					|| changedPaths.length === 0
					|| changedPaths.length > request.scan.maxChangedFiles
					|| stats.additions + stats.deletions > request.scan.maxChangedLines
					|| nameChanges.some(change => change.status.startsWith('R') || change.status.startsWith('C'))
					|| rawChanges.some(change =>
						change.oldMode === '160000'
						|| change.newMode === '160000'
						|| change.oldMode === '120000'
						|| change.newMode === '120000')
					|| changedPaths.some(repositoryPath =>
						isGeneratedOrVendor(repositoryPath)
						|| matchesAnyGlob(repositoryPath, request.scan.excludeGlobs));
				if (invalidShape) {
					continue;
				}

				const testPatterns = [...request.scan.testGlobs, ...request.scan.allowedSupportGlobs];
				const changedTestPaths = changedPaths.filter(repositoryPath =>
					matchesAnyGlob(repositoryPath, testPatterns));
				if (request.scan.requireNoTestChanges && changedTestPaths.length > 0) {
					continue;
				}

				const changedProductionPaths = changedPaths.filter(repositoryPath =>
					matchesAnyGlob(repositoryPath, request.scan.includeProduction)
					&& !matchesAnyGlob(repositoryPath, testPatterns)
					&& !isDependencyOrConfiguration(repositoryPath)
					&& !isDocumentation(repositoryPath));
				if (changedProductionPaths.length === 0) {
					continue;
				}

				const diffSha256 = sha256Text(diff);
				const candidateId = sha256Canonical({
					repository: request.repository.slug,
					parentSha,
					fixSha: record.sha,
				});
				candidates.push({
					repository: request.repository,
					parentSha,
					fixSha: record.sha,
					headSha,
					subject: record.subject,
					authoredAt: record.authoredAt,
					changedProductionPaths,
					changedTestPaths,
					additions: stats.additions,
					deletions: stats.deletions,
					diff,
					diffSha256,
					candidateId,
					modifiesBranchLogic: /^\+.*\b(?:if|else|switch|case|throw|catch|validat\w*|error)\b/imu.test(diff),
					referencesIssue: /(?:^|\s)#\d+\b|https:\/\/github\.com\/[^\s]+\/issues\/\d+/iu.test(record.subject),
					headContainsFixedRegion: await headContainsAddedRegion(
						repositoryRoot,
						headSha,
						changedProductionPaths,
						diff,
					),
				});
			} catch (error: unknown) {
				if (error instanceof z.ZodError || error instanceof TypeError) {
					continue;
				}

				throw error;
			}
		}

		return candidates;
	}
}
