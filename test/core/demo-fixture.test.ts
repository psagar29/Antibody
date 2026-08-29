import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {afterEach, describe, expect, test} from 'vitest';
import {z} from 'zod';

import {buildDemoFixture} from '../../scripts/build-demo-fixture.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

const ExpectedFixtureSchema = z
	.object({
		schemaVersion: z.literal('antibody.demo-history/v1'),
		baseSha: z.string().regex(/^[0-9a-f]{40}$/u),
		docsSha: z.string().regex(/^[0-9a-f]{40}$/u),
		fixSha: z.string().regex(/^[0-9a-f]{40}$/u),
		headSha: z.string().regex(/^[0-9a-f]{40}$/u),
		candidateOrder: z.array(z.string().regex(/^[0-9a-f]{40}$/u)),
		patchSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
		normalizedParentSignature: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
		verdict: z.literal('verified'),
	})
	.strict();

async function makeTemporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

async function run(
	command: string,
	argv: readonly string[],
	workingDirectory: string,
): Promise<Readonly<{exitCode: number; stdout: string; stderr: string}>> {
	try {
		const result = await execFileAsync(command, argv, {
			cwd: workingDirectory,
			encoding: 'utf8',
			maxBuffer: 1_048_576,
			windowsHide: true,
		});
		return {exitCode: 0, stdout: result.stdout, stderr: result.stderr};
	} catch (error: unknown) {
		if (
			typeof error === 'object'
			&& error !== null
			&& 'code' in error
			&& typeof error.code === 'number'
			&& 'stdout' in error
			&& typeof error.stdout === 'string'
			&& 'stderr' in error
			&& typeof error.stderr === 'string'
		) {
			return {
				exitCode: error.code,
				stdout: error.stdout,
				stderr: error.stderr,
			};
		}

		throw error;
	}
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async directory =>
			rm(directory, {recursive: true, force: true}),
		),
	);
});

describe('deterministic demo history', () => {
	test('reproduces exact commits and the historical red/green behavior', async () => {
		const repository = await makeTemporaryDirectory('antibody-demo-repository-');
		const fixtureRoot = path.resolve('fixtures/demo-history');
		const expected = ExpectedFixtureSchema.parse(
			JSON.parse(await readFile(path.join(fixtureRoot, 'expected.json'), 'utf8')),
		);
		const patchPath = path.join(fixtureRoot, 'recovered-test.diff');
		const patchBytes = await readFile(patchPath);

		await expect(buildDemoFixture(repository)).resolves.toBe(expected.headSha);
		const history = await run(
			'git',
			['log', '--reverse', '--format=%H'],
			repository,
		);
		expect(history.exitCode).toBe(0);
		expect(history.stdout.trim().split(/\r?\n/u)).toEqual([
			expected.baseSha,
			expected.docsSha,
			expected.fixSha,
			expected.headSha,
		]);
		expect(`sha256:${createHash('sha256').update(patchBytes).digest('hex')}`).toBe(
			expected.patchSha256,
		);

		const lanes = [
			{label: 'parent', sha: expected.docsSha, expectedExitCode: 1},
			{label: 'fix', sha: expected.fixSha, expectedExitCode: 0},
			{label: 'head', sha: expected.headSha, expectedExitCode: 0},
		];
		for (const lane of lanes) {
			const checkout = await makeTemporaryDirectory(`antibody-demo-${lane.label}-`);
			await rm(checkout, {recursive: true});
			const worktree = await run(
				'git',
				['worktree', 'add', '--detach', checkout, lane.sha],
				repository,
			);
			expect(worktree.exitCode).toBe(0);
			expect((await run('git', ['apply', '--check', patchPath], checkout)).exitCode).toBe(0);
			expect((await run('git', ['apply', patchPath], checkout)).exitCode).toBe(0);

			const first = await run(
				process.execPath,
				['--test', '--test-reporter=tap', 'test/slug.test.js'],
				checkout,
			);
			expect(first.exitCode).toBe(lane.expectedExitCode);
			if (lane.label === 'parent') {
				const second = await run(
					process.execPath,
					['--test', '--test-reporter=tap', 'test/slug.test.js'],
					checkout,
				);
				expect(second.exitCode).toBe(1);
				expect(first.stdout).toContain('collapses repeated whitespace');
				expect(second.stdout).toContain("operator: 'strictEqual'");
			}
		}
	}, 20_000);

	test('refuses to overwrite a non-empty target', async () => {
		const repository = await makeTemporaryDirectory('antibody-demo-non-empty-');
		await buildDemoFixture(repository);
		await expect(buildDemoFixture(repository)).rejects.toThrow(
			'Demo fixture target must be an empty directory',
		);
	});
});
