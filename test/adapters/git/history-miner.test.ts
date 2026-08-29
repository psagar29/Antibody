import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {afterEach, describe, expect, test} from 'vitest';

import {buildDemoFixture} from '../../../scripts/build-demo-fixture.js';
import {
	GitHistoryMiner,
	parseNameStatus,
	parseRawChanges,
} from '../../../src/adapters/git/history-miner.js';
import {decodeUtf8, runGit} from '../../../src/adapters/git/git-process.js';
import {rankCandidates} from '../../../src/core/ranking/ranker.js';

const temporaryDirectories: string[] = [];

async function temporaryRepository(): Promise<string> {
	const repository = await mkdtemp(path.join(tmpdir(), 'antibody-miner-'));
	temporaryDirectories.push(repository);
	await buildDemoFixture(repository);
	return repository;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async directory =>
			rm(directory, {recursive: true, force: true}),
		),
	);
});

describe('GitHistoryMiner', () => {
	test('mines and deterministically ranks only eligible production commits', async () => {
		const repositoryRoot = await temporaryRepository();
		const commits = await new GitHistoryMiner().scan({
			repositoryRoot,
			repository: {
				slug: 'example/antibody-demo',
				cloneUrl: 'https://github.com/example/antibody-demo.git',
			},
			scan: {
				maxCommits: 20,
				includeProduction: ['src/**/*.js', '**/*.js'],
				testGlobs: ['test/**', 'tests/**', '**/*.test.js'],
				allowedSupportGlobs: ['test/**', 'tests/**', '**/__fixtures__/**'],
				excludeGlobs: ['vendor/**', 'dist/**', 'node_modules/**'],
				maxChangedFiles: 12,
				maxChangedLines: 400,
				excludeMerges: true,
				requireNoTestChanges: true,
			},
		});

		expect(commits.map(commit => commit.fixSha)).toEqual([
			'1bcd48e2eba3a5ed823460b6763c90f49efca6b3',
			'e2398bf45efca03a24dbb9101a52cf1c70ea0fe0',
		]);
		const ranked = rankCandidates(commits);
		expect(ranked.map(candidate => candidate.fixSha)).toEqual([
			'e2398bf45efca03a24dbb9101a52cf1c70ea0fe0',
			'1bcd48e2eba3a5ed823460b6763c90f49efca6b3',
		]);
		expect(ranked.map(candidate => candidate.score)).toEqual([65, 30]);
		expect(ranked[0]?.signals.map(signal => signal.code)).toEqual([
			'fix-subject',
			'small-diff',
			'focused-production-files',
			'fixed-region-retained',
		]);
	});

	test('rejects malformed and traversal-bearing NUL records', () => {
		expect(() => parseNameStatus(Buffer.from('M\0../outside.js\0'))).toThrow();
		expect(() => parseNameStatus(Buffer.from('M\0src/file.js'))).not.toThrow();
		expect(() => parseNameStatus(Buffer.from('M\0src/file.js\0trailing\0'))).toThrow(
			'Malformed NUL-delimited git name-status output',
		);
		expect(() => parseRawChanges(Buffer.from('not-a-header\0src/file.js\0'))).toThrow(
			'Malformed NUL-delimited git raw diff output',
		);
	});

	test('preserves rename paths and special modes for fail-closed policy checks', () => {
		const objectId = '0'.repeat(40);
		expect(parseNameStatus(Buffer.from('R100\0src/old.js\0src/new.js\0'))).toEqual([
			{status: 'R100', oldPath: 'src/old.js', newPath: 'src/new.js'},
		]);
		expect(parseRawChanges(Buffer.from(
			`:120000 100644 ${objectId} ${objectId} M\0src/link.js\0`,
		))).toEqual([
			{
				status: 'M',
				oldPath: 'src/link.js',
				newPath: 'src/link.js',
				oldMode: '120000',
				newMode: '100644',
			},
		]);
	});

	test('always excludes commits that touch tests even if legacy config disables the hint', async () => {
		const repositoryRoot = await temporaryRepository();
		await writeFile(path.join(repositoryRoot, 'src/slug.js'), 'export const changed = true;\n', 'utf8');
		await writeFile(path.join(repositoryRoot, 'test/slug.test.js'), "test('changed', () => {});\n", 'utf8');
		await runGit(repositoryRoot, ['add', '--', 'src/slug.js', 'test/slug.test.js']);
		await runGit(repositoryRoot, ['commit', '-m', 'fix source and test together'], {
			environment: {
				GIT_AUTHOR_DATE: '2024-01-05T00:00:00Z',
				GIT_COMMITTER_DATE: '2024-01-05T00:00:00Z',
			},
		});
		const unsafeSha = decodeUtf8((await runGit(repositoryRoot, ['rev-parse', 'HEAD'])).stdout).trim();
		const commits = await new GitHistoryMiner().scan({
			repositoryRoot,
			repository: {
				slug: 'example/antibody-demo',
				cloneUrl: 'https://github.com/example/antibody-demo.git',
			},
			scan: {
				maxCommits: 20,
				includeProduction: ['src/**/*.js', '**/*.js'],
				testGlobs: ['test/**'],
				allowedSupportGlobs: ['test/**'],
				excludeGlobs: [],
				maxChangedFiles: 12,
				maxChangedLines: 400,
				excludeMerges: true,
				requireNoTestChanges: false,
			},
		});
		expect(commits.map(commit => commit.fixSha)).not.toContain(unsafeSha);
	});
});
