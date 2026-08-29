import {
  ReflexSocket,
  configureReflex,
  getAgent,
  getAgentStream,
  interruptAgent,
  isTurnEndEventType,
  launchAgentFromPersona,
  sendAgentMessage,
  stopAgent,
  type Agent,
} from '@runloop/reflex-client';

import {AntibodyError} from '../../contracts/errors.js';
import type {AgentSessionPort, OperationOptions} from '../../contracts/ports.js';
import {
  AgentInvocationResultSchema,
  AgentInvocationSchema,
  type AgentInvocationResultV1,
  type AgentInvocationV1,
} from '../../contracts/schemas.js';
import {OutputRedactor} from '../runloop/redaction.js';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_POLL_INTERVAL_MS = 8_000;
const MAX_CONSECUTIVE_READ_FAILURES = 4;

interface ReflexEvent {
  readonly id: string;
  readonly sequence?: number;
  readonly streamId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly timestamp: number;
}

interface ReflexControl {
  launchPersona(
    personaId: string,
    request: AgentInvocationV1,
    signal?: AbortSignal,
  ): Promise<Agent>;
  getAgent(agentId: string, signal?: AbortSignal): Promise<Agent>;
  sendMessage(agentId: string, message: string, signal?: AbortSignal): Promise<void>;
  getHistory(
    agentId: string,
    fromSequence?: number,
    signal?: AbortSignal,
  ): Promise<ReflexEvent[]>;
  subscribe(streamId: string, onEvent: (event: ReflexEvent) => void): () => void;
  interrupt(agentId: string, signal?: AbortSignal): Promise<void>;
  stop(agentId: string, signal?: AbortSignal): Promise<void>;
}

interface ReflexClock {
  nowMs(): number;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

interface ReflexAdapterTuning {
  readonly pollIntervalMs?: number;
  readonly maxPollIntervalMs?: number;
  readonly literalSecrets?: readonly string[];
  readonly clock?: ReflexClock;
}

export interface ReflexAdapterFactoryOptions extends ReflexAdapterTuning {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly organizationId: string;
  readonly personaId: string;
  readonly requestTimeoutMs?: number;
}

interface WatchBoundary {
  readonly sequence?: number;
  readonly ignoredIds: ReadonlySet<string>;
}

type TerminalOutcome = 'success' | 'failure';

function mergeTerminalOutcome(
  current: TerminalOutcome | undefined,
  next: TerminalOutcome | undefined,
): TerminalOutcome | undefined {
  if (current === 'failure' || next === 'failure') return 'failure';
  return current ?? next;
}

const systemClock: ReflexClock = {
  nowMs: () => Date.now(),
  sleep: async (milliseconds, signal) => {
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(abortedError());
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortedError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, milliseconds);
      signal?.addEventListener('abort', onAbort, {once: true});
    });
  },
};

function abortedError(): AntibodyError {
  return new AntibodyError('Reflex invocation was aborted', {
    code: 'ANTB_EXTERNAL_UNAVAILABLE',
    category: 'external',
    retryable: true,
    causeCode: 'ABORTED',
  });
}

function timeoutError(): AntibodyError {
  return new AntibodyError('Reflex invocation exceeded its deadline', {
    code: 'ANTB_BUDGET_EXCEEDED',
    category: 'budget',
    retryable: false,
    causeCode: 'REFLEX_TIMEOUT',
  });
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const candidate = field(value, key);
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  const candidate = field(value, key);
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
}

function safeErrorCode(error: unknown): string {
  const code = stringField(error, 'code');
  if (code !== undefined && /^[A-Za-z0-9_.-]{1,128}$/u.test(code)) return code;
  const name = stringField(error, 'name');
  if (name !== undefined && /^[A-Za-z0-9_.-]{1,128}$/u.test(name)) return name;
  return 'REFLEX_ERROR';
}

