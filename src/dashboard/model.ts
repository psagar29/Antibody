import {constants as fileConstants} from 'node:fs';
import {lstat, open, readdir, readFile, realpath, stat} from 'node:fs/promises';
import {basename, isAbsolute, join, relative} from 'node:path';

import type {
  ClassifiedAttemptV1,
  RawExecutionAttemptV1,
  RawVerificationEvidenceV1,
  ReceiptV1,
} from '../contracts/index.js';
import {RawVerificationEvidenceSchema, ReceiptSchema} from '../contracts/index.js';
import {
  FileReceiptStore,
  Redactor,
  receiptDigest,
} from '../core/receipts/receipt-store.js';

const REQUIRED_RUN_FILES = [
  'candidate.json',
  'patch.diff',
  'raw-evidence.json',
  'classified-evidence.json',
  'receipt.json',
  'receipt.sha256',
] as const;

const RUN_LOAD_CONCURRENCY = 8;

export interface DashboardRunSummary {
  readonly runId: string;
  readonly verdict: ReceiptV1['verdict'];
  readonly repository: string;
  readonly subject: string;
  readonly createdAt: string;
  readonly candidateId: string;
  readonly parentSha: string;
  readonly fixSha: string;
  readonly headSha: string;
  readonly patchSha256: string;
  readonly receiptSha256: string;
  readonly reasonCodes: readonly string[];
  readonly attemptCount: number;
  readonly totalCostUsd?: number;
  readonly detailUrl: string;
}

export interface DashboardArtifact {
  readonly key: string;
  readonly label: string;
  readonly name: string;
  readonly mediaType: string;
  readonly sha256?: string;
  readonly sizeBytes: number;
  readonly url: string;
}

export interface DashboardAttempt {
  readonly index: number;
  readonly lane: RawExecutionAttemptV1['lane'];
  readonly phase: RawExecutionAttemptV1['phase'];
  readonly attempt: number;
  readonly checkoutSha: string;
  readonly patchSha256?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly termination: RawExecutionAttemptV1['termination'];
  readonly exitCode: number | null;
  readonly outcome?: ClassifiedAttemptV1['outcome'];
  readonly targetTestNames: readonly string[];
  readonly explanation?: string;
  readonly confidence?: ClassifiedAttemptV1['confidence'];
  readonly artifacts: readonly DashboardArtifact[];
}

export interface DashboardRunDetail extends DashboardRunSummary {
  readonly patch: ReceiptV1['patch'];
  readonly policy: ReceiptV1['policy'];
  readonly environment: ReceiptV1['environment'];
  readonly costs: ReceiptV1['costs'];
  readonly cleanup: ReceiptV1['evidence']['cleanup'];
  readonly attempts: readonly DashboardAttempt[];
  readonly files: readonly DashboardArtifact[];
}

export interface DashboardIndex {
  readonly runs: readonly DashboardRunSummary[];
  readonly invalidRunCount: number;
}

interface FileSpec {
  readonly key: string;
  readonly label: string;
  readonly relativePath: string;
  readonly name: string;
  readonly contentType: string;
  readonly mediaType: string;
  readonly sha256?: string;
  readonly sizeBytes: number;
}

interface VerifiedRun {
  readonly receipt: ReceiptV1;
  readonly evidence: RawVerificationEvidenceV1;
  readonly files: readonly FileSpec[];
}

export interface DashboardFile {
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly name: string;
}

export class RunNotFoundError extends Error {}
export class RunIntegrityError extends Error {}
export class RunFileNotFoundError extends Error {}

export class DashboardRepository {
  readonly #rootDirectory: string;
  readonly #receiptStore: FileReceiptStore;

