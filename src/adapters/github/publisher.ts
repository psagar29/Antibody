import {createHash} from 'node:crypto';

import type {Octokit, RestEndpointMethodTypes} from '@octokit/rest';

import type {PublicationRecordV1, ReceiptV1, RepoPath, Sha256} from '../../contracts/index.js';
import {
  AntibodyError,
  FullGitShaSchema,
  PublicationRecordSchema,
  ReceiptSchema,
  RepoPathSchema,
  Sha256Schema,
} from '../../contracts/index.js';
import {Redactor, receiptDigest} from '../../core/receipts/receipt-store.js';
import {materializeUnifiedDiff} from '../../core/policy/materialize-patch.js';

type GetRefParameters = RestEndpointMethodTypes['git']['getRef']['parameters'];
type GetCommitParameters = RestEndpointMethodTypes['git']['getCommit']['parameters'];
type CreateBlobParameters = RestEndpointMethodTypes['git']['createBlob']['parameters'];
type CreateTreeParameters = RestEndpointMethodTypes['git']['createTree']['parameters'];
type CreateCommitParameters = RestEndpointMethodTypes['git']['createCommit']['parameters'];
type CreateRefParameters = RestEndpointMethodTypes['git']['createRef']['parameters'];
type UpdateRefParameters = RestEndpointMethodTypes['git']['updateRef']['parameters'];
type ListPullsParameters = RestEndpointMethodTypes['pulls']['list']['parameters'];
type CreatePullParameters = RestEndpointMethodTypes['pulls']['create']['parameters'];
type AddLabelsParameters = RestEndpointMethodTypes['issues']['addLabels']['parameters'];
type GetContentParameters = RestEndpointMethodTypes['repos']['getContent']['parameters'];

interface ReferenceView {
  readonly sha: string;
}

interface CommitView {
  readonly sha: string;
  readonly treeSha: string;
}

interface PullView {
  readonly number: number;
  readonly htmlUrl: string;
  readonly body: string | null;
  readonly draft: boolean | null;
  readonly headRef: string;
  readonly headSha: string;
  readonly createdAt: string;
}

interface GitHubControl {
  getRef(parameters: GetRefParameters): Promise<ReferenceView>;
  getCommit(parameters: GetCommitParameters): Promise<CommitView>;
  getFile(parameters: GetContentParameters): Promise<Buffer | undefined>;
  createBlob(parameters: CreateBlobParameters): Promise<{readonly sha: string}>;
  createTree(parameters: CreateTreeParameters): Promise<{readonly sha: string}>;
  createCommit(parameters: CreateCommitParameters): Promise<{readonly sha: string}>;
  createRef(parameters: CreateRefParameters): Promise<ReferenceView>;
  updateRef(parameters: UpdateRefParameters): Promise<ReferenceView>;
  listPulls(parameters: ListPullsParameters): Promise<readonly PullView[]>;
  createPull(parameters: CreatePullParameters): Promise<PullView>;
  addLabels(parameters: AddLabelsParameters): Promise<void>;
}

class OctokitGitHubControl implements GitHubControl {
  readonly #octokit: Octokit;

  constructor(octokit: Octokit) {
    this.#octokit = octokit;
  }

  async getRef(parameters: GetRefParameters): Promise<ReferenceView> {
    const response = await this.#octokit.rest.git.getRef(parameters);
    return {sha: response.data.object.sha};
  }

  async getCommit(parameters: GetCommitParameters): Promise<CommitView> {
    const response = await this.#octokit.rest.git.getCommit(parameters);
    return {sha: response.data.sha, treeSha: response.data.tree.sha};
  }

  async getFile(parameters: GetContentParameters): Promise<Buffer | undefined> {
    try {
      const response = await this.#octokit.rest.repos.getContent(parameters);
      const data = response.data;
      if (
        Array.isArray(data) ||
        data.type !== 'file' ||
        data.encoding !== 'base64' ||
        typeof data.content !== 'string'
      ) {
        throw publicationError('GitHub base path is not a regular file', 'ANTB_PUBLISH_CONFLICT');
      }
      return Buffer.from(data.content.replaceAll('\n', ''), 'base64');
    } catch (error: unknown) {
      if (httpStatus(error) === 404) return undefined;
      throw error;
    }
  }

  async createBlob(parameters: CreateBlobParameters): Promise<{readonly sha: string}> {
    const response = await this.#octokit.rest.git.createBlob(parameters);
    return {sha: response.data.sha};
  }

  async createTree(parameters: CreateTreeParameters): Promise<{readonly sha: string}> {
    const response = await this.#octokit.rest.git.createTree(parameters);
    return {sha: response.data.sha};
  }

  async createCommit(parameters: CreateCommitParameters): Promise<{readonly sha: string}> {
    const response = await this.#octokit.rest.git.createCommit(parameters);
    return {sha: response.data.sha};
  }

