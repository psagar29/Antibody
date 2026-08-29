import {describe, expect, it} from 'vitest';

import {
  AntibodyError,
  ConfigSchema,
  FullGitShaSchema,
  RecoveryCandidateSchema,
  RepoPathSchema,
  Sha256Schema,
  exitCodeByErrorCode,
} from '../../src/contracts/index.js';

const sha = '0123456789abcdef0123456789abcdef01234567';
const digest = `sha256:${'a'.repeat(64)}`;

const validCandidate = {
  schemaVersion: 'antibody.candidate/v1',
  candidateId: digest,
  repository: {
    slug: 'psagar29/Antibody',
    cloneUrl: 'https://github.com/psagar29/Antibody.git',
  },
  parentSha: sha,
  fixSha: sha,
  headSha: sha,
  commit: {
    subject: 'Fix an edge case',
    authoredAt: '2026-08-29T12:00:00Z',
    changedProductionPaths: ['src/index.ts'],
    changedTestPaths: [],
    additions: 2,
    deletions: 1,
    diffSha256: digest,
  },
  signals: [{code: 'BUG_WORD', weight: 10, evidence: 'Commit subject says fix'}],
  score: 10,
};

describe('contract primitives', () => {
  it('accepts only full lowercase Git SHAs', () => {
    expect(FullGitShaSchema.parse(sha)).toBe(sha);
    expect(() => FullGitShaSchema.parse('abc')).toThrow();
    expect(() => FullGitShaSchema.parse(sha.toUpperCase())).toThrow();
  });

  it('accepts only prefixed lowercase SHA-256 values', () => {
    expect(Sha256Schema.parse(digest)).toBe(digest);
    expect(() => Sha256Schema.parse('a'.repeat(64))).toThrow();
  });

  it.each([
    '../secret',
    'src/../secret',
    '/tmp/file',
    'C:/tmp/file',
    'src\\file.ts',
    'src//file.ts',
    'src/',
    `src/${String.fromCodePoint(0)}file.ts`,
  ])(
    'rejects unsafe repository path %s',
    (candidate) => {
      expect(() => RepoPathSchema.parse(candidate)).toThrow();
    },
  );
});

describe('versioned contracts', () => {
  it('parses a valid recovery candidate', () => {
    expect(RecoveryCandidateSchema.parse(validCandidate)).toEqual(validCandidate);
  });

  it('rejects unknown fields', () => {
    expect(() => RecoveryCandidateSchema.parse({...validCandidate, surprise: true})).toThrow();
  });

  it('rejects non-UTC timestamps', () => {
    const candidate = {
      ...validCandidate,
      commit: {...validCandidate.commit, authoredAt: '2026-08-29T05:00:00-07:00'},
    };
    expect(() => RecoveryCandidateSchema.parse(candidate)).toThrow();
  });

  it('keeps provider and publication choices intentionally narrow', () => {
    const minimalConfig = {
      schemaVersion: 'antibody.config/v1',
      repository: {baseBranch: 'main'},
      scan: {
        maxCommits: 100,
        includeProduction: ['src/**'],
        testGlobs: ['test/**'],
        allowedSupportGlobs: ['fixtures/**'],
        excludeGlobs: ['vendor/**'],
        maxChangedFiles: 20,
        maxChangedLines: 500,
        excludeMerges: true,
        requireNoTestChanges: true,
      },
      authoring: {
        provider: 'reflex',
        personaIdEnv: 'REFLEX_PERSONA_ID',
        maxAttempts: 3,
        timeoutMs: 60_000,
        maxOutputBytes: 100_000,
      },
      verification: {
        provider: 'runloop',
        environment: {
          source: {kind: 'blueprint', idEnv: 'RUNLOOP_BLUEPRINT_ID'},
          maxParallel: 2,
        },
        repetitions: 3,
        commands: {
          setup: [],
          baseline: {argv: ['pnpm', 'test'], cwd: '.', env: {}, timeoutMs: 60_000},
          targeted: {argv: ['pnpm', 'test'], cwd: '.', env: {}, timeoutMs: 60_000},
        },
        report: {format: 'vitest-json'},
      },
      policy: {
        maxPatchBytes: 100_000,
        maxPatchFiles: 10,
        maxAddedLines: 1_000,
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
        labels: ['tests'],
      },
    };

    expect(ConfigSchema.parse(minimalConfig)).toMatchObject(minimalConfig);
    expect(() =>
      ConfigSchema.parse({
        ...minimalConfig,
        authoring: {...minimalConfig.authoring, provider: 'tenor'},
      }),
    ).toThrow();
  });
});

describe('stable errors', () => {
  it('maps every success and failure code to a documented process exit code', () => {
    expect(exitCodeByErrorCode.ANTB_OK).toBe(0);
    expect(exitCodeByErrorCode.ANTB_INTERNAL).toBe(70);
    expect(Object.keys(exitCodeByErrorCode)).toHaveLength(13);
  });

  it('preserves safe structured metadata', () => {
    const error = new AntibodyError('Invalid config', {
      code: 'ANTB_INPUT_INVALID',
      category: 'input',
      retryable: false,
      causeCode: 'INVALID_YAML',
      details: {line: 3},
    });

    expect(error).toMatchObject({
      name: 'AntibodyError',
      code: 'ANTB_INPUT_INVALID',
      category: 'input',
      retryable: false,
      causeCode: 'INVALID_YAML',
      details: {line: 3},
    });
  });
});