function externalError(error: unknown, stage: string): AntibodyError {
  if (error instanceof AntibodyError) return error;
  const status = numberField(error, 'status');
  if (status === 401 || status === 403) {
    return new AntibodyError(`Reflex authorization failed during ${stage}`, {
      code: 'ANTB_EXTERNAL_AUTH',
      category: 'external',
      retryable: false,
      causeCode: safeErrorCode(error),
      cause: error,
    });
  }
  if (status === 429) {
    return new AntibodyError(`Reflex rate limit reached during ${stage}`, {
      code: 'ANTB_EXTERNAL_RATE_LIMIT',
      category: 'external',
      retryable: true,
      causeCode: safeErrorCode(error),
      cause: error,
    });
  }
  return new AntibodyError(`Reflex unavailable during ${stage}`, {
    code: 'ANTB_EXTERNAL_UNAVAILABLE',
    category: 'external',
    retryable: true,
    causeCode: safeErrorCode(error),
    cause: error,
  });
}

function parsePayload(payload: unknown): unknown {
  if (typeof payload !== 'string') return payload;
  try {
    const parsed: unknown = JSON.parse(payload);
    return parsed;
  } catch {
    try {
      const parsed: unknown = JSON.parse(payload.replace(/\}\s*\}$/u, '}'));
      return parsed;
    } catch {
      return payload;
    }
  }
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((entry) => contentText(entry)).join('');
  return stringField(value, 'text') ?? '';
}

