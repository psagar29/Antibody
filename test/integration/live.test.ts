import {execFile} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';

import {afterEach, describe, expect, it} from 'vitest';
import {parse} from 'yaml';

import type {ConfigV1, VerificationExecutionPort} from '../../src/contracts/index.js';
import {
  ClassifiedAttemptSchema,
  ConfigSchema,
  RawVerificationEvidenceSchema,
  RecoveryCandidateSchema,
  VerificationRequestSchema,
} from '../../src/contracts/index.js';
import {renderDefaultConfig} from '../../src/composition/config.js';
import {
  EvidenceSpool,
  HydratingVerificationAdapter,
  buildAuthoringContext,
  requiredEnvironment,
  resolveVerificationEnvironment,
  selectCandidate,
} from '../../src/composition/live.js';
import {
  FileReceiptStore,
  Redactor,
  buildReceipt,
} from '../../src/core/receipts/receipt-store.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const changedEnvironment = new Map<string, string | undefined>();
const sourceEnvironmentName = 'ANTIBODY_TEST_RUNLOOP_SNAPSHOT_ID';
const policyEnvironmentName = 'ANTIBODY_TEST_RUNLOOP_NETWORK_POLICY_ID';

afterEach(async () => {
  for (const [name, value] of changedEnvironment) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
  changedEnvironment.clear();
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, {recursive: true, force: true});
    }),
  );
});

describe('live candidate and environment resolution', () => {
  it('selects the deterministic top-ranked candidate independent of input order', () => {
    const older = candidateFixture('2', 'a', 80, '2026-08-28T00:00:00.000Z');
    const newer = candidateFixture('3', 'b', 80, '2026-08-29T00:00:00.000Z');
    const lowerScore = candidateFixture('1', 'c', 70, '2026-08-30T00:00:00.000Z');

    expect(selectCandidate([lowerScore, older, newer])).toEqual(newer);
    expect(selectCandidate([newer, lowerScore, older])).toEqual(newer);
    expect(selectCandidate([older, newer], newer.fixSha.slice(0, 12))).toEqual(newer);
    expect(selectCandidate([older, newer], `sha256:${newer.candidateId.slice(7, 19)}`)).toEqual(newer);
  });

  it('rejects empty, ambiguous, and duplicate candidate identities', () => {
    const first = candidateFixture('2', 'a', 80, '2026-08-29T00:00:00.000Z');
    const second = candidateFixture('3', 'a', 70, '2026-08-28T00:00:00.000Z');
    expect(() => selectCandidate([first], '  ')).toThrow('Candidate reference must');
    expect(() => selectCandidate([first, second], 'sha256:a')).toThrow('ambiguous');
    expect(() => selectCandidate([first, first])).toThrow('not unique');
  });

  it('resolves config pointers to values without retaining idEnv fields', () => {
    const config = liveConfig();
    setEnvironment(sourceEnvironmentName, 'snapshot-resolved');
    setEnvironment(policyEnvironmentName, 'network-policy-resolved');

    const environment = resolveVerificationEnvironment(config);
    expect(environment).toEqual({
      source: {kind: 'snapshot', id: 'snapshot-resolved'},
      networkPolicyId: 'network-policy-resolved',
      architecture: 'x86_64',
      maxParallel: 2,
    });
    expect(JSON.stringify(environment)).not.toContain('idEnv');

    const blueprintConfig = ConfigSchema.parse({
      ...config,
      verification: {
        ...config.verification,
        environment: {
          ...config.verification.environment,
          source: {kind: 'blueprint', idEnv: sourceEnvironmentName},
        },
      },
    });
    expect(resolveVerificationEnvironment(blueprintConfig).source).toEqual({
      kind: 'blueprint',
      id: 'snapshot-resolved',
    });
  });

  it('requires configured proof pointers but never includes their values in errors', () => {
    const config = liveConfig();
    setEnvironment(sourceEnvironmentName, 'snapshot-sensitive-value');
    setEnvironment(policyEnvironmentName, undefined);
    expect(() => resolveVerificationEnvironment(config)).toThrow(policyEnvironmentName);
    expect(() => resolveVerificationEnvironment(config)).not.toThrow('snapshot-sensitive-value');

    setEnvironment('ANTIBODY_TEST_REQUIRED_SECRET', '   ');
    expect(() => requiredEnvironment('ANTIBODY_TEST_REQUIRED_SECRET')).toThrow(
      'ANTIBODY_TEST_REQUIRED_SECRET',
    );
  });
});

