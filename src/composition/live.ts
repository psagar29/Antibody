import {createHash, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir, readFile, rm} from 'node:fs/promises';
import {posix, join, resolve} from 'node:path';

import ignore from 'ignore';

import {createReflexAgentSessionAdapter} from '../adapters/reflex/index.js';
import {createRunloopVerificationAdapter} from '../adapters/runloop/index.js';
import type {
  ArtifactV1,
  ConfigV1,
  OperationOptions,
  RawVerificationEvidenceV1,
  RecoveryCandidateV1,
  RepoPath,
  Sha256,
  VerificationExecutionPort,
  VerificationRequestV1,
} from '../contracts/index.js';
import {
  AntibodyError,
  ArtifactSchema,
  RawVerificationEvidenceSchema,
  RepoPathSchema,
  Sha256Schema,
} from '../contracts/index.js';
import type {AuthoringContextFile, AuthoringContextV1} from '../core/authoring/authoring.js';
import {GitHistoryMiner} from '../core/mining/miner.js';
import {rankRecoveryCandidates} from '../core/ranking/ranker.js';
import {RecoveryCoordinator, type RecoverCandidateResult} from '../core/recover.js';
import {FileAtomicWriter, FileReceiptStore, Redactor} from '../core/receipts/receipt-store.js';

import {loadConfig} from './config.js';
import {resolveRepositoryRef} from './local.js';

const contextFileLimit = 128 * 1024;
const contextDiffLimit = 512 * 1024;
const contextSourceFileLimit = 12;
const contextTreeLimit = 2 * 1024 * 1024;
const gitErrorLimit = 8 * 1024;
const maximumHydratedArtifactBytes = 1_125_000;
const frameworkFiles = [
  'package.json',
  'vitest.config.ts',
  'vitest.config.js',
  'jest.config.ts',
  'jest.config.js',
  'ava.config.js',
  'pyproject.toml',
  'pytest.ini',
  'pom.xml',
  'build.gradle',
] as const;

export interface LiveRecoveryResult extends RecoverCandidateResult {
  readonly directory: string;
}

export interface LiveRecoveryOptions {
  readonly repositoryPath: string;
  readonly candidateRef?: string;
  readonly outputDirectory?: string;
  readonly signal?: AbortSignal;
}

export async function runLiveRecovery(options: LiveRecoveryOptions): Promise<LiveRecoveryResult> {
  const repositoryPath = resolve(options.repositoryPath);
  const config = await loadConfig(repositoryPath);
  const repository = await resolveRepositoryRef(repositoryPath, config);
  const candidates = await new GitHistoryMiner().scan({
    repositoryPath,
    repository,
    scan: config.scan,
    ...(options.signal === undefined ? {} : {signal: options.signal}),
  });
  const candidate = selectCandidate(candidates, options.candidateRef);
  const context = await buildAuthoringContext(
    repositoryPath,
    candidate,
    config,
    options.signal,
  );
  const credentials = resolveCredentials(config);
  const redactor = new Redactor(credentials.secretValues);
  const spoolDirectory = join(repositoryPath, '.antibody', 'spool', randomUUID());
  const spool = new EvidenceSpool(spoolDirectory);
  const verifier = new HydratingVerificationAdapter(
    createRunloopVerificationAdapter({
      apiKey: credentials.runloopApiKey,
      ...(credentials.githubToken === undefined ? {} : {githubToken: credentials.githubToken}),
      persistArtifact: (name, content) => spool.persistArtifact(name, content),
      persistRawEvidence: (evidence) => spool.persistRawEvidence(evidence),
      literalSecrets: credentials.secretValues,
    }),
    spool,
  );
  const agent = createReflexAgentSessionAdapter({
    baseUrl: credentials.reflexBaseUrl,
    apiKey: credentials.reflexApiKey,
    organizationId: credentials.reflexOrganizationId,
    personaId: credentials.reflexPersonaId,
    requestTimeoutMs: config.authoring.timeoutMs,
    literalSecrets: credentials.secretValues,
  });
  const coordinator = new RecoveryCoordinator({agent, verifier});
  const verificationEnvironment = resolveVerificationEnvironment(config);
  const verificationCommands = {
    setup: config.verification.commands.setup,
    baseline: config.verification.commands.baseline,
    targeted: config.verification.commands.targeted,
    ...(config.verification.commands.fullSuite === undefined
      ? {}
      : {fullSuite: config.verification.commands.fullSuite}),
  };
  const result = await coordinator.recover({
    repositoryPath,
    candidate,
    context,
    authoringBudget: {
      maxAttempts: config.authoring.maxAttempts,
      timeoutMs: config.authoring.timeoutMs,
      maxOutputBytes: config.authoring.maxOutputBytes,
      maxPromptBytes: 1_048_576,
    },
    patchPolicy: config.policy,
    testGlobs: config.scan.testGlobs,
    allowedSupportGlobs: config.scan.allowedSupportGlobs,
    verificationPlan: {
      environment: verificationEnvironment,
      commands: verificationCommands,
      report: config.verification.report,
      repetitions: config.verification.repetitions,
    },
    ...(options.signal === undefined ? {} : {signal: options.signal}),
    redactor,
  });
  const store = new FileReceiptStore({
    baseDirectory: resolve(options.outputDirectory ?? join(repositoryPath, '.antibody', 'runs')),
    redactor,
  });
  const persisted = await store.persist({
    receipt: result.receipt,
    request: result.request,
    evidence: result.evidence,
    classifications: result.classifications,
    normalizedPatch: result.policy.normalizedPatch,
  });
  await store.verify(persisted.directory);
  await rm(spoolDirectory, {recursive: true, force: true});
  return {...result, directory: persisted.directory};
}

