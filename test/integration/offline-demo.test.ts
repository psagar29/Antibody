import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {runOfflineFixtureDemo} from '../../src/composition/offline-demo.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, {recursive: true, force: true});
    }),
  );
});

describe('offline fixture demo', () => {
  it('runs the trusted fixture through authoring, proof, receipt persistence, and verification', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'antibody-demo-output-'));
    temporaryDirectories.push(outputDirectory);
    const result = await runOfflineFixtureDemo({outputDirectory});
    expect(result.simulated).toBe(true);
    expect(result.receipt.verdict).toBe('verified');
    expect(result.receiptSha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.receipt.evidence.cleanup.every((entry) => entry.completed)).toBe(true);
  }, 30_000);
});
