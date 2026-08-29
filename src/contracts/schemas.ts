import {z} from 'zod';

export const CONTRACT_VERSION = '1.0.0' as const;

const rfc3339Schema = z.iso.datetime();
const boundedTextSchema = z.string().max(1_048_576);

export const FullGitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/u, 'Expected a full lowercase Git SHA')
  .brand<'FullGitSha'>();

export const Sha256Schema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u, 'Expected sha256:<64 lowercase hex>')
  .brand<'Sha256'>();

export const RepoPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(
    // eslint-disable-next-line no-control-regex -- JSON Schema must retain the NUL rejection.
    /^(?!\/)(?![A-Za-z]:)(?!.*\\)(?!.*\u0000)(?!\.\.(?:\/|$))(?!.*\/\.\.(?:\/|$))(?!.*\/\/)(?!.*\/$).+$/u,
    'Expected a relative slash-normalized repository path without traversal',
  )
  .brand<'RepoPath'>();

export const RepositoryRefSchema = z
  .object({
    slug: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
    cloneUrl: z
      .string()
      .regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/u),
  })
  .strict();

export const CommandSpecSchema = z
  .object({
    argv: z.tuple([z.string().min(1)]).rest(z.string()),
    cwd: RepoPathSchema,
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), z.string().max(16_384)),
    timeoutMs: z.number().int().min(1_000).max(1_800_000),
  })
  .strict();

export const ArtifactSchema = z
  .object({
    name: z.string().min(1).max(256),
    mediaType: z.string().min(1).max(256),
    sha256: Sha256Schema,
    sizeBytes: z.number().int().nonnegative(),
    contentBase64: z.string().max(1_500_000).optional(),
  })
  .strict();

const candidateSignalSchema = z
  .object({
    code: z.string().min(1).max(128),
    weight: z.number().int().min(-100).max(100),
    evidence: z.string().min(1).max(2048),
  })
  .strict();

export const RecoveryCandidateSchema = z
  .object({
    schemaVersion: z.literal('antibody.candidate/v1'),
    candidateId: Sha256Schema,
    repository: RepositoryRefSchema,
    parentSha: FullGitShaSchema,
    fixSha: FullGitShaSchema,
    headSha: FullGitShaSchema,
    commit: z
      .object({
        subject: z.string().min(1).max(512),
        authoredAt: rfc3339Schema,
        changedProductionPaths: z.array(RepoPathSchema).min(1),
        changedTestPaths: z.array(RepoPathSchema),
        additions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
        diffSha256: Sha256Schema,
      })
      .strict(),
    signals: z.array(candidateSignalSchema),
    score: z.number().min(0).max(100),
  })
  .strict();

export const AgentInvocationSchema = z
  .object({
    schemaVersion: z.literal('antibody.agent-invocation/v1'),
    invocationId: z.uuid(),
    repository: RepositoryRefSchema,
    checkoutSha: FullGitShaSchema,
    prompt: z.string().min(1).max(1_048_576),
    continuationId: z.string().min(1).max(512).optional(),
    timeoutMs: z.number().int().min(1_000).max(1_800_000),
    maxOutputBytes: z.number().int().min(1).max(1_048_576),
  })
  .strict();

export const AgentInvocationResultSchema = z
  .object({
    schemaVersion: z.literal('antibody.agent-result/v1'),
    invocationId: z.uuid(),
    continuationId: z.string().min(1).max(512),
    finalText: boundedTextSchema,
    provider: z
      .object({
        name: z.literal('reflex'),
        agentId: z.string().min(1).max(512),
        streamId: z.string().min(1).max(512).optional(),
        personaId: z.string().min(1).max(512).optional(),
        axonId: z.string().min(1).max(512).optional(),
      })
      .strict(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional(),
        modelUsd: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
    startedAt: rfc3339Schema,
    finishedAt: rfc3339Schema,
  })
  .strict();

export const AgentOutputSchema = z
  .object({
    schemaVersion: z.literal('antibody.agent-output/v1'),
    candidateId: Sha256Schema,
    patchBase64: z.string().min(1).max(1_500_000),
    testCommandHint: z.array(z.string()).min(1).max(128),
    summary: z.string().min(1).max(1024),
  })
  .strict();

const environmentSourceSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('blueprint'), id: z.string().min(1).max(512)}).strict(),
  z.object({kind: z.literal('snapshot'), id: z.string().min(1).max(512)}).strict(),
]);