export function selectCandidate(
  candidates: readonly RecoveryCandidateV1[],
  candidateRef?: string,
): RecoveryCandidateV1 {
  if (candidates.length === 0) throw inputError('No eligible production-only fix candidates found');
  if (candidateRef === undefined) {
    const selected = rankRecoveryCandidates(candidates)[0];
    if (selected === undefined) {
      throw inputError('No eligible production-only fix candidates found');
    }
    const duplicates = candidates.filter((candidate) =>
      candidate.fixSha === selected.fixSha || candidate.candidateId === selected.candidateId,
    );
    if (duplicates.length !== 1) throw inputError('Top candidate identity is not unique');
    return selected;
  }
  const reference = candidateRef.trim().toLowerCase();
  const candidateIdReference = reference.startsWith('sha256:');
  const normalized = candidateIdReference ? reference.slice('sha256:'.length) : reference;
  const maximumLength = candidateIdReference ? 64 : 40;
  if (normalized.length === 0 || normalized.length > maximumLength || !/^[0-9a-f]+$/u.test(normalized)) {
    throw inputError('Candidate reference must be a lowercase Git SHA or sha256 digest prefix');
  }
  const matches = candidates.filter((candidate) => candidateIdReference
    ? candidate.candidateId.slice('sha256:'.length).startsWith(normalized)
    : candidate.fixSha.startsWith(normalized));
  if (matches.length === 0) throw inputError('Candidate reference did not match an eligible fix');
  if (matches.length > 1) throw inputError('Candidate reference is ambiguous');
  const selected = matches[0];
  if (selected === undefined) throw inputError('Candidate reference did not resolve uniquely');
  return selected;
}

export async function buildAuthoringContext(
  repositoryPath: string,
  candidate: RecoveryCandidateV1,
  config: ConfigV1,
  signal?: AbortSignal,
): Promise<AuthoringContextV1> {
  signal?.throwIfAborted();
  const sourcePaths = [...candidate.commit.changedProductionPaths]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, contextSourceFileLimit);
  const rawParentFixDiff = await gitText(
    repositoryPath,
    ['diff', '--no-ext-diff', '--no-color', candidate.parentSha, candidate.fixSha, '--', ...sourcePaths],
    contextDiffLimit,
    signal,
  );
  const parentFixDiff = sourcePaths.length === candidate.commit.changedProductionPaths.length
    ? rawParentFixDiff
    : `[Context limited to ${String(sourcePaths.length)} of ${String(candidate.commit.changedProductionPaths.length)} changed production files.]\n${rawParentFixDiff}`;
  const parentSources = await readRevisionFiles(
    repositoryPath,
    candidate.parentSha,
    sourcePaths,
    false,
    signal,
  );
  const fixSources = await readRevisionFiles(
    repositoryPath,
    candidate.fixSha,
    sourcePaths,
    false,
    signal,
  );
  const frameworkConfigFiles = await readRevisionFiles(
    repositoryPath,
    candidate.fixSha,
    frameworkFiles.map((path) => RepoPathSchema.parse(path)),
    true,
    signal,
  );
  const paths = (await gitText(
    repositoryPath,
    ['ls-tree', '-r', '-z', '--name-only', candidate.fixSha, '--'],
    contextTreeLimit,
    signal,
  )).split('\u0000').filter(Boolean);
  const testMatcher = ignore({allowRelativePaths: true}).add(config.scan.testGlobs);
  const nearbyPaths = paths
    .filter((path) => testMatcher.ignores(path))
    .sort((left, right) => compareTestRelevance(left, right, sourcePaths))
    .slice(0, 3)
    .map((path) => RepoPathSchema.parse(path));
  const nearbyTests = await readRevisionFiles(
    repositoryPath,
    candidate.fixSha,
    nearbyPaths,
    true,
    signal,
  );
  return {
    commitMessage: candidate.commit.subject,
    parentFixDiff,
    parentSources,
    fixSources,
    frameworkConfig: frameworkConfigFiles
      .map((file) => `FILE ${file.path}\n${file.content}`)
      .join('\n\n'),
    nearbyTests,
  };
}

