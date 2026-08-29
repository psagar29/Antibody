import {readFile} from 'node:fs/promises';

import {beforeEach, describe, expect, test} from 'vitest';

import {
	ReceiptSchema,
	RecoveryCandidateSchema,
	RepoPathSchema,
	Sha256Schema,
} from '../../../src/contracts/index.js';
import {GitHubDraftPublisher} from '../../../src/adapters/github/draft-publisher.js';
import type {
	GitCommitRecord,
	GitHubPublisherClient,
	OpenPullRequest,
} from '../../../src/adapters/github/octokit-publisher-client.js';
import {sha256Bytes, sha256Canonical} from '../../../src/core/digest.js';

const baseHead = '1bcd48e2eba3a5ed823460b6763c90f49efca6b3';
const baseTree = '2'.repeat(40);

class FakeGitHubClient implements GitHubPublisherClient {
	readonly refs = new Map<string, string>([['heads/main', baseHead]]);
	readonly commits = new Map<string, GitCommitRecord>([[baseHead, {
		sha: baseHead,
		treeSha: baseTree,
		message: 'base',
		parentShas: [],
	}]]);
	readonly pullRequests: OpenPullRequest[] = [];
	readonly calls: string[] = [];
	readonly treeEntries: Readonly<{path: string; blobSha: string}>[][] = [];
	lastPullRequestInput: Readonly<{title: string; head: string; base: string; body: string}> | undefined;
	failPullRequestOnce = false;
	private blobCount = 0;

	getRef(_owner: string, _repository: string, ref: string) {
		this.calls.push(`getRef:${ref}`);
		const sha = this.refs.get(ref);
		return Promise.resolve(sha === undefined ? undefined : {sha});
	}

	getCommit(_owner: string, _repository: string, sha: string) {
		this.calls.push(`getCommit:${sha}`);
		const commit = this.commits.get(sha);
		return commit === undefined
			? Promise.reject(new Error('missing commit'))
			: Promise.resolve(commit);
	}

