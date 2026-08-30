import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {runCli} from '../../src/cli/run.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {recursive: true, force: true})));
});

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {write(value: string) { stdout += value; }},
      stderr: {write(value: string) { stderr += value; }},
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe('CLI', () => {
  it('reports the package version without starting provider integrations', async () => {
    const output = capture();
    expect(await runCli(['--version'], output.io)).toBe(0);
    expect(output.stdout()).toBe('0.1.0\n');
    expect(output.stderr()).toBe('');
  });

  it('initializes and diagnoses a repository without exposing secret values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'antibody-cli-'));
    temporaryDirectories.push(directory);
    const initialized = capture();
    expect(await runCli(['init', directory, '--preset', 'node-test'], initialized.io)).toBe(0);

    const diagnosed = capture();
    expect(await runCli(['doctor', directory, '--json'], diagnosed.io)).toBe(0);
    const report = JSON.parse(diagnosed.stdout()) as {
      configValid: boolean;
      liveReady: boolean;
      credentials: Record<string, boolean>;
    };
    expect(report.configValid).toBe(true);
    expect(report.liveReady).toBe(false);
    expect(report.credentials).toMatchObject({REFLEX_API_KEY: false, RUNLOOP_API_KEY: false});
    expect(diagnosed.stdout()).not.toContain('undefined');
  });

  it('fails a missing receipt closed with a stable input error', async () => {
    const output = capture();
    expect(await runCli(['receipt', 'verify', '/definitely/missing/antibody-run', '--json'], output.io)).toBe(2);
    expect(JSON.parse(output.stderr())).toMatchObject({
      error: {code: 'ANTB_INPUT_INVALID', causeCode: 'RECEIPT_INTEGRITY'},
    });
  });
});
