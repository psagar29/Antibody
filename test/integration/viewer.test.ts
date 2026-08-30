import {createHash} from 'node:crypto';

import {describe, expect, it} from 'vitest';

import {ReceiptSchema} from '../../src/contracts/index.js';
import {renderReceiptHtml} from '../../src/viewer/render.js';

describe('proof viewer', () => {
  it('is self-contained, CSP-restricted, and escapes every receipt value', () => {
    const patch = 'diff';
    const digest = `sha256:${createHash('sha256').update(patch).digest('hex')}`;
    const receipt = ReceiptSchema.parse({
      schemaVersion: 'antibody.receipt/v1',
      runId: '00000000-0000-4000-8000-000000000001',
      candidate: {
        schemaVersion: 'antibody.candidate/v1',
        candidateId: digest,
        repository: {slug: 'owner/repo', cloneUrl: 'https://github.com/owner/repo.git'},
        parentSha: '1'.repeat(40),
        fixSha: '2'.repeat(40),
        headSha: '3'.repeat(40),
        commit: {
          subject: 'fix: <script>alert(1)</script>',
          authoredAt: '2026-08-29T00:00:00.000Z',
          changedProductionPaths: ['src/index.js'],
          changedTestPaths: [],
          additions: 1,
          deletions: 1,
          diffSha256: digest,
        },
        signals: [],
        score: 50,
      },
      patch: {
        sha256: digest,
        sizeBytes: Buffer.byteLength(patch),
        changedPaths: ['test/a.test.js'],
        artifact: {
          name: 'patch.diff',
          mediaType: 'text/x-diff',
          sha256: digest,
          sizeBytes: Buffer.byteLength(patch),
        },
      },
      policy: {testOnly: true, allowedGlobs: ['test/**'], violations: []},
      environment: {
        equivalent: true,
        comparedFields: ['snapshot'],
        mismatchFields: [],
        source: {kind: 'snapshot', id: 'fixture'},
      },
      classifications: [],
      evidence: {rawEvidenceSha256: digest, artifacts: [], cleanup: []},
      costs: {},
      verdict: 'verified',
      reasonCodes: ['CAUSAL'],
      createdAt: '2026-08-29T00:00:01.000Z',
    });
    const html = renderReceiptHtml(receipt);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toMatch(/<(?:script|link|img)[^>]+(?:src|href)=["']https?:\/\//iu);
  });
});
