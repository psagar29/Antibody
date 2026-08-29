import {createHash} from 'node:crypto';

import {
  RunloopSDK,
  toFile,
} from '@runloop/api-client';
import type {BlueprintView} from '@runloop/api-client/resources/blueprints.js';
import type {
  DevboxAsyncExecutionDetailView,
  DevboxCreateParams,
  DevboxView,
} from '@runloop/api-client/resources/devboxes/devboxes.js';
import type {DevboxSnapshotAsyncStatusView} from '@runloop/api-client/resources/devboxes/disk-snapshots.js';
import type {NetworkPolicyView} from '@runloop/api-client/resources/network-policies.js';

import {AntibodyError} from '../../contracts/errors.js';
import type {OperationOptions, VerificationExecutionPort} from '../../contracts/ports.js';
import {
  ArtifactSchema,
  CommandSpecSchema,
  RawExecutionAttemptSchema,
  RawVerificationEvidenceSchema,
  VerificationRequestSchema,
  type ArtifactV1,
  type CommandSpecV1,
  type RawExecutionAttemptV1,
  type RawVerificationEvidenceV1,
  type VerificationRequestV1,
} from '../../contracts/schemas.js';
import {renderPosixCommand} from './argv.js';
import {OutputRedactor} from './redaction.js';

const PATCH_REMOTE_PATH = '/home/user/.antibody/patch.diff';
const DEFAULT_INLINE_ARTIFACT_BYTES = 1_048_576;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_CONTROLLER_GRACE_MS = 5_000;
const DEFAULT_PROVISION_TIMEOUT_MS = 180_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

interface RunloopControl {
  retrieveBlueprint(id: string, signal?: AbortSignal): Promise<BlueprintView>;
  querySnapshot(id: string, signal?: AbortSignal): Promise<DevboxSnapshotAsyncStatusView>;
  retrieveNetworkPolicy(id: string, signal?: AbortSignal): Promise<NetworkPolicyView>;
  createDevbox(
    params: DevboxCreateParams,
    signal?: AbortSignal,
  ): Promise<DevboxView>;
  retrieveDevbox(id: string, signal?: AbortSignal): Promise<DevboxView>;
  uploadFile(
    devboxId: string,
    path: string,
    content: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void>;
  executeAsync(
    devboxId: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<DevboxAsyncExecutionDetailView>;
  retrieveExecution(
    devboxId: string,
    executionId: string,
    signal?: AbortSignal,
  ): Promise<DevboxAsyncExecutionDetailView>;
  killExecution(devboxId: string, executionId: string, signal?: AbortSignal): Promise<void>;
  readFile(devboxId: string, path: string, signal?: AbortSignal): Promise<string>;
  shutdown(devboxId: string, signal?: AbortSignal): Promise<DevboxView>;
}

interface RunloopPersistence {
  persistArtifact(name: string, content: Uint8Array): Promise<void>;
  persistRawEvidence(evidence: RawVerificationEvidenceV1): Promise<void>;
}

interface AdapterClock {
  nowMs(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

interface RunloopAdapterTuning {
  readonly inlineArtifactBytes?: number;
  readonly pollIntervalMs?: number;
  readonly controllerGraceMs?: number;
  readonly provisionTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly literalSecrets?: readonly string[];
  readonly clock?: AdapterClock;
}

export interface RunloopAdapterFactoryOptions extends RunloopAdapterTuning {
  readonly apiKey: string;
  readonly githubToken?: string;
  readonly baseUrl?: string;
  readonly persistArtifact: (name: string, content: Uint8Array) => Promise<void>;
  readonly persistRawEvidence: (evidence: RawVerificationEvidenceV1) => Promise<void>;
}

interface SourceResolution {
  readonly kind: 'blueprint' | 'snapshot';
  readonly id: string;
  readonly blueprintId?: string;
  readonly snapshotId?: string;
  readonly architecture?: string;
  readonly shape?: string;
}

interface NetworkResolution {
  readonly id: string;
  readonly sha256: `sha256:${string}`;
}

interface ProviderMetadata {
  readonly devboxId: string;
  readonly resolvedBlueprintId?: string;
  readonly resolvedSnapshotId?: string;
  readonly networkPolicyId?: string;
  readonly resolvedNetworkPolicySha256?: `sha256:${string}`;
  readonly architecture?: string;
  readonly shape?: string;
}

interface ProvisionedDevbox {
  readonly id: string;
  readonly repositoryRoot: string;
  readonly provider: ProviderMetadata;
  active: boolean;
}

interface RemoteRunResult {
  readonly attempt: RawExecutionAttemptV1;
  readonly completed: boolean;
  readonly aborted: boolean;
}

interface AttemptContext {
  readonly lane: 'parent' | 'fix' | 'head';
  readonly phase: 'setup' | 'baseline' | 'candidate' | 'full-suite';
  readonly checkoutSha: VerificationRequestV1['candidate']['parentSha'];
  readonly patchSha256?: VerificationRequestV1['patch']['sha256'];
  readonly command: CommandSpecV1;
}

interface ExecutionState {
  readonly request: VerificationRequestV1;
  readonly patch: Uint8Array;
  readonly source: SourceResolution;
  readonly network?: NetworkResolution;
  readonly attempts: RawExecutionAttemptV1[];
  readonly devboxes: ProvisionedDevbox[];
  readonly cleanup: Map<string, RawVerificationEvidenceV1['cleanup'][number]>;
  readonly counters: Map<string, number>;
  parent?: ProvisionedDevbox;
  fix?: ProvisionedDevbox;
}

const systemClock: AdapterClock = {
  nowMs: () => Date.now(),
  sleep: async (ms, signal) => {
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(abortedError());
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortedError());
      };
      signal?.addEventListener('abort', onAbort, {once: true});
    });
  },
};

