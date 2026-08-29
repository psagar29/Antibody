import {createHash} from 'node:crypto';

import {describe, expect, it} from 'vitest';

import {
  RawVerificationEvidenceSchema,
  VerificationRequestSchema,
} from '../../../src/contracts/schemas.js';
import {
  makeRunloopFixtureEvidence,
  makeRunloopFixtureRequest,
  runloopFixturePatch,
  runloopFixturePatchSha256,
} from './fixtures.js';

describe('Runloop adapter contract fixtures', () => {
  it('provides a schema-valid immutable verification request', () => {
    const request = makeRunloopFixtureRequest();

    expect(VerificationRequestSchema.parse(request)).toEqual(request);
    expect(request.environment.maxParallel).toBe(2);
    expect(request.candidate.parentSha).not.toBe(request.candidate.fixSha);
  });

  it('binds the uploaded patch bytes to their declared digest', () => {
    const digest = `sha256:${createHash('sha256').update(runloopFixturePatch).digest('hex')}`;

    expect(digest).toBe(runloopFixturePatchSha256);
    expect(makeRunloopFixtureRequest().patch.unifiedDiffBase64).toBe(
      runloopFixturePatch.toString('base64'),
    );
  });

  it('provides schema-valid raw evidence without a domain verdict', () => {
    const evidence = makeRunloopFixtureEvidence();

    expect(RawVerificationEvidenceSchema.parse(evidence)).toEqual(evidence);
    expect(evidence).not.toHaveProperty('verdict');
  });
});