export const VerificationRequestSchema = z
  .object({
    schemaVersion: z.literal('antibody.verification-request/v1'),
    runId: z.uuid(),
    candidate: RecoveryCandidateSchema,
    patch: z
      .object({
        unifiedDiffBase64: z.string().min(1).max(1_500_000),
        sha256: Sha256Schema,
        changedPaths: z.array(RepoPathSchema).min(1),
      })
      .strict(),
    environment: z
      .object({
        source: environmentSourceSchema,
        networkPolicyId: z.string().min(1).max(512).optional(),
        architecture: z.enum(['x86_64', 'arm64']).optional(),
        shape: z.string().min(1).max(128).optional(),
        maxParallel: z.union([z.literal(1), z.literal(2)]),
      })
      .strict(),
    commands: z
      .object({
        setup: z.array(CommandSpecSchema),
        baseline: CommandSpecSchema,
        targeted: CommandSpecSchema,
        fullSuite: CommandSpecSchema.optional(),
      })
      .strict(),
    report: z
      .object({
        format: z.enum(['tap', 'junit', 'vitest-json', 'jest-json', 'pytest-text']),
        path: RepoPathSchema.optional(),
      })
      .strict(),
    repetitions: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  })
  .strict();

export const RawExecutionAttemptSchema = z
  .object({
    lane: z.enum(['parent', 'fix', 'head']),
    phase: z.enum(['setup', 'baseline', 'candidate', 'full-suite']),
    attempt: z.number().int().nonnegative(),
    checkoutSha: FullGitShaSchema,
    patchSha256: Sha256Schema.optional(),
    command: CommandSpecSchema,
    startedAt: rfc3339Schema,
    finishedAt: rfc3339Schema,
    durationMs: z.number().int().nonnegative(),
    termination: z.enum(['exited', 'timed-out', 'signaled', 'platform-error']),
    exitCode: z.number().int().nullable(),
    stdout: ArtifactSchema,
    stderr: ArtifactSchema,
    report: ArtifactSchema.optional(),
    provider: z
      .object({
        devboxId: z.string().min(1).max(512),
        executionId: z.string().min(1).max(512).optional(),
        resolvedBlueprintId: z.string().min(1).max(512).optional(),
        resolvedSnapshotId: z.string().min(1).max(512).optional(),
        networkPolicyId: z.string().min(1).max(512).optional(),
        resolvedNetworkPolicySha256: Sha256Schema.optional(),
        architecture: z.string().min(1).max(128).optional(),
        shape: z.string().min(1).max(128).optional(),
      })
      .strict(),
  })
  .strict();

const cleanupSchema = z
  .object({
    devboxId: z.string().min(1).max(512),
    requested: z.boolean(),
    completed: z.boolean(),
    errorCode: z.string().min(1).max(128).optional(),
  })
  .strict();

const environmentEquivalenceSchema = z
  .object({
    equivalent: z.boolean(),
    comparedFields: z.array(z.string().min(1).max(256)),
    mismatchFields: z.array(z.string().min(1).max(256)),
  })
  .strict();

export const RawVerificationEvidenceSchema = z
  .object({
    schemaVersion: z.literal('antibody.raw-evidence/v1'),
    runId: z.uuid(),
    candidateId: Sha256Schema,
    patchSha256: Sha256Schema,
    environmentEquivalence: environmentEquivalenceSchema,
    attempts: z.array(RawExecutionAttemptSchema),
    reflex: AgentInvocationResultSchema.shape.provider.optional(),
    runloopCostUsd: z.number().nonnegative().optional(),
    cleanup: z.array(cleanupSchema),
  })
  .strict();

export const OutcomeKindSchema = z.enum([
  'pass',
  'assertion-failure',
  'behavioral-failure',
  'unrelated-test-failure',
  'collection-failure',
  'build-failure',
  'dependency-failure',
  'timeout',
  'crash',
  'platform-failure',
  'unknown-failure',
]);

export const ClassifiedAttemptSchema = z
  .object({
    rawAttemptIndex: z.number().int().nonnegative(),
    outcome: OutcomeKindSchema,
    signature: Sha256Schema.optional(),
    targetTestNames: z.array(z.string().min(1).max(1024)),
    explanation: z.string().min(1).max(4096),
    confidence: z.enum(['high', 'medium', 'low']),
  })
  .strict();

