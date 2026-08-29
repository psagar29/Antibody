import path from 'node:path';

import {canonicalize} from 'json-canonicalize';
import {z} from 'zod';

import {
	FullGitShaSchema,
	PublicationRecordSchema,
	ReceiptSchema,
	Sha256Schema,
	type FullGitSha,
	type PublicationRecordV1,
	type RepoPath,
	type Sha256,
} from '../../contracts/index.js';
import {
	materializePatchFiles,
	type MaterializedPatchFile,
} from '../git/apply-checker.js';
import {sha256Bytes, sha256Canonical} from '../../core/digest.js';
import {parseUnifiedDiff} from '../../core/patch-policy/unified-diff.js';
import type {GitHubPublisherClient, OpenPullRequest} from './octokit-publisher-client.js';

const PublishRequestSchema = z
	.object({
		repositoryRoot: z.string().min(1).max(32_768),
		receipt: ReceiptSchema,
		receiptSha256: Sha256Schema,
		approval: Sha256Schema,
		patch: z.string().min(1).max(10_485_760),
		baseBranch: z.string().min(1).max(255).regex(/^(?!\/)(?!.*\.\.)(?!.*\s)[A-Za-z0-9._/-]+$/u),
		includeReceiptInRepository: z.boolean(),
	})
	.strict();

export type PatchMaterializer = (
	repositoryRoot: string,
	patch: string,
	commit: FullGitSha,
	changedPaths: readonly RepoPath[],
) => Promise<readonly MaterializedPatchFile[]>;

export type PublisherClock = Readonly<{now: () => string}>;

const systemClock: PublisherClock = {now: () => new Date().toISOString()};

function marker(receiptSha256: Sha256): string {
	return `<!-- antibody-receipt: ${receiptSha256} -->`;
}

function branchName(fixSha: FullGitSha, runId: string): string {
	return `antibody/${fixSha.slice(0, 8)}-${runId.slice(0, 8)}`;
}

function repositoryParts(slug: string): readonly [string, string] {
	return z.tuple([z.string().min(1), z.string().min(1)]).parse(slug.split('/'));
}

function pathsFromPatch(patch: string): RepoPath[] {
	const parsed = parseUnifiedDiff(patch);
	return [...new Set(parsed.files.map(file => file.newPath ?? file.oldPath)
		.filter((repositoryPath): repositoryPath is RepoPath => repositoryPath !== null))];
}

function samePaths(left: readonly RepoPath[], right: readonly RepoPath[]): boolean {
	return [...left].sort().join('\0') === [...right].sort().join('\0');
}

function bodyFor(request: z.output<typeof PublishRequestSchema>): string {
	return [
		'## Antibody historical regression recovery',
		'',
		`- Parent: \`${request.receipt.candidate.parentSha}\``,
		`- Fix: \`${request.receipt.candidate.fixSha}\``,
		`- Verified HEAD: \`${request.receipt.candidate.headSha}\``,
		`- Patch: \`${request.receipt.patch.sha256}\``,
		`- Receipt: \`${request.receiptSha256}\``,
		'- Result: stable red on the historical parent; green on the fix and captured current HEAD.',
		'- Limitation: this is historical causal evidence, not proof against future repository changes.',
		'',
		marker(request.receiptSha256),
	].join('\n');
}

function publicationFromPullRequest(
	request: z.output<typeof PublishRequestSchema>,
	branch: string,
	pullRequest: OpenPullRequest,
	clock: PublisherClock,
): PublicationRecordV1 {
	if (!pullRequest.draft) {
		throw new Error('Refusing a matching non-draft pull request as an Antibody publication');
	}
	return PublicationRecordSchema.parse({
		schemaVersion: 'antibody.publication/v1',
		receiptSha256: request.receiptSha256,
		repository: request.receipt.candidate.repository,
		branch,
		commitSha: FullGitShaSchema.parse(pullRequest.headSha),
		pullRequestNumber: pullRequest.number,
		pullRequestUrl: pullRequest.url,
		draft: true,
		createdAt: clock.now(),
	});
}

export class GitHubDraftPublisher {
	constructor(
		private readonly client: GitHubPublisherClient,
		private readonly materialize: PatchMaterializer = materializePatchFiles,
		private readonly clock: PublisherClock = systemClock,
	) {}

