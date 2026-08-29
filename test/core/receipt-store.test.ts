import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {
  ClassifiedAttemptSchema,
  RawVerificationEvidenceSchema,
  ReceiptSchema,
  RecoveryCandidateSchema,
  VerificationRequestSchema,
} from '../../src/contracts/index.js';
import type {AtomicWriter} from '../../src/core/receipts/receipt-store.js';
import {
  FileAtomicWriter,
  FileReceiptStore,
  Redactor,
  buildReceipt,
  canonicalReceiptBytes,
  receiptDigest,
  verifyReceipt,
} from '../../src/core/receipts/receipt-store.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, {recursive: true, force: true});
    }),
  );
});

function fixture(secret = '') {
  const runId = randomUUID();
  const digest = `sha256:${'a'.repeat(64)}`;
  const candidate = RecoveryCandidateSchema.parse({
    schemaVersion: 'antibody.candidate/v1',
    candidateId: digest,
    repository: {slug: 'owner/repo', cloneUrl: 'https://github.com/owner/repo.git'},
    parentSha: '1'.repeat(40),
    fixSha: '2'.repeat(40),
    headSha: '3'.repeat(40),
    commit: {
      subject: 'fix: behavior',
      authoredAt: '2026-08-29T00:00:00.000Z',
      changedProductionPaths: ['src/index.js'],
      changedTestPaths: [],
      additions: 1,
      deletions: 1,
      diffSha256: digest,
    },
    signals: [],
    score: 50,
  });
  const patch = 'diff --git a/test/a.test.js b/test/a.test.js\n';
  const patchDigest = `sha256:${createHash('sha256').update(patch).digest('hex')}`;
  const request = VerificationRequestSchema.parse({
    schemaVersion: 'antibody.verification-request/v1',
    runId,
    candidate,
    patch: {unifiedDiffBase64: Buffer.from(patch).toString('base64'), sha256: patchDigest, changedPaths: ['test/a.test.js']},
    environment: {source: {kind: 'snapshot', id: 'snapshot-1'}, maxParallel: 2},
    commands: {
      setup: [],
      baseline: {argv: ['node', '--test'], cwd: '.', env: {}, timeoutMs: 60_000},
      targeted: {argv: ['node', '--test'], cwd: '.', env: {}, timeoutMs: 60_000},
    },
    report: {format: 'tap'},
    repetitions: 2,
  });
  const output = Buffer.from(`assertion ${secret}`);
  const artifact = {
    name: 'stdout',
    mediaType: 'text/plain',
    sha256: `sha256:${createHash('sha256').update(output).digest('hex')}`,
    sizeBytes: output.byteLength,
    contentBase64: output.toString('base64'),
  };
  const evidence = RawVerificationEvidenceSchema.parse({
    schemaVersion: 'antibody.raw-evidence/v1',
    runId,
    candidateId: candidate.candidateId,
    patchSha256: patchDigest,
    environmentEquivalence: {equivalent: true, comparedFields: ['snapshot'], mismatchFields: []},
    attempts: [
      {
        lane: 'parent',
        phase: 'candidate',
        attempt: 0,
        checkoutSha: candidate.parentSha,
        patchSha256: patchDigest,
        command: request.commands.targeted,
        startedAt: '2026-08-29T00:00:00.000Z',
        finishedAt: '2026-08-29T00:00:01.000Z',
        durationMs: 1000,
        termination: 'exited',
        exitCode: 1,
        stdout: artifact,
        stderr: {...artifact, name: 'stderr'},
        provider: {devboxId: 'box-1'},
      },
    ],
    cleanup: [{devboxId: 'box-1', requested: true, completed: true}],
  });
  const classifications = [
    ClassifiedAttemptSchema.parse({
      rawAttemptIndex: 0,
      outcome: 'assertion-failure',
      signature: digest,
      targetTestNames: ['target'],
      explanation: 'target assertion',
      confidence: 'high',
    }),
  ];
  const policy = {
    testOnly: true,
    patchSha256: request.patch.sha256,
    sizeBytes: Buffer.byteLength(patch),
    normalizedPatch: patch,
    changedPaths: request.patch.changedPaths,
    allowedGlobs: ['test/**'],
    violations: [],
  };
  const redactor = new Redactor(secret === '' ? [] : [secret]);
  const receipt = buildReceipt({
    request,
    evidence,
    classifications,
    policy,
    adjudication: {verdict: 'verified', reasonCodes: ['CAUSAL']},
    patchArtifact: {name: 'patch.diff', mediaType: 'text/x-diff', sha256: request.patch.sha256, sizeBytes: Buffer.byteLength(patch)},
    createdAt: '2026-08-29T00:00:02.000Z',
    redactor,
  });
  return {request, evidence, classifications, policy, receipt, patch};
}

