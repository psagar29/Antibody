import {randomUUID} from 'node:crypto';

import type {
  AgentSessionPort,
  ClassifiedAttemptV1,
  CommandSpecV1,
  RawVerificationEvidenceV1,
  ReceiptV1,
  RecoveryCandidateV1,
  VerificationExecutionPort,
  VerificationRequestV1,
} from '../contracts/index.js';
import {VerificationRequestSchema} from '../contracts/index.js';

import type {
  AuthoredPatchResultV1,
  AuthoringBudgetV1,
  AuthoringContextV1,
  AuthoringReview,
} from './authoring/authoring.js';
import {CodexAuthoringModule} from './authoring/authoring.js';
import type {AdjudicationResult} from './adjudication/adjudicator.js';
import {adjudicateVerification} from './adjudication/adjudicator.js';
import {classifyEvidenceAttempts} from './classification/classifier.js';
import type {
  EvaluatePatchOptions,
  PatchApplicabilityChecker,
  PatchPolicyResult,
} from './policy/patch-policy.js';
import {GitPatchApplicabilityChecker, evaluateTestPatch} from './policy/patch-policy.js';
import type {BuildReceiptOptions} from './receipts/receipt-store.js';
import {Redactor, buildReceipt, receiptDigest} from './receipts/receipt-store.js';

export interface VerificationPlanV1 {
  readonly environment: VerificationRequestV1['environment'];
  readonly commands: {
    readonly setup: readonly CommandSpecV1[];
    readonly baseline: CommandSpecV1;
    readonly targeted: CommandSpecV1;
    readonly fullSuite?: CommandSpecV1;
  };
  readonly report: VerificationRequestV1['report'];
  readonly repetitions: VerificationRequestV1['repetitions'];
}

export interface RecoverCandidateOptions {
  readonly repositoryPath: string;
  readonly candidate: RecoveryCandidateV1;
  readonly context: AuthoringContextV1;
  readonly authoringBudget: AuthoringBudgetV1;
  readonly patchPolicy: EvaluatePatchOptions['policy'];
  readonly testGlobs: readonly string[];
  readonly allowedSupportGlobs: readonly string[];
  readonly verificationPlan: VerificationPlanV1;
  readonly targetTestNames?: readonly string[];
  readonly signal?: AbortSignal;
  readonly runIdFactory?: () => string;
  readonly now?: () => string;
  readonly redactor?: Redactor;
}

export interface RecoverCandidateResult {
  readonly authored: AuthoredPatchResultV1;
  readonly request: VerificationRequestV1;
  readonly policy: PatchPolicyResult;
  readonly evidence: RawVerificationEvidenceV1;
  readonly classifications: readonly ClassifiedAttemptV1[];
  readonly adjudication: AdjudicationResult;
  readonly receipt: ReceiptV1;
  readonly receiptSha256: ReturnType<typeof receiptDigest>;
}

interface AcceptedRun {
  readonly authored: AuthoredPatchResultV1;
  readonly request: VerificationRequestV1;
  readonly policy: PatchPolicyResult;
  readonly evidence: RawVerificationEvidenceV1;
  readonly classifications: readonly ClassifiedAttemptV1[];
  readonly adjudication: AdjudicationResult;
}

export class RecoveryCoordinator {
  readonly #authoring: CodexAuthoringModule;
  readonly #agent: AgentSessionPort;
  readonly #verifier: VerificationExecutionPort;
  readonly #applicability: PatchApplicabilityChecker;

  constructor(options: {
    readonly agent: AgentSessionPort;
    readonly verifier: VerificationExecutionPort;
    readonly authoring?: CodexAuthoringModule;
    readonly applicability?: PatchApplicabilityChecker;
  }) {
    this.#agent = options.agent;
    this.#verifier = options.verifier;
    this.#authoring = options.authoring ?? new CodexAuthoringModule();
    this.#applicability = options.applicability ?? new GitPatchApplicabilityChecker();
  }

