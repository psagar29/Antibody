import {createHash} from 'node:crypto';

import ignore, {type Ignore} from 'ignore';

import type {ConfigV1, RecoveryCandidateV1, RepositoryRefV1} from '../../contracts/index.js';
import {RecoveryCandidateSchema, RepositoryRefSchema} from '../../contracts/index.js';
import type {GitCommandRunner} from '../../adapters/git/command.js';
import {SpawnGitCommandRunner} from '../../adapters/git/command.js';
import {rankRecoveryCandidates} from '../ranking/ranker.js';

const fullShaPattern = /^[0-9a-f]{40}$/u;
const safeModePattern = /^100(?:644|755)$/u;
const bugWordPattern = /\b(?:fix|bug|regression|crash|incorrect|error)\b/iu;
const issueReferencePattern = /(?:^|\s)#\d+\b/u;
const branchChangePattern = /^[-+].*\b(?:if|else|throw|catch|error|validat(?:e|ion))\b/imu;

interface CommitHeader {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly authoredAt: string;
  readonly subject: string;
}

interface ChangedFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
  readonly oldMode: string;
  readonly newMode: string;
  readonly status: string;
}

export interface CandidateEnrichment {
  readonly hasBugLabel: boolean;
  readonly evidence?: string;
}

export interface CandidateEnrichmentSource {
  getForCommit(fixSha: string): Promise<CandidateEnrichment | undefined>;
}

export interface GitHistoryMinerOptions {
  readonly repositoryPath: string;
  readonly repository: RepositoryRefV1;
  readonly scan: ConfigV1['scan'];
  readonly signal?: AbortSignal;
}

export class GitHistoryMiner {
  readonly #git: GitCommandRunner;
  readonly #enrichment: CandidateEnrichmentSource | undefined;
  readonly #enrichmentCache = new Map<string, CandidateEnrichment | undefined>();

  constructor(options?: {
    readonly git?: GitCommandRunner;
    readonly enrichment?: CandidateEnrichmentSource;
  }) {
    this.#git = options?.git ?? new SpawnGitCommandRunner();
    this.#enrichment = options?.enrichment;
  }

