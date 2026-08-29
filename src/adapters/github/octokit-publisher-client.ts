import type {Octokit} from '@octokit/rest';
import {z} from 'zod';

export type GitCommitRecord = Readonly<{
	sha: string;
	treeSha: string;
	message: string;
	parentShas: readonly string[];
}>;

export type OpenPullRequest = Readonly<{
	number: number;
	url: string;
	body: string;
	headSha: string;
	draft: boolean;
}>;

export interface GitHubPublisherClient {
	getRef(owner: string, repository: string, ref: string): Promise<Readonly<{sha: string}> | undefined>;
	getCommit(owner: string, repository: string, sha: string): Promise<GitCommitRecord>;
	createRef(owner: string, repository: string, ref: string, sha: string): Promise<void>;
	createBlob(owner: string, repository: string, contentBase64: string): Promise<string>;
	createTree(
		owner: string,
		repository: string,
		baseTreeSha: string,
		entries: readonly Readonly<{path: string; blobSha: string}>[],
	): Promise<string>;
	createCommit(
		owner: string,
		repository: string,
		message: string,
		treeSha: string,
		parentSha: string,
	): Promise<string>;
	updateRef(
		owner: string,
		repository: string,
		ref: string,
		sha: string,
	): Promise<void>;
	listOpenPullRequests(owner: string, repository: string, head: string): Promise<readonly OpenPullRequest[]>;
	createDraftPullRequest(
		owner: string,
		repository: string,
		input: Readonly<{title: string; head: string; base: string; body: string}>,
	): Promise<OpenPullRequest>;
}

function isNotFound(error: unknown): boolean {
	return z.looseObject({status: z.literal(404)}).safeParse(error).success;
}

export class OctokitPublisherClient implements GitHubPublisherClient {
	constructor(private readonly octokit: Octokit) {}

	async getRef(owner: string, repository: string, ref: string) {
		try {
			const response = await this.octokit.rest.git.getRef({owner, repo: repository, ref});
			return {sha: response.data.object.sha};
		} catch (error: unknown) {
			if (isNotFound(error)) return undefined;
			throw error;
		}
	}

	async getCommit(owner: string, repository: string, sha: string): Promise<GitCommitRecord> {
		const response = await this.octokit.rest.git.getCommit({owner, repo: repository, commit_sha: sha});
		return {
			sha: response.data.sha,
			treeSha: response.data.tree.sha,
			message: response.data.message,
			parentShas: response.data.parents.map(parent => parent.sha),
		};
	}

	async createRef(owner: string, repository: string, ref: string, sha: string): Promise<void> {
		await this.octokit.rest.git.createRef({owner, repo: repository, ref, sha});
	}

	async createBlob(owner: string, repository: string, contentBase64: string): Promise<string> {
		const response = await this.octokit.rest.git.createBlob({
			owner,
			repo: repository,
			content: contentBase64,
			encoding: 'base64',
		});
		return response.data.sha;
	}

	async createTree(
		owner: string,
		repository: string,
		baseTreeSha: string,
		entries: readonly Readonly<{path: string; blobSha: string}>[],
	): Promise<string> {
		const response = await this.octokit.rest.git.createTree({
			owner,
			repo: repository,
			base_tree: baseTreeSha,
			tree: entries.map(entry => ({
				path: entry.path,
				mode: '100644',
				type: 'blob',
				sha: entry.blobSha,
			})),
		});
		return response.data.sha;
	}

	async createCommit(
		owner: string,
		repository: string,
		message: string,
		treeSha: string,
		parentSha: string,
	): Promise<string> {
		const response = await this.octokit.rest.git.createCommit({
			owner,
			repo: repository,
			message,
			tree: treeSha,
			parents: [parentSha],
		});
		return response.data.sha;
	}

	async updateRef(
		owner: string,
		repository: string,
		ref: string,
		sha: string,
	): Promise<void> {
		await this.octokit.rest.git.updateRef({
			owner,
			repo: repository,
			ref,
			sha,
			force: false,
		});
	}

	async listOpenPullRequests(
		owner: string,
		repository: string,
		head: string,
	): Promise<readonly OpenPullRequest[]> {
		const records = await this.octokit.paginate(this.octokit.rest.pulls.list, {
			owner,
			repo: repository,
			state: 'open',
			head,
			per_page: 100,
		});
		return records.map(pullRequest => ({
			number: pullRequest.number,
			url: pullRequest.html_url,
			body: pullRequest.body ?? '',
			headSha: pullRequest.head.sha,
			draft: pullRequest.draft ?? false,
		}));
	}

	async createDraftPullRequest(
		owner: string,
		repository: string,
		input: Readonly<{title: string; head: string; base: string; body: string}>,
	): Promise<OpenPullRequest> {
		const response = await this.octokit.rest.pulls.create({
			owner,
			repo: repository,
			title: input.title,
			head: input.head,
			base: input.base,
			body: input.body,
			draft: true,
		});
		return {
			number: response.data.number,
			url: response.data.html_url,
			body: response.data.body ?? '',
			headSha: response.data.head.sha,
			draft: response.data.draft ?? true,
		};
	}
}