  async recover(options: RecoverCandidateOptions): Promise<RecoverCandidateResult> {
    const runIdFactory = options.runIdFactory ?? randomUUID;
    const now = options.now ?? (() => new Date().toISOString());
    const redactor = options.redactor ?? new Redactor([]);
    let accepted: AcceptedRun | undefined;
    const authored = await this.#authoring.authorCandidate(
      options.candidate,
      options.context,
      this.#agent,
      options.authoringBudget,
      {
        ...(options.signal === undefined ? {} : {signal: options.signal}),
        review: async (candidatePatch) => {
          const review = await this.#reviewCandidate(
            options,
            candidatePatch,
            runIdFactory(),
          );
          if ('accepted' in review) accepted = review.accepted;
          return review.result;
        },
      },
    );
    if (accepted === undefined) throw new Error('Authoring accepted a patch without preserved verification evidence');
    const receiptOptions: BuildReceiptOptions = {
      request: accepted.request,
      evidence: accepted.evidence,
      classifications: accepted.classifications,
      policy: accepted.policy,
      adjudication: accepted.adjudication,
      patchArtifact: {
        name: 'patch.diff',
        mediaType: 'text/x-diff',
        sha256: accepted.policy.patchSha256,
        sizeBytes: accepted.policy.sizeBytes,
      },
      createdAt: now(),
      ...(authored.agentResult.usage?.modelUsd === undefined
        ? {}
        : {modelUsd: authored.agentResult.usage.modelUsd}),
      redactor,
    };
    const receipt = buildReceipt(receiptOptions);
    return {
      ...accepted,
      receipt,
      receiptSha256: receiptDigest(receipt),
    };
  }

  async #reviewCandidate(
    options: RecoverCandidateOptions,
    authored: AuthoredPatchResultV1,
    runId: string,
  ): Promise<{result: AuthoringReview; accepted?: AcceptedRun}> {
    const policy = await evaluateTestPatch(
      {
        repositoryPath: options.repositoryPath,
        candidate: options.candidate,
        patchBytes: Buffer.from(authored.normalizedPatch, 'utf8'),
        policy: options.patchPolicy,
        testGlobs: options.testGlobs,
        allowedSupportGlobs: options.allowedSupportGlobs,
        ...(options.signal === undefined ? {} : {signal: options.signal}),
      },
      this.#applicability,
    );
    if (!policy.testOnly) {
      return {
        result: {
          accepted: false,
          category: 'candidate-policy',
          feedback: policy.violations.map((violation) => violation.code).join(', '),
        },
      };
    }
    const request = VerificationRequestSchema.parse({
      schemaVersion: 'antibody.verification-request/v1',
      runId,
      candidate: options.candidate,
      patch: {
        unifiedDiffBase64: Buffer.from(policy.normalizedPatch, 'utf8').toString('base64'),
        sha256: policy.patchSha256,
        changedPaths: policy.changedPaths,
      },
      environment: options.verificationPlan.environment,
      commands: options.verificationPlan.commands,
      report: options.verificationPlan.report,
      repetitions: options.verificationPlan.repetitions,
    });
    const targetTestNames = options.targetTestNames?.length === 0 || options.targetTestNames === undefined
      ? inferTargetTestNames(policy.normalizedPatch)
      : [...options.targetTestNames];
    if (targetTestNames.length === 0) {
      return {
        result: {
          accepted: false,
          category: 'candidate-policy',
          feedback: 'Generated patch must contain an identifiable named test',
        },
      };
    }
    const evidence = await this.#verifier.execute(
      request,
      options.signal === undefined ? undefined : {signal: options.signal},
    );
    const classifications = classifyEvidenceAttempts(
      evidence.attempts,
      request.report.format,
      targetTestNames,
    );
    const adjudication = adjudicateVerification({request, evidence, classifications, policy});
    if (adjudication.verdict === 'verified') {
      return {
        result: {accepted: true},
        accepted: {authored, request, policy, evidence, classifications, adjudication},
      };
    }
    return {result: reviewFromAdjudication(adjudication, classifications)};
  }
}

/** Extracts reporter-visible test identifiers from added lines in a unified diff. */
export function inferTargetTestNames(normalizedPatch: string): string[] {
  const names = new Set<string>();
  let pendingJunitAnnotation = false;
  for (const line of normalizedPatch.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const added = line.slice(1).trim();
    if (/^@(?:org\.junit\.)?(?:jupiter\.api\.)?Test\b/u.test(added)) {
      pendingJunitAnnotation = true;
      continue;
    }
    const quoted = /^(?:test|it)(?:\.(?:only|skip|todo|concurrent|each)(?:\([^)]*\))?)*\s*\(\s*(['"`])([^'"`]+)\1/u.exec(added)
      ?? /^it\s+(['"])([^'"]+)\1/u.exec(added);
    if (quoted?.[2] !== undefined && !quoted[2].includes('${')) names.add(quoted[2].trim());

    const python = /^(?:async\s+)?def\s+(test_[A-Za-z0-9_]+)\s*\(/u.exec(added);
    if (python?.[1] !== undefined) names.add(python[1]);

    const go = /^func\s+(Test[A-Za-z0-9_]+)\s*\(/u.exec(added);
    if (go?.[1] !== undefined) names.add(go[1]);

    if (pendingJunitAnnotation) {
      const junit = /^(?:(?:public|protected|private|static|final|synchronized)\s+)*void\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/u.exec(added);
      if (junit?.[1] !== undefined) {
        names.add(junit[1]);
        pendingJunitAnnotation = false;
      } else if (added !== '' && !added.startsWith('@')) {
        pendingJunitAnnotation = false;
      }
    }
  }
  return [...names].filter((name) => name.length > 0 && name.length <= 1_024);
}

function reviewFromAdjudication(
  adjudication: AdjudicationResult,
  classifications: readonly ClassifiedAttemptV1[],
): AuthoringReview {
  if (adjudication.reasonCodes.includes('PARENT_PASSED')) {
    return {accepted: false, category: 'candidate-parent-pass', feedback: 'Generated test passed on the parent revision'};
  }
  if (classifications.some((entry) => entry.outcome === 'collection-failure')) {
    return {accepted: false, category: 'candidate-collection', feedback: 'Generated test did not collect'};
  }
  if (classifications.some((entry) => entry.outcome === 'dependency-failure')) {
    return {accepted: false, category: 'dependency'};
  }
  if (classifications.some((entry) => entry.outcome === 'timeout')) {
    return {accepted: false, category: 'timeout'};
  }
  if (classifications.some((entry) => entry.outcome === 'platform-failure')) {
    return {accepted: false, category: 'platform'};
  }
  if (adjudication.reasonCodes.includes('ENVIRONMENT_MISMATCH')) {
    return {accepted: false, category: 'environment-equivalence'};
  }
  return {
    accepted: false,
    category: adjudication.verdict === 'rejected' ? 'candidate-syntax' : 'platform',
    feedback: adjudication.reasonCodes.join(', '),
  };
}
