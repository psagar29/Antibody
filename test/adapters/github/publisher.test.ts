import {createHash} from 'node:crypto';

import {describe, expect, it} from 'vitest';

import {
  ReceiptSchema,
  RepoPathSchema,
} from '../../../src/contracts/index.js';
import {GitHubDraftPublisher} from '../../../src/adapters/github/publisher.js';
import {receiptDigest} from '../../../src/core/receipts/receipt-store.js';

function sha(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

function fixture() {
  const patch = [
    'diff --git a/test/a.test.js b/test/a.test.js',
    '--- a/test/a.test.js',
    '+++ b/test/a.test.js',
    '@@ -1 +1,2 @@',
    ' old();',
    '+test();',
    '',
  ].join('\n');
  const patchDigest = `sha256:${createHash('sha256').update(patch).digest('hex')}`;
  const receipt = ReceiptSchema.parse({
    schemaVersion: 'antibody.receipt/v1',
    runId: '00000000-0000-4000-8000-000000000001',
    candidate: {
      schemaVersion: 'antibody.candidate/v1',
      candidateId: `sha256:${'a'.repeat(64)}`,
      repository: {slug: 'owner/repo', cloneUrl: 'https://github.com/owner/repo.git'},
      parentSha: '1'.repeat(40),
      fixSha: '2'.repeat(40),
      headSha: '3'.repeat(40),
      commit: {
        subject: 'fix: behavior <unsafe>',
        authoredAt: '2026-08-29T00:00:00.000Z',
        changedProductionPaths: ['src/index.js'],
        changedTestPaths: [],
        additions: 1,
        deletions: 1,
        diffSha256: patchDigest,
      },
      signals: [],
      score: 50,
    },
    patch: {
      sha256: patchDigest,
      sizeBytes: Buffer.byteLength(patch),
      changedPaths: ['test/a.test.js'],
      artifact: {name: 'patch.diff', mediaType: 'text/x-diff', sha256: patchDigest, sizeBytes: Buffer.byteLength(patch)},
    },
    policy: {testOnly: true, allowedGlobs: ['test/**'], violations: []},
    environment: {equivalent: true, comparedFields: ['snapshot'], mismatchFields: [], source: {kind: 'snapshot', id: 'snapshot-1'}},
    classifications: [],
    evidence: {rawEvidenceSha256: patchDigest, artifacts: [], cleanup: []},
    costs: {},
    verdict: 'verified',
    reasonCodes: ['CAUSAL'],
    createdAt: '2026-08-29T00:00:02.000Z',
  });
  return {
    receipt,
    patch,
    files: [{
      path: RepoPathSchema.parse('test/a.test.js'),
      contentBase64: Buffer.from('old();\ntest();\n').toString('base64'),
    }],
  };
}

function fakeControl(options: {
  baseSha?: string;
  branchSha?: string;
  existingPull?: boolean;
  existingHeadRef?: string;
  existingHeadSha?: string;
  nondraft?: boolean;
  failPullOnce?: boolean;
  failLabels?: boolean;
} = {}) {
  const calls: string[] = [];
  let branchSha = options.branchSha;
  let pullFailures = options.failPullOnce === true ? 1 : 0;
  const commitSha = sha('commit');
  const control = {
    getRef(parameters: {ref: string}) {
      calls.push(`getRef:${parameters.ref}`);
      if (parameters.ref === 'heads/main') return Promise.resolve({sha: options.baseSha ?? '3'.repeat(40)});
      if (branchSha === undefined) {
        return Promise.reject(Object.assign(new Error('reference not found'), {status: 404}));
      }
      return Promise.resolve({sha: branchSha});
    },
    getCommit() {
      calls.push('getCommit');
      return Promise.resolve({sha: '3'.repeat(40), treeSha: sha('base-tree')});
    },
    getFile(parameters: {path: string}) {
      calls.push(`getFile:${parameters.path}`);
      return Promise.resolve(Buffer.from('old();\n'));
    },
    createBlob(parameters: {content: string}) {
      calls.push('createBlob');
      return Promise.resolve({sha: sha(parameters.content)});
    },
    createTree() {
      calls.push('createTree');
      return Promise.resolve({sha: sha('tree')});
    },
    createCommit() {
      calls.push('createCommit');
      return Promise.resolve({sha: commitSha});
    },
    createRef(parameters: {sha: string}) {
      calls.push('createRef');
      branchSha = parameters.sha;
      return Promise.resolve({sha: parameters.sha});
    },
    updateRef(parameters: {sha: string; force?: boolean}) {
      calls.push(`updateRef:${String(parameters.force)}`);
      branchSha = parameters.sha;
      return Promise.resolve({sha: parameters.sha});
    },
    listPulls() {
      calls.push('listPulls');
      if (options.existingPull !== true) return Promise.resolve([]);
      const digest = receiptDigest(fixture().receipt);
      return Promise.resolve([
        {
          number: 7,
          htmlUrl: 'https://github.com/owner/repo/pull/7',
          body: `<!-- antibody-receipt: ${digest} -->`,
          draft: options.nondraft === true ? false : true,
          headRef: options.existingHeadRef ?? 'antibody/222222222222-00000000',
          headSha: options.existingHeadSha ?? commitSha,
          createdAt: '2026-08-29T00:00:03.000Z',
        },
      ]);
    },
    createPull(parameters: {draft?: boolean; body?: string}) {
      calls.push(`createPull:${String(parameters.draft)}`);
      if (pullFailures > 0) {
        pullFailures -= 1;
        return Promise.reject(new Error('temporary create failure'));
      }
      return Promise.resolve({
        number: 8,
        htmlUrl: 'https://github.com/owner/repo/pull/8',
        body: parameters.body ?? null,
        draft: parameters.draft ?? null,
        headRef: 'antibody/222222222222-00000000',
        headSha: commitSha,
        createdAt: '2026-08-29T00:00:04.000Z',
      });
    },
    addLabels() {
      calls.push('addLabels');
      return options.failLabels === true ? Promise.reject(new Error('no label permission')) : Promise.resolve();
    },
  };
  return {control, calls, commitSha};
}

function publishOptions() {
  const values = fixture();
  return {
    receipt: values.receipt,
    approval: receiptDigest(values.receipt),
    normalizedPatch: values.patch,
    files: values.files,
    baseBranch: 'main',
    branchPrefix: 'antibody/',
    labels: ['tests'],
  };
}

describe('GitHubDraftPublisher', () => {
  it('creates a deterministic non-forced branch, commit, and draft PR', async () => {
    const fake = fakeControl();
    const record = await new GitHubDraftPublisher(fake.control).publish(publishOptions());

    expect(record.draft).toBe(true);
    expect(record.commitSha).toBe(fake.commitSha);
    expect(fake.calls).toContain('createRef');
    expect(fake.calls).toContain('updateRef:false');
    expect(fake.calls).toContain('createPull:true');
    expect(fake.calls).toContain('addLabels');
  });

  it('materializes publication files directly from the approved patch', async () => {
    const fake = fakeControl();
    const values = publishOptions();
    const options = {
      receipt: values.receipt,
      approval: values.approval,
      normalizedPatch: values.normalizedPatch,
      baseBranch: values.baseBranch,
      branchPrefix: values.branchPrefix,
      labels: values.labels,
    };
    await expect(new GitHubDraftPublisher(fake.control).publish(options)).resolves.toMatchObject({
      draft: true,
      commitSha: fake.commitSha,
    });
    expect(fake.calls).toContain('createBlob');
  });

  it.each([
    ['wrong approval', (options: ReturnType<typeof publishOptions>) => ({...options, approval: `sha256:${'f'.repeat(64)}`}), 'ANTB_PUBLISH_APPROVAL_REQUIRED'],
    ['tampered patch', (options: ReturnType<typeof publishOptions>) => ({...options, normalizedPatch: 'tampered'}), 'ANTB_PUBLISH_CONFLICT'],
    ['wrong files', (options: ReturnType<typeof publishOptions>) => ({...options, files: []}), 'ANTB_PUBLISH_CONFLICT'],
    ['unsafe prefix', (options: ReturnType<typeof publishOptions>) => ({...options, branchPrefix: '../bad/'}), 'ANTB_PUBLISH_CONFLICT'],
  ] as const)('rejects %s before remote writes', async (_name, mutate, code) => {
    const fake = fakeControl();
    await expect(new GitHubDraftPublisher(fake.control).publish(mutate(publishOptions()))).rejects.toMatchObject({code});
    expect(fake.calls).toHaveLength(0);
  });

  it('rejects file contents not produced by the approved patch before remote writes', async () => {
    const fake = fakeControl();
    const options = publishOptions();
    await expect(
      new GitHubDraftPublisher(fake.control).publish({
        ...options,
        files: [{
          path: RepoPathSchema.parse('test/a.test.js'),
          contentBase64: Buffer.from('malicious();\n').toString('base64'),
        }],
      }),
    ).rejects.toMatchObject({code: 'ANTB_PUBLISH_CONFLICT'});
    expect(fake.calls).toEqual(['getRef:heads/main', 'getFile:test/a.test.js']);
  });

  it('refuses stale current-head proof and unrelated deterministic branches', async () => {
    const stale = fakeControl({baseSha: '4'.repeat(40)});
    await expect(new GitHubDraftPublisher(stale.control).publish(publishOptions())).rejects.toMatchObject({code: 'ANTB_PUBLISH_CONFLICT'});
    expect(stale.calls).toEqual(['getRef:heads/main']);

    const conflict = fakeControl({branchSha: '9'.repeat(40)});
    await expect(new GitHubDraftPublisher(conflict.control).publish(publishOptions())).rejects.toMatchObject({code: 'ANTB_PUBLISH_CONFLICT'});
    expect(conflict.calls).not.toContain('updateRef:false');
  });

  it('reuses a matching open draft and refuses a matching non-draft', async () => {
    const duplicate = fakeControl({existingPull: true});
    const record = await new GitHubDraftPublisher(duplicate.control).publish(publishOptions());
    expect(record.pullRequestNumber).toBe(7);
    expect(duplicate.calls).not.toContain('createRef');

    const nondraft = fakeControl({existingPull: true, nondraft: true});
    await expect(new GitHubDraftPublisher(nondraft.control).publish(publishOptions())).rejects.toMatchObject({code: 'ANTB_PUBLISH_CONFLICT'});
  });

  it('refuses a copied receipt marker on the wrong branch or commit', async () => {
    const wrongBranch = fakeControl({existingPull: true, existingHeadRef: 'attacker/copied'});
    await expect(
      new GitHubDraftPublisher(wrongBranch.control).publish(publishOptions()),
    ).rejects.toMatchObject({code: 'ANTB_PUBLISH_CONFLICT'});

    const wrongCommit = fakeControl({existingPull: true, existingHeadSha: '9'.repeat(40)});
    await expect(
      new GitHubDraftPublisher(wrongCommit.control).publish(publishOptions()),
    ).rejects.toMatchObject({code: 'ANTB_PUBLISH_CONFLICT'});
  });

  it('recovers after a partial PR failure without duplicating the branch', async () => {
    const fake = fakeControl({failPullOnce: true});
    const publisher = new GitHubDraftPublisher(fake.control);
    await expect(publisher.publish(publishOptions())).rejects.toThrow('temporary create failure');
    const record = await publisher.publish(publishOptions());
    expect(record.pullRequestNumber).toBe(8);
    expect(fake.calls.filter((call) => call === 'createRef')).toHaveLength(1);
  });

  it('treats label failure as non-fatal after the idempotent draft exists', async () => {
    const fake = fakeControl({failLabels: true});
    await expect(new GitHubDraftPublisher(fake.control).publish(publishOptions())).resolves.toMatchObject({draft: true});
  });
});
