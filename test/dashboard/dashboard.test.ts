import {createHash, randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Script} from 'node:vm';

import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';

import {
  ClassifiedAttemptSchema,
  RawVerificationEvidenceSchema,
  ReceiptSchema,
} from '../../src/contracts/index.js';
import {
  canonicalReceiptBytes,
  receiptDigest,
} from '../../src/core/receipts/receipt-store.js';
import type {DashboardHandle} from '../../src/dashboard/index.js';
import {startDashboard} from '../../src/dashboard/index.js';

const temporaryDirectories: string[] = [];
const dashboards: DashboardHandle[] = [];

const indexResponseSchema = z.object({
  runs: z.array(
    z.object({
      runId: z.string(),
      verdict: z.enum(['verified', 'rejected', 'inconclusive']),
      candidateId: z.string(),
      fixSha: z.string(),
      patchSha256: z.string(),
      receiptSha256: z.string(),
      detailUrl: z.string(),
    }),
  ),
  invalidRunCount: z.number().int().nonnegative(),
});

const detailResponseSchema = z.object({
  run: z.object({
    runId: z.string(),
    verdict: z.enum(['verified', 'rejected', 'inconclusive']),
    reasonCodes: z.array(z.string()),
    patch: z.object({sha256: z.string(), changedPaths: z.array(z.string())}),
    costs: z.object({modelUsd: z.number().optional(), runloopUsd: z.number().optional()}),
    cleanup: z.array(
      z.object({devboxId: z.string(), requested: z.boolean(), completed: z.boolean()}),
    ),
    attempts: z.array(
      z.object({
        lane: z.enum(['parent', 'fix', 'head']),
        phase: z.enum(['setup', 'baseline', 'candidate', 'full-suite']),
        outcome: z.string().optional(),
        durationMs: z.number(),
        artifacts: z.array(z.object({key: z.string(), url: z.string()})),
      }),
    ),
    files: z.array(z.object({key: z.string(), url: z.string()})),
  }),
});

afterEach(async () => {
  await Promise.all(dashboards.splice(0).map(async (dashboard) => dashboard.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, {recursive: true, force: true});
    }),
  );
});

