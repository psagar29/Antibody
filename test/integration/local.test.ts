import {execFile} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';

import {afterEach, describe, expect, it} from 'vitest';
import {parse} from 'yaml';

import {ConfigSchema} from '../../src/contracts/index.js';
import {renderDefaultConfig} from '../../src/composition/config.js';
import {
  doctor,
  parseGitHubRepositorySlug,
  resolveRepositoryRef,
} from '../../src/composition/local.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {recursive: true, force: true})));
});

describe('local repository resolution', () => {
  it.each([
    ['https://github.com/owner/repo.git', 'owner/repo'],
    ['git@github.com:owner/repo.git', 'owner/repo'],
    ['ssh://git@github.com/owner/repo', 'owner/repo'],
  ])('accepts credential-free GitHub remote %s', (remote, expected) => {
    expect(parseGitHubRepositorySlug(remote)).toBe(expected);
  });

  it('never reports credentials embedded in an unsupported origin URL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'antibody-local-'));
    temporaryDirectories.push(directory);
    await execFileAsync('git', ['init', '--quiet'], {cwd: directory});
    await execFileAsync(
      'git',
      ['remote', 'add', 'origin', 'https://sensitive-token@github.com/owner/repo.git'],
      {cwd: directory},
    );
    const report = await doctor(directory);
    expect(report.remote).toBe('[configured but unsupported]');
    expect(JSON.stringify(report)).not.toContain('sensitive-token');
  });

  it('normalizes an SSH origin to the frozen HTTPS repository contract', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'antibody-local-'));
    temporaryDirectories.push(directory);
    await execFileAsync('git', ['init', '--quiet'], {cwd: directory});
    await execFileAsync('git', ['remote', 'add', 'origin', 'git@github.com:owner/repo.git'], {cwd: directory});
    const config = ConfigSchema.parse(parse(renderDefaultConfig('node-test')));
    await expect(resolveRepositoryRef(directory, config)).resolves.toEqual({
      slug: 'owner/repo',
      cloneUrl: 'https://github.com/owner/repo.git',
    });
  });
});