  async scan(options: GitHistoryMinerOptions): Promise<RecoveryCandidateV1[]> {
    const repository = RepositoryRefSchema.parse(options.repository);
    const headSha = await this.#gitText(options, ['rev-parse', 'HEAD']);
    requireFullSha(headSha, 'HEAD');
    const logArguments: [string, ...string[]] = [
      'log',
      '-z',
      '--format=%H%x00%P%x00%aI%x00%s%x00',
      `--max-count=${String(options.scan.maxCommits)}`,
    ];
    if (options.scan.since !== undefined) logArguments.push(`--since=${options.scan.since}`);
    logArguments.push(headSha);
    const log = await this.#gitBuffer(options, logArguments);
    const headers = parseCommitHeaders(log);
    const candidates: RecoveryCandidateV1[] = [];
    const productionMatcher = createMatcher(options.scan.includeProduction);
    const testMatcher = createMatcher([
      ...options.scan.testGlobs,
      ...options.scan.allowedSupportGlobs,
    ]);
    const excludedMatcher = createMatcher(options.scan.excludeGlobs);

    for (const header of headers) {
      if (header.parents.length !== 1) continue;
      if (!fullShaPattern.test(header.sha) || header.subject.length === 0 || header.subject.length > 512) {
        continue;
      }
      const parentSha = header.parents[0];
      if (parentSha === undefined || !fullShaPattern.test(parentSha)) continue;
      const nameStatus = await this.#gitBuffer(options, [
        'diff',
        '--name-status',
        '-z',
        '-M',
        '-C',
        parentSha,
        header.sha,
        '--',
      ]);
      if (hasRenameOrCopy(nameStatus)) continue;
      const [numstat, raw, diff] = await Promise.all([
        this.#gitBuffer(options, [
          'diff',
          '--numstat',
          '-z',
          '--no-renames',
          parentSha,
          header.sha,
          '--',
        ]),
        this.#gitBuffer(options, [
          'diff',
          '--raw',
          '-z',
          '--no-renames',
          parentSha,
          header.sha,
          '--',
        ]),
        this.#gitBuffer(options, [
          'diff',
          '--binary',
          '--full-index',
          '--no-ext-diff',
          '--no-color',
          parentSha,
          header.sha,
          '--',
        ]),
      ]);
      const changedFiles = mergeChangedFileData(parseNumstat(numstat), parseRawDiff(raw));
      if (
        changedFiles.length === 0 ||
        changedFiles.length > options.scan.maxChangedFiles ||
        changedFiles.some(
          (file) =>
            file.binary ||
            !isSafePath(file.path) ||
            !safeModePattern.test(file.oldMode) ||
            !safeModePattern.test(file.newMode) ||
            excludedMatcher.ignores(file.path),
        )
      ) {
        continue;
      }
      const changedLines = changedFiles.reduce(
        (sum, file) => sum + file.additions + file.deletions,
        0,
      );
      if (changedLines > options.scan.maxChangedLines) continue;
      const changedTestPaths = changedFiles
        .filter((file) => testMatcher.ignores(file.path))
        .map((file) => file.path);
      if (options.scan.requireNoTestChanges && changedTestPaths.length > 0) continue;
      const changedProductionPaths = changedFiles
        .filter((file) => productionMatcher.ignores(file.path))
        .map((file) => file.path);
      if (changedProductionPaths.length === 0) continue;

      const enrichment = await this.#getEnrichment(header.sha);
      const signals = buildSignals({
        subject: header.subject,
        changedLines,
        productionFileCount: changedProductionPaths.length,
        diff: diff.toString('utf8'),
        ...(enrichment === undefined ? {} : {enrichment}),
      });
      const score = Math.max(
        0,
        Math.min(
          100,
          signals.reduce((total, signal) => total + signal.weight, 0),
        ),
      );
      const additions = changedFiles.reduce((sum, file) => sum + file.additions, 0);
      const deletions = changedFiles.reduce((sum, file) => sum + file.deletions, 0);
      const candidate = RecoveryCandidateSchema.parse({
        schemaVersion: 'antibody.candidate/v1',
        candidateId: sha256(`${repository.slug}\u0000${parentSha}\u0000${header.sha}`),
        repository,
        parentSha,
        fixSha: header.sha,
        headSha,
        commit: {
          subject: header.subject,
          authoredAt: new Date(header.authoredAt).toISOString(),
          changedProductionPaths,
          changedTestPaths,
          additions,
          deletions,
          diffSha256: sha256(diff),
        },
        signals,
        score,
      });
      candidates.push(candidate);
    }
    return rankRecoveryCandidates(candidates);
  }

  async #getEnrichment(fixSha: string): Promise<CandidateEnrichment | undefined> {
    if (this.#enrichment === undefined) return undefined;
    if (this.#enrichmentCache.has(fixSha)) return this.#enrichmentCache.get(fixSha);
    let enrichment: CandidateEnrichment | undefined;
    try {
      enrichment = await this.#enrichment.getForCommit(fixSha);
    } catch {
      enrichment = undefined;
    }
    this.#enrichmentCache.set(fixSha, enrichment);
    return enrichment;
  }

  async #gitBuffer(
    options: Pick<GitHistoryMinerOptions, 'repositoryPath' | 'signal'>,
    argv: readonly [string, ...string[]],
  ): Promise<Buffer> {
    const request = {
      repositoryPath: options.repositoryPath,
      argv,
      ...(options.signal === undefined ? {} : {signal: options.signal}),
    };
    return (await this.#git.run(request)).stdout;
  }

  async #gitText(
    options: Pick<GitHistoryMinerOptions, 'repositoryPath' | 'signal'>,
    argv: readonly [string, ...string[]],
  ): Promise<string> {
    return (await this.#gitBuffer(options, argv)).toString('utf8').trim();
  }
}

function createMatcher(patterns: readonly string[]): Ignore {
  return ignore({allowRelativePaths: true}).add(patterns);
}

function parseCommitHeaders(buffer: Buffer): CommitHeader[] {
  const records = buffer.toString('utf8').split('\u0000\u0000').filter(Boolean);
  const headers: CommitHeader[] = [];
  for (const record of records) {
    const withoutLeadingSeparator = record.startsWith('\u0000') ? record.slice(1) : record;
    const normalized = withoutLeadingSeparator.endsWith('\u0000')
      ? withoutLeadingSeparator.slice(0, -1)
      : withoutLeadingSeparator;
    const fields = normalized.split('\u0000');
    if (fields.length !== 4) continue;
    const [sha, parentsText, authoredAt, subject] = fields;
    if (sha === undefined || parentsText === undefined || authoredAt === undefined || subject === undefined) {
      continue;
    }
    headers.push({
      sha,
      parents: parentsText === '' ? [] : parentsText.split(' '),
      authoredAt,
      subject,
    });
  }
  return headers;
}