describe('live authoring context', () => {
  it('collects bounded historical source, diff, framework, and relevant nearby tests', async () => {
    const repository = await createContextRepository();
    const config = liveConfig();
    const context = await buildAuthoringContext(
      repository.directory,
      repository.candidate,
      config,
    );

    expect(context.parentFixDiff).toContain("value.replaceAll(' ', '-')");
    expect(context.parentSources).toEqual([
      {path: 'src/slug.ts', content: "export const slug = (value: string) => value.replaceAll(' ', '-');\n"},
    ]);
    expect(context.fixSources).toEqual([
      {path: 'src/slug.ts', content: "export const slug = (value: string) => value.replaceAll(/ +/g, '-');\n"},
    ]);
    expect(context.frameworkConfig).toContain('FILE package.json');
    expect(context.nearbyTests[0]?.path).toBe('test/slug.test.ts');
    expect(context.nearbyTests).toHaveLength(3);
  });

  it('honors cancellation before spawning context Git commands', async () => {
    const repository = await createContextRepository();
    const controller = new AbortController();
    controller.abort(new Error('context cancelled'));
    await expect(
      buildAuthoringContext(
        repository.directory,
        repository.candidate,
        liveConfig(),
        controller.signal,
      ),
    ).rejects.toThrow('context cancelled');
  });
});

describe('durable evidence hydration', () => {
  it('hydrates adapter-omitted content from a safe spool path and completes receipt persistence', async () => {
    const directory = await makeTemporaryDirectory('antibody-live-spool-');
    const spoolDirectory = join(directory, 'spool');
    const spool = new EvidenceSpool(spoolDirectory);
    const artifactBytes = Buffer.alloc(1_048_577, 120);
    const digest = sha256(artifactBytes);
    const request = verificationRequestFixture();
    const evidence = rawEvidenceFixture(request, {
      name: '../../outside/unsafe stdout',
      mediaType: 'text/plain; charset=utf-8',
      sha256: digest,
      sizeBytes: artifactBytes.byteLength,
    });
    const controller = new AbortController();
    const delegate: VerificationExecutionPort = {
      async execute(receivedRequest, options) {
        expect(receivedRequest).toEqual(request);
        expect(options?.signal).toBe(controller.signal);
        await spool.persistArtifact('../../outside/unsafe stdout', artifactBytes);
        return evidence;
      },
    };
    const adapter = new HydratingVerificationAdapter(delegate, spool);

    const hydrated = await adapter.execute(request, {signal: controller.signal});
    expect(
      Buffer.from(hydrated.attempts[0]?.stdout.contentBase64 ?? '', 'base64'),
    ).toEqual(artifactBytes);
    expect(await readdir(join(spoolDirectory, 'artifacts'))).toEqual([
      `${digest.slice('sha256:'.length)}.bin`,
    ]);

    const patch = Buffer.from(request.patch.unifiedDiffBase64, 'base64').toString('utf8');
    const classifications = [ClassifiedAttemptSchema.parse({
      rawAttemptIndex: 0,
      outcome: 'assertion-failure',
      signature: sha256('stable failure'),
      targetTestNames: ['recovers regression'],
      explanation: 'target assertion failed on parent',
      confidence: 'high',
    })];
    const policy = {
      testOnly: true,
      patchSha256: request.patch.sha256,
      sizeBytes: Buffer.byteLength(patch),
      normalizedPatch: patch,
      changedPaths: request.patch.changedPaths,
      allowedGlobs: ['test/**'],
      violations: [],
    };
    const redactor = new Redactor([]);
    const receipt = buildReceipt({
      request,
      evidence: hydrated,
      classifications,
      policy,
      adjudication: {verdict: 'verified', reasonCodes: ['CAUSAL']},
      patchArtifact: {
        name: 'patch.diff',
        mediaType: 'text/x-diff',
        sha256: request.patch.sha256,
        sizeBytes: Buffer.byteLength(patch),
      },
      createdAt: '2026-08-29T00:00:02.000Z',
      redactor,
    });
    const store = new FileReceiptStore({baseDirectory: join(directory, 'runs'), redactor});
    const persisted = await store.persist({
      receipt,
      request,
      evidence: hydrated,
      classifications,
      normalizedPatch: patch,
    });
    await expect(store.verify(persisted.directory)).resolves.toEqual(receipt);
  });

  it('preserves durable bytes when hydration fails', async () => {
    const directory = await makeTemporaryDirectory('antibody-live-spool-failure-');
    const spoolDirectory = join(directory, 'spool');
    const spool = new EvidenceSpool(spoolDirectory);
    const content = Buffer.from('preserve me');
    await spool.persistArtifact('../unsafe', content);
    const request = verificationRequestFixture();
    const evidence = rawEvidenceFixture(request, {
      name: '../unsafe',
      mediaType: 'text/plain',
      sha256: sha256('different content'),
      sizeBytes: content.byteLength,
    });
    const delegate: VerificationExecutionPort = {execute: () => Promise.resolve(evidence)};

    await expect(
      new HydratingVerificationAdapter(delegate, spool).execute(request),
    ).rejects.toThrow('missing from durable spool');
    expect(await readFile(
      join(spoolDirectory, 'artifacts', `${sha256(content).slice(7)}.bin`),
    )).toEqual(content);
  });
});

