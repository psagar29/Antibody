import {spawn} from 'node:child_process';

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1_048_576;

export type GitProcessResult = Readonly<{
	stdout: Buffer;
	stderr: Buffer;
}>;

export async function runGit(
	repositoryRoot: string,
	argv: readonly string[],
	options: Readonly<{
		maxOutputBytes?: number;
		environment?: Readonly<Record<string, string>>;
	}> = {},
): Promise<GitProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn('git', argv, {
			cwd: repositoryRoot,
			env: options.environment === undefined
				? process.env
				: {...process.env, ...options.environment},
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const maximum = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
		let bytes = 0;
		let exceeded = false;

		const collect = (destination: Buffer[], chunk: Buffer): void => {
			bytes += chunk.byteLength;
			if (bytes > maximum) {
				exceeded = true;
				child.kill();
				return;
			}

			destination.push(chunk);
		};

		child.stdout.on('data', (chunk: Buffer) => {
			collect(stdout, chunk);
		});
		child.stderr.on('data', (chunk: Buffer) => {
			collect(stderr, chunk);
		});
		child.once('error', reject);
		child.once('close', exitCode => {
			if (exceeded) {
				reject(new Error(`git ${argv[0] ?? '<missing>'} exceeded ${String(maximum)} output bytes`));
				return;
			}

			const stdoutBuffer = Buffer.concat(stdout);
			const stderrBuffer = Buffer.concat(stderr);
			if (exitCode !== 0) {
				const termination = exitCode === null ? 'signal' : String(exitCode);
				const detail = decodeUtf8(stderrBuffer).slice(0, 4096);
				reject(new Error(`git ${argv[0] ?? '<missing>'} failed (${termination}): ${detail}`));
				return;
			}

			resolve({stdout: stdoutBuffer, stderr: stderrBuffer});
		});
	});
}

export function decodeUtf8(value: Uint8Array): string {
	return new TextDecoder('utf-8', {fatal: true}).decode(value);
}

export function splitNull(value: Uint8Array): string[] {
	const decoded = decodeUtf8(value);
	const fields = decoded.split('\0');
	if (fields.at(-1) === '') {
		fields.pop();
	}

	return fields;
}