function firstText(value: unknown, keys: readonly string[]): string {
  for (const key of keys) {
    const candidate = field(value, key);
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return '';
}

function protocolType(rawType: string): string {
  const wrapped = /^turn\.[a-z0-9-]+\.(.+)$/u.exec(rawType);
  return wrapped?.[1] ?? rawType;
}

function eventTerminalOutcome(event: ReflexEvent): TerminalOutcome | undefined {
  const type = protocolType(event.type);
  const payload = parsePayload(event.payload);
  if (
    type === 'turn.failed' ||
    type === 'turn.cancelled' ||
    type === 'agent.error' ||
    type === 'agent.interrupted' ||
    type === 'agent.killed' ||
    type === 'agent.stopped' ||
    type === 'broker.error' ||
    type === 'devbox.failed' ||
    type === 'session/cancel'
  ) {
    return 'failure';
  }
  if (type === 'result') {
    return field(payload, 'is_error') === true ? 'failure' : 'success';
  }
  if (type === 'turn/completed') {
    const params = field(payload, 'params') ?? payload;
    const turn = field(params, 'turn');
    const status = stringField(turn, 'status');
    return status === 'failed' || status === 'interrupted' ? 'failure' : 'success';
  }
  if (isTurnEndEventType(event.type) || isTurnEndEventType(type)) return 'success';
  return undefined;
}

function statusTerminalOutcome(status: Agent['status']): TerminalOutcome | undefined {
  switch (status) {
    case 'completed':
    case 'needs_input':
      return 'success';
    case 'interrupted':
    case 'stopping':
    case 'stopped':
    case 'error':
    case 'terminated':
      return 'failure';
    case 'starting':
    case 'running':
      return undefined;
  }
}

function maxSequence(events: readonly ReflexEvent[]): number | undefined {
  let maximum: number | undefined;
  for (const event of events) {
    if (event.sequence !== undefined && (maximum === undefined || event.sequence > maximum)) {
      maximum = event.sequence;
    }
  }
  return maximum;
}

function eventText(events: readonly ReflexEvent[]): string {
  const ordered = [...events].sort((left, right) => {
    if (left.sequence !== undefined && right.sequence !== undefined) {
      return left.sequence - right.sequence;
    }
    if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
    return left.id.localeCompare(right.id);
  });
  const chunks: string[] = [];
  const streamedCodexItems = new Set<string>();
  let resultFallback = '';

  for (const event of ordered) {
    const type = protocolType(event.type);
    const payload = parsePayload(event.payload);
    const params = field(payload, 'params') ?? payload;

    if (type === 'result' && field(payload, 'is_error') !== true) {
      resultFallback = firstText(payload, ['result']);
      continue;
    }

    if (type === 'session/update') {
      const update = field(params, 'update');
      if (stringField(update, 'sessionUpdate') === 'agent_message_chunk') {
        chunks.push(contentText(field(update, 'content')));
      }
      continue;
    }

    if (type === 'item/agentMessage/delta') {
      const delta = firstText(params, ['delta']);
      const itemId = stringField(params, 'itemId');
      if (itemId !== undefined) streamedCodexItems.add(itemId);
      chunks.push(delta);
      continue;
    }

    if (type === 'item/completed') {
      const item = field(params, 'item');
      if (stringField(item, 'type') !== 'agentMessage') continue;
      const itemId = stringField(item, 'id');
      if (itemId === undefined || !streamedCodexItems.has(itemId)) {
        chunks.push(firstText(item, ['text']));
      }
      continue;
    }

    if (type === 'agent_message_chunk' || type === 'turn.message_chunk') {
      chunks.push(firstText(payload, ['message', 'text', 'content', 'delta']));
      continue;
    }

    if (type === 'assistant') {
      const message = field(payload, 'message');
      if (typeof message === 'string') {
        chunks.push(message);
      } else {
        chunks.push(contentText(field(message, 'content')) || firstText(payload, ['text', 'content']));
      }
    }
  }

  const streamed = chunks.join('');
  return streamed.length > 0 ? streamed : resultFallback;
}

function boundUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function isNotFound(error: unknown): boolean {
  return numberField(error, 'status') === 404;
}

function requestOptions(signal?: AbortSignal): RequestInit {
  return signal === undefined ? {} : {signal};
}

class SdkReflexControl implements ReflexControl {
  readonly #socket: ReflexSocket;

  constructor(socket: ReflexSocket) {
    this.#socket = socket;
  }

  async launchPersona(
    personaId: string,
    request: AgentInvocationV1,
    signal?: AbortSignal,
  ): Promise<Agent> {
    const response = await launchAgentFromPersona(
      personaId,
      {
        prompt: request.prompt,
        promptStrategy: 'replace',
        repoSlug: request.repository.slug,
        repoBranch: request.checkoutSha,
      },
      requestOptions(signal),
    );
    return response.data;
  }

  async getAgent(agentId: string, signal?: AbortSignal): Promise<Agent> {
    const response = await getAgent(agentId, requestOptions(signal));
    return response.data;
  }

  async sendMessage(agentId: string, message: string, signal?: AbortSignal): Promise<void> {
    await sendAgentMessage(agentId, {message}, requestOptions(signal));
  }

  async getHistory(
    agentId: string,
    fromSequence?: number,
    signal?: AbortSignal,
  ): Promise<ReflexEvent[]> {
    const response = await getAgentStream(
      agentId,
      {paged: 'false', ...(fromSequence === undefined ? {} : {fromSeq: fromSequence})},
      requestOptions(signal),
    );
    return Array.isArray(response.data) ? response.data : response.data.events;
  }

  subscribe(streamId: string, onEvent: (event: ReflexEvent) => void): () => void {
    return this.#socket.subscribe(streamId, (event) => {
      onEvent(event);
    });
  }

  async interrupt(agentId: string, signal?: AbortSignal): Promise<void> {
    await interruptAgent(agentId, requestOptions(signal));
  }

  async stop(agentId: string, signal?: AbortSignal): Promise<void> {
    await stopAgent(agentId, requestOptions(signal));
  }
}

export function createReflexAgentSessionAdapter(
  options: ReflexAdapterFactoryOptions,
): ReflexAgentSessionAdapter {
  configureReflex({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    organizationId: options.organizationId,
    ...(options.requestTimeoutMs === undefined ? {} : {timeoutMs: options.requestTimeoutMs}),
  });
  return new ReflexAgentSessionAdapter(
    new SdkReflexControl(new ReflexSocket()),
    options.personaId,
    {
      ...options,
      literalSecrets: [options.apiKey, ...(options.literalSecrets ?? [])],
    },
  );
}

export class ReflexAgentSessionAdapter implements AgentSessionPort {
  readonly #control: ReflexControl;
  readonly #personaId: string;
  readonly #redactor: OutputRedactor;
  readonly #clock: ReflexClock;
  readonly #pollIntervalMs: number;
  readonly #maxPollIntervalMs: number;
  readonly #stopOperations = new Map<string, Promise<void>>();