describe('canonical receipts', () => {
  it('canonicalizes independent of object key order and validates the frozen schema', () => {
    const {receipt} = fixture();
    expect(ReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(canonicalReceiptBytes(receipt).toString('utf8')).toBe(
      canonicalReceiptBytes({...receipt}).toString('utf8'),
    );
    const digest = receiptDigest(receipt);
    expect(verifyReceipt(receipt, digest)).toEqual(receipt);
  });

  it('detects receipt tampering', () => {
    const {receipt} = fixture();
    const digest = receiptDigest(receipt);
    expect(() => verifyReceipt({...receipt, reasonCodes: ['TAMPERED']}, digest)).toThrow(
      'digest',
    );
  });
});

describe('FileReceiptStore', () => {
  it('persists atomically, redacts artifacts, and verifies receipt and patch digests', async () => {
    const baseDirectory = await mkdtemp(join(tmpdir(), 'antibody-receipt-test-'));
    temporaryDirectories.push(baseDirectory);
    const secret = 'fixture-secret-canary';
    const values = fixture(secret);
    const store = new FileReceiptStore({baseDirectory, redactor: new Redactor([secret])});
    const persisted = await store.persist({
      receipt: values.receipt,
      request: values.request,
      evidence: values.evidence,
      classifications: values.classifications,
      normalizedPatch: values.patch,
    });

    expect(await store.verify(persisted.directory)).toEqual(values.receipt);
    const rawEvidence = await readFile(join(persisted.directory, 'raw-evidence.json'), 'utf8');
    expect(rawEvidence).not.toContain(secret);
    const parsedEvidence = RawVerificationEvidenceSchema.parse(JSON.parse(rawEvidence));
    expect(
      Buffer.from(parsedEvidence.attempts[0]?.stdout.contentBase64 ?? '', 'base64').toString('utf8'),
    ).toContain('[REDACTED]');
    expect((await readFile(join(persisted.directory, 'receipt.json'), 'utf8')).endsWith('\n')).toBe(false);
  });

  it('detects a tampered persisted patch', async () => {
    const baseDirectory = await mkdtemp(join(tmpdir(), 'antibody-receipt-tamper-'));
    temporaryDirectories.push(baseDirectory);
    const values = fixture();
    const store = new FileReceiptStore({baseDirectory, redactor: new Redactor([])});
    const persisted = await store.persist({
      receipt: values.receipt,
      request: values.request,
      evidence: values.evidence,
      classifications: values.classifications,
      normalizedPatch: values.patch,
    });
    await writeFile(join(persisted.directory, 'patch.diff'), 'tampered');
    await expect(store.verify(persisted.directory)).rejects.toThrow('patch digest');
  });

  it('never exposes a receipt when its atomic write fails', async () => {
    const baseDirectory = await mkdtemp(join(tmpdir(), 'antibody-receipt-failure-'));
    temporaryDirectories.push(baseDirectory);
    const values = fixture();
    const delegate = new FileAtomicWriter();
    const writer: AtomicWriter = {
      write(path, bytes) {
        if (basename(path) === 'receipt.json') return Promise.reject(new Error('disk full'));
        return delegate.write(path, bytes);
      },
    };
    const store = new FileReceiptStore({baseDirectory, redactor: new Redactor([]), writer});
    await expect(
      store.persist({
        receipt: values.receipt,
        request: values.request,
        evidence: values.evidence,
        classifications: values.classifications,
        normalizedPatch: values.patch,
      }),
    ).rejects.toThrow('disk full');
    await expect(readFile(join(baseDirectory, values.receipt.runId, 'receipt.json'))).rejects.toThrow();
  });
});
