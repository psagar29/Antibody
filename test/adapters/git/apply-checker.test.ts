import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {afterEach, describe, expect, test} from 'vitest';

import {buildDemoFixture} from '../../../scripts/build-demo-fixture.js';
import {materializePatchFiles} from '../../../src/adapters/git/apply-checker.js';
import {decodeUtf8, runGit} from '../../../src/adapters/git/git-process.js';
import {FullGitShaSchema, RepoPathSchema} from '../../../src/contracts/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(async directory =>
		rm(directory, {recursive: true, force: true})));
});

describe('materializePatchFiles', () => {
	test('reads patched blobs from a temporary index without changing the worktree', async () => {
		const repositoryRoot = await mkdtemp(path.join(tmpdir(), 'antibody-materialize-'));
		temporaryDirectories.push(repositoryRoot);
		await buildDemoFixture(repositoryRoot);
		const patch = await readFile('fixtures/demo-history/recovered-test.diff', 'utf8');
		const files = await materializePatchFiles(
			repositoryRoot,
			patch,
			FullGitShaSchema.parse('1bcd48e2eba3a5ed823460b6763c90f49efca6b3'),
			[RepoPathSchema.parse('test/slug.test.js')],
		);

		expect(files).toHaveLength(1);
		expect(new TextDecoder().decode(files[0]?.content)).toContain(
			"test('collapses repeated whitespace'",
		);
		const status = await runGit(repositoryRoot, ['status', '--porcelain=v1', '-z']);
		expect(decodeUtf8(status.stdout)).toBe('');
	});
});