  constructor(
    control: ReflexControl,
    personaId: string,
    tuning: ReflexAdapterTuning = {},
  ) {
    this.#control = control;
    this.#personaId = personaId;
    this.#redactor = new OutputRedactor(tuning.literalSecrets);
    this.#clock = tuning.clock ?? systemClock;
    this.#pollIntervalMs = tuning.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#maxPollIntervalMs = tuning.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS;
  }

  async invoke(
    input: AgentInvocationV1,
    options: OperationOptions = {},
  ): Promise<AgentInvocationResultV1> {
    const parsed = AgentInvocationSchema.safeParse(input);
    if (!parsed.success) {
      throw new AntibodyError('Agent invocation failed frozen contract validation', {
        code: 'ANTB_INPUT_INVALID',
        category: 'input',
        retryable: false,
        causeCode: 'AGENT_INVOCATION_SCHEMA',
      });
    }
    const request = parsed.data;
    if (this.#personaId.length === 0 || this.#personaId.length > 512) {
      throw new AntibodyError('Reflex Persona id is invalid', {
        code: 'ANTB_INPUT_INVALID',
        category: 'input',
        retryable: false,
        causeCode: 'REFLEX_PERSONA_ID',
      });
    }

    const startedMs = this.#clock.nowMs();
    const deadlineMs = startedMs + request.timeoutMs;
    const deadlineController = new AbortController();
    const onCallerAbort = (): void => {
      deadlineController.abort();
    };
    options.signal?.addEventListener('abort', onCallerAbort, {once: true});
    const deadlineTimer = setTimeout(() => {
      deadlineController.abort();
    }, request.timeoutMs);
    let agent: Agent | undefined;

    try {
      if (options.signal?.aborted === true) throw abortedError();
      let boundary: WatchBoundary = {ignoredIds: new Set()};
      if (request.continuationId === undefined) {
        agent = await this.#control.launchPersona(
          this.#personaId,
          request,
          deadlineController.signal,
        );
      } else {
        agent = await this.#control.getAgent(request.continuationId, deadlineController.signal);
        const prior = await this.#control.getHistory(
          agent.id,
          undefined,
          deadlineController.signal,
        );
        const sequence = maxSequence(prior);
        boundary = {
          ...(sequence === undefined ? {} : {sequence}),
          ignoredIds: new Set(prior.map(({id}) => id)),
        };
        await this.#control.sendMessage(agent.id, request.prompt, deadlineController.signal);
      }

