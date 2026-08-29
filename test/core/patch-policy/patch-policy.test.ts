import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {afterEach, describe, expect, test} from 'vitest';

import {buildDemoFixture} from '../../../scripts/build-demo-fixture.js';
import {TestOnlyPatchPolicy} from '../../../src/core/patch-policy/patch-policy.js';

const commits = {
	parent: '66e82fb6b511eccffc879042c61bf45100067881',
	fix: 'e2398bf45efca03a24dbb9101a52cf1c70ea0fe0',
	head: '1bcd48e2eba3a5ed823460b6763c90f49efca6b3',
} as const;
const temporaryDirectories: string[] = [];

const defaultPolicy = {
	maxPatchBytes: 100_000,
	maxPatchFiles: 3,
	maxAddedLines: 30,
	forbidBinary: true,
	forbidSymlinks: true,
	forbidSubmodules: true,
	requireCurrentHeadPass: true,
} as const;

function request(
	patch: string,
	overrides: Readonly<{
		repositoryRoot?: string;
		maxPatchBytes?: number;
		maxPatchFiles?: number;
		maxAddedLines?: number;
	}> = {},
) {
	return {
		repositoryRoot: overrides.repositoryRoot ?? process.cwd(),
		patch,
		commits,
		testGlobs: ['test/**', 'tests/**', '**/*.test.js'],
		allowedSupportGlobs: ['test/**', 'tests/**', '**/__fixtures__/**'],
		policy: {
			...defaultPolicy,
			...(overrides.maxPatchBytes === undefined
				? {}
				: {maxPatchBytes: overrides.maxPatchBytes}),
			...(overrides.maxPatchFiles === undefined
				? {}
				: {maxPatchFiles: overrides.maxPatchFiles}),
			...(overrides.maxAddedLines === undefined
				? {}
				: {maxAddedLines: overrides.maxAddedLines}),
		},
	};
}

function addedTestPatch(repositoryPath = 'test/new.test.js'): string {
	return [
		`diff --git a/${repositoryPath} b/${repositoryPath}`,
		'new file mode 100644',
		'--- /dev/null',
		`+++ b/${repositoryPath}`,
		'@@ -0,0 +1 @@',
		"+test('behavior', () => {});",
		'',
	].join('\n');
}

async function expectReason(
	patch: string,
	reason: string,
	overrides: Parameters<typeof request>[1] = {},
): Promise<void> {
	const result = await new TestOnlyPatchPolicy().evaluate(request(patch, overrides));
	expect(result.accepted).toBe(false);
	if (!result.accepted) {
		expect(result.reasons).toContain(reason);
	}
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async directory =>
			rm(directory, {recursive: true, force: true}),
		),
	);
});

describe('TestOnlyPatchPolicy attack matrix', () => {
	test('accepts the deterministic recovered test on parent, fix, and captured HEAD', async () => {
		const repositoryRoot = await mkdtemp(path.join(tmpdir(), 'antibody-policy-'));
		temporaryDirectories.push(repositoryRoot);
		await buildDemoFixture(repositoryRoot);
		const patch = await readFile('fixtures/demo-history/recovered-test.diff', 'utf8');

		const result = await new TestOnlyPatchPolicy().evaluate(request(patch, {repositoryRoot}));
		expect(result).toMatchObject({
			accepted: true,
			patchSha256: 'sha256:b476eab1b29fcac4afd72fd5b979db87f6ae5ed9fa69c5af284cf5652898dcc3',
			changedPaths: ['test/slug.test.js'],
		});
	});

	test.each([
		['production path', addedTestPatch('src/slug.js'), 'disallowed-path'],
		['dependency path', addedTestPatch('package.json'), 'disallowed-path'],
		['build path', addedTestPatch('dist/generated.test.js'), 'disallowed-path'],
		['workflow path', addedTestPatch('.github/workflows/attack.test.js'), 'workflow-path'],
		['absolute path', addedTestPatch('/tmp/attack.test.js'), 'invalid-unified-diff'],
		['traversal path', addedTestPatch('../attack.test.js'), 'invalid-unified-diff'],
		['backslash path', addedTestPatch('test\\attack.test.js'), 'invalid-unified-diff'],
		['NUL path', addedTestPatch('test/attack\0.test.js'), 'invalid-unified-diff'],
	] as const)('rejects %s', async (_label, patch, reason) => {
		await expectReason(patch, reason);
	});

	test('rejects renames and copies', async () => {
		const rename = [
			'diff --git a/test/old.test.js b/src/new.js',
			'similarity index 100%',
			'rename from test/old.test.js',
			'rename to src/new.js',
			'--- a/test/old.test.js',
			'+++ b/src/new.js',
			"@@ -1 +1 @@\n-test('old', () => {});\n+test('new', () => {});\n",
		].join('\n');
		await expectReason(rename, 'rename-or-copy');
		await expectReason(rename, 'disallowed-path');
	});

	test.each([
		['binary', `${addedTestPatch()}GIT binary patch\n`, 'binary-patch'],
		['symlink', addedTestPatch().replace('new file mode 100644', 'new file mode 120000'), 'special-file-mode'],
		['gitlink', addedTestPatch().replace('new file mode 100644', 'new file mode 160000'), 'special-file-mode'],
		['executable', addedTestPatch().replace('new file mode 100644', 'new file mode 100755'), 'executable-mode'],
	] as const)('rejects %s content or mode', async (_label, patch, reason) => {
		await expectReason(patch, reason);
	});

	test('rejects deletion of an existing test', async () => {
		const deletion = [
			'diff --git a/test/old.test.js b/test/old.test.js',
			'deleted file mode 100644',
			'--- a/test/old.test.js',
			'+++ /dev/null',
			"@@ -1 +0,0 @@\n-test('old', () => {});\n",
		].join('\n');
		await expectReason(deletion, 'deleted-test');
	});

	test('enforces empty, byte, file, line, and executable-test limits', async () => {
		await expectReason('', 'empty-patch');
		await expectReason(addedTestPatch(), 'patch-too-large', {maxPatchBytes: 10});
		await expectReason(
			`${addedTestPatch('test/one.test.js')}${addedTestPatch('test/two.test.js')}`,
			'too-many-files',
			{maxPatchFiles: 1},
		);
		await expectReason(
			addedTestPatch().replace(
				"+test('behavior', () => {});",
				"+test('behavior', () => {});\n+test('another behavior', () => {});",
			),
			'too-many-added-lines',
			{maxAddedLines: 1},
		);
		await expectReason(
			addedTestPatch().replace("test('behavior', () => {});", '// documentation only'),
			'no-executable-test',
		);
	});

	test('rejects a syntactically safe patch that cannot apply to all three trees', async () => {
		const repositoryRoot = await mkdtemp(path.join(tmpdir(), 'antibody-policy-stale-'));
		temporaryDirectories.push(repositoryRoot);
		await buildDemoFixture(repositoryRoot);
		const stalePatch = [
			'diff --git a/test/slug.test.js b/test/slug.test.js',
			'--- a/test/slug.test.js',
			'+++ b/test/slug.test.js',
			'@@ -1 +1,2 @@',
			'-this context never existed',
			'+replacement',
			"+test('behavior', () => {});",
			'',
		].join('\n');
		await expectReason(stalePatch, 'git-apply-parent', {repositoryRoot});
		await expectReason(stalePatch, 'git-apply-fix', {repositoryRoot});
		await expectReason(stalePatch, 'git-apply-head', {repositoryRoot});
	});
});
