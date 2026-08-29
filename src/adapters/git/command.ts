import {spawn} from 'node:child_process';

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface GitCommandRequest {
  readonly repositoryPath: string;
  readonly argv: readonly [string, ...string[]];
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

export interface GitCommandResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export interface GitCommandRunner {
  run(request: GitCommandRequest): Promise<GitCommandResult>;
}

export class SpawnGitCommandRunner implements GitCommandRunner {
  async run(request: GitCommandRequest): Promise<GitCommandResult> {
    const maxOutputBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    return await new Promise<GitCommandResult>((resolve, reject) => {
      const child = spawn('git', request.argv, {
        cwd: request.repositoryPath,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;

      const finishWithError = (error: Error): void => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(error);
      };
      const onAbort = (): void => {
        finishWithError(new Error('Git command aborted'));
      };
      request.signal?.addEventListener('abort', onAbort, {once: true});

      const collect = (target: Buffer[]) => (chunk: Buffer): void => {
        outputBytes += chunk.byteLength;
        if (outputBytes > maxOutputBytes) {
          finishWithError(new Error('Git command output exceeded the configured byte limit'));
          return;
        }
        target.push(chunk);
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.once('error', finishWithError);
      child.once('close', (code, signal) => {
        request.signal?.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        const stdoutBuffer = Buffer.concat(stdout);
        const stderrBuffer = Buffer.concat(stderr);
        if (code !== 0) {
          const safeError = stderrBuffer.toString('utf8').slice(0, 4096);
          reject(
            new Error(
              `git ${request.argv[0]} failed (${code === null ? signal ?? 'unknown' : String(code)}): ${safeError}`,
            ),
          );
          return;
        }
        resolve({stdout: stdoutBuffer, stderr: stderrBuffer});
      });
    });
  }
}