export const VerdictSchema = z.enum(['verified', 'rejected', 'inconclusive']);

export const ReceiptSchema = z
  .object({
    schemaVersion: z.literal('antibody.receipt/v1'),
    runId: z.uuid(),
    candidate: RecoveryCandidateSchema,
    patch: z
      .object({
        sha256: Sha256Schema,
        sizeBytes: z.number().int().nonnegative(),
        changedPaths: z.array(RepoPathSchema).min(1),
        artifact: ArtifactSchema.omit({contentBase64: true}),
      })
      .strict(),
    policy: z
      .object({
        testOnly: z.boolean(),
        allowedGlobs: z.array(z.string().min(1).max(1024)),
        violations: z.array(
          z
            .object({
              code: z.string().min(1).max(128),
              path: RepoPathSchema.optional(),
              detail: z.string().min(1).max(2048),
            })
            .strict(),
        ),
      })
      .strict(),
    environment: environmentEquivalenceSchema
      .extend({
        source: environmentSourceSchema,
        networkPolicyId: z.string().min(1).max(512).optional(),
      })
      .strict(),
    classifications: z.array(ClassifiedAttemptSchema),
    evidence: z
      .object({
        rawEvidenceSha256: Sha256Schema,
        artifacts: z.array(ArtifactSchema.omit({contentBase64: true})),
        reflex: AgentInvocationResultSchema.shape.provider.optional(),
        cleanup: z.array(cleanupSchema),
      })
      .strict(),
    costs: z
      .object({
        modelUsd: z.number().nonnegative().optional(),
        runloopUsd: z.number().nonnegative().optional(),
      })
      .strict(),
    verdict: VerdictSchema,
    reasonCodes: z.array(z.string().min(1).max(128)),
    createdAt: rfc3339Schema,
  })
  .strict();

export const PublicationRecordSchema = z
  .object({
    schemaVersion: z.literal('antibody.publication/v1'),
    receiptSha256: Sha256Schema,
    repository: RepositoryRefSchema,
    branch: z.string().min(1).max(255),
    commitSha: FullGitShaSchema,
    pullRequestNumber: z.number().int().positive(),
    pullRequestUrl: z.url().startsWith('https://github.com/'),
    draft: z.literal(true),
    createdAt: rfc3339Schema,
  })
  .strict();

export const HandoffSchema = z
  .object({
    schemaVersion: z.literal('antibody.handoff/v1'),
    owner: z.enum(['person-a', 'person-b']),
    branch: z.string().min(1).max(255),
    baseCommit: FullGitShaSchema,
    headCommit: FullGitShaSchema,
    ownedPaths: z.array(z.string().min(1).max(1024)).min(1),
    commits: z.array(
      z.object({sha: FullGitShaSchema, subject: z.string().min(1).max(512)}).strict(),
    ),
    contractsConsumed: z.array(z.string().min(1).max(128)),
    commandsRun: z.array(z.string().min(1).max(2048)),
    testResults: z.array(
      z
        .object({
          name: z.string().min(1).max(256),
          passed: z.boolean(),
          details: z.string().max(4096),
        })
        .strict(),
    ),
    liveChecks: z.array(
      z
        .object({
          name: z.string().min(1).max(256),
          status: z.enum(['passed', 'failed', 'blocked', 'not-run']),
          artifact: z.string().max(2048).optional(),
        })
        .strict(),
    ),
    requiredEnvironmentNames: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/u)),
    knownIssues: z.array(z.string().max(4096)),
    integrationInstructions: z.array(z.string().max(4096)),
    contractChangeRequests: z.array(z.string().max(4096)),
  })
  .strict();

const stringArraySchema = z.array(z.string().min(1).max(1024));
const commandCollectionSchema = z
  .object({
    setup: z.array(CommandSpecSchema),
    baseline: CommandSpecSchema,
    targeted: CommandSpecSchema,
    fullSuite: CommandSpecSchema.optional(),
  })
  .strict();