export function resolveVerificationEnvironment(
  config: ConfigV1,
): VerificationRequestV1['environment'] {
  const configured = config.verification.environment;
  const id = requiredEnvironment(configured.source.idEnv);
  const source: VerificationRequestV1['environment']['source'] = configured.source.kind === 'blueprint'
    ? {kind: 'blueprint', id}
    : {kind: 'snapshot', id};
  const networkPolicyId = configured.networkPolicyIdEnv === undefined
    ? undefined
    : requiredEnvironment(configured.networkPolicyIdEnv);
  return {
    source,
    ...(networkPolicyId === undefined ? {} : {networkPolicyId}),
    ...(configured.architecture === undefined ? {} : {architecture: configured.architecture}),
    maxParallel: configured.maxParallel,
  };
}

interface ResolvedCredentials {
  readonly reflexApiKey: string;
  readonly reflexBaseUrl: string;
  readonly reflexOrganizationId: string;
  readonly reflexPersonaId: string;
  readonly runloopApiKey: string;
  readonly githubToken?: string;
  readonly secretValues: readonly string[];
}

function resolveCredentials(config: ConfigV1): ResolvedCredentials {
  const reflexApiKey = requiredEnvironment('REFLEX_API_KEY');
  const reflexBaseUrl = requiredEnvironment('REFLEX_BASE_URL');
  const reflexOrganizationId = requiredEnvironment('REFLEX_ORGANIZATION_ID');
  const reflexPersonaId = requiredEnvironment(config.authoring.personaIdEnv);
  const runloopApiKey = requiredEnvironment('RUNLOOP_API_KEY');
  const githubToken = optionalEnvironment(config.publication.tokenEnv);
  return {
    reflexApiKey,
    reflexBaseUrl,
    reflexOrganizationId,
    reflexPersonaId,
    runloopApiKey,
    ...(githubToken === undefined ? {} : {githubToken}),
    secretValues: [
      reflexApiKey,
      reflexBaseUrl,
      reflexOrganizationId,
      reflexPersonaId,
      runloopApiKey,
      githubToken,
    ]
      .filter((value): value is string => value !== undefined),
  };
}

export function requiredEnvironment(name: string): string {
  const value = optionalEnvironment(name);
  if (value === undefined) throw inputError(`Required environment variable is missing: ${name}`);
  return value;
}

function optionalEnvironment(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value;
}

async function readRevisionFiles(
  repositoryPath: string,
  revision: string,
  paths: readonly RepoPath[],
  allowMissing = false,
  signal?: AbortSignal,
): Promise<AuthoringContextFile[]> {
  const files: AuthoringContextFile[] = [];
  for (const path of paths) {
    signal?.throwIfAborted();
    try {
      files.push({
        path,
        content: await gitText(
          repositoryPath,
          ['show', `${revision}:${path}`],
          contextFileLimit,
          signal,
        ),
      });
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error;
      if (!allowMissing) throw error;
    }
  }
  return files;
}

async function gitText(
  repositoryPath: string,
  argv: readonly string[],
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  return await new Promise((resolvePromise, reject) => {
    const child = spawn('git', argv, {cwd: repositoryPath, shell: false, stdio: ['ignore', 'pipe', 'pipe']});
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let outputExceeded = false;
    const finishWithError = (error: Error): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      child.kill('SIGKILL');
      reject(error);
    };
    const onAbort = (): void => {
      const reason: unknown = signal?.reason;
      finishWithError(
        reason instanceof Error ? reason : new Error('Git context collection was aborted'),
      );
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxBytes) {
        outputExceeded = true;
        child.kill('SIGKILL');
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > gitErrorLimit) {
        outputExceeded = true;
        child.kill('SIGKILL');
      } else {
        stderr.push(chunk);
      }
    });
    child.once('error', finishWithError);
    child.once('close', (code, terminationSignal) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (outputExceeded) {
        reject(inputError(`Git context exceeds ${String(maxBytes)} bytes`));
      } else if (code !== 0) {
        reject(inputError(`git ${argv[0] ?? 'command'} failed (${terminationSignal ?? String(code)}): ${Buffer.concat(stderr).toString('utf8').trim().slice(0, 512)}`));
      } else {
        resolvePromise(Buffer.concat(stdout).toString('utf8'));
      }
    });
    signal?.addEventListener('abort', onAbort, {once: true});
    if (signal?.aborted === true) onAbort();
  });
}