      const events = await this.#watch(
        agent,
        boundary,
        deadlineMs,
        deadlineController.signal,
      );
      const finalText = boundUtf8(
        this.#redactor.redact(eventText(events)),
        request.maxOutputBytes,
      );
      const finishedMs = this.#clock.nowMs();
      return AgentInvocationResultSchema.parse({
        schemaVersion: 'antibody.agent-result/v1',
        invocationId: request.invocationId,
        continuationId: agent.id,
        finalText,
        provider: {
          name: 'reflex',
          agentId: agent.id,
          streamId: agent.streamId,
          ...(agent.personaId == null ? {} : {personaId: agent.personaId}),
        },
        startedAt: new Date(startedMs).toISOString(),
        finishedAt: new Date(finishedMs).toISOString(),
      });
    } catch (error) {
      if (agent !== undefined) await this.#bestEffortInterrupt(agent.id);
      if (this.#clock.nowMs() >= deadlineMs) throw timeoutError();
      if (options.signal?.aborted === true) throw abortedError();
      throw externalError(error, 'agent invocation');
    } finally {
      clearTimeout(deadlineTimer);
      options.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  async stop(continuationId: string): Promise<void> {
    if (continuationId.length === 0 || continuationId.length > 512) {
      throw new AntibodyError('Reflex continuation id is invalid', {
        code: 'ANTB_INPUT_INVALID',
        category: 'input',
        retryable: false,
        causeCode: 'REFLEX_CONTINUATION_ID',
      });
    }
    const existing = this.#stopOperations.get(continuationId);
    if (existing !== undefined) return existing;
    const operation = this.#stopOnce(continuationId);
    this.#stopOperations.set(continuationId, operation);
    try {
      await operation;
    } catch (error) {
      this.#stopOperations.delete(continuationId);
      throw externalError(error, 'agent stop');
    }
  }

  async #watch(
    agent: Agent,
    boundary: WatchBoundary,
    deadlineMs: number,
    signal: AbortSignal,
  ): Promise<ReflexEvent[]> {
    const events: ReflexEvent[] = [];
    const seenIds = new Set(boundary.ignoredIds);
    const terminalState: {outcome: TerminalOutcome | undefined} = {outcome: undefined};
    let pollIntervalMs = this.#pollIntervalMs;
    let consecutiveReadFailures = 0;

    const observe = (event: ReflexEvent): void => {
      if (seenIds.has(event.id)) return;
      if (
        boundary.sequence !== undefined &&
        event.sequence !== undefined &&
        event.sequence <= boundary.sequence
      ) {
        seenIds.add(event.id);
        return;
      }
      seenIds.add(event.id);
      events.push(event);
      const outcome = eventTerminalOutcome(event);
      terminalState.outcome = mergeTerminalOutcome(terminalState.outcome, outcome);
    };

    const unsubscribe = this.#control.subscribe(agent.streamId, observe);
    try {
      while (terminalState.outcome === undefined) {
        if (signal.aborted) throw abortedError();
        if (this.#clock.nowMs() >= deadlineMs) throw timeoutError();
        try {
          const history = await this.#control.getHistory(
            agent.id,
            boundary.sequence === undefined ? undefined : boundary.sequence + 1,
            signal,
          );
          for (const event of history) observe(event);
          const current = await this.#control.getAgent(agent.id, signal);
          const statusOutcome = statusTerminalOutcome(current.status);
          terminalState.outcome = mergeTerminalOutcome(terminalState.outcome, statusOutcome);
          consecutiveReadFailures = 0;
          pollIntervalMs = this.#pollIntervalMs;
        } catch (error) {
          consecutiveReadFailures += 1;
          if (consecutiveReadFailures >= MAX_CONSECUTIVE_READ_FAILURES) {
            throw externalError(error, 'agent stream polling');
          }
          pollIntervalMs = Math.min(pollIntervalMs * 2, this.#maxPollIntervalMs);
        }
        if (terminalState.outcome === undefined) {
          const remaining = deadlineMs - this.#clock.nowMs();
          await this.#clock.sleep(Math.min(pollIntervalMs, Math.max(1, remaining)), signal);
        }
      }

      try {
        const finalHistory = await this.#control.getHistory(
          agent.id,
          boundary.sequence === undefined ? undefined : boundary.sequence + 1,
          signal,
        );
        for (const event of finalHistory) observe(event);
      } catch {
        // The terminal event and already captured raw text remain authoritative.
      }

      if (terminalState.outcome === 'failure') {
        throw new AntibodyError('Reflex agent reached a terminal failure state', {
          code: 'ANTB_EXTERNAL_UNAVAILABLE',
          category: 'external',
          retryable: true,
          causeCode: 'REFLEX_TERMINAL_FAILURE',
        });
      }
      return events;
    } finally {
      unsubscribe();
    }
  }

  async #bestEffortInterrupt(agentId: string): Promise<void> {
    try {
      await this.#control.interrupt(agentId);
    } catch {
      // The original timeout, abort, or provider error remains primary.
    }
  }

  async #stopOnce(agentId: string): Promise<void> {
    let agent: Agent;
    try {
      agent = await this.#control.getAgent(agentId);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    if (agent.status === 'stopped' || agent.status === 'terminated') return;
    try {
      await this.#control.interrupt(agentId);
    } catch (error) {
      const status = numberField(error, 'status');
      if (status !== 404 && status !== 409) throw error;
    }
    try {
      await this.#control.stop(agentId);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}