describe('local proof dashboard', () => {
  it('fails closed when asked to bind beyond the loopback interface', async () => {
    const runsDirectory = await temporaryDirectory('antibody-dashboard-host-');
    await expect(startDashboard({runsDirectory, host: '0.0.0.0'})).rejects.toThrow(
      'loopback address',
    );
    await expect(startDashboard({runsDirectory, host: '192.168.1.20'})).rejects.toThrow(
      'loopback address',
    );
  });

  it('serves meaningful self-contained HTML with restrictive response headers', async () => {
    const runsDirectory = await temporaryDirectory('antibody-dashboard-html-');
    const dashboard = await launch(runsDirectory);

    const response = await fetch(dashboard.url);
    const html = await response.text();
    const csp = response.headers.get('content-security-policy') ?? '';

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9_-]+'/u);
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(html).toContain('Antibody Proof Ledger');
    expect(html).toContain('Evidence attempt matrix');
    expect(html).toContain('Raw local artifacts');
    expect(html).toMatch(/<script nonce="[A-Za-z0-9_-]+">/u);
    expect(html).not.toMatch(/<(?:script|link|img)[^>]+(?:src|href)=["']https?:\/\//iu);
    const scriptSource = /<script nonce="[A-Za-z0-9_-]+">([\s\S]+)<\/script>/u.exec(html)?.[1];
    if (scriptSource === undefined) throw new Error('Expected an inline dashboard script');
    expect(() => new Script(scriptSource)).not.toThrow();

    const post = await fetch(dashboard.url, {method: 'POST'});
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });

  it('lists every valid verdict and exposes verified proof detail and raw artifacts', async () => {
    const runsDirectory = await temporaryDirectory('antibody-dashboard-runs-');
    const verified = await createRun(runsDirectory, 'verified', 'fix: stable causal behavior');
    await createRun(runsDirectory, 'inconclusive', 'investigate environment drift');
    await createRun(runsDirectory, 'rejected', 'reject non-sensitive candidate');
    const dashboard = await launch(runsDirectory);

    const indexResponse = await fetch(`${dashboard.url}/api/runs`);
    const index = indexResponseSchema.parse(await indexResponse.json());
    expect(indexResponse.status).toBe(200);
    expect(index.runs.map((run) => run.verdict).sort()).toEqual([
      'inconclusive',
      'rejected',
      'verified',
    ]);
    const summary = index.runs.find((run) => run.runId === verified.runId);
    expect(summary).toMatchObject({
      candidateId: verified.candidateId,
      fixSha: '2'.repeat(40),
      patchSha256: verified.patchSha256,
      receiptSha256: verified.receiptSha256,
    });

    const detailResponse = await fetch(`${dashboard.url}/api/runs/${verified.runId}`);
    const detail = detailResponseSchema.parse(await detailResponse.json());
    expect(detailResponse.status).toBe(200);
    expect(detail.run).toMatchObject({
      verdict: 'verified',
      reasonCodes: ['CAUSAL'],
      costs: {modelUsd: 0.25, runloopUsd: 0.5},
      cleanup: [{devboxId: 'box-1', requested: true, completed: true}],
    });
    expect(detail.run.attempts).toHaveLength(1);
    expect(detail.run.attempts[0]).toMatchObject({
      lane: 'parent',
      phase: 'candidate',
      outcome: 'assertion-failure',
      durationMs: 1250,
    });
    expect(detail.run.files.map((file) => file.key)).toContain('receipt');

    const stdout = detail.run.attempts[0]?.artifacts.find(
      (artifact) => artifact.key === 'attempt-0-stdout',
    );
    expect(stdout).toBeDefined();
    const artifactResponse = await fetch(`${dashboard.url}${stdout?.url ?? ''}`);
    expect(artifactResponse.status).toBe(200);
    expect(artifactResponse.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await artifactResponse.text()).toBe('target assertion failed\n');
  });

  it('rejects traversal and symlinked proof directories without exposing outside bytes', async () => {
    const root = await temporaryDirectory('antibody-dashboard-traversal-');
    const runsDirectory = join(root, 'runs');
    const outsideDirectory = join(root, 'outside');
    await mkdir(runsDirectory);
    await mkdir(outsideDirectory);
    await writeFile(join(outsideDirectory, 'secret.txt'), 'outside-secret-canary');
    const insideRun = await createRun(runsDirectory, 'verified', 'inside proof');
    const outsideRun = await createRun(outsideDirectory, 'verified', 'outside proof');
    await symlink(join(outsideDirectory, outsideRun.runId), join(runsDirectory, outsideRun.runId));
    const dashboard = await launch(runsDirectory);

    const traversal = await fetch(
      `${dashboard.url}/api/runs/${insideRun.runId}/files/..%2F..%2Fsecret.txt`,
    );
    const traversalBody = await traversal.text();
    expect(traversal.status).toBe(404);
    expect(traversalBody).not.toContain('outside-secret-canary');
    expect(traversalBody).not.toContain(outsideDirectory);

    const directSymlink = await fetch(`${dashboard.url}/api/runs/${outsideRun.runId}`);
    expect(directSymlink.status).toBe(422);
    expect(await directSymlink.text()).toContain('RUN_INTEGRITY_FAILED');

    const index = indexResponseSchema.parse(
      await (await fetch(`${dashboard.url}/api/runs`)).json(),
    );
    expect(index.runs.map((run) => run.runId)).toEqual([insideRun.runId]);
  });

  it('excludes invalid and tampered runs and returns a generic integrity error', async () => {
    const runsDirectory = await temporaryDirectory('antibody-dashboard-tamper-');
    const tampered = await createRun(runsDirectory, 'verified', 'tampered patch proof');
    await writeFile(join(runsDirectory, tampered.runId, 'patch.diff'), 'tampered');
    const invalidRunId = randomUUID();
    await mkdir(join(runsDirectory, invalidRunId, 'artifacts'), {recursive: true});
    await writeFile(join(runsDirectory, invalidRunId, 'receipt.json'), '{not-json');
    const dashboard = await launch(runsDirectory);

    const response = await fetch(`${dashboard.url}/api/runs`);
    const index = indexResponseSchema.parse(await response.json());
    expect(index.runs).toHaveLength(0);
    expect(index.invalidRunCount).toBe(2);

    const detailResponse = await fetch(`${dashboard.url}/api/runs/${tampered.runId}`);
    const detailText = await detailResponse.text();
    expect(detailResponse.status).toBe(422);
    expect(detailText).toContain('RUN_INTEGRITY_FAILED');
    expect(detailText).not.toContain('patch digest');
    expect(detailText).not.toContain(runsDirectory);
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function launch(runsDirectory: string): Promise<DashboardHandle> {
  const dashboard = await startDashboard({runsDirectory});
  dashboards.push(dashboard);
  expect(dashboard.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
  return dashboard;
}

async function createRun(
  runsDirectory: string,
  verdict: 'verified' | 'rejected' | 'inconclusive',
  subject: string,
): Promise<{
  runId: string;
  candidateId: string;
  patchSha256: string;
  receiptSha256: string;
}> {
  const runId = randomUUID();
  const runDirectory = join(runsDirectory, runId);
  const artifactsDirectory = join(runDirectory, 'artifacts');
  await mkdir(artifactsDirectory, {recursive: true});

  const candidateId = sha256(Buffer.from(`candidate:${runId}`, 'utf8'));
  const patch = Buffer.from('diff --git a/test/a.test.js b/test/a.test.js\n', 'utf8');
  const patchSha256 = sha256(patch);
  const stdout = Buffer.from('target assertion failed\n', 'utf8');
  const stderr = Buffer.from('', 'utf8');
  const stdoutArtifact = {
    name: 'stdout',
    mediaType: 'text/plain',
    sha256: sha256(stdout),
    sizeBytes: stdout.byteLength,
    contentBase64: stdout.toString('base64'),
  };
  const stderrArtifact = {
    name: 'stderr',
    mediaType: 'text/plain',
    sha256: sha256(stderr),
    sizeBytes: stderr.byteLength,
    contentBase64: stderr.toString('base64'),
  };
  const candidate = {
    schemaVersion: 'antibody.candidate/v1',
    candidateId,
    repository: {slug: 'owner/repo', cloneUrl: 'https://github.com/owner/repo.git'},
    parentSha: '1'.repeat(40),
    fixSha: '2'.repeat(40),
    headSha: '3'.repeat(40),
    commit: {
      subject,
      authoredAt: '2026-08-29T00:00:00.000Z',
      changedProductionPaths: ['src/index.js'],
      changedTestPaths: [],
      additions: 2,
      deletions: 1,
      diffSha256: sha256(Buffer.from('production diff', 'utf8')),
    },
    signals: [{code: 'FIX_SUBJECT', weight: 35, evidence: 'fix keyword'}],
    score: 85,
  };
  const evidence = RawVerificationEvidenceSchema.parse({
    schemaVersion: 'antibody.raw-evidence/v1',
    runId,
    candidateId,
    patchSha256,
    environmentEquivalence: {equivalent: true, comparedFields: ['snapshot'], mismatchFields: []},
    attempts: [
      {
        lane: 'parent',
        phase: 'candidate',
        attempt: 0,
        checkoutSha: '1'.repeat(40),
        patchSha256,
        command: {argv: ['node', '--test'], cwd: '.', env: {CI: '1'}, timeoutMs: 60_000},
        startedAt: '2026-08-29T00:00:00.000Z',
        finishedAt: '2026-08-29T00:00:01.250Z',
        durationMs: 1250,
        termination: 'exited',
        exitCode: 1,
        stdout: stdoutArtifact,
        stderr: stderrArtifact,
        provider: {devboxId: 'box-1', resolvedSnapshotId: 'snapshot-1'},
      },
    ],
    runloopCostUsd: 0.5,
    cleanup: [{devboxId: 'box-1', requested: true, completed: true}],
  });
  const classifications = [
    ClassifiedAttemptSchema.parse({
      rawAttemptIndex: 0,
      outcome: 'assertion-failure',
      signature: sha256(Buffer.from('stable assertion', 'utf8')),
      targetTestNames: ['target behavior'],
      explanation: 'target assertion failed only on parent',
      confidence: 'high',
    }),
  ];
  const rawEvidenceBytes = Buffer.from(JSON.stringify(evidence), 'utf8');
  const receipt = ReceiptSchema.parse({
    schemaVersion: 'antibody.receipt/v1',
    runId,
    candidate,
    patch: {
      sha256: patchSha256,
      sizeBytes: patch.byteLength,
      changedPaths: ['test/a.test.js'],
      artifact: {
        name: 'patch.diff',
        mediaType: 'text/x-diff',
        sha256: patchSha256,
        sizeBytes: patch.byteLength,
      },
    },
    policy: {testOnly: true, allowedGlobs: ['test/**'], violations: []},
    environment: {
      equivalent: true,
      comparedFields: ['snapshot'],
      mismatchFields: [],
      source: {kind: 'snapshot', id: 'snapshot-1'},
    },
    classifications,
    evidence: {
      rawEvidenceSha256: sha256(rawEvidenceBytes),
      artifacts: [omitContent(stdoutArtifact), omitContent(stderrArtifact)],
      cleanup: evidence.cleanup,
    },
    costs: {modelUsd: 0.25, runloopUsd: 0.5},
    verdict,
    reasonCodes: verdict === 'verified' ? ['CAUSAL'] : [verdict.toUpperCase()],
    createdAt: `2026-08-29T00:00:0${verdict === 'verified' ? '3' : verdict === 'rejected' ? '2' : '1'}.000Z`,
  });
  const receiptSha256 = receiptDigest(receipt);

  await Promise.all([
    writeFile(join(runDirectory, 'candidate.json'), JSON.stringify(receipt.candidate)),
    writeFile(join(runDirectory, 'patch.diff'), patch),
    writeFile(join(runDirectory, 'raw-evidence.json'), rawEvidenceBytes),
    writeFile(join(runDirectory, 'classified-evidence.json'), JSON.stringify(classifications)),
    writeFile(join(runDirectory, 'receipt.json'), canonicalReceiptBytes(receipt)),
    writeFile(join(runDirectory, 'receipt.sha256'), `${receiptSha256}\n`),
    writeFile(join(artifactsDirectory, '0-stdout.bin'), stdout),
    writeFile(join(artifactsDirectory, '0-stderr.bin'), stderr),
  ]);
  return {runId, candidateId, patchSha256, receiptSha256};
}

function omitContent(artifact: {
  readonly name: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}): {
  readonly name: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly sizeBytes: number;
} {
  return {
    name: artifact.name,
    mediaType: artifact.mediaType,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
  };
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
