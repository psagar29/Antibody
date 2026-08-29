import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import ignore, {type Ignore} from 'ignore';

import type {ConfigV1, RecoveryCandidateV1, RepoPath, Sha256} from '../../contracts/index.js';
import {RecoveryCandidateSchema, RepoPathSchema, Sha256Schema} from '../../contracts/index.js';
import type {GitCommandRunner} from '../../adapters/git/command.js';
import {SpawnGitCommandRunner} from '../../adapters/git/command.js';

export interface PatchPolicyViolation {
  readonly code: string;
  readonly path?: RepoPath;
  readonly detail: string;
}

export interface PatchPolicyResult {
  readonly testOnly: boolean;
  readonly patchSha256: Sha256;
  readonly sizeBytes: number;
  readonly normalizedPatch: string;
  readonly changedPaths: readonly RepoPath[];
  readonly allowedGlobs: readonly string[];
  readonly violations: readonly PatchPolicyViolation[];
}

export interface PatchApplicabilityChecker {
  check(options: {
    readonly repositoryPath: string;
    readonly checkoutSha: string;
    readonly patch: string;
    readonly signal?: AbortSignal;
  }): Promise<boolean>;
}

export interface EvaluatePatchOptions {
  readonly repositoryPath: string;
  readonly candidate: RecoveryCandidateV1;
  readonly patchBytes: Buffer;
  readonly policy: ConfigV1['policy'];
  readonly testGlobs: readonly string[];
  readonly allowedSupportGlobs: readonly string[];
  readonly signal?: AbortSignal;
}

interface ParsedFilePatch {
  readonly oldPath?: string;
  readonly newPath?: string;
  readonly path: string;
  readonly addedLines: number;
  readonly violations: readonly {code: string; detail: string}[];
}

export class GitPatchApplicabilityChecker implements PatchApplicabilityChecker {
  readonly #git: GitCommandRunner;

  constructor(git: GitCommandRunner = new SpawnGitCommandRunner()) {
    this.#git = git;
  }

  async check(options: {
    readonly repositoryPath: string;
    readonly checkoutSha: string;
    readonly patch: string;
    readonly signal?: AbortSignal;
  }): Promise<boolean> {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'antibody-patch-check-'));
    const worktreePath = join(temporaryDirectory, 'worktree');
    const patchPath = join(temporaryDirectory, 'candidate.patch');
    let worktreeCreated = false;
    try {
      await mkdir(worktreePath);
      await writeFile(patchPath, options.patch, {encoding: 'utf8', mode: 0o600});
      await this.#run(options.repositoryPath, ['worktree', 'add', '--detach', worktreePath, options.checkoutSha], options.signal);
      worktreeCreated = true;
      await this.#run(worktreePath, ['apply', '--check', '--recount', '--whitespace=nowarn', patchPath], options.signal);
      return true;
    } catch {
      return false;
    } finally {
      if (worktreeCreated) {
        try {
          await this.#run(options.repositoryPath, ['worktree', 'remove', '--force', worktreePath], undefined);
        } catch {
          // A stale temporary worktree is pruned by the next repository maintenance operation.
        }
      }
      await rm(temporaryDirectory, {recursive: true, force: true});
    }
  }

  async #run(
    repositoryPath: string,
    argv: readonly [string, ...string[]],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    await this.#git.run({
      repositoryPath,
      argv,
      ...(signal === undefined ? {} : {signal}),
    });
  }
}

export async function evaluateTestPatch(
  options: EvaluatePatchOptions,
  applicability: PatchApplicabilityChecker = new GitPatchApplicabilityChecker(),
): Promise<PatchPolicyResult> {
  const candidate = RecoveryCandidateSchema.parse(options.candidate);
  const allowedGlobs = [...options.testGlobs, ...options.allowedSupportGlobs];
  const violations: PatchPolicyViolation[] = [];
  let patch = '';
  try {
    patch = new TextDecoder('utf-8', {fatal: true}).decode(options.patchBytes);
  } catch {
    violations.push({code: 'PATCH_UTF8', detail: 'Patch is not valid UTF-8 text'});
  }
  const normalizedPatch = patch.replaceAll('\r\n', '\n');
  if (normalizedPatch.includes('\r')) {
    violations.push({code: 'PATCH_LINE_ENDINGS', detail: 'Patch contains unsupported lone carriage returns'});
  }
  const sizeBytes = Buffer.byteLength(normalizedPatch, 'utf8');
  if (sizeBytes === 0) violations.push({code: 'PATCH_EMPTY', detail: 'Patch is empty'});
  if (sizeBytes > options.policy.maxPatchBytes) {
    violations.push({code: 'PATCH_BYTES', detail: 'Patch exceeds the configured byte limit'});
  }
  const parsedFiles = parseUnifiedDiff(normalizedPatch);
  if (parsedFiles.length === 0 && sizeBytes > 0) {
    violations.push({code: 'PATCH_FORMAT', detail: 'Patch contains no parseable file diff'});
  }
  if (parsedFiles.length > options.policy.maxPatchFiles) {
    violations.push({code: 'PATCH_FILES', detail: 'Patch exceeds the configured file limit'});
  }
  const addedLines = parsedFiles.reduce((sum, file) => sum + file.addedLines, 0);
  if (addedLines > options.policy.maxAddedLines) {
    violations.push({code: 'PATCH_ADDED_LINES', detail: 'Patch exceeds the configured added-line limit'});
  }

  const testMatcher = createMatcher(options.testGlobs);
  const allowedMatcher = createMatcher(allowedGlobs);
  const changedPaths: RepoPath[] = [];
  let executableTestChanged = false;
  for (const file of parsedFiles) {
    const parsedPath = RepoPathSchema.safeParse(file.path);
    if (!parsedPath.success) {
      violations.push({code: 'PATCH_PATH', detail: 'Patch contains an unsafe repository path'});
      continue;
    }
    const path = parsedPath.data;
    changedPaths.push(path);
    if (path.startsWith('.github/workflows/')) {
      violations.push({code: 'PATCH_WORKFLOW', path, detail: 'Workflow changes are always forbidden'});
    }
    if (!allowedMatcher.ignores(path)) {
      violations.push({code: 'PATCH_NOT_TEST_ONLY', path, detail: 'Path is outside configured test and support globs'});
    }
    if (testMatcher.ignores(path) && file.addedLines > 0) executableTestChanged = true;
    for (const violation of file.violations) {
      violations.push({code: violation.code, path, detail: violation.detail});
    }
  }
  if (!executableTestChanged) {
    violations.push({code: 'PATCH_NO_TEST', detail: 'Patch does not add or modify an executable test'});
  }

  if (violations.length === 0) {
    for (const [lane, checkoutSha] of [
      ['parent', candidate.parentSha],
      ['fix', candidate.fixSha],
      ['head', candidate.headSha],
    ] as const) {
      const applicable = await applicability.check({
        repositoryPath: options.repositoryPath,
        checkoutSha,
        patch: normalizedPatch,
        ...(options.signal === undefined ? {} : {signal: options.signal}),
      });
      if (!applicable) {
        violations.push({
          code: `PATCH_APPLY_${lane.toUpperCase()}`,
          detail: `Patch does not apply cleanly to the captured ${lane} revision`,
        });
      }
    }
  }

  return {
    testOnly: violations.length === 0,
    patchSha256: Sha256Schema.parse(sha256(normalizedPatch)),
    sizeBytes,
    normalizedPatch,
    changedPaths: [...new Set(changedPaths)],
    allowedGlobs,
    violations,
  };
}