  private constructor(rootDirectory: string) {
    this.#rootDirectory = rootDirectory;
    this.#receiptStore = new FileReceiptStore({
      baseDirectory: rootDirectory,
      redactor: new Redactor([]),
    });
  }

  static async open(runsDirectory: string): Promise<DashboardRepository> {
    const rootDirectory = await realpath(runsDirectory);
    const rootStat = await stat(rootDirectory);
    if (!rootStat.isDirectory()) throw new Error('runsDirectory must be a directory');
    return new DashboardRepository(rootDirectory);
  }

  async list(): Promise<DashboardIndex> {
    const entries = await readdir(this.#rootDirectory, {withFileTypes: true});
    const directoryNames = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const results = await mapConcurrent(directoryNames, RUN_LOAD_CONCURRENCY, async (runId) => {
      try {
        return {run: await this.#loadVerifiedRun(runId)} as const;
      } catch {
        return {invalid: true} as const;
      }
    });
    const runs = results
      .flatMap((result) => ('run' in result ? [this.#summary(result.run)] : []))
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) || left.runId.localeCompare(right.runId),
      );
    return {
      runs,
      invalidRunCount: results.filter((result) => 'invalid' in result).length,
    };
  }

  async detail(runId: string): Promise<DashboardRunDetail> {
    const verified = await this.#loadVerifiedRun(runId);
    const classifications = new Map(
      verified.receipt.classifications.map((classification) => [
        classification.rawAttemptIndex,
        classification,
      ]),
    );
    const attempts = verified.evidence.attempts.map((attempt, index) => {
      const classification = classifications.get(index);
      const artifacts = [
        this.#artifactForAttempt(verified, index, 'stdout', attempt.stdout),
        this.#artifactForAttempt(verified, index, 'stderr', attempt.stderr),
        ...(attempt.report === undefined
          ? []
          : [this.#artifactForAttempt(verified, index, 'report', attempt.report)]),
      ];
      return {
        index,
        lane: attempt.lane,
        phase: attempt.phase,
        attempt: attempt.attempt,
        checkoutSha: attempt.checkoutSha,
        ...(attempt.patchSha256 === undefined ? {} : {patchSha256: attempt.patchSha256}),
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt,
        durationMs: attempt.durationMs,
        termination: attempt.termination,
        exitCode: attempt.exitCode,
        ...(classification === undefined
          ? {targetTestNames: []}
          : {
              outcome: classification.outcome,
              targetTestNames: classification.targetTestNames,
              explanation: classification.explanation,
              confidence: classification.confidence,
            }),
        artifacts,
      } satisfies DashboardAttempt;
    });
    return {
      ...this.#summary(verified),
      patch: verified.receipt.patch,
      policy: verified.receipt.policy,
      environment: verified.receipt.environment,
      costs: verified.receipt.costs,
      cleanup: verified.receipt.evidence.cleanup,
      attempts,
      files: verified.files
        .filter((file) => !file.relativePath.startsWith('artifacts/'))
        .map((file) => this.#publicArtifact(runId, file)),
    };
  }

  async readFile(runId: string, key: string): Promise<DashboardFile> {
    const verified = await this.#loadVerifiedRun(runId);
    const file = verified.files.find((candidate) => candidate.key === key);
    if (file === undefined) throw new RunFileNotFoundError('Unknown run file');
    const path = join(this.#rootDirectory, runId, file.relativePath);
    await this.#assertRegularFile(path);
    let handle;
    try {
      handle = await open(path, fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW);
      return {
        bytes: await handle.readFile(),
        contentType: file.contentType,
        name: file.name,
      };
    } finally {
      await handle?.close();
    }
  }

  async #loadVerifiedRun(runId: string): Promise<VerifiedRun> {
    if (!isRunId(runId)) throw new RunNotFoundError('Run not found');
    const runDirectory = join(this.#rootDirectory, runId);
    let runStat;
    try {
      runStat = await lstat(runDirectory);
    } catch {
      throw new RunNotFoundError('Run not found');
    }
    if (!runStat.isDirectory() || runStat.isSymbolicLink()) {
      throw new RunIntegrityError('Run directory is not a regular directory');
    }
    await this.#assertInsideRoot(runDirectory);
    try {
      await Promise.all(
        REQUIRED_RUN_FILES.map(async (name) => this.#assertRegularFile(join(runDirectory, name))),
      );
      const artifactsDirectory = join(runDirectory, 'artifacts');
      const artifactDirectoryStat = await lstat(artifactsDirectory);
      if (!artifactDirectoryStat.isDirectory() || artifactDirectoryStat.isSymbolicLink()) {
        throw new Error('Invalid artifacts directory');
      }
      await this.#assertInsideRoot(artifactsDirectory);
      const artifactEntries = await readdir(artifactsDirectory, {withFileTypes: true});
      if (artifactEntries.some((entry) => entry.isSymbolicLink())) {
        throw new Error('Symbolic links are not allowed in run artifacts');
      }

      const receipt = await this.#receiptStore.verify(runDirectory);
      if (receipt.runId !== runId) throw new Error('Run directory does not match receipt identity');
      const rawEvidenceValue = JSON.parse(
        await readFile(join(runDirectory, 'raw-evidence.json'), 'utf8'),
      ) as unknown;
      const evidence = RawVerificationEvidenceSchema.parse(rawEvidenceValue);
      const files = this.#fileSpecs(receipt, evidence);
      await Promise.all(
        files.map(async (file) => this.#assertRegularFile(join(runDirectory, file.relativePath))),
      );
      return {receipt, evidence, files};
    } catch (error: unknown) {
      throw new RunIntegrityError('Run failed integrity verification', {cause: error});
    }
  }

  #summary(verified: VerifiedRun): DashboardRunSummary {
    const {receipt, evidence} = verified;
    const totalCostUsd = sumDefined(receipt.costs.modelUsd, receipt.costs.runloopUsd);
    return {
      runId: receipt.runId,
      verdict: receipt.verdict,
      repository: receipt.candidate.repository.slug,
      subject: receipt.candidate.commit.subject,
      createdAt: receipt.createdAt,
      candidateId: receipt.candidate.candidateId,
      parentSha: receipt.candidate.parentSha,
      fixSha: receipt.candidate.fixSha,
      headSha: receipt.candidate.headSha,
      patchSha256: receipt.patch.sha256,
      receiptSha256: receiptDigest(receipt),
      reasonCodes: receipt.reasonCodes,
      attemptCount: evidence.attempts.length,
      ...(totalCostUsd === undefined ? {} : {totalCostUsd}),
      detailUrl: `/api/runs/${encodeURIComponent(receipt.runId)}`,
    };
  }

  #fileSpecs(receipt: ReceiptV1, evidence: RawVerificationEvidenceV1): FileSpec[] {
    const runFiles: FileSpec[] = [
      this.#baseFile('receipt', 'Canonical receipt', 'receipt.json', 'application/json; charset=utf-8'),
      this.#baseFile('receipt-digest', 'Receipt digest', 'receipt.sha256', 'text/plain; charset=utf-8'),
      this.#baseFile('candidate', 'Candidate', 'candidate.json', 'application/json; charset=utf-8'),
      this.#baseFile('patch', 'Test patch', 'patch.diff', 'text/x-diff; charset=utf-8'),
      this.#baseFile('raw-evidence', 'Raw evidence', 'raw-evidence.json', 'application/json; charset=utf-8'),
      this.#baseFile(
        'classified-evidence',
        'Classified evidence',
        'classified-evidence.json',
        'application/json; charset=utf-8',
      ),
    ];
    const evidenceFiles = evidence.attempts.flatMap((attempt, index) => [
      this.#attemptFile(index, 'stdout', attempt.stdout),
      this.#attemptFile(index, 'stderr', attempt.stderr),
      ...(attempt.report === undefined ? [] : [this.#attemptFile(index, 'report', attempt.report)]),
    ]);
    if (evidenceFiles.length !== receipt.evidence.artifacts.length) {
      throw new Error('Artifact manifest length mismatch');
    }
    return [...runFiles, ...evidenceFiles];
  }

  #baseFile(key: string, label: string, relativePath: string, contentType: string): FileSpec {
    return {
      key,
      label,
      relativePath,
      name: basename(relativePath),
      contentType,
      mediaType: contentType.split(';', 1)[0] ?? 'application/octet-stream',
      sizeBytes: 0,
    };
  }

  #attemptFile(
    index: number,
    kind: 'stdout' | 'stderr' | 'report',
    artifact: RawExecutionAttemptV1['stdout'],
  ): FileSpec {
    const filename = `${String(index)}-${kind}.bin`;
    return {
      key: `attempt-${String(index)}-${kind}`,
      label: `${kind} · attempt ${String(index + 1)}`,
      relativePath: `artifacts/${filename}`,
      name: filename,
      contentType: safeArtifactContentType(artifact.mediaType),
      mediaType: artifact.mediaType,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
    };
  }

  #artifactForAttempt(
    verified: VerifiedRun,
    index: number,
    kind: 'stdout' | 'stderr' | 'report',
    artifact: RawExecutionAttemptV1['stdout'],
  ): DashboardArtifact {
    const key = `attempt-${String(index)}-${kind}`;
    const file = verified.files.find((candidate) => candidate.key === key);
    if (file === undefined) throw new RunIntegrityError('Artifact file is not indexed');
    return this.#publicArtifact(verified.receipt.runId, {
      ...file,
      label: artifact.name,
    });
  }

  #publicArtifact(runId: string, file: FileSpec): DashboardArtifact {
    return {
      key: file.key,
      label: file.label,
      name: file.name,
      mediaType: file.mediaType,
      ...(file.sha256 === undefined ? {} : {sha256: file.sha256}),
      sizeBytes: file.sizeBytes,
      url: `/api/runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(file.key)}`,
    };
  }

  async #assertRegularFile(path: string): Promise<void> {
    const fileStat = await lstat(path);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error('Expected a regular file');
    await this.#assertInsideRoot(path);
  }

  async #assertInsideRoot(path: string): Promise<void> {
    const resolved = await realpath(path);
    const relativePath = relative(this.#rootDirectory, resolved);
    if (relativePath === '' || (!isAbsolute(relativePath) && !relativePath.startsWith('..'))) return;
    throw new Error('Resolved path leaves runsDirectory');
  }
}

function isRunId(value: string): boolean {
  return ReceiptSchema.shape.runId.safeParse(value).success;
}

function safeArtifactContentType(mediaType: string): string {
  if (mediaType === 'text/plain') return 'text/plain; charset=utf-8';
  if (mediaType === 'application/json') return 'application/json; charset=utf-8';
  if (mediaType === 'application/xml' || mediaType === 'text/xml') {
    return 'text/plain; charset=utf-8';
  }
  return 'application/octet-stream';
}

function sumDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  return (left ?? 0) + (right ?? 0);
}

async function mapConcurrent<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  mapper: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const output: Output[] = [];
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) output[index] = await mapper(value);
    }
  }
  await Promise.all(
    Array.from({length: Math.min(concurrency, values.length)}, async () => worker()),
  );
  return output;
}