function abortedError(): AntibodyError {
  return new AntibodyError('Operation was aborted', {
    code: 'ANTB_EXTERNAL_UNAVAILABLE',
    category: 'external',
    retryable: true,
    causeCode: 'ABORTED',
  });
}

function sha256(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function parseBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new AntibodyError('Patch is not canonical base64', {
      code: 'ANTB_INPUT_INVALID',
      category: 'input',
      retryable: false,
      causeCode: 'PATCH_BASE64',
    });
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new AntibodyError('Patch is not canonical base64', {
      code: 'ANTB_INPUT_INVALID',
      category: 'input',
      retryable: false,
      causeCode: 'PATCH_BASE64',
    });
  }
  return decoded;
}

function safeErrorField(error: unknown, field: string): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, field) : undefined;
}

function safeErrorCode(error: unknown): string {
  const code = safeErrorField(error, 'code');
  if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,128}$/u.test(code)) return code;
  const name = safeErrorField(error, 'name');
  if (typeof name === 'string' && /^[A-Za-z0-9_.-]{1,128}$/u.test(name)) return name;
  return 'RUNLOOP_ERROR';
}

function externalError(error: unknown, stage: string): AntibodyError {
  if (error instanceof AntibodyError) return error;
  const status = safeErrorField(error, 'status');
  if (status === 401 || status === 403) {
    return new AntibodyError(`Runloop authorization failed during ${stage}`, {
      code: 'ANTB_EXTERNAL_AUTH',
      category: 'external',
      retryable: false,
      causeCode: safeErrorCode(error),
      cause: error,
    });
  }
  if (status === 429) {
    return new AntibodyError(`Runloop rate limit reached during ${stage}`, {
      code: 'ANTB_EXTERNAL_RATE_LIMIT',
      category: 'external',
      retryable: true,
      causeCode: safeErrorCode(error),
      cause: error,
    });
  }
  return new AntibodyError(`Runloop unavailable during ${stage}`, {
    code: 'ANTB_EXTERNAL_UNAVAILABLE',
    category: 'external',
    retryable: true,
    causeCode: safeErrorCode(error),
    cause: error,
  });
}

function resourceSize(shape: string | undefined): NonNullable<
  NonNullable<DevboxCreateParams['launch_parameters']>['resource_size_request']
> | undefined {
  switch (shape) {
    case undefined:
      return undefined;
    case 'X_SMALL':
    case 'SMALL':
    case 'MEDIUM':
    case 'LARGE':
    case 'X_LARGE':
    case 'XX_LARGE':
      return shape;
    default:
      throw new AntibodyError(`Unsupported Runloop resource shape: ${shape}`, {
        code: 'ANTB_INPUT_INVALID',
        category: 'input',
        retryable: false,
        causeCode: 'RUNLOOP_SHAPE_UNSUPPORTED',
      });
  }
}

function networkPolicyDigest(policy: NetworkPolicyView): `sha256:${string}` {
  const canonical = {
    id: policy.id,
    name: policy.name,
    description: policy.description ?? null,
    createTimeMs: policy.create_time_ms,
    updateTimeMs: policy.update_time_ms,
    egress: {
      allowAgentGateway: policy.egress.allow_agent_gateway,
      allowAll: policy.egress.allow_all,
      allowDevboxToDevbox: policy.egress.allow_devbox_to_devbox,
      allowMcpGateway: policy.egress.allow_mcp_gateway,
      allowRunloopMirrors: policy.egress.allow_runloop_mirrors,
      allowedHostnames: policy.egress.allowed_hostnames.toSorted(),
      allowedCidrs: policy.egress.allowed_cidrs
        .map((entry) => ({
          cidr: entry.cidr,
          ports: (entry.ports ?? [])
            .map((port) => ({
              port: port.port,
              endPort: port.end_port ?? null,
              protocol: port.protocol ?? null,
            }))
            .toSorted((left, right) =>
              `${left.protocol}:${left.port}:${left.endPort ?? ''}`.localeCompare(
                `${right.protocol}:${right.port}:${right.endPort ?? ''}`,
              ),
            ),
        }))
        .toSorted((left, right) => left.cidr.localeCompare(right.cidr)),
    },
  };
  return sha256(Buffer.from(JSON.stringify(canonical), 'utf8'));
}

function internalCommand(argv: readonly [string, ...string[]], timeoutMs = 30_000): CommandSpecV1 {
  return CommandSpecSchema.parse({argv, cwd: '.', env: {}, timeoutMs});
}

function withTargetPaths(command: CommandSpecV1, paths: readonly string[]): CommandSpecV1 {
  return CommandSpecSchema.parse({
    ...command,
    argv: [...command.argv, ...paths],
  });
}

