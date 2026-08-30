import {constants as fileConstants} from 'node:fs';
import {access, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';

import {parse, stringify} from 'yaml';

import type {CommandSpecV1, ConfigV1} from '../contracts/index.js';
import {AntibodyError, ConfigSchema, RepoPathSchema} from '../contracts/index.js';

export type ConfigPreset = 'node-test' | 'ava' | 'vitest' | 'jest' | 'pytest';

export function configPath(repositoryPath: string): string {
  return join(resolve(repositoryPath), '.antibody.yml');
}

export function renderDefaultConfig(preset: ConfigPreset): string {
  return stringify(createDefaultConfig(preset), {lineWidth: 0});
}

export async function writeConfig(
  repositoryPath: string,
  contents: string,
  force: boolean,
): Promise<string> {
  const path = configPath(repositoryPath);
  if (!force && await pathExists(path)) {
    throw inputError('.antibody.yml already exists; use --force to replace it');
  }
  await writeFile(path, contents, {encoding: 'utf8', flag: force ? 'w' : 'wx', mode: 0o600});
  return path;
}

export async function loadConfig(repositoryPath: string): Promise<ConfigV1> {
  const path = configPath(repositoryPath);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error: unknown) {
    throw inputError(`Cannot read ${path}`, error);
  }
  let value: unknown;
  try {
    value = parse(text);
  } catch (error: unknown) {
    throw inputError(`${path} is not valid YAML`, error);
  }
  const parsed = ConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw inputError(`${path} does not match antibody.config/v1`, parsed.error);
  }
  return parsed.data;
}

function createDefaultConfig(preset: ConfigPreset): ConfigV1 {
  const presetValues = commandPreset(preset);
  return ConfigSchema.parse({
    schemaVersion: 'antibody.config/v1',
    repository: {baseBranch: 'main'},
    scan: {
      maxCommits: 250,
      includeProduction: ['src/**', 'lib/**', 'app/**', '**/*.{js,jsx,ts,tsx,py}'],
      testGlobs: presetValues.testGlobs,
      allowedSupportGlobs: ['fixtures/**', 'test/fixtures/**', 'tests/fixtures/**'],
      excludeGlobs: ['node_modules/**', 'vendor/**', 'dist/**', 'build/**', 'generated/**'],
      maxChangedFiles: 20,
      maxChangedLines: 1_000,
      excludeMerges: true,
      requireNoTestChanges: true,
    },
    authoring: {
      provider: 'reflex',
      personaIdEnv: 'ANTIBODY_REFLEX_PERSONA_ID',
      maxAttempts: 3,
      timeoutMs: 300_000,
      maxOutputBytes: 1_048_576,
    },
    verification: {
      provider: 'runloop',
      environment: {
        source: {kind: 'snapshot', idEnv: 'ANTIBODY_RUNLOOP_SNAPSHOT_ID'},
        networkPolicyIdEnv: 'ANTIBODY_RUNLOOP_NETWORK_POLICY_ID',
        architecture: 'x86_64',
        maxParallel: 2,
      },
      repetitions: 2,
      commands: {
        setup: [],
        baseline: presetValues.command,
        targeted: presetValues.command,
        fullSuite: presetValues.command,
      },
      report: presetValues.report,
    },
    policy: {
      maxPatchBytes: 262_144,
      maxPatchFiles: 8,
      maxAddedLines: 500,
      forbidBinary: true,
      forbidSymlinks: true,
      forbidSubmodules: true,
      requireCurrentHeadPass: true,
    },
    publication: {
      provider: 'github',
      tokenEnv: 'GITHUB_TOKEN',
      draft: true,
      branchPrefix: 'antibody/',
      labels: ['tests', 'antibody'],
    },
  });
}

function commandPreset(preset: ConfigPreset): {
  readonly command: CommandSpecV1;
  readonly testGlobs: readonly string[];
  readonly report: ConfigV1['verification']['report'];
} {
  const common = {cwd: RepoPathSchema.parse('.'), env: {}, timeoutMs: 600_000};
  switch (preset) {
    case 'node-test':
      return {
        command: {...common, argv: ['node', '--test', '--test-reporter=tap']},
        testGlobs: ['test/**', 'tests/**', '**/*.test.{js,ts}'],
        report: {format: 'tap'},
      };
    case 'ava':
      return {
        command: {...common, argv: ['npx', 'ava', '--tap']},
        testGlobs: ['test/**', 'tests/**', '**/*.test.{js,ts}'],
        report: {format: 'tap'},
      };
    case 'vitest':
      return {
        command: {...common, argv: ['npx', 'vitest', 'run', '--reporter=json']},
        testGlobs: ['test/**', 'tests/**', '**/*.{test,spec}.{js,jsx,ts,tsx}'],
        report: {format: 'vitest-json'},
      };
    case 'jest':
      return {
        command: {...common, argv: ['npx', 'jest', '--json']},
        testGlobs: ['test/**', 'tests/**', '__tests__/**', '**/*.{test,spec}.{js,jsx,ts,tsx}'],
        report: {format: 'jest-json'},
      };
    case 'pytest':
      return {
        command: {...common, argv: ['pytest', '-q']},
        testGlobs: ['test/**', 'tests/**', '**/test_*.py', '**/*_test.py'],
        report: {format: 'pytest-text'},
      };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fileConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function inputError(message: string, cause?: unknown): AntibodyError {
  return new AntibodyError(message, {
    code: 'ANTB_INPUT_INVALID',
    category: 'input',
    retryable: false,
    ...(cause === undefined ? {} : {cause}),
  });
}