	async publish(input: z.input<typeof PublishRequestSchema>): Promise<PublicationRecordV1> {
		const request = PublishRequestSchema.parse(input);
		const recomputedReceiptSha256 = sha256Canonical(request.receipt);
		if (request.receipt.verdict !== 'verified') {
			throw new Error('Only a verified receipt may be published');
		}
		if (!request.receipt.policy.testOnly || request.receipt.policy.violations.length > 0) {
			throw new Error('Receipt patch policy is not clean');
		}
		if (request.receiptSha256 !== recomputedReceiptSha256
			|| request.approval !== recomputedReceiptSha256) {
			throw new Error('Publication approval does not exactly match the canonical receipt digest');
		}
		const patchBytes = Buffer.from(request.patch, 'utf8');
		if (sha256Bytes(patchBytes) !== request.receipt.patch.sha256
			|| patchBytes.byteLength !== request.receipt.patch.sizeBytes) {
			throw new Error('Publication patch does not match the approved receipt');
		}
		const changedPaths = pathsFromPatch(request.patch);
		if (!samePaths(changedPaths, request.receipt.patch.changedPaths)) {
			throw new Error('Publication patch paths do not match the approved receipt');
		}

		const [owner, repository] = repositoryParts(request.receipt.candidate.repository.slug);
		const baseRef = await this.client.getRef(owner, repository, `heads/${request.baseBranch}`);
		const baseHead = FullGitShaSchema.parse(baseRef?.sha);
		if (baseHead !== request.receipt.candidate.headSha) {
			throw new Error('Base branch moved after current-HEAD verification');
		}

		const branch = branchName(request.receipt.candidate.fixSha, request.receipt.runId);
		const headFilter = `${owner}:${branch}`;
		const receiptMarker = marker(request.receiptSha256);
		const existingPullRequest = (await this.client.listOpenPullRequests(
			owner,
			repository,
			headFilter,
		)).find(pullRequest => pullRequest.body.includes(receiptMarker));
		if (existingPullRequest !== undefined) {
			return publicationFromPullRequest(request, branch, existingPullRequest, this.clock);
		}

		const branchRefName = `refs/heads/${branch}`;
		const branchApiRef = `heads/${branch}`;
		const commitMarker = `Antibody-Receipt: ${request.receiptSha256}`;
		const existingBranch = await this.client.getRef(owner, repository, branchApiRef);
		let publicationCommit: FullGitSha | undefined;
		if (existingBranch === undefined) {
			await this.client.createRef(owner, repository, branchRefName, baseHead);
		} else {
			const existingSha = FullGitShaSchema.parse(existingBranch.sha);
			if (existingSha !== baseHead) {
				const existingCommit = await this.client.getCommit(owner, repository, existingSha);
				const parentSha = existingCommit.parentShas[0];
				if (!existingCommit.message.includes(commitMarker) || parentSha !== baseHead) {
					throw new Error('Deterministic publication branch already contains unrelated work');
				}
				publicationCommit = FullGitShaSchema.parse(existingCommit.sha);
			}
		}

		if (publicationCommit === undefined) {
			const files = await this.materialize(
				path.resolve(request.repositoryRoot),
				request.patch,
				baseHead,
				changedPaths,
			);
			if (!samePaths(files.map(file => file.path), changedPaths)) {
				throw new Error('Materialized patch files do not match the approved paths');
			}
			const baseCommit = await this.client.getCommit(owner, repository, baseHead);
			const entries: {path: string; blobSha: string}[] = [];
			for (const file of files) {
				const blobSha = await this.client.createBlob(
					owner,
					repository,
					Buffer.from(file.content).toString('base64'),
				);
				entries.push({path: file.path, blobSha});
			}
			if (request.includeReceiptInRepository) {
				const receiptBlobSha = await this.client.createBlob(
					owner,
					repository,
					Buffer.from(canonicalize(request.receipt), 'utf8').toString('base64'),
				);
				entries.push({
					path: `.antibody/receipts/${request.receiptSha256}.json`,
					blobSha: receiptBlobSha,
				});
			}
			const treeSha = await this.client.createTree(
				owner,
				repository,
				baseCommit.treeSha,
				entries,
			);
			publicationCommit = FullGitShaSchema.parse(await this.client.createCommit(
				owner,
				repository,
				`test: recover historical regression\n\n${commitMarker}`,
				treeSha,
				baseHead,
			));
			await this.client.updateRef(
				owner,
				repository,
				branchApiRef,
				publicationCommit,
			);
		}

		const lateDuplicate = (await this.client.listOpenPullRequests(
			owner,
			repository,
			headFilter,
		)).find(pullRequest => pullRequest.body.includes(receiptMarker));
		if (lateDuplicate !== undefined) {
			return publicationFromPullRequest(request, branch, lateDuplicate, this.clock);
		}

		const pullRequest = await this.client.createDraftPullRequest(owner, repository, {
			title: `test: recover regression for ${request.receipt.candidate.fixSha.slice(0, 8)}`,
			head: branch,
			base: request.baseBranch,
			body: bodyFor(request),
		});
		if (!pullRequest.draft || pullRequest.headSha !== publicationCommit) {
			throw new Error('GitHub did not create the expected draft pull request');
		}
		return publicationFromPullRequest(request, branch, pullRequest, this.clock);
	}
}
