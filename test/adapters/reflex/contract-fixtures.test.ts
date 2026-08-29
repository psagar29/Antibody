import {describe, expect, it} from 'vitest';

import {
  AgentInvocationResultSchema,
  AgentInvocationSchema,
} from '../../../src/contracts/schemas.js';
import {
  makeReflexFixtureContinuation,
  makeReflexFixtureInvocation,
  makeReflexFixtureResult,
} from './fixtures.js';

describe('Reflex adapter contract fixtures', () => {
  it('provides a schema-valid new invocation without a transport session id', () => {
    const request = makeReflexFixtureInvocation();

    expect(AgentInvocationSchema.parse(request)).toEqual(request);
    expect(request.continuationId).toBeUndefined();
  });

  it('provides a schema-valid continuation using an opaque existing id', () => {
    const request = makeReflexFixtureContinuation();

    expect(AgentInvocationSchema.parse(request)).toEqual(request);
    expect(request.continuationId).toBe('agent_fixture');
  });

  it('provides raw bounded final text with only public Reflex provenance', () => {
    const result = makeReflexFixtureResult();

    expect(AgentInvocationResultSchema.parse(result)).toEqual(result);
    expect(result.provider).not.toHaveProperty('axonId');
    expect(result).not.toHaveProperty('patch');
    expect(result).not.toHaveProperty('verdict');
    expect(result).not.toHaveProperty('usage');
  });
});
