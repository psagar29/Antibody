import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {access, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import type {
  AgentInvocationV1,
  AgentSessionPort,
  ArtifactV1,
  CommandSpecV1,
  RawExecutionAttemptV1,
  RawVerificationEvidenceV1,
  ReceiptV1,
  VerificationExecutionPort,
  VerificationRequestV1,
} from '../contracts/index.js';
import {
  AgentInvocationResultSchema,
  ArtifactSchema,
  RawExecutionAttemptSchema,
  RawVerificationEvidenceSchema,
  RepoPathSchema,
} from '../contracts/index.js';
import {GitHistoryMiner} from '../core/mining/miner.js';
import {RecoveryCoordinator} from '../core/recover.js';
import {FileReceiptStore, Redactor} from '../core/receipts/receipt-store.js';

const fixtureRepository = {
  slug: 'antibody/demo-history',
  cloneUrl: 'https://github.com/antibody/demo-history.git',
} as const;

export interface OfflineDemoResult {
  readonly simulated: true;
  readonly receipt: ReceiptV1;
  readonly receiptSha256: string;
  readonly directory: string;
}

export async function runOfflineFixtureDemo(options: {
  readonly outputDirectory: string;
}): Promise<OfflineDemoResult> {
  const fixtureDirectory = await findFixtureDirectory();
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'antibody-offline-demo-'));
  const repositoryPath = join(temporaryRoot, 'repository');
  try {
    await runProcess('git', ['init', '--initial-branch=main', repositoryPath], temporaryRoot);
    await runProcess(
      'git',
      ['fast-import', '--date-format=raw'],
      repositoryPath,
      await readFile(join(fixtureDirectory, 'history.fi')),
    );
    const expected = JSON.parse(
      await readFile(join(fixtureDirectory, 'expected.json'), 'utf8'),
    ) as {candidateId: string; shas: {fix: string}; verdict: string};
    const patch = await readFile(join(fixtureDirectory, 'recovered-test.patch'), 'utf8');
    const candidates = await new GitHistoryMiner().scan({
      repositoryPath,
      repository: fixtureRepository,
      scan: {
        maxCommits: 20,
        includeProduction: ['src/**'],
        testGlobs: ['test/**'],
        allowedSupportGlobs: ['fixtures/**'],
        excludeGlobs: ['vendor/**', 'dist/**'],
        maxChangedFiles: 12,
        maxChangedLines: 400,
        excludeMerges: true,
        requireNoTestChanges: true,
      },
    });
    const candidate = candidates.find((entry) => entry.fixSha === expected.shas.fix);
    if (candidate?.candidateId !== expected.candidateId) {
      throw new Error('Offline fixture candidate does not match checked-in expectations');
    }
    const agent = fixtureAgent(patch, candidate.candidateId);
    const verifier = new LocalFixtureVerificationAdapter(repositoryPath, temporaryRoot);
    const command = {
      argv: ['node', '--test', '--test-reporter=tap', 'test/slug.test.js'],
      cwd: RepoPathSchema.parse('.'),
      env: {},
      timeoutMs: 30_000,
    } satisfies CommandSpecV1;
    const result = await new RecoveryCoordinator({agent, verifier}).recover({
      repositoryPath,
      candidate,
      context: {
        commitMessage: candidate.commit.subject,
        parentFixDiff: 'Trusted deterministic fixture diff.',
        parentSources: [],
        fixSources: [],
        frameworkConfig: 'node:test with TAP reporter',
        nearbyTests: [],
      },
      authoringBudget: {
        maxAttempts: 1,
        timeoutMs: 30_000,
        maxOutputBytes: 262_144,
        maxPromptBytes: 65_536,
      },
      patchPolicy: {
        maxPatchBytes: 262_144,
        maxPatchFiles: 4,
        maxAddedLines: 100,
        forbidBinary: true,
        forbidSymlinks: true,
        forbidSubmodules: true,
        requireCurrentHeadPass: true,
      },
      testGlobs: ['test/**'],
      allowedSupportGlobs: [],
      verificationPlan: {
        environment: {source: {kind: 'snapshot', id: 'offline-fixture'}, maxParallel: 1},
        commands: {setup: [], baseline: command, targeted: command, fullSuite: command},
        report: {format: 'tap'},
        repetitions: 2,
      },
      targetTestNames: ['collapses repeated whitespace'],
    });
    if (result.receipt.verdict !== expected.verdict) {
      throw new Error('Offline fixture did not produce the expected verified verdict');
    }
    const store = new FileReceiptStore({
      baseDirectory: resolve(options.outputDirectory),
      redactor: new Redactor([]),
    });
    const persisted = await store.persist({
      receipt: result.receipt,
      request: result.request,
      evidence: result.evidence,
      classifications: result.classifications,
      normalizedPatch: result.policy.normalizedPatch,
    });
    await store.verify(persisted.directory);
    return {
      simulated: true,
      receipt: result.receipt,
      receiptSha256: result.receiptSha256,
      directory: persisted.directory,
    };
  } finally {
    await rm(temporaryRoot, {recursive: true, force: true});
  }
}