  async createRef(parameters: CreateRefParameters): Promise<ReferenceView> {
    const response = await this.#octokit.rest.git.createRef(parameters);
    return {sha: response.data.object.sha};
  }

  async updateRef(parameters: UpdateRefParameters): Promise<ReferenceView> {
    const response = await this.#octokit.rest.git.updateRef(parameters);
    return {sha: response.data.object.sha};
  }

  async listPulls(parameters: ListPullsParameters): Promise<readonly PullView[]> {
    const pulls = await this.#octokit.paginate(this.#octokit.rest.pulls.list, parameters);
    return pulls.map((pull) => ({
      number: pull.number,
      htmlUrl: pull.html_url,
      body: pull.body,
      draft: pull.draft ?? null,
      headRef: pull.head.ref,
      headSha: pull.head.sha,
      createdAt: pull.created_at,
    }));
  }

  async createPull(parameters: CreatePullParameters): Promise<PullView> {
    const response = await this.#octokit.rest.pulls.create(parameters);
    return {
      number: response.data.number,
      htmlUrl: response.data.html_url,
      body: response.data.body,
      draft: response.data.draft ?? null,
      headRef: response.data.head.ref,
      headSha: response.data.head.sha,
      createdAt: response.data.created_at,
    };
  }

  async addLabels(parameters: AddLabelsParameters): Promise<void> {
    await this.#octokit.rest.issues.addLabels(parameters);
  }
}

export interface PublicationFile {
  readonly path: RepoPath;
  readonly contentBase64: string;
}

export interface PublishOptions {
  readonly receipt: ReceiptV1;
  readonly approval: string;
  readonly normalizedPatch: string;
  /** Optional defense-in-depth assertion; omitted files are materialized from the approved patch. */
  readonly files?: readonly PublicationFile[];
  readonly baseBranch: string;
  readonly branchPrefix: string;
  readonly labels: readonly string[];
}

export class GitHubDraftPublisher {
  readonly #control: GitHubControl;

  constructor(control: GitHubControl) {
    this.#control = control;
  }

