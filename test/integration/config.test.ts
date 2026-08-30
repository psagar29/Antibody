import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';
import {parse} from 'yaml';

import {ConfigSchema} from '../../src/contracts/index.js';
import {
  configPath,
  loadConfig,
  renderDefaultConfig,
  writeConfig,
} from '../../src/composition/config.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, {recursive: true, force: true});
    }),
  );
});

describe('configuration', () => {
  it.each(['node-test', 'ava', 'vitest', 'jest', 'pytest'] as const)(
    'renders a strict %s preset without secret values',
    (preset) => {
      const text = renderDefaultConfig(preset);
      const config = ConfigSchema.parse(parse(text));
      expect(config.authoring.personaIdEnv).toMatch(/_ID$/u);
      expect(text).not.toContain('apiKey');
      expect(text).not.toContain('secret');
    },
  );

  it('writes, loads, and refuses to overwrite without --force semantics', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'antibody-config-'));
    temporaryDirectories.push(directory);
    const text = renderDefaultConfig('node-test');
    expect(await writeConfig(directory, text, false)).toBe(configPath(directory));
    await expect(writeConfig(directory, text, false)).rejects.toMatchObject({
      code: 'ANTB_INPUT_INVALID',
    });
    expect(await loadConfig(directory)).toEqual(ConfigSchema.parse(parse(text)));
    expect(await readFile(configPath(directory), 'utf8')).toBe(text);
  });
});
