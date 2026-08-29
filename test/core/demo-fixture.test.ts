import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {buildDemoFixture, buildFixtureStream} from '../../scripts/build-demo-fixture.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, {recursive: true, force: true});
    }),
  );
});

describe('deterministic demo history', () => {
  it('renders byte-identical fast-import input', () => {
    expect(buildFixtureStream()).toBe(buildFixtureStream());
    expect(buildFixtureStream()).toContain('fix: collapse repeated whitespace in slugs');
  });

  it('rebuilds the checked-in SHAs and regression patch exactly', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'antibody-fixture-test-'));
    temporaryDirectories.push(outputDirectory);

    const expected = await buildDemoFixture(outputDirectory);
    const checkedInExpected = JSON.parse(
      await readFile('fixtures/demo-history/expected.json', 'utf8'),
    ) as unknown;
    const checkedInPatch = await readFile('fixtures/demo-history/recovered-test.patch', 'utf8');
    const rebuiltPatch = await readFile(join(outputDirectory, 'recovered-test.patch'), 'utf8');

    expect(expected).toEqual(checkedInExpected);
    expect(rebuiltPatch).toBe(checkedInPatch);
    expect(expected.candidateOrder).toHaveLength(2);
    expect(expected.verdict).toBe('verified');
  });
});
