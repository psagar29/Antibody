import type {BlueprintView} from '@runloop/api-client/resources/blueprints.js';
import type {
  DevboxAsyncExecutionDetailView,
  DevboxCreateParams,
  DevboxView,
} from '@runloop/api-client/resources/devboxes/devboxes.js';
import type {DevboxSnapshotAsyncStatusView} from '@runloop/api-client/resources/devboxes/disk-snapshots.js';
import type {NetworkPolicyView} from '@runloop/api-client/resources/network-policies.js';

import type {RawVerificationEvidenceV1} from '../../../src/contracts/schemas.js';
import {runloopFixturePatchSha256} from './fixtures.js';

export type FakeRunloopFault =
  | 'resolve'
  | 'create'
  | 'provision'
  | 'upload'
  | 'execute'
  | 'report'
  | 'shutdown';

export interface FakeRunloopOptions {
  readonly fault?: FakeRunloopFault;
  readonly faultCommand?: string;
  readonly runningExecutions?: boolean;
  readonly abortController?: AbortController;
  readonly abortOnCommand?: string;
  readonly truncatedCommand?: string;
  readonly outputText?: string;
}

function makeDevbox(
  id: string,
  params: DevboxCreateParams,
  status: DevboxView['status'],
): DevboxView {
  return {
    id,
    capabilities: [],
    create_time_ms: 1_788_019_200_000,
    end_time_ms: status === 'shutdown' ? 1_788_019_201_000 : null,
    launch_parameters: params.launch_parameters ?? {},
    metadata: params.metadata ?? {},
    state_transitions: [],
    status,
    ...(params.blueprint_id == null ? {} : {blueprint_id: params.blueprint_id}),
    ...(params.snapshot_id == null ? {} : {snapshot_id: params.snapshot_id}),
  };
}

export class FakeRunloopControl {
  readonly createParams: DevboxCreateParams[] = [];
  readonly commands: string[] = [];
  readonly uploads: {devboxId: string; path: string; content: Uint8Array}[] = [];
  readonly killed: string[] = [];
  readonly shutdowns: string[] = [];
  readonly events: string[] = [];
  readonly #options: FakeRunloopOptions;
  readonly #devboxes = new Map<string, DevboxView>();
  readonly #checkouts = new Map<string, string>();
  #executionCount = 0;
  #createCount = 0;
  #active = 0;
  maxActive = 0;

  constructor(options: FakeRunloopOptions = {}) {
    this.#options = options;
  }