export class EvidenceSpool {
  readonly #directory: string;
  readonly #writer = new FileAtomicWriter();

  constructor(directory: string) {
    this.#directory = resolve(directory);
  }

  async persistArtifact(_name: string, content: Uint8Array): Promise<void> {
    const bytes = Buffer.from(content);
    const digest = digestBytes(bytes);
    await mkdir(join(this.#directory, 'artifacts'), {recursive: true, mode: 0o700});
    await this.#writer.write(this.#artifactPath(digest), bytes);
  }

  async persistRawEvidence(evidence: RawVerificationEvidenceV1): Promise<void> {
    await mkdir(this.#directory, {recursive: true, mode: 0o700});
    await this.#writer.write(
      join(this.#directory, 'raw-evidence.latest.json'),
      Buffer.from(`${JSON.stringify(evidence)}\n`, 'utf8'),
    );
  }

  async hydrate(artifactInput: ArtifactV1): Promise<ArtifactV1> {
    const artifact = ArtifactSchema.parse(artifactInput);
    const content = artifact.contentBase64 === undefined
      ? await this.#readArtifact(artifact)
      : Buffer.from(artifact.contentBase64, 'base64');
    if (content.byteLength !== artifact.sizeBytes || digestBytes(content) !== artifact.sha256) {
      throw new Error(`Runloop artifact metadata does not match durable content: ${artifact.name}`);
    }
    if (content.byteLength > maximumHydratedArtifactBytes) {
      throw new Error(`Runloop artifact exceeds frozen durable-content limit: ${artifact.name}`);
    }
    return ArtifactSchema.parse({...artifact, contentBase64: content.toString('base64')});
  }

  #artifactPath(digest: Sha256): string {
    return join(
      this.#directory,
      'artifacts',
      `${digest.slice('sha256:'.length)}.bin`,
    );
  }

  async #readArtifact(artifact: ArtifactV1): Promise<Buffer> {
    try {
      return await readFile(this.#artifactPath(artifact.sha256));
    } catch (error: unknown) {
      throw new Error(`Runloop artifact missing from durable spool: ${artifact.name}`, {cause: error});
    }
  }
}

export class HydratingVerificationAdapter implements VerificationExecutionPort {
  readonly #delegate: VerificationExecutionPort;
  readonly #spool: EvidenceSpool;

  constructor(delegate: VerificationExecutionPort, spool: EvidenceSpool) {
    this.#delegate = delegate;
    this.#spool = spool;
  }

  async execute(
    request: VerificationRequestV1,
    options?: OperationOptions,
  ): Promise<RawVerificationEvidenceV1> {
    const evidence = await this.#delegate.execute(request, options);
    const attempts = await Promise.all(evidence.attempts.map(async (attempt) => ({
      ...attempt,
      stdout: await this.#spool.hydrate(attempt.stdout),
      stderr: await this.#spool.hydrate(attempt.stderr),
      ...(attempt.report === undefined
        ? {}
        : {report: await this.#spool.hydrate(attempt.report)}),
    })));
    return RawVerificationEvidenceSchema.parse({
      ...evidence,
      attempts,
    });
  }
}

function digestBytes(bytes: Uint8Array): Sha256 {
  return Sha256Schema.parse(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
}

function compareTestRelevance(
  left: string,
  right: string,
  sourcePaths: readonly RepoPath[],
): number {
  const scoreDifference = testRelevance(right, sourcePaths) - testRelevance(left, sourcePaths);
  return scoreDifference === 0 ? left.localeCompare(right) : scoreDifference;
}

function testRelevance(testPath: string, sourcePaths: readonly RepoPath[]): number {
  const testSegments = testPath.toLowerCase().split('/');
  const testStem = pathStem(testPath);
  return sourcePaths.reduce((best, sourcePath) => {
    const sourceSegments = sourcePath.toLowerCase().split('/');
    const sourceStem = pathStem(sourcePath);
    let commonSegments = 0;
    for (const segment of sourceSegments.slice(0, -1)) {
      if (testSegments.includes(segment)) commonSegments += 1;
    }
    const stemScore = sourceStem !== 'index' && testStem === sourceStem ? 1_000 : 0;
    return Math.max(best, stemScore + commonSegments * 10);
  }, 0);
}

function pathStem(path: string): string {
  return posix.basename(path)
    .toLowerCase()
    .replace(/\.[^.]+$/u, '')
    .replace(/\.(?:test|spec)$/u, '');
}

function inputError(message: string): AntibodyError {
  return new AntibodyError(message, {
    code: 'ANTB_INPUT_INVALID',
    category: 'input',
    retryable: false,
  });
}