function liveConfig(): ConfigV1 {
  const base = ConfigSchema.parse(parse(renderDefaultConfig('node-test')));
  return ConfigSchema.parse({
    ...base,
    verification: {
      ...base.verification,
      environment: {
        ...base.verification.environment,
        source: {kind: 'snapshot', idEnv: sourceEnvironmentName},
        networkPolicyIdEnv: policyEnvironmentName,
      },
    },
  });
}

function candidateFixture(
  fixDigit: string,
  candidateDigit: string,
  score: number,
  authoredAt: string,
) {
  return RecoveryCandidateSchema.parse({
    schemaVersion: 'antibody.candidate/v1',
    candidateId: `sha256:${candidateDigit.repeat(64)}`,
    repository: {slug: 'owner/repo', cloneUrl: 'https://github.com/owner/repo.git'},
    parentSha: '1'.repeat(40),
    fixSha: fixDigit.repeat(40),
    headSha: 'f'.repeat(40),
    commit: {
      subject: 'fix: regression',
      authoredAt,
      changedProductionPaths: ['src/slug.ts'],
      changedTestPaths: [],
      additions: 1,
      deletions: 1,
      diffSha256: `sha256:${'d'.repeat(64)}`,
    },
    signals: [],
    score,
  });
}

async function createContextRepository() {
  const directory = await makeTemporaryDirectory('antibody-live-context-');
  await runGit(directory, ['init', '--quiet']);
  await runGit(directory, ['config', 'user.name', 'Antibody Test']);
  await runGit(directory, ['config', 'user.email', 'antibody@example.invalid']);
  await writeFile(join(directory, 'package.json'), '{"type":"module","scripts":{"test":"node --test"}}\n');
  await writeRepositoryFile(
    directory,
    'src/slug.ts',
    "export const slug = (value: string) => value.replaceAll(' ', '-');\n",
  );
  await writeRepositoryFile(directory, 'test/aaa.test.ts', "test('aaa', () => {});\n");
  await writeRepositoryFile(directory, 'test/slug.test.ts', "test('slug', () => {});\n");
  await writeRepositoryFile(directory, 'test/zzz.test.ts', "test('zzz', () => {});\n");
  await writeRepositoryFile(directory, 'test/other.test.ts', "test('other', () => {});\n");
  await runGit(directory, ['add', '--all']);
  await runGit(directory, ['commit', '--quiet', '-m', 'base']);
  const parentSha = await gitHead(directory);
  await writeRepositoryFile(
    directory,
    'src/slug.ts',
    "export const slug = (value: string) => value.replaceAll(/ +/g, '-');\n",
  );
  await runGit(directory, ['add', '--all']);
  await runGit(directory, ['commit', '--quiet', '-m', 'fix: repeated spaces']);
  const fixSha = await gitHead(directory);
  return {
    directory,
    candidate: RecoveryCandidateSchema.parse({
      schemaVersion: 'antibody.candidate/v1',
      candidateId: sha256(`owner/repo\u0000${parentSha}\u0000${fixSha}`),
      repository: {slug: 'owner/repo', cloneUrl: 'https://github.com/owner/repo.git'},
      parentSha,
      fixSha,
      headSha: fixSha,
      commit: {
        subject: 'fix: repeated spaces',
        authoredAt: '2026-08-29T00:00:00.000Z',
        changedProductionPaths: ['src/slug.ts'],
        changedTestPaths: [],
        additions: 1,
        deletions: 1,
        diffSha256: sha256('diff'),
      },
      signals: [],
      score: 90,
    }),
  };
}