function isoTime(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function repositoryParts(request: VerificationRequestV1): {owner: string; name: string} {
  const separator = request.candidate.repository.slug.indexOf('/');
  return {
    owner: request.candidate.repository.slug.slice(0, separator),
    name: request.candidate.repository.slug.slice(separator + 1),
  };
}

class SdkRunloopControl implements RunloopControl {
  readonly #sdk: RunloopSDK;

  constructor(sdk: RunloopSDK) {
    this.#sdk = sdk;
  }

  async retrieveBlueprint(id: string, signal?: AbortSignal): Promise<BlueprintView> {
    return this.#sdk.api.blueprints.retrieve(id, {signal, maxRetries: 2});
  }

  async querySnapshot(id: string, signal?: AbortSignal): Promise<DevboxSnapshotAsyncStatusView> {
    return this.#sdk.api.devboxes.diskSnapshots.queryStatus(id, {signal, maxRetries: 2});
  }

  async retrieveNetworkPolicy(id: string, signal?: AbortSignal): Promise<NetworkPolicyView> {
    return this.#sdk.api.networkPolicies.retrieve(id, {signal, maxRetries: 2});
  }

  async createDevbox(
    params: DevboxCreateParams,
    signal?: AbortSignal,
  ): Promise<DevboxView> {
    return this.#sdk.api.devboxes.create(params, {signal, maxRetries: 0});
  }

  async retrieveDevbox(id: string, signal?: AbortSignal): Promise<DevboxView> {
    return this.#sdk.api.devboxes.retrieve(id, {signal, maxRetries: 2});
  }

  async uploadFile(
    devboxId: string,
    path: string,
    content: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    const file = await toFile(content, 'patch.diff');
    await this.#sdk.api.devboxes.uploadFile(devboxId, {path, file}, {signal});
  }

  async executeAsync(
    devboxId: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<DevboxAsyncExecutionDetailView> {
    return this.#sdk.api.devboxes.executeAsync(devboxId, {command}, {signal});
  }

  async retrieveExecution(
    devboxId: string,
    executionId: string,
    signal?: AbortSignal,
  ): Promise<DevboxAsyncExecutionDetailView> {
    return this.#sdk.api.devboxes.executions.retrieve(
      devboxId,
      executionId,
      {last_n: '1000000'},
      {signal},
    );
  }

  async killExecution(
    devboxId: string,
    executionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#sdk.api.devboxes.executions.kill(
      devboxId,
      executionId,
      {kill_process_group: true},
      {signal},
    );
  }

  async readFile(devboxId: string, path: string, signal?: AbortSignal): Promise<string> {
    return this.#sdk.api.devboxes.readFileContents(
      devboxId,
      {file_path: path},
      {signal, maxRetries: 2},
    );
  }

  async shutdown(devboxId: string, signal?: AbortSignal): Promise<DevboxView> {
    return this.#sdk.api.devboxes.shutdown(devboxId, {force: 'true'}, {signal});
  }
}

export function createRunloopVerificationAdapter(
  options: RunloopAdapterFactoryOptions,
): RunloopVerificationAdapter {
  const sdkOptions = {
    bearerToken: options.apiKey,
    maxRetries: 0,
    ...(options.baseUrl === undefined ? {} : {baseURL: options.baseUrl}),
  };
  const sdk = new RunloopSDK(sdkOptions);
  const persistence: RunloopPersistence = {
    persistArtifact: options.persistArtifact,
    persistRawEvidence: options.persistRawEvidence,
  };
  const literalSecrets = [
    options.apiKey,
    ...(options.githubToken === undefined ? [] : [options.githubToken]),
    ...(options.literalSecrets ?? []),
  ];
  return new RunloopVerificationAdapter(new SdkRunloopControl(sdk), persistence, {
    ...options,
    literalSecrets,
  });
}

export class RunloopVerificationAdapter implements VerificationExecutionPort {
  readonly #control: RunloopControl;
  readonly #persistence: RunloopPersistence;
  readonly #redactor: OutputRedactor;
  readonly #clock: AdapterClock;
  readonly #githubToken?: string;
  readonly #inlineArtifactBytes: number;
  readonly #pollIntervalMs: number;
  readonly #controllerGraceMs: number;
  readonly #provisionTimeoutMs: number;
  readonly #shutdownTimeoutMs: number;

