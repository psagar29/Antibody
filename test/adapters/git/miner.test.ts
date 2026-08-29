import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
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
});