function verificationRequestFixture() {
  const candidate = candidateFixture('2', 'a', 90, '2026-08-29T00:00:00.000Z');
  const patch = 'diff --git a/test/slug.test.ts b/test/slug.test.ts\n';
  return VerificationRequestSchema.parse({
    schemaVersion: 'antibody.verification-request/v1',
    runId: randomUUID(),
    candidate,
    patch: {
      unifiedDiffBase64: Buffer.from(patch).toString('base64'),
      sha256: sha256(patch),
      changedPaths: ['test/slug.test.ts'],
    },
    environment: {source: {kind: 'snapshot', id: 'snapshot-1'}, maxParallel: 2},
    commands: {
      setup: [],
      baseline: {argv: ['node', '--test'], cwd: '.', env: {}, timeoutMs: 60_000},
      targeted: {argv: ['node', '--test'], cwd: '.', env: {}, timeoutMs: 60_000},
    },
    report: {format: 'tap'},
    repetitions: 2,
  });
}

function rawEvidenceFixture(
  request: ReturnType<typeof verificationRequestFixture>,
  artifact: {
    readonly name: string;
    readonly mediaType: string;
    readonly sha256: ReturnType<typeof sha256>;
    readonly sizeBytes: number;
  },
) {
  return RawVerificationEvidenceSchema.parse({
    schemaVersion: 'antibody.raw-evidence/v1',
    runId: request.runId,
    candidateId: request.candidate.candidateId,
    patchSha256: request.patch.sha256,
    environmentEquivalence: {
      equivalent: true,
      comparedFields: ['resolvedSnapshotId'],
      mismatchFields: [],
    },
    attempts: [{
      lane: 'parent',
      phase: 'candidate',
      attempt: 0,
      checkoutSha: request.candidate.parentSha,
      patchSha256: request.patch.sha256,
      command: request.commands.targeted,
      startedAt: '2026-08-29T00:00:00.000Z',
      finishedAt: '2026-08-29T00:00:01.000Z',
      durationMs: 1_000,
      termination: 'exited',
      exitCode: 1,
      stdout: artifact,
      stderr: artifact,
      provider: {devboxId: 'devbox-1', resolvedSnapshotId: 'snapshot-1'},
    }],
    cleanup: [{devboxId: 'devbox-1', requested: true, completed: true}],
  });
}

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeRepositoryFile(
  directory: string,
  path: string,
  content: string,
): Promise<void> {
  const segments = path.split('/');
  const filename = segments.pop();
  if (filename === undefined) throw new Error('Test fixture path has no filename');
  const parent = join(directory, ...segments);
  await mkdir(parent, {recursive: true});
  await writeFile(join(parent, filename), content);
}

async function runGit(directory: string, argv: readonly string[]): Promise<void> {
  await execFileAsync('git', [...argv], {cwd: directory});
}

async function gitHead(directory: string): Promise<string> {
  const result = await execFileAsync('git', ['rev-parse', 'HEAD'], {cwd: directory});
  return result.stdout.trim();
}

function setEnvironment(name: string, value: string | undefined): void {
  if (!changedEnvironment.has(name)) changedEnvironment.set(name, process.env[name]);
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