  async publish(options: PublishOptions): Promise<PublicationRecordV1> {
    const receipt = ReceiptSchema.parse(options.receipt);
    const digest = receiptDigest(receipt);
    if (receipt.verdict !== 'verified' || !receipt.policy.testOnly || receipt.policy.violations.length > 0) {
      throw publicationError('Only a verified test-only receipt can be published', 'ANTB_PUBLISH_APPROVAL_REQUIRED');
    }
    if (options.approval !== digest) {
      throw publicationError('Publication approval digest is missing or does not match', 'ANTB_PUBLISH_APPROVAL_REQUIRED');
    }
    if (sha256(options.normalizedPatch) !== receipt.patch.sha256) {
      throw publicationError('Patch digest does not match the approved receipt', 'ANTB_PUBLISH_CONFLICT');
    }
    const providedFiles = options.files === undefined
      ? undefined
      : validatePublicationFiles(options.files, receipt.patch.changedPaths);
    const [owner, repo] = receipt.candidate.repository.slug.split('/');
    if (owner === undefined || repo === undefined) {
      throw publicationError('Repository slug is invalid', 'ANTB_PUBLISH_CONFLICT');
    }
    requireSafeBranchComponent(options.baseBranch);
    requireSafeBranchPrefix(options.branchPrefix);
    const baseReference = await this.#control.getRef({
      owner,
      repo,
      ref: `heads/${options.baseBranch}`,
    });
    const baseSha = FullGitShaSchema.parse(baseReference.sha);
    if (baseSha !== receipt.candidate.headSha) {
      throw publicationError(
        'Base branch moved after current-head verification; reverify before publishing',
        'ANTB_PUBLISH_CONFLICT',
      );
    }

    const marker = `<!-- antibody-receipt: ${digest} -->`;
    const branch = buildBranchName(options.branchPrefix, receipt);
    const baseFiles = new Map<string, Buffer | undefined>();
    for (const path of receipt.patch.changedPaths) {
      baseFiles.set(path, await this.#control.getFile({owner, repo, path, ref: baseSha}));
    }
    let materialized: ReadonlyMap<RepoPath, Buffer>;
    try {
      materialized = materializeUnifiedDiff(options.normalizedPatch, baseFiles);
    } catch (error: unknown) {
      throw publicationError(
        `Approved patch cannot be materialized against verified head: ${errorMessage(error)}`,
        'ANTB_PUBLISH_CONFLICT',
      );
    }
    const files = providedFiles ?? publicationFilesFromMaterialized(materialized, receipt.patch.changedPaths);
    for (const file of files) {
      const expected = materialized.get(file.path);
      if (expected?.equals(Buffer.from(file.contentBase64, 'base64')) !== true) {
        throw publicationError(
          'Publication file contents differ from the approved patch result',
          'ANTB_PUBLISH_CONFLICT',
        );
      }
    }

    const baseCommit = await this.#control.getCommit({owner, repo, commit_sha: baseSha});
    FullGitShaSchema.parse(baseCommit.sha);
    const treeEntries: NonNullable<CreateTreeParameters['tree']> = [];
    for (const file of files) {
      const blob = await this.#control.createBlob({
        owner,
        repo,
        content: file.contentBase64,
        encoding: 'base64',
      });
      treeEntries.push({path: file.path, mode: '100644', type: 'blob', sha: blob.sha});
    }
    const tree = await this.#control.createTree({
      owner,
      repo,
      base_tree: baseCommit.treeSha,
      tree: treeEntries,
    });
    const commitMessage = `test: recover regression for ${receipt.candidate.fixSha.slice(0, 12)}`;
    const commit = await this.#control.createCommit({
      owner,
      repo,
      message: commitMessage,
      tree: tree.sha,
      parents: [baseSha],
      author: {
        name: 'Antibody',
        email: 'antibody@users.noreply.github.com',
        date: receipt.createdAt,
      },
      committer: {
        name: 'Antibody',
        email: 'antibody@users.noreply.github.com',
        date: receipt.createdAt,
      },
    });
    const commitSha = FullGitShaSchema.parse(commit.sha);
    const existingPulls = await this.#control.listPulls({
      owner,
      repo,
      state: 'open',
      base: options.baseBranch,
      per_page: 100,
    });
    const existing = existingPulls.find((pull) => pull.body?.includes(marker) === true);
    if (existing !== undefined) {
      if (
        existing.draft !== true ||
        existing.headRef !== branch ||
        existing.headSha !== commitSha
      ) {
        throw publicationError(
          'Matching receipt pull request has an unexpected draft, branch, or commit',
          'ANTB_PUBLISH_CONFLICT',
        );
      }
      return publicationRecord(receipt, digest, branch, existing);
    }
    const branchRef = `heads/${branch}`;
    const existingBranch = await this.#getOptionalRef(owner, repo, branchRef);
    if (existingBranch === undefined) {
      await this.#control.createRef({owner, repo, ref: `refs/${branchRef}`, sha: baseSha});
    } else if (existingBranch.sha !== baseSha && existingBranch.sha !== commitSha) {
      throw publicationError('Deterministic publication branch contains unrelated work', 'ANTB_PUBLISH_CONFLICT');
    }
    if (existingBranch?.sha !== commitSha) {
      await this.#control.updateRef({
        owner,
        repo,
        ref: branchRef,
        sha: commitSha,
        force: false,
      });
    }

    const pull = await this.#control.createPull({
      owner,
      repo,
      title: buildTitle(receipt),
      head: branch,
      base: options.baseBranch,
      body: buildPullBody(receipt, digest, marker),
      draft: true,
      maintainer_can_modify: false,
    });
    if (pull.draft !== true || pull.headSha !== commitSha) {
      throw publicationError('GitHub returned a pull request that violates draft/head invariants', 'ANTB_PUBLISH_CONFLICT');
    }
    if (options.labels.length > 0) {
      try {
        await this.#control.addLabels({owner, repo, issue_number: pull.number, labels: [...options.labels]});
      } catch {
        // Label permissions are optional; the draft PR and receipt marker remain idempotent.
      }
    }
    return publicationRecord(receipt, digest, branch, pull);
  }

  async #getOptionalRef(owner: string, repo: string, ref: string): Promise<ReferenceView | undefined> {
    try {
      return await this.#control.getRef({owner, repo, ref});
    } catch (error: unknown) {
      if (httpStatus(error) === 404) return undefined;
      throw error;
    }
  }
}

function publicationFilesFromMaterialized(
  materialized: ReadonlyMap<RepoPath, Buffer>,
  expectedPaths: readonly RepoPath[],
): PublicationFile[] {
  return expectedPaths.map((path) => {
    const bytes = materialized.get(path);
    if (bytes === undefined) {
      throw publicationError('Approved patch did not materialize every receipt path', 'ANTB_PUBLISH_CONFLICT');
    }
    if (bytes.byteLength > 1_048_576) {
      throw publicationError('Publication file exceeds the byte limit', 'ANTB_PUBLISH_CONFLICT');
    }
    try {
      new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    } catch {
      throw publicationError('Publication file is not UTF-8 text', 'ANTB_PUBLISH_CONFLICT');
    }
    return {path, contentBase64: bytes.toString('base64')};
  });
}

export function createGitHubDraftPublisher(octokit: Octokit): GitHubDraftPublisher {
  return new GitHubDraftPublisher(new OctokitGitHubControl(octokit));
}