  constructor(
    control: RunloopControl,
    persistence: RunloopPersistence,
    tuning: RunloopAdapterTuning & {readonly githubToken?: string} = {},
  ) {
    this.#control = control;
    this.#persistence = persistence;
    this.#redactor = new OutputRedactor(tuning.literalSecrets);
    this.#clock = tuning.clock ?? systemClock;
    if (tuning.githubToken !== undefined) this.#githubToken = tuning.githubToken;
    this.#inlineArtifactBytes = tuning.inlineArtifactBytes ?? DEFAULT_INLINE_ARTIFACT_BYTES;
    this.#pollIntervalMs = tuning.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#controllerGraceMs = tuning.controllerGraceMs ?? DEFAULT_CONTROLLER_GRACE_MS;
    this.#provisionTimeoutMs = tuning.provisionTimeoutMs ?? DEFAULT_PROVISION_TIMEOUT_MS;
    this.#shutdownTimeoutMs = tuning.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }

  async execute(
    input: VerificationRequestV1,
    options: OperationOptions = {},
  ): Promise<RawVerificationEvidenceV1> {
    const request = this.#validateRequest(input);
    const patch = parseBase64(request.patch.unifiedDiffBase64);
    if (sha256(patch) !== request.patch.sha256) {
      throw new AntibodyError('Patch digest does not match decoded bytes', {
        code: 'ANTB_INPUT_INVALID',
        category: 'input',
        retryable: false,
        causeCode: 'PATCH_DIGEST_MISMATCH',
      });
    }
    this.#throwIfAborted(options.signal);

    let state: ExecutionState | undefined;
    let failure: unknown;
    try {
      const source = await this.#resolveSource(request, options.signal);
      const network = await this.#resolveNetwork(request, options.signal);
      state = {
        request,
        patch,
        source,
        ...(network === undefined ? {} : {network}),
        attempts: [],
        devboxes: [],
        cleanup: new Map(),
        counters: new Map(),
      };
      await this.#executePlan(state, options.signal);
    } catch (error) {
      failure = error;
    }

    if (state === undefined) throw externalError(failure, 'environment resolution');

    try {
      await this.#persist(state);
    } catch (error) {
      if (failure === undefined) failure = externalError(error, 'raw evidence persistence');
    }

    await this.#cleanupAll(state);
    const finalEvidence = this.#buildEvidence(state);
    try {
      await this.#persistence.persistRawEvidence(finalEvidence);
    } catch (error) {
      if (failure === undefined) failure = externalError(error, 'final evidence persistence');
    }

    if (failure !== undefined) throw externalError(failure, 'verification execution');
    return finalEvidence;
  }

  #validateRequest(input: VerificationRequestV1): VerificationRequestV1 {
    const parsed = VerificationRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new AntibodyError('Verification request failed frozen contract validation', {
        code: 'ANTB_INPUT_INVALID',
        category: 'input',
        retryable: false,
        causeCode: 'VERIFICATION_REQUEST_SCHEMA',
      });
    }
    for (const command of [
      ...parsed.data.commands.setup,
      parsed.data.commands.baseline,
      parsed.data.commands.targeted,
      ...(parsed.data.commands.fullSuite === undefined ? [] : [parsed.data.commands.fullSuite]),
    ]) {
      for (const value of Object.values(command.env)) {
        if (this.#redactor.containsSecretLikeValue(value)) {
          throw new AntibodyError('Command environment contains a secret-like literal', {
            code: 'ANTB_INPUT_INVALID',
            category: 'input',
            retryable: false,
            causeCode: 'COMMAND_ENV_SECRET',
          });
        }
      }
    }
    return parsed.data;
  }

  async #resolveSource(
    request: VerificationRequestV1,
    signal?: AbortSignal,
  ): Promise<SourceResolution> {
    try {
      if (request.environment.source.kind === 'blueprint') {
        const blueprint = await this.#control.retrieveBlueprint(
          request.environment.source.id,
          signal,
        );
        if (blueprint.id !== request.environment.source.id || blueprint.state !== 'created') {
          throw new AntibodyError('Configured Blueprint did not resolve to an active resource', {
            code: 'ANTB_EXTERNAL_UNAVAILABLE',
            category: 'external',
            retryable: false,
            causeCode: 'BLUEPRINT_RESOLUTION_MISMATCH',
          });
        }
        if (blueprint.status !== 'build_complete') {
          throw new AntibodyError('Configured Blueprint is not build-complete', {
            code: 'ANTB_EXTERNAL_UNAVAILABLE',
            category: 'external',
            retryable: true,
            causeCode: `BLUEPRINT_${blueprint.status.toUpperCase()}`,
          });
        }
        const launch = blueprint.parameters.launch_parameters;
        return {
          kind: 'blueprint',
          id: blueprint.id,
          blueprintId: blueprint.id,
          ...(launch?.architecture == null ? {} : {architecture: launch.architecture}),
          ...(launch?.resource_size_request == null ? {} : {shape: launch.resource_size_request}),
        };
      }

      const status = await this.#control.querySnapshot(request.environment.source.id, signal);
      if (
        status.status !== 'complete' ||
        status.snapshot == null ||
        status.snapshot.id !== request.environment.source.id
      ) {
        throw new AntibodyError('Configured Snapshot is not complete and resolvable', {
          code: 'ANTB_EXTERNAL_UNAVAILABLE',
          category: 'external',
          retryable: status.status === 'in_progress',
          causeCode: `SNAPSHOT_${status.status.toUpperCase()}`,
        });
      }
      return {
        kind: 'snapshot',
        id: status.snapshot.id,
        snapshotId: status.snapshot.id,
        ...(status.snapshot.source_blueprint_id == null
          ? {}
          : {blueprintId: status.snapshot.source_blueprint_id}),
      };
    } catch (error) {
      throw externalError(error, 'environment source resolution');
    }
  }

  async #resolveNetwork(
    request: VerificationRequestV1,
    signal?: AbortSignal,
  ): Promise<NetworkResolution | undefined> {
    if (request.environment.networkPolicyId === undefined) return undefined;
    try {
      const policy = await this.#control.retrieveNetworkPolicy(
        request.environment.networkPolicyId,
        signal,
      );
      if (policy.id !== request.environment.networkPolicyId) {
        throw new AntibodyError('Network Policy identifier did not resolve exactly', {
          code: 'ANTB_EXTERNAL_UNAVAILABLE',
          category: 'external',
          retryable: false,
          causeCode: 'NETWORK_POLICY_RESOLUTION_MISMATCH',
        });
      }
      return {id: policy.id, sha256: networkPolicyDigest(policy)};
    } catch (error) {
      throw externalError(error, 'network policy resolution');
    }
  }

  async #executePlan(state: ExecutionState, signal?: AbortSignal): Promise<void> {
    state.parent = await this.#provision(state, 'parent', signal);
    await this.#prepareAndRunCausalLane(
      state,
      state.parent,
      'parent',
      state.request.candidate.parentSha,
      signal,
    );

    if (state.request.environment.maxParallel === 1) {
      await this.#persist(state);
      await this.#cleanupOne(state, state.parent);
    }

    state.fix = await this.#provision(state, 'fix', signal);
    await this.#prepareAndRunCausalLane(
      state,
      state.fix,
      'fix',
      state.request.candidate.fixSha,
      signal,
    );

    const headBox = state.fix;
    await this.#checkout(state, headBox, 'head', state.request.candidate.headSha, true, signal);
    for (const setup of state.request.commands.setup) {
      await this.#recordCommand(state, headBox, {
        lane: 'head',
        phase: 'setup',
        checkoutSha: state.request.candidate.headSha,
        command: setup,
      }, signal);
    }
    await this.#uploadAndApplyPatch(
      state,
      headBox,
      'head',
      state.request.candidate.headSha,
      signal,
    );
    const targeted = withTargetPaths(
      state.request.commands.targeted,
      state.request.patch.changedPaths,
    );
    await this.#recordCommand(state, headBox, {
      lane: 'head',
      phase: 'candidate',
      checkoutSha: state.request.candidate.headSha,
      patchSha256: state.request.patch.sha256,
      command: targeted,
    }, signal);
    if (state.request.commands.fullSuite !== undefined) {
      await this.#recordCommand(state, headBox, {
        lane: 'head',
        phase: 'full-suite',
        checkoutSha: state.request.candidate.headSha,
        patchSha256: state.request.patch.sha256,
        command: state.request.commands.fullSuite,
      }, signal);
    }
  }

  async #prepareAndRunCausalLane(
    state: ExecutionState,
    devbox: ProvisionedDevbox,
    lane: 'parent' | 'fix',
    checkoutSha: VerificationRequestV1['candidate']['parentSha'],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#checkout(state, devbox, lane, checkoutSha, false, signal);
    for (const setup of state.request.commands.setup) {
      await this.#recordCommand(state, devbox, {
        lane,
        phase: 'setup',
        checkoutSha,
        command: setup,
      }, signal);
    }
    await this.#recordCommand(state, devbox, {
      lane,
      phase: 'baseline',
      checkoutSha,
      command: state.request.commands.baseline,
    }, signal);
    await this.#uploadAndApplyPatch(state, devbox, lane, checkoutSha, signal);
    const targeted = withTargetPaths(
      state.request.commands.targeted,
      state.request.patch.changedPaths,
    );
    for (let repetition = 0; repetition < state.request.repetitions; repetition += 1) {
      await this.#recordCommand(state, devbox, {
        lane,
        phase: 'candidate',
        checkoutSha,
        patchSha256: state.request.patch.sha256,
        command: targeted,
      }, signal);
    }
  }

  async #provision(
    state: ExecutionState,
    lane: 'parent' | 'fix',
    signal?: AbortSignal,
  ): Promise<ProvisionedDevbox> {
    this.#throwIfAborted(signal);
    const active = state.devboxes.filter((devbox) => devbox.active).length;
    if (active >= state.request.environment.maxParallel) {
      throw new AntibodyError('Runloop maxParallel invariant would be exceeded', {
        code: 'ANTB_INTERNAL',
        category: 'internal',
        retryable: false,
        causeCode: 'RUNLOOP_PARALLEL_LIMIT',
      });
    }
    const repository = repositoryParts(state.request);
    const requestedShape = resourceSize(state.request.environment.shape);
    const launchParameters = {
      keep_alive_time_seconds: Math.ceil(this.#provisionTimeoutMs / 1000) + 3_600,
      ...(state.request.environment.architecture === undefined
        ? {}
        : {architecture: state.request.environment.architecture}),
      ...(requestedShape === undefined ? {} : {resource_size_request: requestedShape}),
      ...(state.network === undefined ? {} : {network_policy_id: state.network.id}),
    };
    const mount: NonNullable<DevboxCreateParams['mounts']>[number] = {
      type: 'code_mount',
      repo_owner: repository.owner,
      repo_name: repository.name,
      ...(this.#githubToken === undefined ? {} : {token: this.#githubToken}),
    };
    const params: DevboxCreateParams = {
      name: `antibody-${state.request.runId.slice(0, 8)}-${lane}`,
      metadata: {antibodyRunId: state.request.runId, antibodyLane: lane},
      mounts: [mount],
      launch_parameters: launchParameters,
      ...(state.source.kind === 'blueprint'
        ? {blueprint_id: state.source.id}
        : {snapshot_id: state.source.id}),
    };
    let view: DevboxView;
    try {
      view = await this.#control.createDevbox(params, signal);
    } catch (error) {
      throw externalError(error, `Devbox ${lane} provisioning`);
    }
    const networkPolicyId = view.launch_parameters.network_policy_id ?? state.network?.id;
    const provider: ProviderMetadata = {
      devboxId: view.id,
      ...(view.blueprint_id == null && state.source.blueprintId === undefined
        ? {}
        : {resolvedBlueprintId: view.blueprint_id ?? state.source.blueprintId}),
      ...(view.snapshot_id == null && state.source.snapshotId === undefined
        ? {}
        : {resolvedSnapshotId: view.snapshot_id ?? state.source.snapshotId}),
      ...(networkPolicyId === undefined ? {} : {networkPolicyId}),
      ...(state.network === undefined ? {} : {resolvedNetworkPolicySha256: state.network.sha256}),
      ...(view.launch_parameters.architecture == null && state.source.architecture === undefined
        ? {}
        : {architecture: view.launch_parameters.architecture ?? state.source.architecture}),
      ...(view.launch_parameters.resource_size_request == null && state.source.shape === undefined
        ? {}
        : {shape: view.launch_parameters.resource_size_request ?? state.source.shape}),
    };
    const devbox: ProvisionedDevbox = {
      id: view.id,
      repositoryRoot: `/home/user/${repository.name}`,
      provider,
      active: true,
    };
    state.devboxes.push(devbox);
    state.cleanup.set(view.id, {devboxId: view.id, requested: false, completed: false});
    const provisionDeadline = this.#clock.nowMs() + this.#provisionTimeoutMs;
    try {
      while (view.status !== 'running') {
        if (view.status === 'failure' || view.status === 'shutdown') {
          throw new AntibodyError(`Runloop Devbox entered ${view.status} during provisioning`, {
            code: 'ANTB_EXTERNAL_UNAVAILABLE',
            category: 'external',
            retryable: view.status !== 'shutdown',
            causeCode: `DEVBOX_${view.status.toUpperCase()}`,
          });
        }
        this.#throwIfAborted(signal);
        if (this.#clock.nowMs() >= provisionDeadline) {
          throw new AntibodyError('Runloop Devbox provisioning exceeded its controller deadline', {
            code: 'ANTB_EXTERNAL_UNAVAILABLE',
            category: 'external',
            retryable: true,
            causeCode: 'DEVBOX_PROVISION_TIMEOUT',
          });
        }
        await this.#clock.sleep(this.#pollIntervalMs, signal);
        view = await this.#control.retrieveDevbox(devbox.id, signal);
      }
    } catch (error) {
      throw externalError(error, `Devbox ${lane} provisioning wait`);
    }
    return devbox;
  }

  async #checkout(
    state: ExecutionState,
    devbox: ProvisionedDevbox,
    lane: 'parent' | 'fix' | 'head',
    checkoutSha: VerificationRequestV1['candidate']['parentSha'],
    clean: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    if (clean) {
      await this.#requireSuccessfulInternal(
        state,
        devbox,
        {lane, phase: 'setup', checkoutSha, command: internalCommand(['git', 'reset', '--hard'])},
        signal,
        'git reset',
      );
      await this.#requireSuccessfulInternal(
        state,
        devbox,
        {lane, phase: 'setup', checkoutSha, command: internalCommand(['git', 'clean', '-fd'])},
        signal,
        'git clean',
      );
    }
    await this.#requireSuccessfulInternal(
      state,
      devbox,
      {
        lane,
        phase: 'setup',
        checkoutSha,
        command: internalCommand(['git', 'checkout', '--detach', checkoutSha]),
      },
      signal,
      'git checkout',
    );
    const verified = await this.#recordCommand(
      state,
      devbox,
      {
        lane,
        phase: 'setup',
        checkoutSha,
        command: internalCommand(['git', 'rev-parse', 'HEAD']),
      },
      signal,
    );
    const stdout = this.#artifactText(verified.attempt.stdout);
    if (!verified.completed || stdout.trim() !== checkoutSha) {
      throw new AntibodyError('Runloop checkout did not resolve to the requested full SHA', {
        code: 'ANTB_EXTERNAL_UNAVAILABLE',
        category: 'external',
        retryable: false,
        causeCode: 'CHECKOUT_SHA_MISMATCH',
      });
    }
  }

  async #uploadAndApplyPatch(
    state: ExecutionState,
    devbox: ProvisionedDevbox,
    lane: 'parent' | 'fix' | 'head',
    checkoutSha: VerificationRequestV1['candidate']['parentSha'],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#requireSuccessfulInternal(
      state,
      devbox,
      {
        lane,
        phase: 'setup',
        checkoutSha,
        command: internalCommand(['mkdir', '-p', '/home/user/.antibody']),
      },
      signal,
      'patch directory creation',
    );
    try {
      await this.#control.uploadFile(devbox.id, PATCH_REMOTE_PATH, state.patch, signal);
    } catch (error) {
      throw externalError(error, 'patch upload');
    }
    const digest = await this.#recordCommand(
      state,
      devbox,
      {
        lane,
        phase: 'setup',
        checkoutSha,
        command: internalCommand(['sha256sum', '--', PATCH_REMOTE_PATH]),
      },
      signal,
    );
    const digestText = this.#artifactText(digest.attempt.stdout).trim().split(/\s+/u)[0];
    if (!digest.completed || digestText !== state.request.patch.sha256.slice('sha256:'.length)) {
      throw new AntibodyError('Patch digest inside Devbox differs from controller bytes', {
        code: 'ANTB_EXTERNAL_UNAVAILABLE',
        category: 'external',
        retryable: false,
        causeCode: 'REMOTE_PATCH_DIGEST_MISMATCH',
      });
    }
    await this.#requireSuccessfulInternal(
      state,
      devbox,
      {
        lane,
        phase: 'setup',
        checkoutSha,
        patchSha256: state.request.patch.sha256,
        command: internalCommand(['git', 'apply', '--check', PATCH_REMOTE_PATH]),
      },
      signal,
      'git apply check',
    );
    await this.#requireSuccessfulInternal(
      state,
      devbox,
      {
        lane,
        phase: 'setup',
        checkoutSha,
        patchSha256: state.request.patch.sha256,
        command: internalCommand(['git', 'apply', PATCH_REMOTE_PATH]),
      },
      signal,
      'git apply',
    );
    const changed = await this.#recordCommand(
      state,
      devbox,
      {
        lane,
        phase: 'setup',
        checkoutSha,
        patchSha256: state.request.patch.sha256,
        command: internalCommand(['git', 'status', '--short']),
      },
      signal,
    );
    if (!changed.completed) {
      throw new AntibodyError('Unable to verify patched paths inside Devbox', {
        code: 'ANTB_EXTERNAL_UNAVAILABLE',
        category: 'external',
        retryable: false,
        causeCode: 'PATCH_PATH_VERIFICATION_FAILED',
      });
    }
    const observed = this.#artifactText(changed.attempt.stdout)
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter((line) => line.length > 0)
      .toSorted();
    const expected = state.request.patch.changedPaths.toSorted();
    if (observed.length !== expected.length || observed.some((path, index) => path !== expected[index])) {
      throw new AntibodyError('Applied patch changed paths outside the frozen request', {
        code: 'ANTB_EXTERNAL_UNAVAILABLE',
        category: 'external',
        retryable: false,
        causeCode: 'PATCH_PATH_MISMATCH',
      });
    }
  }

  async #requireSuccessfulInternal(
    state: ExecutionState,
    devbox: ProvisionedDevbox,
    context: AttemptContext,
    signal: AbortSignal | undefined,
    stage: string,
  ): Promise<void> {
    const outcome = await this.#recordCommand(state, devbox, context, signal);
    if (!outcome.completed) {
      throw new AntibodyError(`Runloop internal command failed during ${stage}`, {
        code: 'ANTB_EXTERNAL_UNAVAILABLE',
        category: 'external',
        retryable: false,
        causeCode: 'RUNLOOP_INTERNAL_COMMAND',
      });
    }
  }

  async #recordCommand(
    state: ExecutionState,
    devbox: ProvisionedDevbox,
    context: AttemptContext,
    signal?: AbortSignal,
  ): Promise<RemoteRunResult> {
    const attempt = this.#nextAttempt(state, context.lane, context.phase);
    const result = await this.#runRemote(devbox, context, attempt, state.request, signal);
    state.attempts.push(result.attempt);
    if (result.aborted) throw abortedError();
    return result;
  }

  async #runRemote(
    devbox: ProvisionedDevbox,
    context: AttemptContext,
    attempt: number,
    request: VerificationRequestV1,
    signal?: AbortSignal,
  ): Promise<RemoteRunResult> {
    const startedMs = this.#clock.nowMs();
    const controllerDeadline = startedMs + context.command.timeoutMs + this.#controllerGraceMs;
    const rendered = renderPosixCommand(context.command, devbox.repositoryRoot);
    let executionId: string | undefined;
    let detail: DevboxAsyncExecutionDetailView | undefined;
    let termination: RawExecutionAttemptV1['termination'] = 'platform-error';
    let aborted = false;
    let platformError = '';
    try {
      this.#throwIfAborted(signal);
      detail = await this.#control.executeAsync(devbox.id, rendered, signal);
      const runningExecutionId = detail.execution_id;
      executionId = runningExecutionId;
      while (detail.status !== 'completed') {
        if (signal?.aborted === true) {
          aborted = true;
          await this.#bestEffortKill(devbox.id, runningExecutionId);
          termination = 'signaled';
          break;
        }
        if (this.#clock.nowMs() >= controllerDeadline) {
          await this.#bestEffortKill(devbox.id, runningExecutionId);
          termination = 'timed-out';
          break;
        }
        await this.#clock.sleep(this.#pollIntervalMs, signal);
        detail = await this.#control.retrieveExecution(devbox.id, runningExecutionId, signal);
      }
      if (detail.status === 'completed') {
        termination = detail.exit_status === 124 || detail.exit_status === 137 ? 'timed-out' : 'exited';
        if (detail.stdout_truncated === true || detail.stderr_truncated === true) {
          termination = 'platform-error';
        }
      }
    } catch (error) {
      if (signal?.aborted === true) {
        aborted = true;
        if (executionId !== undefined) await this.#bestEffortKill(devbox.id, executionId);
        termination = 'signaled';
      } else {
        platformError = safeErrorCode(error);
      }
    }

    const stdoutText = detail?.stdout ?? '';
    const stderrText = platformError.length > 0 ? platformError : (detail?.stderr ?? '');
    const suffix = detail?.stdout_truncated === true || detail?.stderr_truncated === true
      ? '.truncated'
      : '';
    const stdout = await this.#artifact(
      `${context.lane}-${context.phase}-${attempt}.stdout${suffix}.txt`,
      stdoutText,
    );
    const stderr = await this.#artifact(
      `${context.lane}-${context.phase}-${attempt}.stderr${suffix}.txt`,
      stderrText,
    );
    const report = await this.#readReport(
      devbox,
      request,
      context,
      attempt,
      signal,
    );
    const finishedMs = this.#clock.nowMs();
    const rawAttempt = RawExecutionAttemptSchema.parse({
      lane: context.lane,
      phase: context.phase,
      attempt,
      checkoutSha: context.checkoutSha,
      ...(context.patchSha256 === undefined ? {} : {patchSha256: context.patchSha256}),
      command: context.command,
      startedAt: isoTime(startedMs),
      finishedAt: isoTime(finishedMs),
      durationMs: Math.max(0, finishedMs - startedMs),
      termination,
      exitCode: detail?.exit_status ?? null,
      stdout,
      stderr,
      ...(report === undefined ? {} : {report}),
      provider: {
        ...devbox.provider,
        ...(executionId === undefined ? {} : {executionId}),
      },
    });
    return {
      attempt: rawAttempt,
      completed: termination === 'exited' && rawAttempt.exitCode === 0,
      aborted,
    };
  }

  async #bestEffortKill(devboxId: string, executionId: string): Promise<void> {
    try {
      await this.#control.killExecution(devboxId, executionId);
    } catch {
      // Cleanup of the whole Devbox remains the authoritative fallback.
    }
  }

  async #readReport(
    devbox: ProvisionedDevbox,
    request: VerificationRequestV1,
    context: AttemptContext,
    attempt: number,
    signal?: AbortSignal,
  ): Promise<ArtifactV1 | undefined> {
    if (request.report.path === undefined || context.phase === 'setup') return undefined;
    const absolute = `${devbox.repositoryRoot}/${request.report.path}`;
    try {
      const content = await this.#control.readFile(devbox.id, absolute, signal);
      return await this.#artifact(
        `${context.lane}-${context.phase}-${attempt}.report.${request.report.format}`,
        content,
      );
    } catch {
      return undefined;
    }
  }

  async #artifact(name: string, content: string): Promise<ArtifactV1> {
    const redacted = Buffer.from(this.#redactor.redact(content), 'utf8');
    await this.#persistence.persistArtifact(name, redacted);
    return ArtifactSchema.parse({
      name,
      mediaType: 'text/plain; charset=utf-8',
      sha256: sha256(redacted),
      sizeBytes: redacted.byteLength,
      ...(redacted.byteLength <= this.#inlineArtifactBytes
        ? {contentBase64: redacted.toString('base64')}
        : {}),
    });
  }

  #artifactText(artifact: ArtifactV1): string {
    return artifact.contentBase64 === undefined
      ? ''
      : Buffer.from(artifact.contentBase64, 'base64').toString('utf8');
  }

  #nextAttempt(
    state: ExecutionState,
    lane: AttemptContext['lane'],
    phase: AttemptContext['phase'],
  ): number {
    const key = `${lane}:${phase}`;
    const attempt = state.counters.get(key) ?? 0;
    state.counters.set(key, attempt + 1);
    return attempt;
  }

  async #persist(state: ExecutionState): Promise<void> {
    await this.#persistence.persistRawEvidence(this.#buildEvidence(state));
  }

  #buildEvidence(state: ExecutionState): RawVerificationEvidenceV1 {
    const environmentEquivalence = this.#environmentEquivalence(state);
    return RawVerificationEvidenceSchema.parse({
      schemaVersion: 'antibody.raw-evidence/v1',
      runId: state.request.runId,
      candidateId: state.request.candidate.candidateId,
      patchSha256: state.request.patch.sha256,
      environmentEquivalence,
      attempts: state.attempts,
      cleanup: [...state.cleanup.values()],
    });
  }

  #environmentEquivalence(state: ExecutionState): RawVerificationEvidenceV1['environmentEquivalence'] {
    const fields = [
      'resolvedBlueprintId',
      'resolvedSnapshotId',
      'networkPolicyId',
      'resolvedNetworkPolicySha256',
      'architecture',
      'shape',
    ];
    if (state.parent === undefined || state.fix === undefined) {
      return {equivalent: false, comparedFields: fields, mismatchFields: ['missingCausalLane']};
    }
    const parentProvider = state.parent.provider;
    const fixProvider = state.fix.provider;
    const mismatchFields = fields.filter(
      (field) => Reflect.get(parentProvider, field) !== Reflect.get(fixProvider, field),
    );
    const requested = state.request.environment;
    if (
      requested.architecture !== undefined &&
      state.parent.provider.architecture !== requested.architecture
    ) {
      mismatchFields.push('requestedArchitecture');
    }
    if (requested.shape !== undefined && state.parent.provider.shape !== requested.shape) {
      mismatchFields.push('requestedShape');
    }
    if (
      requested.networkPolicyId !== undefined &&
      state.parent.provider.networkPolicyId !== requested.networkPolicyId
    ) {
      mismatchFields.push('requestedNetworkPolicyId');
    }
    return {
      equivalent: mismatchFields.length === 0,
      comparedFields: fields,
      mismatchFields: [...new Set(mismatchFields)].toSorted(),
    };
  }

  async #cleanupAll(state: ExecutionState): Promise<void> {
    for (const devbox of state.devboxes) {
      await this.#cleanupOne(state, devbox);
    }
  }

  async #cleanupOne(state: ExecutionState, devbox: ProvisionedDevbox): Promise<void> {
    if (!devbox.active) return;
    devbox.active = false;
    state.cleanup.set(devbox.id, {devboxId: devbox.id, requested: true, completed: false});
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#shutdownTimeoutMs);
    try {
      let view = await this.#control.shutdown(devbox.id, controller.signal);
      const deadline = this.#clock.nowMs() + this.#shutdownTimeoutMs;
      while (view.status !== 'shutdown' && view.status !== 'failure') {
        if (controller.signal.aborted || this.#clock.nowMs() >= deadline) {
          throw new Error('cleanup timeout');
        }
        await this.#clock.sleep(this.#pollIntervalMs, controller.signal);
        view = await this.#control.retrieveDevbox(devbox.id, controller.signal);
      }
      state.cleanup.set(devbox.id, {
        devboxId: devbox.id,
        requested: true,
        completed: view.status === 'shutdown',
        ...(view.status === 'shutdown' ? {} : {errorCode: 'DEVBOX_FAILURE'}),
      });
    } catch (error) {
      state.cleanup.set(devbox.id, {
        devboxId: devbox.id,
        requested: true,
        completed: false,
        errorCode: controller.signal.aborted ? 'CLEANUP_TIMEOUT' : safeErrorCode(error),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  #throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted === true) throw abortedError();
  }
}
