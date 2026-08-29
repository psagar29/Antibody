export const antibodyErrorCodes = [
  'ANTB_OK',
  'ANTB_INPUT_INVALID',
  'ANTB_SCAN_NO_CANDIDATE',
  'ANTB_POLICY_TEST_ONLY',
  'ANTB_PROOF_REJECTED',
  'ANTB_PROOF_INCONCLUSIVE',
  'ANTB_BUDGET_EXCEEDED',
  'ANTB_EXTERNAL_AUTH',
  'ANTB_EXTERNAL_RATE_LIMIT',
  'ANTB_EXTERNAL_UNAVAILABLE',
  'ANTB_PUBLISH_APPROVAL_REQUIRED',
  'ANTB_PUBLISH_CONFLICT',
  'ANTB_INTERNAL',
] as const;

export type AntibodyErrorCode = (typeof antibodyErrorCodes)[number];

export type AntibodyErrorCategory =
  | 'input'
  | 'scan'
  | 'policy'
  | 'proof'
  | 'budget'
  | 'external'
  | 'publication'
  | 'internal';

export interface AntibodyErrorOptions {
  readonly code: AntibodyErrorCode;
  readonly category: AntibodyErrorCategory;
  readonly retryable: boolean;
  readonly causeCode?: string;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
  readonly cause?: unknown;
}

export class AntibodyError extends Error {
  readonly code: AntibodyErrorCode;
  readonly category: AntibodyErrorCategory;
  readonly retryable: boolean;
  readonly causeCode?: string;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;

  constructor(message: string, options: AntibodyErrorOptions) {
    super(message, {cause: options.cause});
    this.name = 'AntibodyError';
    this.code = options.code;
    this.category = options.category;
    this.retryable = options.retryable;
    if (options.causeCode !== undefined) {
      this.causeCode = options.causeCode;
    }
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

export const exitCodeByErrorCode: Readonly<Record<AntibodyErrorCode, number>> = {
  ANTB_OK: 0,
  ANTB_INPUT_INVALID: 2,
  ANTB_SCAN_NO_CANDIDATE: 3,
  ANTB_POLICY_TEST_ONLY: 10,
  ANTB_PROOF_REJECTED: 11,
  ANTB_PROOF_INCONCLUSIVE: 12,
  ANTB_BUDGET_EXCEEDED: 13,
  ANTB_EXTERNAL_AUTH: 20,
  ANTB_EXTERNAL_RATE_LIMIT: 21,
  ANTB_EXTERNAL_UNAVAILABLE: 22,
  ANTB_PUBLISH_APPROVAL_REQUIRED: 30,
  ANTB_PUBLISH_CONFLICT: 31,
  ANTB_INTERNAL: 70,
};