	createRef(_owner: string, _repository: string, ref: string, sha: string) {
		this.calls.push(`createRef:${ref}`);
		this.refs.set(ref.replace(/^refs\//u, ''), sha);
		return Promise.resolve();
	}

	createBlob() {
		this.blobCount += 1;
		this.calls.push('createBlob');
		return Promise.resolve(String(this.blobCount).padStart(40, '0'));
	}

	createTree(
		_owner: string,
		_repository: string,
		_baseTreeSha: string,
		entries: readonly Readonly<{path: string; blobSha: string}>[],
	) {
		this.calls.push('createTree');
		this.treeEntries.push([...entries]);
		return Promise.resolve('3'.repeat(40));
	}

	createCommit(
		_owner: string,
		_repository: string,
		message: string,
		treeSha: string,
		parentSha: string,
	) {
		this.calls.push('createCommit');
		const sha = '4'.repeat(40);
		this.commits.set(sha, {sha, treeSha, message, parentShas: [parentSha]});
		return Promise.resolve(sha);
	}

	updateRef(_owner: string, _repository: string, ref: string, sha: string) {
		this.calls.push(`updateRef:${ref}`);
		this.refs.set(ref, sha);
		return Promise.resolve();
	}

	listOpenPullRequests(_owner: string, _repository: string, head: string) {
		this.calls.push(`listPulls:${head}`);
		return Promise.resolve(this.pullRequests);
	}

	createDraftPullRequest(
		_owner: string,
		_repository: string,
		input: Readonly<{title: string; head: string; base: string; body: string}>,
	) {
		this.calls.push('createDraftPullRequest');
		this.lastPullRequestInput = input;
		if (this.failPullRequestOnce) {
			this.failPullRequestOnce = false;
			return Promise.reject(new Error('injected PR failure'));
		}
		const pullRequest: OpenPullRequest = {
			number: 17,
			url: 'https://github.com/example/antibody-demo/pull/17',
			body: input.body,
			headSha: this.refs.get(`heads/${input.head}`) ?? '',
			draft: true,
		};
		this.pullRequests.push(pullRequest);
		return Promise.resolve(pullRequest);
	}
}

let patch: string;
let receipt: ReturnType<typeof ReceiptSchema.parse>;
let receiptSha256: ReturnType<typeof sha256Canonical>;

beforeEach(async () => {
	patch = await readFile('fixtures/demo-history/recovered-test.diff', 'utf8');
	const patchBytes = Buffer.from(patch, 'utf8');
	const candidate = RecoveryCandidateSchema.parse({
		schemaVersion: 'antibody.candidate/v1',
		candidateId: `sha256:${'a'.repeat(64)}`,
		repository: {
			slug: 'example/antibody-demo',
			cloneUrl: 'https://github.com/example/antibody-demo.git',
		},
		parentSha: '66e82fb6b511eccffc879042c61bf45100067881',
		fixSha: 'e2398bf45efca03a24dbb9101a52cf1c70ea0fe0',
		headSha: baseHead,
		commit: {
			subject: 'fix repeated whitespace',
			authoredAt: '2024-01-03T00:00:00.000Z',
			changedProductionPaths: ['src/slug.js'],
			changedTestPaths: [],
			additions: 1,
			deletions: 1,
			diffSha256: `sha256:${'b'.repeat(64)}`,
		},
		signals: [],
		score: 65,
	});
	receipt = ReceiptSchema.parse({
		schemaVersion: 'antibody.receipt/v1',
		runId: '11111111-1111-4111-8111-111111111111',
		candidate,
		patch: {
			sha256: sha256Bytes(patchBytes),
			sizeBytes: patchBytes.byteLength,
			changedPaths: ['test/slug.test.js'],
			artifact: {
				name: 'patch.diff',
				mediaType: 'text/x-diff',
				sha256: sha256Bytes(patchBytes),
				sizeBytes: patchBytes.byteLength,
			},
		},
		policy: {testOnly: true, allowedGlobs: ['test/**'], violations: []},
		environment: {
			equivalent: true,
			comparedFields: ['snapshot'],
			mismatchFields: [],
			source: {kind: 'snapshot', id: 'snapshot-1'},
		},
		classifications: [],
		evidence: {
			rawEvidenceSha256: `sha256:${'c'.repeat(64)}`,
			artifacts: [],
			cleanup: [],
		},
		costs: {},
		verdict: 'verified',
		reasonCodes: ['causal-red-green-confirmed'],
		createdAt: '2024-01-01T00:00:02.000Z',
	});
	receiptSha256 = sha256Canonical(receipt);
});

function request(overrides: Readonly<{
	approval?: typeof receiptSha256;
	receiptValue?: typeof receipt;
	includeReceiptInRepository?: boolean;
}> = {}) {
	return {
		repositoryRoot: process.cwd(),
		receipt: overrides.receiptValue ?? receipt,
		receiptSha256,
		approval: overrides.approval ?? receiptSha256,
		patch,
		baseBranch: 'main',
		includeReceiptInRepository: overrides.includeReceiptInRepository ?? false,
	};
}

function materialize() {
	return Promise.resolve([{
		path: RepoPathSchema.parse('test/slug.test.js'),
		content: Buffer.from('patched test content', 'utf8'),
	}]);
}

const fixedClock = {now: () => '2024-01-01T00:00:03.000Z'};

describe('GitHubDraftPublisher', () => {
	test('publishes one non-force branch commit and a draft PR', async () => {
		const client = new FakeGitHubClient();
		const publisher = new GitHubDraftPublisher(client, materialize, fixedClock);
		const publication = await publisher.publish(request());

		expect(publication).toMatchObject({
			branch: 'antibody/e2398bf4-11111111',
			commitSha: '4'.repeat(40),
			pullRequestNumber: 17,
			draft: true,
		});
		expect(client.treeEntries).toEqual([[
			{path: 'test/slug.test.js', blobSha: '0'.repeat(39) + '1'},
		]]);
		expect(client.lastPullRequestInput).toMatchObject({
			head: 'antibody/e2398bf4-11111111',
			base: 'main',
		});
		expect(client.lastPullRequestInput?.body).toContain(
			`<!-- antibody-receipt: ${receiptSha256} -->`,
		);
		expect(client.calls.filter(call => call.startsWith('updateRef:'))).toEqual([
			'updateRef:heads/antibody/e2398bf4-11111111',
		]);
	});

	test('requires the exact canonical approval before any GitHub operation', async () => {
		const client = new FakeGitHubClient();
		const publisher = new GitHubDraftPublisher(client, materialize, fixedClock);
		await expect(publisher.publish(request({
			approval: Sha256Schema.parse(`sha256:${'f'.repeat(64)}`),
		}))).rejects.toThrow('approval does not exactly match');
		expect(client.calls).toEqual([]);
	});

	test('stops on a stale base HEAD before writes', async () => {
		const client = new FakeGitHubClient();
		client.refs.set('heads/main', 'f'.repeat(40));
		const publisher = new GitHubDraftPublisher(client, materialize, fixedClock);
		await expect(publisher.publish(request())).rejects.toThrow('Base branch moved');
		expect(client.calls).toEqual(['getRef:heads/main']);
	});

	test('returns a matching open draft PR before any write', async () => {
		const client = new FakeGitHubClient();
		client.pullRequests.push({
			number: 9,
			url: 'https://github.com/example/antibody-demo/pull/9',
			body: `existing\n<!-- antibody-receipt: ${receiptSha256} -->`,
			headSha: '4'.repeat(40),
			draft: true,
		});
		const publication = await new GitHubDraftPublisher(client, materialize, fixedClock)
			.publish(request());
		expect(publication.pullRequestNumber).toBe(9);
		expect(client.calls).toEqual([
			'getRef:heads/main',
			'listPulls:example:antibody/e2398bf4-11111111',
		]);
	});

	test('refuses an unrelated deterministic branch', async () => {
		const client = new FakeGitHubClient();
		const unrelatedSha = '5'.repeat(40);
		client.refs.set('heads/antibody/e2398bf4-11111111', unrelatedSha);
		client.commits.set(unrelatedSha, {
			sha: unrelatedSha,
			treeSha: '6'.repeat(40),
			message: 'unrelated work',
			parentShas: [baseHead],
		});
		await expect(new GitHubDraftPublisher(client, materialize, fixedClock).publish(request()))
			.rejects.toThrow('unrelated work');
		expect(client.calls).not.toContain('createBlob');
	});

	test('resumes after a partial PR failure without duplicating branch or commit', async () => {
		const client = new FakeGitHubClient();
		client.failPullRequestOnce = true;
		const publisher = new GitHubDraftPublisher(client, materialize, fixedClock);
		await expect(publisher.publish(request())).rejects.toThrow('injected PR failure');
		await expect(publisher.publish(request())).resolves.toMatchObject({pullRequestNumber: 17});

		expect(client.calls.filter(call => call.startsWith('createRef:'))).toHaveLength(1);
		expect(client.calls.filter(call => call === 'createCommit')).toHaveLength(1);
		expect(client.calls.filter(call => call.startsWith('updateRef:'))).toHaveLength(1);
		expect(client.calls.filter(call => call === 'createDraftPullRequest')).toHaveLength(2);
	});

	test('adds an in-repository canonical receipt only when explicitly opted in', async () => {
		const client = new FakeGitHubClient();
		await new GitHubDraftPublisher(client, materialize, fixedClock).publish(request({
			includeReceiptInRepository: true,
		}));
		expect(client.treeEntries[0]?.map(entry => entry.path)).toEqual([
			'test/slug.test.js',
			`.antibody/receipts/${receiptSha256}.json`,
		]);
	});
});