class LocalFixtureVerificationAdapter implements VerificationExecutionPort {
  readonly #repositoryPath: string;
  readonly #temporaryRoot: string;

  constructor(repositoryPath: string, temporaryRoot: string) {
    this.#repositoryPath = repositoryPath;
    this.#temporaryRoot = temporaryRoot;
  }

  async execute(request: VerificationRequestV1): Promise<RawVerificationEvidenceV1> {
    const attempts: RawExecutionAttemptV1[] = [];
    const cleanup: {devboxId: string; requested: boolean; completed: boolean; errorCode?: string}[] = [];
    const specs: {
      lane: RawExecutionAttemptV1['lane'];
      phase: RawExecutionAttemptV1['phase'];
      repetitions: number;
      command: CommandSpecV1;
      applyPatch: boolean;
    }[] = [
      {lane: 'parent', phase: 'baseline', repetitions: 1, command: request.commands.baseline, applyPatch: false},
      {lane: 'fix', phase: 'baseline', repetitions: 1, command: request.commands.baseline, applyPatch: false},
      {lane: 'parent', phase: 'candidate', repetitions: request.repetitions, command: request.commands.targeted, applyPatch: true},
      {lane: 'fix', phase: 'candidate', repetitions: request.repetitions, command: request.commands.targeted, applyPatch: true},
      {lane: 'head', phase: 'candidate', repetitions: 1, command: request.commands.targeted, applyPatch: true},
      ...(request.commands.fullSuite === undefined
        ? []
        : [{lane: 'head' as const, phase: 'full-suite' as const, repetitions: 1, command: request.commands.fullSuite, applyPatch: true}]),
    ];
    let attemptIndex = 0;
    for (const spec of specs) {
      for (let repetition = 0; repetition < spec.repetitions; repetition += 1) {
        const devboxId = `offline-${spec.lane}-${spec.phase}-${String(repetition)}`;
        const worktreePath = join(this.#temporaryRoot, devboxId);
        let cleanupCompleted: boolean;
        try {
          const checkoutSha = laneSha(request, spec.lane);
          await runProcess(
            'git',
            ['worktree', 'add', '--detach', worktreePath, checkoutSha],
            this.#repositoryPath,
          );
          if (spec.applyPatch) {
            const patchPath = join(this.#temporaryRoot, `${devboxId}.patch`);
            await writeFile(
              patchPath,
              Buffer.from(request.patch.unifiedDiffBase64, 'base64'),
              {mode: 0o600},
            );
            await runProcess(
              'git',
              ['apply', '--recount', '--whitespace=nowarn', patchPath],
              worktreePath,
            );
          }
          const startedAt = new Date().toISOString();
          const startedMs = Date.now();
          const execution = await runProcess(
            spec.command.argv[0],
            spec.command.argv.slice(1),
            join(worktreePath, spec.command.cwd),
            undefined,
            spec.command.timeoutMs,
          );
          const finishedAt = new Date().toISOString();
          const stdout = artifact('stdout', execution.stdout);
          const stderr = artifact('stderr', execution.stderr);
          attempts.push(RawExecutionAttemptSchema.parse({
            lane: spec.lane,
            phase: spec.phase,
            attempt: attemptIndex,
            checkoutSha,
            ...(spec.applyPatch ? {patchSha256: request.patch.sha256} : {}),
            command: spec.command,
            startedAt,
            finishedAt,
            durationMs: Math.max(0, Date.now() - startedMs),
            termination: execution.timedOut ? 'timed-out' : 'exited',
            exitCode: execution.exitCode,
            stdout,
            stderr,
            ...(spec.phase === 'candidate' ? {report: artifact('report', execution.stdout)} : {}),
            provider: {devboxId},
          }));
          attemptIndex += 1;
        } finally {
          try {
            await runProcess(
              'git',
              ['worktree', 'remove', '--force', worktreePath],
              this.#repositoryPath,
            );
            cleanupCompleted = true;
          } catch {
            cleanupCompleted = false;
          }
          cleanup.push({
            devboxId,
            requested: true,
            completed: cleanupCompleted,
            ...(cleanupCompleted ? {} : {errorCode: 'OFFLINE_WORKTREE_CLEANUP'}),
          });
        }
      }
    }
    return RawVerificationEvidenceSchema.parse({
      schemaVersion: 'antibody.raw-evidence/v1',
      runId: request.runId,
      candidateId: request.candidate.candidateId,
      patchSha256: request.patch.sha256,
      environmentEquivalence: {
        equivalent: true,
        comparedFields: ['offline-fixture', 'node-version', 'command-plan'],
        mismatchFields: [],
      },
      attempts,
      reflex: {name: 'reflex', agentId: 'offline-fixture'},
      cleanup,
    });
  }
}

function fixtureAgent(patch: string, candidateId: string): AgentSessionPort {
  return {
    invoke(request: AgentInvocationV1) {
      return Promise.resolve(AgentInvocationResultSchema.parse({
        schemaVersion: 'antibody.agent-result/v1',
        invocationId: request.invocationId,
        continuationId: 'offline-fixture',
        finalText: JSON.stringify({
          schemaVersion: 'antibody.agent-output/v1',
          candidateId,
          patchBase64: Buffer.from(patch, 'utf8').toString('base64'),
          testCommandHint: ['node', '--test', '--test-reporter=tap', 'test/slug.test.js'],
          summary: 'Adds the deterministic repeated-whitespace regression test.',
        }),
        provider: {name: 'reflex', agentId: 'offline-fixture'},
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      }));
    },
    stop() {
      return Promise.resolve();
    },
  };
}

function laneSha(request: VerificationRequestV1, lane: RawExecutionAttemptV1['lane']): string {
  if (lane === 'parent') return request.candidate.parentSha;
  if (lane === 'fix') return request.candidate.fixSha;
  return request.candidate.headSha;
}

function artifact(name: string, bytes: Buffer): ArtifactV1 {
  const bounded = bytes.subarray(0, 512 * 1024);
  return ArtifactSchema.parse({
    name,
    mediaType: 'text/plain; charset=utf-8',
    sha256: `sha256:${createHash('sha256').update(bounded).digest('hex')}`,
    sizeBytes: bounded.byteLength,
    contentBase64: bounded.toString('base64'),
  });
}

async function findFixtureDirectory(): Promise<string> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, '../fixtures/demo-history'),
    resolve(moduleDirectory, '../../fixtures/demo-history'),
    resolve(process.cwd(), 'fixtures/demo-history'),
  ];
  for (const candidate of candidates) {
    try {
      await access(join(candidate, 'history.fi'));
      return candidate;
    } catch {
      // Continue to the next package/source layout.
    }
  }
  throw new Error('Cannot locate packaged deterministic fixture');
}

async function runProcess(
  command: string | undefined,
  argv: readonly string[],
  cwd: string,
  input?: Buffer,
  timeoutMs = 30_000,
): Promise<{stdout: Buffer; stderr: Buffer; exitCode: number | null; timedOut: boolean}> {
  if (command === undefined || command === '') throw new Error('Command argv is empty');
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, argv, {
      cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode: code,
        timedOut,
      };
      if (!timedOut && code !== 0 && command === 'git') {
        reject(new Error(`git ${argv[0] ?? ''} failed: ${result.stderr.toString('utf8').slice(0, 4096)}`));
        return;
      }
      resolvePromise(result);
    });
    child.stdin.end(input);
  });
}
