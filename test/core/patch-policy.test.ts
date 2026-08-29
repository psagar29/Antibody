import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {RecoveryCandidateSchema} from '../../src/contracts/index.js';
import type {PatchApplicabilityChecker} from '../../src/core/policy/patch-policy.js';
import {
  GitPatchApplicabilityChecker,
  evaluateTestPatch,
} from '../../src/core/policy/patch-policy.js';

const temporaryDirectories: string[] = [];
const alwaysApplies: PatchApplicabilityChecker = {check: () => Promise.resolve(true)};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, {recursive: true, force: true});
    }),
  );
});

const policy = {
  maxPatchBytes: 131_072,
  maxPatchFiles: 4,
  maxAddedLines: 250,
  forbidBinary: true,
  forbidSymlinks: true,
  forbidSubmodules: true,
  requireCurrentHeadPass: true,
};

function candidate(parent = '1'.repeat(40), fix = '2'.repeat(40), head = '3'.repeat(40)) {
  return RecoveryCandidateSchema.parse({
    schemaVersion: 'antibody.candidate/v1',
    candidateId: `sha256:${'a'.repeat(64)}`,
    repository: {slug: 'owner/repo', cloneUrl: 'https://github.com/owner/repo.git'},
    parentSha: parent,
    fixSha: fix,
    headSha: head,
    commit: {
      subject: 'fix: behavior',
      authoredAt: '2026-08-29T00:00:00.000Z',
      changedProductionPaths: ['src/index.js'],
      changedTestPaths: [],
      additions: 1,
      deletions: 1,
      diffSha256: `sha256:${'b'.repeat(64)}`,
    },
    signals: [],
    score: 50,
  });
}

function patchFor(path: string, body = '+test();', metadata = ''): string {
  return [
    `diff --git a/${path} b/${path}`,
    metadata,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1,2 @@',
    ' existing();',
    body,
    '',
  ]
    .filter((line) => line !== '')
    .join('\n') + '\n';
}

async function evaluate(patch: string | Buffer, checker = alwaysApplies) {
  return await evaluateTestPatch(
    {
      repositoryPath: '.',
      candidate: candidate(),
      patchBytes: typeof patch === 'string' ? Buffer.from(patch) : patch,
      policy,
      testGlobs: ['test/**', '**/*.test.js'],
      allowedSupportGlobs: ['fixtures/**'],
    },
    checker,
  );
}

describe('test-only patch policy', () => {
  it('accepts a bounded regular test patch and checks every immutable revision', async () => {
    const revisions: string[] = [];
    const result = await evaluate(patchFor('test/regression.test.js'), {
      check({checkoutSha}) {
        revisions.push(checkoutSha);
        return Promise.resolve(true);
      },
    });

    expect(result.testOnly).toBe(true);
    expect(result.changedPaths).toEqual(['test/regression.test.js']);
    expect(revisions).toEqual(['1'.repeat(40), '2'.repeat(40), '3'.repeat(40)]);
  });

  it.each([
    ['production path', patchFor('src/index.js'), 'PATCH_NOT_TEST_ONLY'],
    ['workflow path', patchFor('.github/workflows/ci.yml'), 'PATCH_WORKFLOW'],
    ['traversal', patchFor('../secret.test.js'), 'PATCH_PATH'],
    ['backslash', patchFor('test\\evil.test.js'), 'PATCH_PATH'],
    ['binary', patchFor('test/a.test.js', '+x', 'GIT binary patch'), 'PATCH_BINARY'],
    ['executable', patchFor('test/a.test.js', '+x', 'new file mode 100755'), 'PATCH_MODE'],
    ['symlink', patchFor('test/a.test.js', '+x', 'new file mode 120000'), 'PATCH_MODE'],
    ['gitlink', patchFor('test/a.test.js', '+x', 'new file mode 160000'), 'PATCH_MODE'],
    [
      'rename',
      [
        'diff --git a/test/a.test.js b/test/b.test.js',
        'similarity index 100%',
        'rename from test/a.test.js',
        'rename to test/b.test.js',
        '',
      ].join('\n'),
      'PATCH_RENAME_COPY',
    ],
    [
      'delete',
      [
        'diff --git a/test/a.test.js b/test/a.test.js',
        'deleted file mode 100644',
        '--- a/test/a.test.js',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-test();',
        '',
      ].join('\n'),
      'PATCH_DELETE',
    ],
  ])('rejects %s', async (_name, patch, code) => {
    const result = await evaluate(patch);
    expect(result.testOnly).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toContain(code);
  });

  it('rejects invalid UTF-8, empty, oversized, file-count, line-count, and support-only patches', async () => {
    const invalidUtf8 = await evaluate(Buffer.from([0xc3, 0x28]));
    expect(invalidUtf8.violations.map((violation) => violation.code)).toContain('PATCH_UTF8');
    expect((await evaluate('')).violations.map((violation) => violation.code)).toContain('PATCH_EMPTY');
    const supportOnly = await evaluate(patchFor('fixtures/case.txt'));
    expect(supportOnly.violations.map((violation) => violation.code)).toContain('PATCH_NO_TEST');

    const manyFiles = Array.from({length: 5}, (_, index) => patchFor(`test/${String(index)}.test.js`)).join('');
    expect((await evaluate(manyFiles)).violations.map((violation) => violation.code)).toContain('PATCH_FILES');

    const manyLines = patchFor('test/a.test.js', Array.from({length: 251}, () => '+x').join('\n'));
    expect((await evaluate(manyLines)).violations.map((violation) => violation.code)).toContain('PATCH_ADDED_LINES');

    const oversized = patchFor('test/a.test.js', `+${'x'.repeat(132_000)}`);
    expect((await evaluate(oversized)).violations.map((violation) => violation.code)).toContain('PATCH_BYTES');
  });

  it('records the exact failing applicability lane', async () => {
    let calls = 0;
    const result = await evaluate(patchFor('test/a.test.js'), {
      check() {
        calls += 1;
        return Promise.resolve(calls !== 2);
      },
    });
    expect(result.violations.map((violation) => violation.code)).toContain('PATCH_APPLY_FIX');
  });

  it('applies the checked-in recovery patch to fixture parent, fix, and head', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'antibody-policy-fixture-'));
    temporaryDirectories.push(repositoryPath);
    await git(repositoryPath, ['init', '--initial-branch=main']);
    await git(repositoryPath, ['fast-import', '--date-format=raw'], await readFile('fixtures/demo-history/history.fi'));
    const expected = JSON.parse(await readFile('fixtures/demo-history/expected.json', 'utf8')) as {
      shas: {docs: string; fix: string; head: string};
    };
    const result = await evaluateTestPatch(
      {
        repositoryPath,
        candidate: candidate(expected.shas.docs, expected.shas.fix, expected.shas.head),
        patchBytes: await readFile('fixtures/demo-history/recovered-test.patch'),
        policy,
        testGlobs: ['test/**'],
        allowedSupportGlobs: [],
      },
      new GitPatchApplicabilityChecker(),
    );
    expect(result.testOnly).toBe(true);
  });
});

async function git(repositoryPath: string, argv: readonly string[], input?: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', argv, {cwd: repositoryPath, shell: false, stdio: ['pipe', 'ignore', 'pipe']});
    const stderr: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(Buffer.concat(stderr).toString('utf8')));
    });
    child.stdin.end(input);
  });
}