  retrieveBlueprint(id: string): Promise<BlueprintView> {
    if (this.#options.fault === 'resolve') return Promise.reject(new Error('resolve failed'));
    return Promise.resolve({
      id,
      create_time_ms: 1_788_019_200_000,
      name: 'fixture-blueprint',
      parameters: {
        name: 'fixture-blueprint',
        launch_parameters: {architecture: 'x86_64', resource_size_request: 'SMALL'},
      },
      state: 'created',
      status: 'build_complete',
    });
  }

  querySnapshot(id: string): Promise<DevboxSnapshotAsyncStatusView> {
    if (this.#options.fault === 'resolve') return Promise.reject(new Error('resolve failed'));
    return Promise.resolve({
      status: 'complete',
      snapshot: {
        id,
        create_time_ms: 1_788_019_200_000,
        metadata: {},
        source_devbox_id: 'devbox_source',
        source_blueprint_id: 'bpt_fixture',
      },
    });
  }

  retrieveNetworkPolicy(id: string): Promise<NetworkPolicyView> {
    if (this.#options.fault === 'resolve') return Promise.reject(new Error('resolve failed'));
    return Promise.resolve({
      id,
      create_time_ms: 1_788_019_200_000,
      update_time_ms: 1_788_019_200_000,
      name: 'fixture-policy',
      egress: {
        allow_agent_gateway: false,
        allow_all: false,
        allow_devbox_to_devbox: false,
        allow_mcp_gateway: false,
        allow_runloop_mirrors: true,
        allowed_cidrs: [],
        allowed_hostnames: ['github.com', 'registry.npmjs.org'],
      },
    });
  }

  createDevbox(params: DevboxCreateParams): Promise<DevboxView> {
    if (this.#options.fault === 'create') return Promise.reject(new Error('create failed'));
    this.#createCount += 1;
    const id = `devbox_${String(this.#createCount)}`;
    this.createParams.push(params);
    const status = this.#options.fault === 'provision' ? 'queued' : 'running';
    const view = makeDevbox(id, params, status);
    this.#devboxes.set(id, view);
    this.#active += 1;
    this.maxActive = Math.max(this.maxActive, this.#active);
    this.events.push(`create:${id}`);
    return Promise.resolve(view);
  }

  retrieveDevbox(id: string): Promise<DevboxView> {
    const view = this.#devboxes.get(id);
    if (view === undefined) return Promise.reject(new Error('unknown devbox'));
    if (this.#options.fault === 'provision' && view.status !== 'shutdown') {
      return Promise.reject(new Error('provision polling failed'));
    }
    return Promise.resolve(view);
  }

  uploadFile(devboxId: string, path: string, content: Uint8Array): Promise<void> {
    if (this.#options.fault === 'upload') return Promise.reject(new Error('upload failed'));
    this.uploads.push({devboxId, path, content});
    return Promise.resolve();
  }

  executeAsync(
    devboxId: string,
    command: string,
  ): Promise<DevboxAsyncExecutionDetailView> {
    this.commands.push(command);
    this.#executionCount += 1;
    const executionId = `exec_${String(this.#executionCount)}`;
    if (
      this.#options.fault === 'execute' &&
      (this.#options.faultCommand === undefined || command.includes(this.#options.faultCommand))
    ) {
      return Promise.reject(new Error('execute failed'));
    }
    const checkout = /'git' 'checkout' '--detach' '([0-9a-f]{40})'/u.exec(command);
    if (checkout?.[1] !== undefined) this.#checkouts.set(devboxId, checkout[1]);
    const stdout = this.#stdout(devboxId, command);
    const truncated =
      this.#options.truncatedCommand !== undefined && command.includes(this.#options.truncatedCommand);
    if (
      this.#options.abortController !== undefined &&
      (this.#options.abortOnCommand === undefined || command.includes(this.#options.abortOnCommand))
    ) {
      this.#options.abortController.abort();
    }
    return Promise.resolve({
      devbox_id: devboxId,
      execution_id: executionId,
      status: this.#options.runningExecutions === true ? 'running' : 'completed',
      ...(this.#options.runningExecutions === true ? {} : {exit_status: 0}),
      stdout,
      stderr: '',
      stdout_truncated: truncated,
      stderr_truncated: false,
    });
  }

  retrieveExecution(
    devboxId: string,
    executionId: string,
  ): Promise<DevboxAsyncExecutionDetailView> {
    return Promise.resolve({
      devbox_id: devboxId,
      execution_id: executionId,
      status: 'running',
      stdout: '',
      stderr: '',
    });
  }

  killExecution(devboxId: string, executionId: string): Promise<void> {
    void devboxId;
    this.killed.push(executionId);
    return Promise.resolve();
  }

  readFile(devboxId: string, path: string): Promise<string> {
    void devboxId;
    void path;
    if (this.#options.fault === 'report') return Promise.reject(new Error('report unavailable'));
    return Promise.resolve('TAP version 13\n1..1\nok 1 - fixture\n');
  }

  shutdown(devboxId: string): Promise<DevboxView> {
    this.shutdowns.push(devboxId);
    this.events.push(`shutdown:${devboxId}`);
    if (this.#options.fault === 'shutdown') return Promise.reject(new Error('shutdown failed'));
    const prior = this.#devboxes.get(devboxId);
    if (prior === undefined) return Promise.reject(new Error('unknown devbox'));
    const view = makeDevbox(devboxId, {
      launch_parameters: prior.launch_parameters,
      metadata: prior.metadata,
      ...(prior.blueprint_id == null ? {} : {blueprint_id: prior.blueprint_id}),
      ...(prior.snapshot_id == null ? {} : {snapshot_id: prior.snapshot_id}),
    }, 'shutdown');
    this.#devboxes.set(devboxId, view);
    this.#active -= 1;
    return Promise.resolve(view);
  }

  #stdout(devboxId: string, command: string): string {
    if (command.includes("'git' 'rev-parse' 'HEAD'")) {
      return `${this.#checkouts.get(devboxId) ?? ''}\n`;
    }
    if (command.includes("'sha256sum' '--'")) {
      return `${runloopFixturePatchSha256.slice('sha256:'.length)}  patch.diff\n`;
    }
    if (command.includes("'git' 'status' '--short'")) {
      return '?? test/regression.test.js\n';
    }
    return this.#options.outputText ?? 'fixture output\n';
  }
}

export class FakeRunloopPersistence {
  readonly artifacts = new Map<string, Uint8Array>();
  readonly evidence: RawVerificationEvidenceV1[] = [];
  readonly events: string[];
  failArtifacts = false;

  constructor(events: string[]) {
    this.events = events;
  }

  persistArtifact(name: string, content: Uint8Array): Promise<void> {
    if (this.failArtifacts) return Promise.reject(new Error('artifact persistence failed'));
    this.artifacts.set(name, content);
    return Promise.resolve();
  }

  persistRawEvidence(evidence: RawVerificationEvidenceV1): Promise<void> {
    this.evidence.push(evidence);
    this.events.push('persist:evidence');
    return Promise.resolve();
  }
}