function validatePublicationFiles(
  files: readonly PublicationFile[],
  expectedPaths: readonly RepoPath[],
): PublicationFile[] {
  if (files.length === 0 || files.length !== expectedPaths.length) {
    throw publicationError('Publication file set does not match receipt paths', 'ANTB_PUBLISH_CONFLICT');
  }
  const expected = [...expectedPaths].sort();
  const validated = files.map((file) => {
    const path = RepoPathSchema.parse(file.path);
    if (!isCanonicalBase64(file.contentBase64)) {
      throw publicationError('Publication file content is not canonical base64', 'ANTB_PUBLISH_CONFLICT');
    }
    const bytes = Buffer.from(file.contentBase64, 'base64');
    if (bytes.byteLength > 1_048_576) {
      throw publicationError('Publication file exceeds the byte limit', 'ANTB_PUBLISH_CONFLICT');
    }
    try {
      new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    } catch {
      throw publicationError('Publication file is not UTF-8 text', 'ANTB_PUBLISH_CONFLICT');
    }
    return {path, contentBase64: file.contentBase64};
  });
  const actual = validated.map((file) => file.path).sort();
  if (new Set(actual).size !== actual.length || actual.some((path, index) => path !== expected[index])) {
    throw publicationError('Publication paths differ from the approved receipt', 'ANTB_PUBLISH_CONFLICT');
  }
  return validated;
}

function buildBranchName(prefix: string, receipt: ReceiptV1): string {
  const runShort = receipt.runId.replaceAll('-', '').slice(0, 8);
  const branch = `${prefix}${receipt.candidate.fixSha.slice(0, 12)}-${runShort}`;
  if (branch.length > 255) throw publicationError('Publication branch is too long', 'ANTB_PUBLISH_CONFLICT');
  return branch;
}

function buildTitle(receipt: ReceiptV1): string {
  const subject = new Redactor([])
    .redact(receipt.candidate.commit.subject)
    .replaceAll(/[\r\n<>`]/gu, ' ')
    .trim();
  return `[Antibody] ${subject}`.slice(0, 200);
}

function buildPullBody(receipt: ReceiptV1, digest: Sha256, marker: string): string {
  return [
    '## Antibody regression recovery',
    '',
    'This draft contains only the approved regression-test files.',
    '',
    `- Parent: \`${receipt.candidate.parentSha}\``,
    `- Fix: \`${receipt.candidate.fixSha}\``,
    `- Verified head: \`${receipt.candidate.headSha}\``,
    `- Patch: \`${receipt.patch.sha256}\``,
    `- Receipt: \`${digest}\``,
    `- Verdict: \`${receipt.verdict}\``,
    '',
    'Limit: this receipt demonstrates regression sensitivity under the recorded environment; it is not formal proof of global correctness.',
    '',
    marker,
  ].join('\n');
}

function publicationRecord(
  receipt: ReceiptV1,
  digest: Sha256,
  branch: string,
  pull: PullView,
): PublicationRecordV1 {
  return PublicationRecordSchema.parse({
    schemaVersion: 'antibody.publication/v1',
    receiptSha256: digest,
    repository: receipt.candidate.repository,
    branch,
    commitSha: pull.headSha,
    pullRequestNumber: pull.number,
    pullRequestUrl: pull.htmlUrl,
    draft: true,
    createdAt: pull.createdAt,
  });
}

function requireSafeBranchComponent(value: string): void {
  if (!isSafeRef(value) || value.includes('/')) {
    throw publicationError('Base branch name is unsafe or unsupported', 'ANTB_PUBLISH_CONFLICT');
  }
}

function requireSafeBranchPrefix(value: string): void {
  if (!value.endsWith('/') || !isSafeRef(value.slice(0, -1))) {
    throw publicationError('Publication branch prefix is unsafe', 'ANTB_PUBLISH_CONFLICT');
  }
}

function isSafeRef(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith('.') &&
    !value.endsWith('.') &&
    !value.includes('..') &&
    // eslint-disable-next-line no-control-regex -- Git refs must reject control bytes.
    !/[~^:?*[\\\u0000-\u001f\u007f]/u.test(value) &&
    !value.includes('@{') &&
    !value.endsWith('/') &&
    !value.includes('//')
  );
}

function isCanonicalBase64(value: string): boolean {
  return (
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value) &&
    Buffer.from(value, 'base64').toString('base64') === value
  );
}

function sha256(value: string): Sha256 {
  return Sha256Schema.parse(`sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`);
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}

function publicationError(
  message: string,
  code: 'ANTB_PUBLISH_APPROVAL_REQUIRED' | 'ANTB_PUBLISH_CONFLICT',
): AntibodyError {
  return new AntibodyError(message, {
    code,
    category: 'publication',
    retryable: false,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown patch error';
}