function parseUnifiedDiff(patch: string): ParsedFilePatch[] {
  const lines = patch.split('\n');
  const files: ParsedFilePatch[] = [];
  let currentLines: string[] | undefined;
  const flush = (): void => {
    if (currentLines === undefined) return;
    const parsed = parseFilePatch(currentLines);
    if (parsed !== undefined) files.push(parsed);
  };
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      currentLines = [line];
    } else if (currentLines !== undefined) {
      currentLines.push(line);
    }
  }
  flush();
  return files;
}

function parseFilePatch(lines: readonly string[]): ParsedFilePatch | undefined {
  const header = lines[0];
  if (header === undefined) return undefined;
  const separatorIndex = header.indexOf(' b/', 'diff --git a/'.length);
  if (!header.startsWith('diff --git a/') || separatorIndex < 0) return undefined;
  const headerOldPath = header.slice('diff --git a/'.length, separatorIndex);
  const headerNewPath = header.slice(separatorIndex + 3);
  let oldPath: string | undefined = headerOldPath;
  let newPath: string | undefined = headerNewPath;
  let addedLines = 0;
  const violations: {code: string; detail: string}[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith('--- ')) oldPath = parseMarkerPath(line.slice(4), 'a/');
    if (line.startsWith('+++ ')) newPath = parseMarkerPath(line.slice(4), 'b/');
    if (line.startsWith('+') && !line.startsWith('+++')) addedLines += 1;
    if (
      ['rename from ', 'rename to ', 'copy from ', 'copy to ', 'similarity index '].some(
        (prefix) => line.startsWith(prefix),
      )
    ) {
      violations.push({code: 'PATCH_RENAME_COPY', detail: 'Rename and copy patches are forbidden'});
    }
    if (line.startsWith('GIT binary patch') || line.startsWith('Binary files ')) {
      violations.push({code: 'PATCH_BINARY', detail: 'Binary patches are forbidden'});
    }
    if (line.startsWith('deleted file mode ') || newPath === undefined) {
      violations.push({code: 'PATCH_DELETE', detail: 'Deleting tests or support files is forbidden'});
    }
    const modeMatch = /^(?:old mode|new mode|new file mode|deleted file mode) (\d{6})$/u.exec(line);
    if (modeMatch !== null && modeMatch[1] !== '100644') {
      violations.push({code: 'PATCH_MODE', detail: 'Only regular non-executable file mode 100644 is allowed'});
    }
    const indexMode = /^index [0-9a-f]+\.\.[0-9a-f]+ (\d{6})$/u.exec(line);
    if (indexMode !== null && indexMode[1] !== '100644') {
      violations.push({code: 'PATCH_MODE', detail: 'Executable, symlink, and gitlink modes are forbidden'});
    }
  }
  if (oldPath !== undefined && newPath !== undefined && oldPath !== newPath) {
    violations.push({code: 'PATCH_RENAME_COPY', detail: 'Old and new paths differ'});
  }
  const path = newPath ?? oldPath ?? headerNewPath;
  return {
    ...(oldPath === undefined ? {} : {oldPath}),
    ...(newPath === undefined ? {} : {newPath}),
    path,
    addedLines,
    violations,
  };
}

function parseMarkerPath(value: string, prefix: string): string | undefined {
  if (value === '/dev/null') return undefined;
  if (!value.startsWith(prefix) || value.startsWith('"')) return value;
  return value.slice(prefix.length);
}

function createMatcher(patterns: readonly string[]): Ignore {
  return ignore({allowRelativePaths: true}).add(patterns);
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
