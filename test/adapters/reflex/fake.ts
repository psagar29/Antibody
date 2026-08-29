import type {Agent} from '@runloop/reflex-client';

import type {AgentInvocationV1} from '../../../src/contracts/schemas.js';

export interface FakeReflexEvent {
  readonly id: string;
  readonly sequence?: number;
  readonly streamId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly timestamp: number;
}

export interface FakeReflexOptions {
  readonly priorEvents?: readonly FakeReflexEvent[];
  readonly events?: readonly FakeReflexEvent[];
  readonly socketEvents?: readonly FakeReflexEvent[];
  readonly status?: Agent['status'];
  readonly launchError?: Error;
  readonly historyFailures?: number;
  readonly abortController?: AbortController;
  readonly abortOnHistory?: boolean;
}

export function makeReflexAgent(status: Agent['status'] = 'running'): Agent {
  return {
    id: 'agent_fixture',
    streamId: 'stream_fixture',
    agentType: 'codex',
    status,
    turnState: status === 'running' ? 'working' : 'idle',
    turnStateVersion: 1,
    devboxId: 'devbox_fixture',
    name: 'fixture-agent',
    prompt: 'fixture prompt',
    personaId: 'persona_fixture',
    createdAt: 1_788_019_200_000,
    archived: false,
    ownerId: 'user_fixture',
    organizationId: 'org_fixture',
    pinned: false,
  };
}

export function makeReflexEvent(
  id: string,
  sequence: number,
  type: string,
  payload: unknown,
): FakeReflexEvent {
  return {
    id,
    sequence,
    streamId: 'stream_fixture',
    type,
    payload,
    timestamp: 1_788_019_200_000 + sequence,
  };
}

export class FakeReflexApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super('fixture provider error');
    this.name = 'FakeReflexApiError';
    this.status = status;
    this.code = code;
  }
}

export class FakeReflexControl {
  readonly launches: {personaId: string; request: AgentInvocationV1}[] = [];
  readonly sent: {agentId: string; message: string}[] = [];
  readonly interrupted: string[] = [];
  readonly stopped: string[] = [];
  readonly subscriptions: string[] = [];
  unsubscribeCount = 0;
  historyCalls = 0;
  readonly #options: FakeReflexOptions;
  #messageSent = false;

  constructor(options: FakeReflexOptions = {}) {
    this.#options = options;
  }

  launchPersona(
    personaId: string,
    request: AgentInvocationV1,
    _signal?: AbortSignal,
  ): Promise<Agent> {
    void _signal;
    if (this.#options.launchError !== undefined) {
      return Promise.reject(this.#options.launchError);
    }
    this.launches.push({personaId, request});
    return Promise.resolve(makeReflexAgent());
  }

  getAgent(_agentId: string, _signal?: AbortSignal): Promise<Agent> {
    void _agentId;
    void _signal;
    return Promise.resolve(makeReflexAgent(this.#options.status ?? 'running'));
  }

  sendMessage(agentId: string, message: string, _signal?: AbortSignal): Promise<void> {
    void _signal;
    this.sent.push({agentId, message});
    this.#messageSent = true;
    return Promise.resolve();
  }

  getHistory(
    _agentId: string,
    _fromSequence?: number,
    _signal?: AbortSignal,
  ): Promise<FakeReflexEvent[]> {
    void _agentId;
    void _fromSequence;
    void _signal;
    this.historyCalls += 1;
    if (
      this.#options.historyFailures !== undefined &&
      this.historyCalls <= this.#options.historyFailures
    ) {
      return Promise.reject(new Error('history failed'));
    }
    if (this.#options.abortOnHistory === true) this.#options.abortController?.abort();
    const events = this.#messageSent
      ? (this.#options.events ?? [])
      : (this.#options.priorEvents ?? this.#options.events ?? []);
    return Promise.resolve([...events]);
  }

  subscribe(
    streamId: string,
    onEvent: (event: FakeReflexEvent) => void,
  ): () => void {
    this.subscriptions.push(streamId);
    for (const event of this.#options.socketEvents ?? []) onEvent(event);
    return () => {
      this.unsubscribeCount += 1;
    };
  }

  interrupt(agentId: string, _signal?: AbortSignal): Promise<void> {
    void _signal;
    this.interrupted.push(agentId);
    return Promise.resolve();
  }

  stop(agentId: string, _signal?: AbortSignal): Promise<void> {
    void _signal;
    this.stopped.push(agentId);
    return Promise.resolve();
  }
}

export class AdvancingReflexClock {
  #milliseconds = 1_788_019_200_000;

  nowMs(): number {
    return this.#milliseconds;
  }

  sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(new Error('aborted'));
    this.#milliseconds += milliseconds;
    return Promise.resolve();
  }
}
