import {spawn} from 'node:child_process';
import {readFile, readdir, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const MAX_GIT_OUTPUT_BYTES = 1_048_576;

type GitResult = Readonly<{
	stdout: string;
	stderr: string;
}>;

async function runGit(
	workingDirectory: string,
	argv: readonly string[],
	input?: Uint8Array,
): Promise<GitResult> {
	return new Promise((resolve, reject) => {
		const child = spawn('git', argv, {
			cwd: workingDirectory,
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
		});
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let outputBytes = 0;

		const collect = (chunks: Buffer[], chunk: Buffer): void => {
			outputBytes += chunk.byteLength;
			if (outputBytes > MAX_GIT_OUTPUT_BYTES) {
				child.kill();
				reject(new Error('Git output exceeded the fixture builder limit'));
				return;
			}

			chunks.push(chunk);
		};

		child.stdout.on('data', (chunk: Buffer) => {
			collect(stdoutChunks, chunk);
		});
		child.stderr.on('data', (chunk: Buffer) => {
			collect(stderrChunks, chunk);
		});
		child.once('error', reject);
		child.once('close', exitCode => {
			const stdout = Buffer.concat(stdoutChunks).toString('utf8');
			const stderr = Buffer.concat(stderrChunks).toString('utf8');
			if (exitCode !== 0) {
				const termination = exitCode === null ? 'signal' : String(exitCode);
				reject(new Error(`git ${argv[0] ?? '<missing>'} failed (${termination}): ${stderr}`));
				return;
			}

			resolve({stdout, stderr});
		});

		if (input === undefined) {
			child.stdin.end();
		} else {
			child.stdin.end(input);
		}
	});
}

export async function buildDemoFixture(targetDirectory: string): Promise<string> {
	const resolvedTarget = path.resolve(targetDirectory);
	await mkdir(resolvedTarget, {recursive: true});
	const existingEntries = await readdir(resolvedTarget);
	if (existingEntries.length > 0) {
		throw new Error('Demo fixture target must be an empty directory');
	}

	await runGit(resolvedTarget, ['init', '--initial-branch=main']);
	const fixtureDirectory = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		'../fixtures/demo-history',
	);
	const stream = await readFile(path.join(fixtureDirectory, 'history.fi'));
	await runGit(resolvedTarget, ['fast-import', '--quiet'], stream);
	await runGit(resolvedTarget, ['reset', '--hard', 'refs/heads/main']);
	const result = await runGit(resolvedTarget, ['rev-parse', '--verify', 'HEAD']);
	return result.stdout.trim();
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
	const target = process.argv[2];
	if (target === undefined) {
		throw new Error('Usage: build-demo-fixture.ts <empty-directory>');
	}

	const head = await buildDemoFixture(target);
	process.stdout.write(`${head}\n`);
}
