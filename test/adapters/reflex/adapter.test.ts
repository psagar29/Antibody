import {describe, expect, it} from 'vitest';

import {AntibodyError} from '../../../src/contracts/errors.js';
import {AgentInvocationResultSchema} from '../../../src/contracts/schemas.js';
import {ReflexAgentSessionAdapter} from '../../../src/adapters/reflex/adapter.js';
import {
  AdvancingReflexClock,
  FakeReflexControl,
  FakeReflexApiError,
  makeReflexEvent,
} from './fake.js';
import {
  makeReflexFixtureContinuation,
  makeReflexFixtureInvocation,
} from './fixtures.js';

describe('Reflex agent session adapter', () => {
  it('launches a Persona and returns deduplicated raw final text with actual provenance', async () => {
    const first = makeReflexEvent('event_1', 1, 'item/agentMessage/delta', {
      params: {itemId: 'item_1', delta: 'hello '},
    });
    const second = makeReflexEvent('event_2', 2, 'item/agentMessage/delta', {
      params: {itemId: 'item_1', delta: 'world'},
    });
    const terminal = makeReflexEvent('event_3', 3, 'turn/completed', {
      params: {turn: {status: 'completed'}},
    });
    const control = new FakeReflexControl({
      events: [first, second, terminal],
      socketEvents: [first, first],
    });
    const adapter = new ReflexAgentSessionAdapter(control, 'persona_fixture');
    const request = makeReflexFixtureInvocation();

    const result = await adapter.invoke(request);

    expect(AgentInvocationResultSchema.parse(result)).toEqual(result);
    expect(result.finalText).toBe('hello world');
    expect(result.continuationId).toBe('agent_fixture');
    expect(result.provider).toEqual({
      name: 'reflex',
      agentId: 'agent_fixture',
      streamId: 'stream_fixture',
      personaId: 'persona_fixture',
    });
    expect(result).not.toHaveProperty('usage');
    expect(control.launches).toEqual([{personaId: 'persona_fixture', request}]);
    expect(control.subscriptions).toEqual(['stream_fixture']);
    expect(control.unsubscribeCount).toBe(1);
  });

  it('continues the opaque agent and excludes replayed prior-turn text', async () => {
    const prior = [
      makeReflexEvent('old_1', 1, 'agent_message_chunk', {message: 'old answer'}),
      makeReflexEvent('old_2', 2, 'turn.completed', {}),
    ];
    const next = [
      ...prior,
      makeReflexEvent('new_1', 3, 'session/update', {
        update: {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'repaired'}},
      }),
      makeReflexEvent('new_2', 4, 'turn.completed', {}),
    ];
    const control = new FakeReflexControl({priorEvents: prior, events: next, socketEvents: prior});
    const adapter = new ReflexAgentSessionAdapter(control, 'persona_fixture');
    const request = makeReflexFixtureContinuation();

    const result = await adapter.invoke(request);

    expect(control.launches).toHaveLength(0);
    expect(control.sent).toEqual([{agentId: 'agent_fixture', message: request.prompt}]);
    expect(result.finalText).toBe('repaired');
  });

  it('deduplicates reconnect replays from socket and REST history', async () => {
    const chunk = makeReflexEvent('event_1', 1, 'agent_message_chunk', {message: 'once'});
    const terminal = makeReflexEvent('event_2', 2, 'turn.completed', {});
    const control = new FakeReflexControl({
      events: [chunk, terminal],
      socketEvents: [chunk, chunk, terminal, terminal],
    });
    const adapter = new ReflexAgentSessionAdapter(control, 'persona_fixture');

    const result = await adapter.invoke(makeReflexFixtureInvocation());

    expect(result.finalText).toBe('once');
    expect(control.historyCalls).toBeGreaterThan(0);
  });

  it('uses a successful record terminal state when the stream terminal is delayed', async () => {
    const control = new FakeReflexControl({
      status: 'completed',
      events: [makeReflexEvent('event_1', 1, 'assistant', {message: 'record complete'})],
    });
    const adapter = new ReflexAgentSessionAdapter(control, 'persona_fixture');

    const result = await adapter.invoke(makeReflexFixtureInvocation());

    expect(result.finalText).toBe('record complete');
  });

  it('surfaces stream and record terminal failures without returning invented text', async () => {
    const control = new FakeReflexControl({
      status: 'error',
      events: [makeReflexEvent('event_1', 1, 'turn.failed', {message: 'failed'})],
    });
    const adapter = new ReflexAgentSessionAdapter(control, 'persona_fixture');

    await expect(adapter.invoke(makeReflexFixtureInvocation())).rejects.toBeInstanceOf(
      AntibodyError,
    );
    expect(control.interrupted).toEqual(['agent_fixture']);
  });

  it('times out with bounded polling backoff and interrupts the live turn', async () => {
    const control = new FakeReflexControl();
    const adapter = new ReflexAgentSessionAdapter(control, 'persona_fixture', {
      clock: new AdvancingReflexClock(),
      pollIntervalMs: 250,
      maxPollIntervalMs: 500,
    });
    const request = {...makeReflexFixtureInvocation(), timeoutMs: 1_000};

    await expect(adapter.invoke(request)).rejects.toMatchObject({causeCode: 'REFLEX_TIMEOUT'});
    expect(control.interrupted).toEqual(['agent_fixture']);
    expect(control.unsubscribeCount).toBe(1);
  });

  it('honors AbortSignal, unsubscribes and interrupts the active turn', async () => {
    const abortController = new AbortController();
    const control = new FakeReflexControl({abortController, abortOnHistory: true});
    const adapter = new ReflexAgentSessionAdapter(control, 'persona_fixture', {
      clock: new AdvancingReflexClock(),
    });

    await expect(
      adapter.invoke(makeReflexFixtureInvocation(), {signal: abortController.signal}),
    ).rejects.toMatchObject({causeCode: 'ABORTED'});
    expect(control.interrupted).toEqual(['agent_fixture']);
    expect(control.unsubscribeCount).toBe(1);
  });

  it('bounds final text on a valid UTF-8 boundary', async () => {
    const control = new FakeReflexControl({
      events: [
        makeReflexEvent('event_1', 1, 'agent_message_chunk', {message: '🧪🧪'}),
        makeReflexEvent('event_2', 2, 'turn.completed', {}),
      ],
    });
    const adapter = new ReflexAgentSessionAdapter(control, 'persona_fixture');
    const request = {...makeReflexFixtureInvocation(), maxOutputBytes: 5};

    const result = await adapter.invoke(request);

    expect(result.finalText).toBe('🧪');
    expect(Buffer.byteLength(result.finalText, 'utf8')).toBeLessThanOrEqual(5);
  });

  it('redacts configured literals and token-shaped output centrally', async () => {
    const literal = 'fixture-sensitive-value';
    const token = ['rfx', 'AAAAAAAAAAAAAAAAAAAA'].join('_');
    const control = new FakeReflexControl({
      events: [
        makeReflexEvent('event_1', 1, 'agent_message_chunk', {
          message: `${literal} ${token}`,
        }),
        makeReflexEvent('event_2', 2, 'turn.completed', {}),
      ],
    });
    const adapter = new ReflexAgentSessionAdapter(control, 'persona_fixture', {
      literalSecrets: [literal],
    });

    const result = await adapter.invoke(makeReflexFixtureInvocation());

    expect(result.finalText).toBe('[REDACTED] [REDACTED]');
  });

  it('retries bounded transient stream reads before succeeding', async () => {
    const control = new FakeReflexControl({
      historyFailures: 2,
      events: [
        makeReflexEvent('event_1', 1, 'agent_message_chunk', {message: 'after retry'}),
        makeReflexEvent('event_2', 2, 'turn.completed', {}),
      ],
    });
    const adapter = new ReflexAgentSessionAdapter(control, 'persona_fixture', {
      clock: new AdvancingReflexClock(),
      pollIntervalMs: 10,
      maxPollIntervalMs: 40,
    });

    const result = await adapter.invoke(makeReflexFixtureInvocation());

    expect(result.finalText).toBe('after retry');
    expect(control.historyCalls).toBeGreaterThanOrEqual(3);
  });

  it('maps public API authorization failures without leaking provider details', async () => {
    const control = new FakeReflexControl({
      launchError: new FakeReflexApiError(401, 'unauthorized'),
    });
    const adapter = new ReflexAgentSessionAdapter(control, 'persona_fixture');

    await expect(adapter.invoke(makeReflexFixtureInvocation())).rejects.toMatchObject({
      code: 'ANTB_EXTERNAL_AUTH',
      causeCode: 'unauthorized',
    });
  });

  it('interrupts and stops at most once across repeated stop calls', async () => {
    const control = new FakeReflexControl();
    const adapter = new ReflexAgentSessionAdapter(control, 'persona_fixture');

    await Promise.all([adapter.stop('agent_fixture'), adapter.stop('agent_fixture')]);
    await adapter.stop('agent_fixture');

    expect(control.interrupted).toEqual(['agent_fixture']);
    expect(control.stopped).toEqual(['agent_fixture']);
  });
});
