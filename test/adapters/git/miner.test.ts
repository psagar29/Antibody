import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import type {ConfigV1} from '../../../src/contracts/index.js';
import {GitHistoryMiner} from '../../../src/core/mining/miner.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, {recursive: true, force: true});
    }),
  );
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

async function importFixture(): Promise<string> {
  const repositoryPath = await mkdtemp(join(tmpdir(), 'antibody-miner-test-'));
  temporaryDirectories.push(repositoryPath);
  await git(repositoryPath, ['init', '--initial-branch=main']);
  await git(
    repositoryPath,
    ['fast-import', '--date-format=raw'],
    await readFile('fixtures/demo-history/history.fi'),
  );
  return repositoryPath;
}

const scan: ConfigV1['scan'] = {
  maxCommits: 20,
  includeProduction: ['src/**'],
  testGlobs: ['test/**'],
  allowedSupportGlobs: ['fixtures/**'],
  excludeGlobs: ['vendor/**', 'dist/**'],
  maxChangedFiles: 12,
  maxChangedLines: 400,
  excludeMerges: true,
  requireNoTestChanges: true,
};

describe('GitHistoryMiner', () => {
  it('finds and deterministically ranks the source-only fix', async () => {
    const repositoryPath = await importFixture();
    const expected = JSON.parse(
      await readFile('fixtures/demo-history/expected.json', 'utf8'),
    ) as {candidateId: string; candidateOrder: string[]};
    const miner = new GitHistoryMiner();

    const candidates = await miner.scan({
      repositoryPath,
      repository: {
        slug: 'antibody/demo-history',
        cloneUrl: 'https://github.com/antibody/demo-history.git',
      },
      scan,
    });

    expect(candidates.map((candidate) => candidate.fixSha)).toEqual(expected.candidateOrder);
    expect(candidates[0]?.candidateId).toBe(expected.candidateId);
    expect(candidates[0]?.commit.changedTestPaths).toEqual([]);
    expect(candidates[0]?.signals.map((signal) => signal.code)).toContain('BUG_WORD');
    expect(candidates[0]?.signals.map((signal) => signal.code)).not.toContain('PRESENT_AT_HEAD');
    expect(candidates[1]?.signals.map((signal) => signal.code)).toContain('PRESENT_AT_HEAD');
  });

  it('hard-rejects documentation-only history even under an overly broad production glob', async () => {
    const repositoryPath = await importFixture();
    const candidates = await new GitHistoryMiner().scan({
      repositoryPath,
      repository: {
        slug: 'antibody/demo-history',
        cloneUrl: 'https://github.com/antibody/demo-history.git',
      },
      scan: {...scan, includeProduction: ['**']},
    });
    expect(candidates.map((entry) => entry.commit.subject)).not.toContain('docs: explain slug output');
  });

  it('hard-rejects test-touching commits even when the legacy flag is false', async () => {
    const repositoryPath = await importFixture();
    await git(repositoryPath, ['checkout', 'main']);
    await writeFile(join(repositoryPath, 'src/slug.js'), 'export const slugify = (value) => value.trim();\n');
    await writeFile(join(repositoryPath, 'test/slug.test.js'), '// changed alongside production\n');
    await git(repositoryPath, ['add', 'src/slug.js', 'test/slug.test.js']);
    await git(repositoryPath, [
      '-c',
      'user.name=Antibody Fixture',
      '-c',
      'user.email=fixture@antibody.invalid',
      'commit',
      '-m',
      'fix: mixed production and test change',
    ]);

    const candidates = await new GitHistoryMiner().scan({
      repositoryPath,
      repository: {
        slug: 'antibody/demo-history',
        cloneUrl: 'https://github.com/antibody/demo-history.git',
      },
      scan: {...scan, requireNoTestChanges: false},
    });

    expect(candidates.map((entry) => entry.commit.subject)).not.toContain(
      'fix: mixed production and test change',
    );
  });

  it('keeps optional enrichment cached and non-authoritative on failure', async () => {
    const repositoryPath = await importFixture();
    let calls = 0;
    const miner = new GitHistoryMiner({
      enrichment: {
        getForCommit() {
          calls += 1;
          return Promise.reject(new Error('rate limited'));
        },
      },
    });
    const options = {
      repositoryPath,
      repository: {
        slug: 'antibody/demo-history',
        cloneUrl: 'https://github.com/antibody/demo-history.git',
      },
      scan,
    };

    const first = await miner.scan(options);
    const second = await miner.scan(options);

    expect(first).toEqual(second);
    expect(calls).toBe(2);
  });

  it('rejects merge, binary, dependency-only, oversized, and rename candidates', async () => {
    const repositoryPath = await importFixture();
    await git(repositoryPath, ['checkout', 'main']);

    await writeFile(join(repositoryPath, 'src/blob.bin'), Buffer.from([0, 1, 2, 0, 3]));
    await commitAll(repositoryPath, 'fix: binary behavior');

    await writeFile(join(repositoryPath, 'package.json'), '{"name":"fixture"}\n');
    await commitAll(repositoryPath, 'fix: dependency metadata');

    await writeFile(
      join(repositoryPath, 'src/large.js'),
      `${Array.from({length: 401}, (_, index) => `export const line${String(index)} = ${String(index)};`).join('\n')}\n`,
    );
    await commitAll(repositoryPath, 'fix: oversized behavior');

    await git(repositoryPath, ['mv', 'src/slug.js', 'src/slug-renamed.js']);
    await commitAll(repositoryPath, 'fix: rename behavior');

    await git(repositoryPath, ['switch', '-c', 'merge-source']);
    await writeFile(
      join(repositoryPath, 'src/slug-renamed.js'),
      'export const slugify = (value) => value.trim().toLowerCase();\n',
    );
    await commitAll(repositoryPath, 'fix: branch behavior');
    await git(repositoryPath, ['switch', 'main']);
    await writeFile(join(repositoryPath, 'merge-note.md'), 'force a real merge\n');
    await commitAll(repositoryPath, 'docs: prepare merge');
    await git(repositoryPath, [
      '-c',
      'user.name=Antibody Fixture',
      '-c',
      'user.email=fixture@antibody.invalid',
      'merge',
      '--no-ff',
      'merge-source',
      '-m',
      'fix: merge behavior',
    ]);

    const candidates = await new GitHistoryMiner().scan({
      repositoryPath,
      repository: {
        slug: 'antibody/demo-history',
        cloneUrl: 'https://github.com/antibody/demo-history.git',
      },
      scan: {...scan, includeProduction: ['**']},
    });
    const subjects = candidates.map((entry) => entry.commit.subject);
    expect(subjects).not.toContain('fix: binary behavior');
    expect(subjects).not.toContain('fix: dependency metadata');
    expect(subjects).not.toContain('fix: oversized behavior');
    expect(subjects).not.toContain('fix: rename behavior');
    expect(subjects).not.toContain('fix: merge behavior');
  });
});

async function commitAll(repositoryPath: string, subject: string): Promise<void> {
  await git(repositoryPath, ['add', '--all']);
  await git(repositoryPath, [
    '-c',
    'user.name=Antibody Fixture',
    '-c',
    'user.email=fixture@antibody.invalid',
    'commit',
    '-m',
    subject,
  ]);
}
