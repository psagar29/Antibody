import {
  AgentInvocationResultSchema,
  AgentInvocationSchema,
  type AgentInvocationResultV1,
  type AgentInvocationV1,
} from '../../../src/contracts/schemas.js';

export function makeReflexFixtureInvocation(): AgentInvocationV1 {
  return AgentInvocationSchema.parse({
    schemaVersion: 'antibody.agent-invocation/v1',
    invocationId: '00000000-0000-4000-8000-000000000002',
    repository: {
      slug: 'example/project',
      cloneUrl: 'https://github.com/example/project.git',
    },
    checkoutSha: '3333333333333333333333333333333333333333',
    prompt: 'Return the requested regression-test patch as bounded final text.',
    timeoutMs: 60_000,
    maxOutputBytes: 65_536,
  });
}

export function makeReflexFixtureContinuation(): AgentInvocationV1 {
  return AgentInvocationSchema.parse({
    ...makeReflexFixtureInvocation(),
    invocationId: '00000000-0000-4000-8000-000000000003',
    continuationId: 'agent_fixture',
    prompt: 'Repair only the previously identified output problem.',
  });
}

export function makeReflexFixtureResult(): AgentInvocationResultV1 {
  const invocation = makeReflexFixtureInvocation();
  return AgentInvocationResultSchema.parse({
    schemaVersion: 'antibody.agent-result/v1',
    invocationId: invocation.invocationId,
    continuationId: 'agent_fixture',
    finalText: 'raw bounded agent final text',
    provider: {
      name: 'reflex',
      agentId: 'agent_fixture',
      streamId: 'stream_fixture',
      personaId: 'persona_fixture',
    },
    startedAt: '2026-08-29T12:00:00.000Z',
    finishedAt: '2026-08-29T12:00:01.000Z',
  });
}