function parseNumstat(buffer: Buffer): Map<string, Pick<ChangedFile, 'additions' | 'deletions' | 'binary'>> {
  const result = new Map<string, Pick<ChangedFile, 'additions' | 'deletions' | 'binary'>>();
  for (const record of buffer.toString('utf8').split('\u0000').filter(Boolean)) {
    const [additionsText, deletionsText, path] = record.split('\t');
    if (additionsText === undefined || deletionsText === undefined || path === undefined) continue;
    const binary = additionsText === '-' || deletionsText === '-';
    result.set(path, {
      additions: binary ? 0 : Number.parseInt(additionsText, 10),
      deletions: binary ? 0 : Number.parseInt(deletionsText, 10),
      binary,
    });
  }
  return result;
}

function parseRawDiff(buffer: Buffer): Map<string, Pick<ChangedFile, 'oldMode' | 'newMode' | 'status'>> {
  const fields = buffer.toString('utf8').split('\u0000').filter(Boolean);
  const result = new Map<string, Pick<ChangedFile, 'oldMode' | 'newMode' | 'status'>>();
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const metadata = fields[index];
    const path = fields[index + 1];
    if (metadata === undefined || path === undefined) continue;
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])(?:\d+)?$/u.exec(metadata);
    if (match === null) continue;
    const oldMode = match[1];
    const newMode = match[2];
    const status = match[3];
    if (oldMode === undefined || newMode === undefined || status === undefined) continue;
    result.set(path, {oldMode, newMode, status});
  }
  return result;
}

function mergeChangedFileData(
  numstat: ReadonlyMap<string, Pick<ChangedFile, 'additions' | 'deletions' | 'binary'>>,
  raw: ReadonlyMap<string, Pick<ChangedFile, 'oldMode' | 'newMode' | 'status'>>,
): ChangedFile[] {
  const result: ChangedFile[] = [];
  for (const [path, statistics] of numstat) {
    const rawEntry = raw.get(path);
    if (rawEntry === undefined) continue;
    result.push({path, ...statistics, ...rawEntry});
  }
  return result;
}

function hasRenameOrCopy(buffer: Buffer): boolean {
  const fields = buffer.toString('utf8').split('\u0000').filter(Boolean);
  return fields.some((field) => /^[RC]\d*$/u.test(field));
}

function isSafePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 4096 &&
    !path.startsWith('/') &&
    !/^[A-Za-z]:/u.test(path) &&
    !path.includes('\\') &&
    !path.includes('\u0000') &&
    !path.split('/').includes('..') &&
    !path.includes('//') &&
    !path.endsWith('/')
  );
}

function buildSignals(options: {
  readonly subject: string;
  readonly changedLines: number;
  readonly productionFileCount: number;
  readonly diff: string;
  readonly enrichment?: CandidateEnrichment;
}): {code: string; weight: number; evidence: string}[] {
  const signals: {code: string; weight: number; evidence: string}[] = [];
  if (bugWordPattern.test(options.subject)) {
    signals.push({code: 'BUG_WORD', weight: 35, evidence: 'Commit subject contains a bug-fix word'});
  }
  if (options.enrichment?.hasBugLabel === true) {
    signals.push({
      code: 'BUG_LABEL',
      weight: 20,
      evidence: options.enrichment.evidence ?? 'Linked issue or pull request has a bug label',
    });
  }
  if (options.changedLines <= 100) {
    signals.push({code: 'SMALL_DIFF', weight: 15, evidence: 'Diff changes at most 100 lines'});
  }
  if (options.productionFileCount >= 1 && options.productionFileCount <= 3) {
    signals.push({code: 'FOCUSED_FILES', weight: 10, evidence: 'Diff changes one to three production files'});
  }
  if (branchChangePattern.test(options.diff)) {
    signals.push({code: 'BRANCH_CHANGE', weight: 10, evidence: 'Diff changes conditional, error, or validation behavior'});
  }
  if (issueReferencePattern.test(options.subject)) {
    signals.push({code: 'ISSUE_REFERENCE', weight: 5, evidence: 'Commit subject references an issue'});
  }
  signals.push({code: 'PRESENT_AT_HEAD', weight: 5, evidence: 'Commit is reachable from captured HEAD'});
  return signals;
}

function sha256(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function requireFullSha(value: string, label: string): void {
  if (!fullShaPattern.test(value)) throw new Error(`${label} is not a full lowercase Git SHA`);
}
