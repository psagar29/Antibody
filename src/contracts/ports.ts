import type {
  AgentInvocationResultV1,
  AgentInvocationV1,
  RawVerificationEvidenceV1,
  VerificationRequestV1,
} from './schemas.js';

export interface OperationOptions {
  readonly signal?: AbortSignal;
}

export interface AgentSessionPort {
  invoke(
    request: AgentInvocationV1,
    options?: OperationOptions,
  ): Promise<AgentInvocationResultV1>;

  stop(continuationId: string): Promise<void>;
}

export interface VerificationExecutionPort {
  execute(
    request: VerificationRequestV1,
    options?: OperationOptions,
  ): Promise<RawVerificationEvidenceV1>;
}
