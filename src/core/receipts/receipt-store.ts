import {createHash, randomUUID} from 'node:crypto';
import {constants as fileConstants} from 'node:fs';
import {access, mkdir, open, readFile, rename} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';

import {canonicalize} from 'json-canonicalize';

import type {
  ArtifactV1,
  ClassifiedAttemptV1,
  RawVerificationEvidenceV1,
  ReceiptV1,
  Sha256,
  VerificationRequestV1,
} from '../../contracts/index.js';
import {
  ClassifiedAttemptSchema,
  RawVerificationEvidenceSchema,
  ReceiptSchema,
  Sha256Schema,
  VerificationRequestSchema,
} from '../../contracts/index.js';

import type {AdjudicationResult} from '../adjudication/adjudicator.js';
import type {PatchPolicyResult} from '../policy/patch-policy.js';

export interface AtomicWriter {
  write(path: string, bytes: Buffer): Promise<void>;
}

export class FileAtomicWriter implements AtomicWriter {
  async write(path: string, bytes: Buffer): Promise<void> {
    const directory = dirname(path);
    await mkdir(directory, {recursive: true, mode: 0o700});
    const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    try {
      const directoryHandle = await open(directory, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {
      // Some filesystems do not support fsync on directories; file fsync and rename still hold.
    }
  }
}

export class Redactor {
  readonly #literalSecrets: readonly string[];

  constructor(literalSecrets: readonly string[]) {
    this.#literalSecrets = literalSecrets.filter((value) => value.length >= 4);
  }

  redact(value: string): string {
    let redacted = value;
    for (const secret of this.#literalSecrets) redacted = redacted.replaceAll(secret, '[REDACTED]');
    return redacted
      .replaceAll(/\b(?:Bearer\s+)[A-Za-z0-9._~+/-]{16,}\b/giu, 'Bearer [REDACTED]')
      .replaceAll(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{16,}\b/gu, '[REDACTED]');
  }
}

export interface BuildReceiptOptions {
  readonly request: VerificationRequestV1;
  readonly evidence: RawVerificationEvidenceV1;
  readonly classifications: readonly ClassifiedAttemptV1[];
  readonly policy: PatchPolicyResult;
  readonly adjudication: AdjudicationResult;
  readonly patchArtifact: Omit<ArtifactV1, 'contentBase64'>;
  readonly createdAt: string;
  readonly modelUsd?: number;
  readonly redactor?: Redactor;
}

export function buildReceipt(options: BuildReceiptOptions): ReceiptV1 {
  const request = VerificationRequestSchema.parse(options.request);
  const evidence = sanitizeEvidence(
    options.evidence,
    options.redactor ?? new Redactor([]),
  );
  const classifications = options.classifications.map((entry) => ClassifiedAttemptSchema.parse(entry));
  const artifacts = evidence.attempts.flatMap((attempt) => [
    omitContent(attempt.stdout),
    omitContent(attempt.stderr),
    ...(attempt.report === undefined ? [] : [omitContent(attempt.report)]),
  ]);
  return ReceiptSchema.parse({
    schemaVersion: 'antibody.receipt/v1',
    runId: request.runId,
    candidate: request.candidate,
    patch: {
      sha256: request.patch.sha256,
      sizeBytes: options.policy.sizeBytes,
      changedPaths: options.policy.changedPaths,
      artifact: options.patchArtifact,
    },
    policy: {
      testOnly: options.policy.testOnly,
      allowedGlobs: options.policy.allowedGlobs,
      violations: options.policy.violations.map((violation) => ({
        code: violation.code,
        ...(violation.path === undefined ? {} : {path: violation.path}),
        detail: violation.detail,
      })),
    },
    environment: {
      ...evidence.environmentEquivalence,
      source: request.environment.source,
      ...(request.environment.networkPolicyId === undefined
        ? {}
        : {networkPolicyId: request.environment.networkPolicyId}),
    },
    classifications,
    evidence: {
      rawEvidenceSha256: sha256(canonicalBytes(evidence)),
      artifacts,
      ...(evidence.reflex === undefined ? {} : {reflex: evidence.reflex}),
      cleanup: evidence.cleanup,
    },
    costs: {
      ...(options.modelUsd === undefined ? {} : {modelUsd: options.modelUsd}),
      ...(evidence.runloopCostUsd === undefined ? {} : {runloopUsd: evidence.runloopCostUsd}),
    },
    verdict: options.adjudication.verdict,
    reasonCodes: options.adjudication.reasonCodes,
    createdAt: options.createdAt,
  });
}

export function canonicalReceiptBytes(receiptInput: ReceiptV1): Buffer {
  return canonicalBytes(ReceiptSchema.parse(receiptInput));
}

export function receiptDigest(receiptInput: ReceiptV1): Sha256 {
  return Sha256Schema.parse(sha256(canonicalReceiptBytes(receiptInput)));
}

export function verifyReceipt(receiptInput: unknown, expectedDigest: string): ReceiptV1 {
  const receipt = ReceiptSchema.parse(receiptInput);
  const actualDigest = receiptDigest(receipt);
  if (actualDigest !== expectedDigest.trim()) throw new Error('Receipt digest does not match canonical content');
  return receipt;
}

export interface PersistRunOptions {
  readonly receipt: ReceiptV1;
  readonly request: VerificationRequestV1;
  readonly evidence: RawVerificationEvidenceV1;
  readonly classifications: readonly ClassifiedAttemptV1[];
  readonly normalizedPatch: string;
}

export class FileReceiptStore {
  readonly #baseDirectory: string;
  readonly #writer: AtomicWriter;
  readonly #redactor: Redactor;

  constructor(options: {
    readonly baseDirectory: string;
    readonly redactor: Redactor;
    readonly writer?: AtomicWriter;
  }) {
    this.#baseDirectory = options.baseDirectory;
    this.#redactor = options.redactor;
    this.#writer = options.writer ?? new FileAtomicWriter();
  }

  async persist(options: PersistRunOptions): Promise<{directory: string; digest: Sha256}> {
    const receipt = ReceiptSchema.parse(options.receipt);
    const request = VerificationRequestSchema.parse(options.request);
    const sanitizedEvidence = sanitizeEvidence(options.evidence, this.#redactor);
    if (receipt.runId !== request.runId || receipt.runId !== sanitizedEvidence.runId) {
      throw new Error('Run identifiers do not match persisted receipt inputs');
    }
    const runDirectory = join(this.#baseDirectory, receipt.runId);
    await mkdir(join(runDirectory, 'artifacts'), {recursive: true, mode: 0o700});
    const digest = receiptDigest(receipt);
    const existingReceiptPath = join(runDirectory, 'receipt.json');
    if (await pathExists(existingReceiptPath)) {
      const existing = JSON.parse(await readFile(existingReceiptPath, 'utf8')) as unknown;
      verifyReceipt(existing, digest);
      return {directory: runDirectory, digest};
    }

    await this.#writer.write(join(runDirectory, 'candidate.json'), canonicalBytes(request.candidate));
    const redactedPatch = this.#redactor.redact(options.normalizedPatch);
    if (redactedPatch !== options.normalizedPatch) {
      throw new Error('Patch contains a configured or high-risk secret and cannot be persisted');
    }
    await this.#writer.write(join(runDirectory, 'patch.diff'), Buffer.from(options.normalizedPatch, 'utf8'));
    const rawEvidenceBytes = canonicalBytes(sanitizedEvidence);
    if (sha256(rawEvidenceBytes) !== receipt.evidence.rawEvidenceSha256) {
      throw new Error('Receipt raw-evidence digest does not match redacted persisted evidence');
    }
    await this.#writer.write(join(runDirectory, 'raw-evidence.json'), rawEvidenceBytes);
    await this.#writer.write(
      join(runDirectory, 'classified-evidence.json'),
      canonicalBytes(options.classifications.map((entry) => ClassifiedAttemptSchema.parse(entry))),
    );
    for (const [index, attempt] of sanitizedEvidence.attempts.entries()) {
      await this.#persistArtifact(runDirectory, `${String(index)}-stdout`, attempt.stdout);
      await this.#persistArtifact(runDirectory, `${String(index)}-stderr`, attempt.stderr);
      if (attempt.report !== undefined) {
        await this.#persistArtifact(runDirectory, `${String(index)}-report`, attempt.report);
      }
    }
    await this.#writer.write(existingReceiptPath, canonicalReceiptBytes(receipt));
    await this.#writer.write(join(runDirectory, 'receipt.sha256'), Buffer.from(`${digest}\n`, 'utf8'));
    return {directory: runDirectory, digest};
  }

  async verify(directory: string): Promise<ReceiptV1> {
    const receiptValue = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8')) as unknown;
    const expectedDigest = await readFile(join(directory, 'receipt.sha256'), 'utf8');
    const receipt = verifyReceipt(receiptValue, expectedDigest);
    const patch = await readFile(join(directory, 'patch.diff'));
    if (sha256(patch) !== receipt.patch.sha256) throw new Error('Persisted patch digest does not match receipt');
    return receipt;
  }

  async #persistArtifact(directory: string, stem: string, artifact: ArtifactV1): Promise<void> {
    if (artifact.contentBase64 === undefined) return;
    await this.#writer.write(
      join(directory, 'artifacts', `${stem}.bin`),
      Buffer.from(artifact.contentBase64, 'base64'),
    );
  }
}

function sanitizeEvidence(evidenceInput: RawVerificationEvidenceV1, redactor: Redactor): RawVerificationEvidenceV1 {
  const evidence = RawVerificationEvidenceSchema.parse(evidenceInput);
  return RawVerificationEvidenceSchema.parse({
    ...evidence,
    attempts: evidence.attempts.map((attempt) => ({
      ...attempt,
      stdout: sanitizeArtifact(attempt.stdout, redactor),
      stderr: sanitizeArtifact(attempt.stderr, redactor),
      ...(attempt.report === undefined ? {} : {report: sanitizeArtifact(attempt.report, redactor)}),
    })),
  });
}

function sanitizeArtifact(artifact: ArtifactV1, redactor: Redactor): ArtifactV1 {
  if (artifact.contentBase64 === undefined) return artifact;
  const decoded = Buffer.from(artifact.contentBase64, 'base64');
  let text: string;
  try {
    text = new TextDecoder('utf-8', {fatal: true}).decode(decoded);
  } catch {
    return artifact;
  }
  const redacted = Buffer.from(redactor.redact(text), 'utf8');
  return {
    ...artifact,
    sha256: Sha256Schema.parse(sha256(redacted)),
    sizeBytes: redacted.byteLength,
    contentBase64: redacted.toString('base64'),
  };
}

function omitContent(artifact: ArtifactV1): Omit<ArtifactV1, 'contentBase64'> {
  return {
    name: artifact.name,
    mediaType: artifact.mediaType,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
  };
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalize(value), 'utf8');
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fileConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