export const ConfigSchema = z
  .object({
    schemaVersion: z.literal('antibody.config/v1'),
    repository: z
      .object({
        slug: RepositoryRefSchema.shape.slug.optional(),
        baseBranch: z.string().min(1).max(255).default('main'),
      })
      .strict(),
    scan: z
      .object({
        maxCommits: z.number().int().min(1).max(10_000),
        since: rfc3339Schema.optional(),
        includeProduction: stringArraySchema,
        testGlobs: stringArraySchema,
        allowedSupportGlobs: stringArraySchema,
        excludeGlobs: stringArraySchema,
        maxChangedFiles: z.number().int().min(1).max(10_000),
        maxChangedLines: z.number().int().min(1).max(1_000_000),
        excludeMerges: z.boolean(),
        requireNoTestChanges: z.boolean(),
      })
      .strict(),
    authoring: z
      .object({
        provider: z.literal('reflex'),
        personaIdEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
        maxAttempts: z.number().int().min(1).max(10),
        timeoutMs: z.number().int().min(1_000).max(1_800_000),
        maxOutputBytes: z.number().int().min(1).max(1_048_576),
      })
      .strict(),
    verification: z
      .object({
        provider: z.literal('runloop'),
        environment: z
          .object({
            source: z.discriminatedUnion('kind', [
              z
                .object({
                  kind: z.literal('blueprint'),
                  idEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
                })
                .strict(),
              z
                .object({
                  kind: z.literal('snapshot'),
                  idEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
                })
                .strict(),
            ]),
            networkPolicyIdEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/u).optional(),
            architecture: z.enum(['x86_64', 'arm64']).optional(),
            maxParallel: z.union([z.literal(1), z.literal(2)]),
          })
          .strict(),
        repetitions: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
        commands: commandCollectionSchema,
        report: z
          .object({
            format: z.enum(['tap', 'junit', 'vitest-json', 'jest-json', 'pytest-text']),
            path: RepoPathSchema.optional(),
          })
          .strict(),
      })
      .strict(),
    policy: z
      .object({
        maxPatchBytes: z.number().int().min(1).max(10_485_760),
        maxPatchFiles: z.number().int().min(1).max(1000),
        maxAddedLines: z.number().int().min(1).max(100_000),
        forbidBinary: z.boolean(),
        forbidSymlinks: z.boolean(),
        forbidSubmodules: z.boolean(),
        requireCurrentHeadPass: z.boolean(),
      })
      .strict(),
    publication: z
      .object({
        provider: z.literal('github'),
        tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
        draft: z.literal(true),
        branchPrefix: z.string().min(1).max(128),
        labels: z.array(z.string().min(1).max(128)),
      })
      .strict(),
  })
  .strict();

export const contractSchemas = {
  'config-v1': ConfigSchema,
  'candidate-v1': RecoveryCandidateSchema,
  'agent-output-v1': AgentOutputSchema,
  'verification-v1': RawVerificationEvidenceSchema,
  'receipt-v1': ReceiptSchema,
  'publication-v1': PublicationRecordSchema,
  'handoff-v1': HandoffSchema,
} as const;

export type FullGitSha = z.infer<typeof FullGitShaSchema>;
export type Sha256 = z.infer<typeof Sha256Schema>;
export type RepoPath = z.infer<typeof RepoPathSchema>;
export type RepositoryRefV1 = z.infer<typeof RepositoryRefSchema>;
export type CommandSpecV1 = z.infer<typeof CommandSpecSchema>;
export type ArtifactV1 = z.infer<typeof ArtifactSchema>;
export type RecoveryCandidateV1 = z.infer<typeof RecoveryCandidateSchema>;
export type AgentInvocationV1 = z.infer<typeof AgentInvocationSchema>;
export type AgentInvocationResultV1 = z.infer<typeof AgentInvocationResultSchema>;
export type AgentOutputV1 = z.infer<typeof AgentOutputSchema>;
export type VerificationRequestV1 = z.infer<typeof VerificationRequestSchema>;
export type RawExecutionAttemptV1 = z.infer<typeof RawExecutionAttemptSchema>;
export type RawVerificationEvidenceV1 = z.infer<typeof RawVerificationEvidenceSchema>;
export type OutcomeKindV1 = z.infer<typeof OutcomeKindSchema>;
export type ClassifiedAttemptV1 = z.infer<typeof ClassifiedAttemptSchema>;
export type VerdictV1 = z.infer<typeof VerdictSchema>;
export type ReceiptV1 = z.infer<typeof ReceiptSchema>;
export type PublicationRecordV1 = z.infer<typeof PublicationRecordSchema>;
export type HandoffV1 = z.infer<typeof HandoffSchema>;
export type ConfigV1 = z.infer<typeof ConfigSchema>;
