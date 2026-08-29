# Antibody three-person implementation plan

**Status:** build-ready hackathon plan  
**Date:** 2026-08-29  
**Repository:** [psagar29/Antibody](https://github.com/psagar29/Antibody)  
**Starting state:** public; `main` initialized with the product README and Apache-2.0 license  
**Package:** `@psagar29/antibody`; installed binary: `antibody`

## 1. Decision

Build one TypeScript/Node 22+ CLI, not a premature monorepo and not a hosted control plane.

Antibody's only winning claim is:

> Antibody finds already-merged bug fixes that omitted regression tests, asks Codex to recover a test, and accepts that test only when the exact patch produces a typed failure on the pre-fix parent and passes on the fixed commit. It then opens a draft, test-only PR against current `HEAD` with an immutable evidence receipt.

Runloop supplies isolated execution and raw evidence. Reflex supplies the Codex session lifecycle, Persona, live/replayable operator experience, and human gate. Antibody owns every domain judgment: mining, ranking, prompt construction, repair policy, failure classification, causal adjudication, receipt construction, test-only enforcement, and GitHub publication.

Tenor gets **no implementation time**. It has no public developer API, SDK, CLI, webhook contract, or self-service setup. It appears in documentation only as an event organizer and possible future integration, contingent on documented access. There must be no Tenor or Slack package, adapter, interface, stub, mock, environment variable, setup screen, or fake demo. Empty abstractions are still code; do not build one.

This plan is grounded in primary-source GitHub and sponsor research completed on 2026-08-29. Use the [Runloop TypeScript SDK](https://github.com/runloopai/api-client-ts), [Runloop OpenAPI](https://docs.runloop.ai/openapi-specs/stainless-processed-openapi.json), [Reflex public SDK/OpenAPI mirror](https://github.com/runloopai/reflex-os), and GitHub's official APIs as implementation contracts. Do not infer vendor calls from prose.

## 2. Non-negotiable product gates

A candidate is publishable only when every condition holds:

1. `fixSha`, its single `parentSha`, and captured `headSha` are full 40-character immutable SHAs.
2. The fix is non-merge, changes eligible production code, and changes no configured test/fixture/snapshot path.
3. The generated patch is UTF-8 text, non-binary, within size/file/line budgets, and touches only configured test-support paths.
4. The exact patch bytes and SHA-256 digest are identical in all executions.
5. Parent and fix executions use the same resolved Runloop environment inputs: Blueprint or Snapshot source, architecture, network policy, command plan, literal environment allowlist, and resource shape.
6. Baseline commands pass before the patch on parent and fix.
7. Every candidate-test repetition on the parent has the same normalized failure signature and is classified as an expected assertion/behavioral failure—not install, build, collection, timeout, crash, platform, or unknown failure.
8. Every repetition on the fix passes.
9. The patch applies to captured current `HEAD`; targeted test passes there; configured full suite passes there.
10. Runloop evidence is persisted before Devbox cleanup. Cleanup outcome is recorded even if cleanup itself fails.
11. A verified receipt is canonicalized and hashed before publication.
12. Publication is a separate, explicit human-approved command. It opens a draft PR; it never merges.

`FAIL(parent) -> PASS(fix)` is causal evidence under recorded conditions. It is not formal proof that the historical fix is globally correct or that the test can never flake.

## 3. Team topology and branch policy

### Person A — Runloop + Reflex, end to end

Branch: `team/person-a-runloop-reflex`

Owns:

- Runloop SDK adapter, paired execution orchestration, artifact capture, cost/lifecycle metadata, bounded parallelism, shutdown in `finally`, and live smoke path.
- Reflex public SDK adapter, Persona-backed Codex session launch/continue/watch/stop, stream recovery, session provenance, and operator runbook.
- Technical transport only. A returns raw process observations and raw agent text. A does **not** rank candidates, write authoring prompts, classify failures, decide verdicts, build receipts, or publish PRs.

### Person B — Antibody intelligence/domain, end to end

Branch: `team/person-b-core`

The obsolete `team/person-b-core-tenor` branch is ignored. Do not delete or force-push it during the hackathon; it is simply not part of the merge graph.

Owns:

- Git history mining, missing-test detection, deterministic ranking, context assembly, and optional GitHub issue/PR enrichment.
- Codex authoring and bounded feedback/repair loop, expressed against the frozen agent-session port.
- Patch parsing and test-only policy.
- Failure taxonomy and framework report classifiers.
- Causal adjudication, canonical receipt construction, artifact manifest, and receipt verification.
- GitHub draft-PR publisher with deduplication and approval digest checks.
- Deterministic demo fixture and real-repository recovery specification.

### Person C — integrator/release owner

Branch: `team/person-c-integration`

Owns:

- Initial repository/bootstrap commit and frozen shared contracts.
- Runtime composition, CLI, package/install path, proof viewer, root tooling, CI, security/release files, final README/docs, and demo choreography.
- Merging A and B without rewriting their implementations.
- End-to-end acceptance, live credentials, npm/GitHub release, and public GitHub presentation.

### Branch rules

1. C creates `main`, the bootstrap commit, and tag `contracts-v1.0.0` first.
2. All three team branches start from that exact commit.
3. A and B never commit to `main`, never modify each other's owned paths, and never edit frozen contracts or root lock/tooling files.
4. C does not make speculative changes inside A/B directories. Integration fixes should first be requested from the owning person; C may make a small surgical fix only when the owner is unavailable, and records it in the merge notes.
5. No force-push after another teammate begins integration. Incremental commits remain reviewable.
6. Contract changes use a stop-the-line protocol: owner writes `handoff/contract-change-person-{a|b}.md`; C makes the change on `main`, bumps the contract minor version, and both active branches merge that main commit. Nobody silently edits the seam.

## 4. Repository layout and path ownership

Use one package. A monorepo adds manifests, locks, build graphs, and failure modes without adding hackathon value.

```text
Antibody/
├── .github/                         # C
│   ├── workflows/ci.yml
│   ├── workflows/live-smoke.yml
│   ├── workflows/release.yml
│   ├── dependabot.yml
│   └── pull_request_template.md
├── docs/
│   ├── architecture.md              # C
│   ├── demo.md                      # C
│   ├── security-model.md            # C
│   ├── runloop-reflex.md            # A
│   ├── domain-model.md              # B
│   ├── real-repo-p-timeout.md       # B
│   └── sponsors.md                  # C; Tenor facts only, no setup
├── fixtures/
│   └── demo-history/                # B
│       ├── history.fi               # deterministic git fast-import stream
│       ├── expected.json
│       └── README.md
├── handoff/
│   ├── person-a.json                # A
│   └── person-b.json                # B
├── schemas/                         # C; generated and committed from Zod
│   ├── config-v1.schema.json
│   ├── candidate-v1.schema.json
│   ├── agent-output-v1.schema.json
│   ├── verification-v1.schema.json
│   ├── receipt-v1.schema.json
│   ├── publication-v1.schema.json
│   └── handoff-v1.schema.json
├── scripts/
│   ├── build-demo-fixture.ts         # B
│   └── release-smoke.mjs            # C
├── src/
│   ├── contracts/                   # C; frozen after bootstrap
│   │   ├── schemas.ts
│   │   ├── ports.ts
│   │   ├── errors.ts
│   │   └── index.ts
│   ├── adapters/
│   │   ├── runloop/                 # A
│   │   ├── reflex/                  # A
│   │   ├── git/                     # B
│   │   └── github/                  # B
│   ├── core/                        # B
│   │   ├── mining/
│   │   ├── ranking/
│   │   ├── authoring/
│   │   ├── policy/
│   │   ├── classification/
│   │   ├── adjudication/
│   │   ├── receipts/
│   │   └── recover.ts
│   ├── cli/                         # C
│   ├── composition/                 # C
│   └── viewer/                      # C
├── test/
│   ├── adapters/runloop/            # A
│   ├── adapters/reflex/             # A
│   ├── adapters/git/                # B
│   ├── adapters/github/             # B
│   ├── core/                        # B
│   ├── integration/                 # C
│   └── package/                     # C
├── .editorconfig                    # C
├── .gitattributes                   # C
├── .gitignore                       # C
├── .npmrc                           # C
├── .node-version                    # C
├── AGENTS.md                        # C
├── CHANGELOG.md                     # C
├── CODE_OF_CONDUCT.md               # C
├── CONTRIBUTING.md                  # C
├── LICENSE                          # C
├── NOTICE                           # C
├── README.md                        # C
├── SECURITY.md                      # C
├── THIRD_PARTY_NOTICES.md           # C
├── eslint.config.mjs                # C
├── package.json                     # C
├── pnpm-lock.yaml                   # C
├── tsconfig.json                    # C
├── tsup.config.ts                   # C
└── vitest.config.ts                 # C
```

A and B may change only their owned files. C predeclares all runtime/dev dependencies in the bootstrap `package.json`, so A and B do not touch `package.json` or `pnpm-lock.yaml`.

## 5. Bootstrap decisions

### Runtime and build

- ESM-only TypeScript.
- Node `>=22` because the public Reflex client documents Node 22+ support.
- `pnpm@11.24.0`, pinned in `packageManager` and CI.
- `tsup` builds `dist/cli.js` and library exports with source maps.
- `package.json` uses `type: module`, `files: ["dist", "schemas", "LICENSE", "NOTICE", "README.md"]`, and `bin: {"antibody": "dist/cli.js"}`.
- Published name: `@psagar29/antibody`. The unscoped npm name `antibody` is already occupied by an unrelated project.

Pin exact dependency versions in the bootstrap commit. Versions verified from the npm registry on 2026-08-29:

| Purpose | Package/version |
|---|---|
| Runtime validation/JSON Schema | `zod@4.5.4` |
| CLI | `commander@15.0.0`, `picocolors@1.1.1` |
| YAML | `yaml@2.9.0` |
| Globs/gitignore semantics | `fast-glob@3.3.3`, `ignore@7.0.6` |
| GitHub REST | `@octokit/rest@22.0.1` |
| Runloop | `@runloop/api-client@1.31.0` |
| Reflex | `@runloop/reflex-client@0.20.0` |
| Canonical JSON | `json-canonicalize@3.0.0` |
| Build/test | `typescript@7.0.2`, `tsup@8.5.1`, `vitest@4.1.11`, `eslint@10.9.1`, `@types/node@22.20.1` |

Do not add a Slack SDK, Tenor package, web framework, database, queue, React app, or telemetry client.

### Development and install paths

```bash
# Source checkout
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm antibody --help

# Published package, after C confirms npm-scope access
npm install --global @psagar29/antibody@0.1.0
antibody --help

# No npm access: release tarball generated by npm pack
npm install --global \
  https://github.com/psagar29/Antibody/releases/download/v0.1.0/psagar29-antibody-0.1.0.tgz
```

`npm pack` plus clean-directory install is a release gate. Do not put the npm command in README as working until the package actually exists.

## 6. Frozen domain contracts

`src/contracts/schemas.ts` is the runtime source of truth. Define schemas in Zod, infer TypeScript types, and generate the committed JSON Schemas. All objects use `strict()`; unknown keys fail. All timestamps are RFC 3339 UTC. All repository paths are slash-normalized, relative, non-empty, and reject `..`, NUL, absolute paths, drive prefixes, and backslashes. All SHAs are lowercase 40-character hex. All SHA-256 values use `sha256:<64 lowercase hex>`.

The contract discriminator is always `schemaVersion`, never an implicit package version.

### 6.1 Core value objects

```ts
export type FullGitSha = string & {readonly __brand: 'FullGitSha'};
export type Sha256 = `sha256:${string}`;
export type RepoPath = string & {readonly __brand: 'RepoPath'};

export type RepositoryRefV1 = Readonly<{
  slug: `${string}/${string}`;
  cloneUrl: `https://github.com/${string}.git`;
}>;

export type CommandSpecV1 = Readonly<{
  argv: readonly [string, ...string[]];
  cwd: RepoPath;
  env: Readonly<Record<string, string>>; // literals only; never secrets
  timeoutMs: number;                    // 1_000..1_800_000
}>;

export type ArtifactV1 = Readonly<{
  name: string;
  mediaType: string;
  sha256: Sha256;
  sizeBytes: number;
  contentBase64?: string; // transport only, <= 1 MiB; omitted from final receipt
}>;
```

Commands are argv arrays. Neither config nor a port accepts an arbitrary shell string. A's Runloop adapter may need to render argv for a remote shell; it must use one reviewed POSIX-quoting function with exhaustive metacharacter tests. No patch, issue text, path, or secret is interpolated into a command.

### 6.2 Candidate

```ts
export type RecoveryCandidateV1 = Readonly<{
  schemaVersion: 'antibody.candidate/v1';
  candidateId: Sha256; // canonical repository slug + parentSha + fixSha
  repository: RepositoryRefV1;
  parentSha: FullGitSha;
  fixSha: FullGitSha;
  headSha: FullGitSha;
  commit: {
    subject: string;
    authoredAt: string;
    changedProductionPaths: readonly RepoPath[];
    changedTestPaths: readonly RepoPath[]; // invariant: [] for eligible candidates
    additions: number;
    deletions: number;
    diffSha256: Sha256;
  };
  signals: readonly {
    code: string;
    weight: number;
    evidence: string;
  }[];
  score: number; // 0..100, deterministic
}>;
```

### 6.3 Agent session seam

B owns prompts, context selection, output protocol, retries, and repair. A owns Reflex transport and session lifecycle. Their only authoring seam is:

```ts
export type AgentInvocationV1 = Readonly<{
  schemaVersion: 'antibody.agent-invocation/v1';
  invocationId: string; // UUID
  repository: RepositoryRefV1;
  checkoutSha: FullGitSha;
  prompt: string;       // constructed and injection-delimited by B
  continuationId?: string; // opaque value returned by the adapter
  timeoutMs: number;
  maxOutputBytes: number;
}>;

export type AgentInvocationResultV1 = Readonly<{
  schemaVersion: 'antibody.agent-result/v1';
  invocationId: string;
  continuationId: string;
  finalText: string; // raw bounded final agent text; B parses it
  provider: {
    name: 'reflex';
    agentId: string;
    streamId?: string;
    personaId?: string;
    axonId?: string;
  };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    modelUsd?: number;
  };
  startedAt: string;
  finishedAt: string;
}>;

export interface AgentSessionPort {
  invoke(
    request: AgentInvocationV1,
    options?: {signal?: AbortSignal},
  ): Promise<AgentInvocationResultV1>;
  stop(continuationId: string): Promise<void>;
}
```

`continuationId` is deliberately opaque. B may return it on a repair turn but must not parse it or assume it is a Reflex ID. A may preserve vendor provenance separately in `provider`.

B instructs Codex to end with exactly one JSON object:

```json
{
  "schemaVersion": "antibody.agent-output/v1",
  "candidateId": "sha256:...",
  "patchBase64": "base64-of-utf8-unified-diff",
  "testCommandHint": ["npm", "exec", "ava", "test.js", "--tap"],
  "summary": "one sentence"
}
```

B treats this as untrusted data: bound size, strict-parse JSON, decode base64, require UTF-8, normalize LF only for hashing, parse the unified diff independently, and reject any command hint that differs from configured commands. The hint is informational; it is never executed.

### 6.4 Verification execution seam

A executes; B classifies and adjudicates.

```ts
export type VerificationRequestV1 = Readonly<{
  schemaVersion: 'antibody.verification-request/v1';
  runId: string;
  candidate: RecoveryCandidateV1;
  patch: {
    unifiedDiffBase64: string;
    sha256: Sha256;
    changedPaths: readonly RepoPath[];
  };
  environment: {
    source:
      | {kind: 'blueprint'; id: string}
      | {kind: 'snapshot'; id: string};
    networkPolicyId?: string;
    architecture?: 'x86_64' | 'arm64';
    shape?: string; // opaque configured Runloop value, not an SDK type
    maxParallel: 1 | 2;
  };
  commands: {
    setup: readonly CommandSpecV1[];
    baseline: CommandSpecV1;
    targeted: CommandSpecV1; // A appends changed test paths as argv entries
    fullSuite?: CommandSpecV1;
  };
  report: {
    format: 'tap' | 'junit' | 'vitest-json' | 'jest-json' | 'pytest-text';
    path?: RepoPath;
  };
  repetitions: 2 | 3 | 4 | 5;
}>;

export type RawExecutionAttemptV1 = Readonly<{
  lane: 'parent' | 'fix' | 'head';
  phase: 'setup' | 'baseline' | 'candidate' | 'full-suite';
  attempt: number;
  checkoutSha: FullGitSha;
  patchSha256?: Sha256;
  command: CommandSpecV1;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  termination: 'exited' | 'timed-out' | 'signaled' | 'platform-error';
  exitCode: number | null;
  stdout: ArtifactV1;
  stderr: ArtifactV1;
  report?: ArtifactV1;
  provider: {
    devboxId: string;
    executionId?: string;
    resolvedBlueprintId?: string;
    resolvedSnapshotId?: string;
    networkPolicyId?: string;
    resolvedNetworkPolicySha256?: Sha256;
    architecture?: string;
    shape?: string;
  };
}>;

export type RawVerificationEvidenceV1 = Readonly<{
  schemaVersion: 'antibody.raw-evidence/v1';
  runId: string;
  candidateId: Sha256;
  patchSha256: Sha256;
  environmentEquivalence: {
    equivalent: boolean;
    comparedFields: readonly string[];
    mismatchFields: readonly string[];
  };
  attempts: readonly RawExecutionAttemptV1[];
  reflex?: AgentInvocationResultV1['provider'];
  runloopCostUsd?: number;
  cleanup: readonly {
    devboxId: string;
    requested: boolean;
    completed: boolean;
    errorCode?: string;
  }[];
}>;

export interface VerificationExecutionPort {
  execute(
    request: VerificationRequestV1,
    options?: {signal?: AbortSignal},
  ): Promise<RawVerificationEvidenceV1>;
}
```

The interface intentionally contains no Runloop SDK request type and no verdict. SDK churn remains local to A; domain truth remains local to B.

### 6.5 Classification and verdict

B maps every raw attempt to exactly one category:

```ts
export type OutcomeKindV1 =
  | 'pass'
  | 'assertion-failure'
  | 'behavioral-failure'
  | 'unrelated-test-failure'
  | 'collection-failure'
  | 'build-failure'
  | 'dependency-failure'
  | 'timeout'
  | 'crash'
  | 'platform-failure'
  | 'unknown-failure';

export type ClassifiedAttemptV1 = Readonly<{
  rawAttemptIndex: number;
  outcome: OutcomeKindV1;
  signature?: Sha256; // normalized test name + failure type + relevant frame/message
  targetTestNames: readonly string[];
  explanation: string;
  confidence: 'high' | 'medium' | 'low';
}>;

export type VerdictV1 = 'verified' | 'rejected' | 'inconclusive';
```

Rules are mechanical:

- `verified`: policy passed; environment equivalent; parent/fix baselines pass; all parent candidate repetitions are `assertion-failure` or target-attributable `behavioral-failure` with one stable signature; all fix repetitions pass; head targeted and configured full suite pass.
- `rejected`: parent candidate passes; fix candidate does not pass for a test-semantic reason; stable failure exists on both sides; patch is non-test-only; or current head semantically conflicts.
- `inconclusive`: install/build/collection/platform/timeout/unknown failure, inconsistent repetition, missing structured report, environment mismatch, or cleanup/evidence loss that compromises the claim.

No binary `exitCode !== 0` shortcut may produce `verified`.

### 6.6 Receipt and publication

The verified receipt is immutable. Publication is a separate record so opening a PR does not mutate and rehash the proof.

```ts
export type ReceiptV1 = Readonly<{
  schemaVersion: 'antibody.receipt/v1';
  runId: string;
  candidate: RecoveryCandidateV1;
  patch: {
    sha256: Sha256;
    sizeBytes: number;
    changedPaths: readonly RepoPath[];
    artifact: Omit<ArtifactV1, 'contentBase64'>;
  };
  policy: {
    testOnly: boolean;
    allowedGlobs: readonly string[];
    violations: readonly {code: string; path?: RepoPath; detail: string}[];
  };
  environment: RawVerificationEvidenceV1['environmentEquivalence'] & {
    source: VerificationRequestV1['environment']['source'];
    networkPolicyId?: string;
  };
  classifications: readonly ClassifiedAttemptV1[];
  evidence: {
    rawEvidenceSha256: Sha256;
    artifacts: readonly Omit<ArtifactV1, 'contentBase64'>[];
    reflex?: AgentInvocationResultV1['provider'];
    cleanup: RawVerificationEvidenceV1['cleanup'];
  };
  costs: {modelUsd?: number; runloopUsd?: number};
  verdict: VerdictV1;
  reasonCodes: readonly string[];
  createdAt: string;
}>;

export type PublicationRecordV1 = Readonly<{
  schemaVersion: 'antibody.publication/v1';
  receiptSha256: Sha256;
  repository: RepositoryRefV1;
  branch: string;
  commitSha: FullGitSha;
  pullRequestNumber: number;
  pullRequestUrl: string;
  draft: true;
  createdAt: string;
}>;
```

Canonicalize receipt JSON with RFC 8785 semantics via `json-canonicalize`, then SHA-256 the UTF-8 bytes. Hashes are integrity checks, not signatures. A later signing feature needs a CI identity and verification key; it is out of hackathon scope.

## 7. Configuration contract

Config filename: `.antibody.yml`. It is data, never executable JavaScript/TypeScript. C owns syntax/schema; B owns semantic validation. Secrets are named by environment-variable name, never embedded in YAML or receipts.

```yaml
schemaVersion: antibody.config/v1

repository:
  slug: sindresorhus/p-timeout        # optional when inferable from origin
  baseBranch: main

scan:
  maxCommits: 250
  since: 2025-01-01T00:00:00Z
  includeProduction:
    - "**/*.js"
    - "**/*.ts"
  testGlobs:
    - "**/*.test.js"
    - "**/*.test.ts"
    - "test/**"
    - "tests/**"
  allowedSupportGlobs:
    - "test/**"
    - "tests/**"
    - "**/__fixtures__/**"
    - "**/__snapshots__/**"
  excludeGlobs:
    - "vendor/**"
    - "dist/**"
    - "**/*.min.js"
  maxChangedFiles: 12
  maxChangedLines: 400
  excludeMerges: true
  requireNoTestChanges: true

authoring:
  provider: reflex
  personaIdEnv: ANTIBODY_REFLEX_PERSONA_ID
  maxAttempts: 3
  timeoutMs: 900000
  maxOutputBytes: 524288

verification:
  provider: runloop
  environment:
    source:
      kind: snapshot
      idEnv: ANTIBODY_RUNLOOP_SNAPSHOT_ID
    networkPolicyIdEnv: ANTIBODY_RUNLOOP_NETWORK_POLICY_ID
    architecture: x86_64
    maxParallel: 2
  repetitions: 2
  commands:
    setup:
      - argv: ["npm", "install", "--ignore-scripts=false"]
        cwd: "."
        env: {"CI": "1"}
        timeoutMs: 600000
    baseline:
      argv: ["npm", "test"]
      cwd: "."
      env: {"CI": "1"}
      timeoutMs: 600000
    targeted:
      argv: ["npm", "exec", "ava", "--", "--tap"]
      cwd: "."
      env: {"CI": "1", "NO_COLOR": "1"}
      timeoutMs: 120000
    fullSuite:
      argv: ["npm", "test"]
      cwd: "."
      env: {"CI": "1"}
      timeoutMs: 600000
  report:
    format: tap

policy:
  maxPatchBytes: 131072
  maxPatchFiles: 4
  maxAddedLines: 250
  forbidBinary: true
  forbidSymlinks: true
  forbidSubmodules: true
  requireCurrentHeadPass: true

publication:
  provider: github
  tokenEnv: GITHUB_TOKEN
  draft: true
  branchPrefix: antibody/
  labels: ["tests", "antibody"]
```

Important behavior:

- `setup`, repository code, and tests are untrusted remote code. They run only in Runloop by default.
- `env` is a literal allowlist that is serialized into the receipt. Secret-valued env entries are rejected.
- Secret values are loaded by adapter constructors from the named environment variables and never cross the shared contracts.
- Snapshot and Blueprint identifiers must be validated through the official SDK before a run.
- Missing network policy is allowed only with explicit `--allow-unrestricted-network` and is prominently recorded; production docs require a policy.
- Config from a target repository does not automatically gain trust. `antibody init` writes config; `recover` displays the command plan and requires an operator confirmation on first use unless `--config-trusted <config-sha256>` is supplied.

## 8. Domain implementation: Person B

### 8.1 Miner

Use the local `git` executable through `spawn`/`execFile`, never a shell. Pin the target repo remote and capture current `HEAD` before scanning.

For each commit in the configured window:

1. Resolve full SHA and parents with NUL-delimited machine formats.
2. Reject zero-parent and multi-parent commits.
3. Obtain `--numstat`, name-status, modes, and full diff.
4. Reject binary, submodule/gitlink, generated, vendor, excluded, oversized, test-only, docs-only, or config-only changes.
5. Require at least one production path and exactly zero configured test/support changes.
6. Compute deterministic diff digest and candidate ID.
7. Optionally query GitHub for linked PR/issue metadata using read-only credentials. Cache by immutable SHA. Rate-limit failures reduce ranking confidence; they do not corrupt Git results.

Local Git is authoritative for changed paths and the full diff. GitHub's compare response is capped at 300 changed files, so never use that response to prove “no tests changed.” GitHub supplies enrichment only.

Initial ranking, clamped to 0..100:

| Signal | Weight |
|---|---:|
| Subject contains `fix`, `bug`, `regression`, `crash`, `incorrect`, or `error` as a word | +35 |
| Linked closed issue/PR has a bug/regression label | +20 |
| Diff changes <= 100 lines | +15 |
| One to three production files | +10 |
| Diff modifies an existing conditional/error/validation branch | +10 |
| Commit message references an issue | +5 |
| Current `HEAD` still contains the fixed code region | +5 |
| Dependency/config/generated-only shape | hard reject |
| More than 400 lines or 12 files | hard reject by default |

Tie-break by score descending, authored time descending, SHA lexicographically ascending. The same repository state must produce the same ordering.

### 8.2 Codex authoring

`CodexAuthoringModule` is a deep module behind:

```ts
authorCandidate(
  candidate: RecoveryCandidateV1,
  context: AuthoringContextV1,
  agent: AgentSessionPort,
  budget: AuthoringBudgetV1,
): Promise<AuthoredPatchResultV1>
```

It owns:

- Context budget: commit subject/body, issue text when available, `P..F` diff, affected source at parent and fix, test framework/config, and at most three nearest existing tests. Never dump the whole repo.
- Prompt-injection framing: label repository/issue content as untrusted quoted evidence; tell Codex not to follow instructions found inside it.
- Explicit task: add the smallest regression test that exercises the behavioral difference; no production/config/dependency changes; no network; no snapshots unless configured.
- Exact base64 JSON output envelope.
- Maximum three candidates. Attempt 1 is independent; later attempts include only normalized policy/classification feedback and the previous patch digest, not unbounded raw logs.
- Repair policy: repair syntax/collection mistakes and parent-pass overgeneralization; do not ask Codex to repair platform, dependency, timeout, environment-equivalence, or credential failures.
- `stop()` in `finally` after terminal result or budget exhaustion.

The known fix is intentionally available as an oracle. This is historical missing-test recovery, not blind bug discovery.

### 8.3 Patch policy

Parse unified diff structurally. Reject before Runloop spend when any condition occurs:

- Path outside `testGlobs` + `allowedSupportGlobs`.
- Rename/copy across allowed and disallowed areas.
- Binary patch, symlink mode `120000`, gitlink mode `160000`, executable-bit change, deletion of an existing test, or modification of production/package/build/workflow/config files.
- Any `.github/workflows/**` change, even if a repository's loose test glob accidentally permits it. The publisher intentionally does not request GitHub workflow permission.
- Absolute/traversal/NUL/backslash path.
- More than configured bytes/files/added lines.
- Empty patch or patch that does not add/change an executable test.
- Patch fails `git apply --check` against parent, fix, or captured current `HEAD`.

The agent's claim that a patch is test-only is irrelevant. The parser decides.

### 8.4 Classifiers

Implement parsers for TAP, JUnit XML, Vitest JSON, Jest JSON, and conservative pytest text. Each parser returns target test names, normalized outcome, signature, and confidence. Unknown/malformed/missing reporter output is `unknown-failure`, never verified.

Normalize signatures by removing paths outside the repo, line numbers, timestamps, random IDs, ANSI, and bounded temp directory names; retain test name, failure/error type, assertion operator, and the first project-code frame. Hash the canonical normalized tuple. Across repetitions, the parent signature must match exactly.

The classifier matrix needs exhaustive tests, especially:

- assertion failure -> pass: eligible;
- thrown target behavioral error wrapped by an assertion -> pass: eligible;
- syntax/collection -> pass: inconclusive;
- dependency/import -> pass: inconclusive;
- timeout -> pass: inconclusive;
- parent pass -> fix pass: rejected as non-regression-sensitive;
- parent fail -> fix fail: rejected or inconclusive based on kinds;
- changing parent signatures: inconclusive/flaky;
- unrelated existing test failure: rejected;
- target pass but full suite fails on head: rejected.

### 8.5 Receipt

Persist under `.antibody/runs/<runId>/`:

```text
candidate.json
patch.diff
raw-evidence.json
classified-evidence.json
artifacts/<lane>-<phase>-<attempt>.*
receipt.json
receipt.sha256
```

Write atomically: temporary file in the run directory, `fsync`, then rename. Set files to user-readable/writable only where supported. Redact configured secret values and high-risk token shapes before persistence. The receipt references all artifact hashes and does not embed megabytes of logs.

### 8.6 GitHub publisher

Use `@octokit/rest` behind an internal injected client seam. Sequence:

1. Re-parse and validate `receipt.json`; require `verdict=verified`.
2. Recompute canonical receipt digest and patch digest.
3. Require `--approval <receiptSha256>` exact match.
4. Fetch base branch and ensure compatibility with captured `headSha`; if it moved, apply patch and rerun current-head verification or stop. Never silently publish stale proof.
5. Search open PRs for marker `<!-- antibody-receipt: sha256:... -->`; return existing PR if found.
6. Create branch `antibody/<fix-short>-<run-short>` from approved current head. Fail on an unrelated existing branch; never force-update.
7. Create one commit containing test patch plus `.antibody/receipts/<receiptSha256>.json` only if project policy opts into in-repo receipts. Otherwise link a GitHub Actions artifact/release asset and keep code diff test-only.
8. Open a **draft** PR with exact parent/fix/head SHAs, patch/receipt hashes, red/green summary, limitations, and marker.
9. Apply labels only when they already exist or the token has explicit label permission; label failure does not duplicate the PR.

Minimum token permissions: repository contents read/write and pull requests write. No actions, issues, administration, or merge permission is needed.

## 9. Infrastructure implementation: Person A

### 9.1 Runloop adapter

Implement `RunloopVerificationAdapter implements VerificationExecutionPort`. Inspect installed generated SDK types and the official OpenAPI before every vendor call; do not guess create payloads, method names, or response fields.

Execution algorithm:

1. Validate `VerificationRequestV1` again at the adapter entry.
2. Resolve the configured Blueprint/Snapshot and network policy using read-only SDK calls. Persist only fields the API actually returns.
3. Provision at most two Devboxes concurrently from the same environment source. Trial accounts cap running Devboxes; shut down authoring resources before proof lanes if necessary.
4. Clone/mount the repo using the documented create-time mount mechanism or a safe SDK file/repository operation. Checkout full SHA and verify `git rev-parse HEAD` equals the request.
5. Upload the patch as a file through a documented SDK file/object mechanism. Never shell-interpolate patch bytes. Verify its digest in the Devbox.
6. Run setup and baseline without patch on parent/fix. Every `exec` uses explicit `cwd` and environment because ordinary Runloop executions do not preserve shell state.
7. Apply with `git apply --check` then `git apply`; verify changed paths and tree modes match the request.
8. Run targeted tests `repetitions` times on parent and fix. Append discovered changed test paths as individually quoted argv entries.
9. Run current-head targeted and configured full suite after causal lanes pass. Reuse a cleaned lane only if evidence records the checkout transition; otherwise create a third lane after one causal lane shuts down.
10. Enforce two timeouts: a timeout command/process inside the Devbox and a controller-side deadline. Runloop's raw optimistic timeout is documented as at most 25 seconds and does not terminate the underlying command; it is not the test timeout. After a controller deadline, explicitly terminate/abandon the execution per documented capabilities and stop the Devbox.
11. Inspect and record SDK truncation indicators. Truncated output or a missing required report makes the attempt inconclusive; never classify from a convenient prefix.
12. Download reporter files and bounded stdout/stderr, hash full bytes, inline at most 1 MiB for B's parser, and write the rest to C-provided artifact directory.
13. Record provider IDs, timings, exits, resolved environment metadata, and cost only when the official response supplies it. Missing cost is `undefined`, not zero. Fetch/canonicalize the resolved Network Policy where the public API permits and record its SHA-256, not only its mutable identifier.
14. Persist raw evidence before cleanup.
15. In `finally`, request shutdown for every created Devbox, await bounded confirmation, and record cleanup failures without losing proof artifacts.

Internal seams are permitted for tests:

- `RunloopControl` wrapping generated SDK calls.
- `ArtifactStore` for downloaded bytes.
- `ArgvRenderer` for remote command strings.
- `Clock` and `IdFactory`.

These stay private to A's implementation. The external seam remains `VerificationExecutionPort`.

Runloop constraints from official docs that must appear in code/tests/runbook:

- Linux only; no claim of native Xcode/macOS verification.
- Fresh shell per ordinary `exec`.
- The raw optimistic execution wait is not a kill switch; use in-box and controller deadlines.
- Mounts are create-time.
- Default networking is unrestricted unless a Network Policy is attached.
- Execution logs have finite retention, so Antibody persists its own artifacts.
- Suspend stops compute but not all storage billing.
- Axon/session provenance is not cryptographic attestation.

### 9.2 Reflex adapter

Implement `ReflexAgentSessionAdapter implements AgentSessionPort` against the public SDK/OpenAPI only.

- Constructor receives resolved credentials and Persona/org configuration; raw keys never enter shared requests or results.
- `invoke` without `continuationId`: use the documented `POST /api/agent-personas/{id}/launch` operation, including its explicit `promptStrategy`, and handle its asynchronous `201` response. Confirm the installed generated function/type names rather than deriving them from the route text.
- `invoke` with `continuationId`: send the repair prompt to that existing session using the documented message/queue operation.
- Subscribe/watch with heartbeats and bounded reconnect/backoff. Deduplicate replayed events by documented event identity/order.
- Return only bounded final text plus actual public provenance fields.
- Abort/timeout calls the documented interrupt/stop operation, then returns/throws a typed external error.
- `stop` is idempotent.
- Do not implement a custom Reflex plugin.
- Do not claim Reflex creates PRs. Current public automation docs do not document a `create_pull_request` action; publication remains Antibody's GitHub module after human approval.
- Do not claim Persona or Automation provisioning is available through the public API. The inspected public surface can list/get/launch Personas but does not expose Persona create/update or Automation CRUD; configure those in the Reflex UI and document the exact manual state.
- Persona settings are defaults, not policy. B's independent patch/verdict gate is authoritative.

Add `docs/runloop-reflex.md` with exact UI/API setup that was live-tested: organization, service account/key, GitHub App/repo access, model credential, Blueprint/Snapshot, Network Policy, Persona, Automation trigger, Inbox approval, cleanup, and teardown. Mark UI-only/manual steps as such. Never invent a portable Persona manifest if Reflex does not document one.

The critical-path controller runs outside the Reflex agent: C's CLI calls Reflex for the Codex turn and Runloop for proof. Public docs do not promise that a Reflex Agent Session automatically receives nested Runloop credentials. A may spike a restricted secret injection path, but the demo must not depend on it unless live-proven. This also prevents an authoring agent from controlling its own proof environment.

## 10. CLI and composition: Person C

### Commands

```text
antibody init [--repo <path>] [--preset node-test|ava|vitest|jest|pytest|junit]
antibody doctor [--json]
antibody scan --repo <path> [--limit <n>] [--json] [--output <file>]
antibody recover --repo <path> --commit <full-sha> [--json]
antibody run --repo <path> [--top <n>] [--json]
antibody publish --receipt <receipt.json> --approval <sha256:...> [--json]
antibody receipt verify <receipt.json> [--json]
antibody receipt render <receipt.json> --output <proof.html>
antibody demo fixture [--live] [--json]
```

Behavior:

- `init` detects likely commands/globs but never runs target code. It writes `.antibody.yml` only after showing the file; existing config requires `--force`.
- `doctor` is read-only: Node/git versions, config/schema, credential presence (never values), GitHub remote, and SDK read checks for configured resource IDs. It creates no Devbox.
- `scan` is read-only and deterministic. Human output goes to stderr; `--json` emits one schema-valid object per stdout line.
- `recover` operates on one explicit full SHA and stops after receipt.
- `run` scans then attempts top candidates sequentially until one verifies or budget ends. Default `--top 1`; never publishes.
- `publish` is the only remote write command. In an interactive TTY it displays the digest and requires exact confirmation; in automation the explicit `--approval` flag is mandatory.
- `receipt render` produces a self-contained static HTML proof viewer with escaped content and no remote JavaScript.
- `demo fixture` uses the deterministic fixture. `--live` opts into Runloop/Reflex spend; without it, use frozen fake evidence for package smoke only and label it simulated.

### Exit codes

| Code | Stable meaning | Example machine code |
|---:|---|---|
| 0 | requested operation completed | `ANTB_OK` |
| 2 | CLI usage/config/schema error | `ANTB_INPUT_INVALID` |
| 3 | scan completed; no eligible candidate | `ANTB_SCAN_NO_CANDIDATE` |
| 10 | patch/policy rejected | `ANTB_POLICY_TEST_ONLY` |
| 11 | causal candidate rejected | `ANTB_PROOF_REJECTED` |
| 12 | proof inconclusive | `ANTB_PROOF_INCONCLUSIVE` |
| 13 | configured budget exhausted | `ANTB_BUDGET_EXCEEDED` |
| 20 | authentication/authorization | `ANTB_EXTERNAL_AUTH` |
| 21 | rate limited | `ANTB_EXTERNAL_RATE_LIMIT` |
| 22 | vendor/network unavailable | `ANTB_EXTERNAL_UNAVAILABLE` |
| 30 | publication lacks exact approval | `ANTB_PUBLISH_APPROVAL_REQUIRED` |
| 31 | branch/PR/base conflict | `ANTB_PUBLISH_CONFLICT` |
| 70 | internal invariant/bug | `ANTB_INTERNAL` |

All thrown errors become `AntibodyError` with `{code, category, message, retryable, causeCode?, details?}`. Details are redacted and schema-bound. Expected rejections are results plus nonzero exit codes, not stack traces. `--debug` may show a local stack but never secret values.

### Composition

C's composition root is the only place concrete modules meet:

```ts
const app = createAntibodyApplication({
  miner: new GitHistoryMiner(...),
  authoring: new CodexAuthoringModule(new ReflexAgentSessionAdapter(...)),
  verifier: new RecoveryVerifier(new RunloopVerificationAdapter(...)),
  publisher: new GitHubDraftPublisher(...),
  receipts: new FileReceiptStore(...),
});
```

No A module imports B. B imports contracts only and receives A ports. C imports both.

## 11. Security model

Threat model: target repositories, commit messages, issue text, patches, test output, and agent output are untrusted. Provider credentials are high-value secrets. GitHub publication is consequential.

Required controls:

1. Never execute target repository code on the operator Mac by default. Only trusted deterministic fixture tests may run locally in CI.
2. Permit only `https://github.com/<owner>/<repo>.git` clone URLs in v1. Reject SSH URLs, credentials in URLs, redirects to other hosts, local/file URLs, and arbitrary archives.
3. Separate credentials: read-only GitHub access for mining/authoring, restricted Runloop/Reflex service credentials for execution, and a write token loaded only by `publish`.
4. No secrets in config, prompts, commands, shared contracts, receipts, logs, proof HTML, or PR body.
5. Redact literal configured secret values plus common GitHub/Runloop/Reflex token shapes before persistence; test redaction with canaries.
6. Commands are argv arrays; quote centrally. Patch bytes are uploaded as files, never interpolated.
7. Path/mode/size policy runs before execution and again before publication.
8. Use Network Policy for verification. Record unrestricted egress as a weakened condition.
9. Use exact SHAs; verify ancestry and checkout after every clone/reset.
10. Default draft PR, no merge capability, no force-push, deterministic dedupe marker.
11. Bound candidate count, agent turns, tokens, output bytes, Devboxes, command duration, artifact bytes, retries, and total wall time.
12. Retry only idempotent reads/provisioning calls with request IDs when supported. Do not blindly retry branch/commit/PR writes.
13. Escape every receipt field in HTML/Markdown. Proof viewer has a restrictive CSP and no remote resources.
14. Pin dependencies and Actions; run dependency review and secret scanning.
15. Record cleanup failure. A leaked Devbox is an operational incident, not a cosmetic warning.

## 12. Tests and CI

### Person A test gate

- Unit: argv quoting including spaces, quotes, `$()`, backticks, newlines, glob characters, leading dashes, and Unicode.
- Unit: two-lane provisioning, exact SHA checkout, patch upload/digest, execution ordering, repetitions, head transition, artifact truncation/hash, cancellation, timeout, cost missing-vs-zero, and cleanup on every thrown stage.
- Unit: Reflex new invocation, continuation, replay dedupe, reconnect, terminal states, timeout/abort, bounded final text, redaction, and idempotent stop.
- Contract: fake generated-SDK clients produce schema-valid `RawVerificationEvidenceV1` and `AgentInvocationResultV1`.
- Live/manual: one low-cost Reflex invocation and one paired Runloop fixture proof. Test resources use a unique run ID and are visibly cleaned.

### Person B test gate

- Golden deterministic git fast-import history: eligible source-only fix, fix with test, merge, binary change, dependency-only change, oversized change, rename/path traversal, and current-head drift.
- Ranking snapshots and tie-break determinism.
- Authoring envelope parser: malformed JSON/base64/UTF-8, oversized output, mismatched candidate ID, prompt injection content, retries, budget, and non-repairable evidence.
- Patch policy matrix for paths, modes, binary, rename/copy, deleted tests, executable bits, file/line/byte caps, and application to all three SHAs.
- Classifier corpus for every outcome in TAP/JUnit/Vitest/Jest/pytest formats; signature stability and normalization.
- Adjudication truth table covering every parent/fix/head combination and repetition inconsistency.
- Receipt canonicalization golden files and tamper detection.
- GitHub publisher with injected fake client: exact approval, stale head, dedupe, branch conflict, partial write recovery, draft invariant, and least-permission errors.
- End-to-end core test with fake `AgentSessionPort` and `VerificationExecutionPort`.

### Person C test gate

- Contract JSON Schema generation produces no diff.
- Typecheck/lint/build/unit suite on Node 22 and 24, Ubuntu; package smoke on macOS too if minutes permit.
- CLI stdout/stderr/exit-code snapshots.
- Clean `npm pack`, install tarball in a temporary directory, run `antibody --version`, `doctor`, fixture scan, receipt verify/render.
- Static proof viewer escaping/CSP test.
- Full deterministic fixture with fakes on every PR.
- Live smoke in a manual, protected GitHub environment only. Never expose secrets to fork PRs.

### Workflows

`ci.yml` (`pull_request`, `push main`): minimal `contents: read`; pinned actions; Corepack/pnpm; frozen lock; schema check; lint; typecheck; test with coverage; build; pack/install smoke; `pnpm licenses list --prod --json` allowlist.

`live-smoke.yml` (`workflow_dispatch` only): protected `demo` environment; Runloop, Reflex, and GitHub read credentials; strict budget; fixture proof; cleanup audit; upload redacted evidence. It does not publish a PR.

`release.yml` (`v*` tag after protected approval): build/test/pack smoke, GitHub release tarball/checksums, and npm publish with provenance if the scope supports trusted publishing. Permissions only `contents: write` and `id-token: write` in the publish job.

Coverage target: 85% global branch/statement; 95% for patch policy, adjudication, receipt digest, and approval checking. Do not chase coverage in vendor wrapper lines at the expense of failure-path tests.

## 13. Demo assets

### 13.1 Deterministic fixture — mandatory

B creates a Git fast-import stream, not a nested `.git` directory and not a hand-waved README fixture. It produces a tiny dependency-free Node ESM repository with four commits at fixed identities/timestamps:

1. `base`: `slugify` plus passing `node:test` tests; repeated whitespace bug present.
2. `docs`: irrelevant commit.
3. `fix: collapse repeated whitespace in slugs`: production `src/slug.js` only; no test change.
4. `head`: unrelated compatible change.

Recovered test asserts `slugify('Hello   World') === 'hello-world'`. It fails on parent with a Node assertion and passes on fix/current head. Commands use Node's built-in test runner, so fixture correctness does not depend on package registries. `expected.json` records generated SHAs, top candidate, patch digest, normalized parent signature, and expected verdict.

Fixture gate:

```text
scan -> source-only fix ranked first
author fake -> exact test-only patch
parent x2 -> same assertion signature
fix x2 -> pass
head targeted/full -> pass
receipt verify -> pass
proof.html -> renders escaped evidence
```

### 13.2 Real public repository — mandatory rehearsal, preferred live demo

Use [sindresorhus/p-timeout](https://github.com/sindresorhus/p-timeout), MIT licensed.

- Fix: [`ed58372c62d3dddfe6f58de37558fb132e1a4e9b`](https://github.com/sindresorhus/p-timeout/commit/ed58372c62d3dddfe6f58de37558fb132e1a4e9b), `Fix "Illegal invocation" error with custom timers`, linked to [issue #45](https://github.com/sindresorhus/p-timeout/issues/45).
- Parent: `f9ced5e18ad81eab24a9a8d0f07bf3002f7bea64`.
- The fix changed only `index.js` (six changed lines) and no test.
- The behavioral change calls custom timer functions with `this === undefined` rather than as object methods.
- A deterministic regression test defines normal-function custom timers whose body asserts an undefined receiver, then resolves a short `pTimeout` call. On the parent, `clearTimeout` receives the timer object and the test fails; on the fix, it receives `undefined` and passes. This parent/fix behavior was independently reproduced locally before this plan was written.

Prewarm and retain a Runloop Snapshot after installing the historical repo dependencies; use that same Snapshot for both causal lanes. Record resolved dependency/toolchain hashes because the historical repository has no lockfile. Rehearse the exact run twice before judging. Prepare a public fork for the draft PR; never assume write permission to upstream.

Fallback order on demo day:

1. Real `p-timeout` run and fork PR.
2. Deterministic fixture live on Runloop/Reflex.
3. Pre-recorded real-run receipt plus live fixture. Never fake a vendor response while presenting it as live.

## 14. Acceptance gates

### Contract freeze gate — C

- Main exists and branches point to one bootstrap SHA.
- All Zod schemas, ports, error codes, package dependencies, and ownership paths compile.
- Generated JSON Schemas are committed and clean.
- A/B each run a contract-only test before implementation.

### Person A handoff gate

- Owns only assigned paths.
- Runloop and Reflex adapters pass unit/contract tests with fakes.
- At least one live smoke has evidence and confirmed cleanup, or handoff explicitly names the credential/access blocker.
- No domain verdict/classifier/prompt/publisher logic.
- Official vendor calls link to exact SDK type/OpenAPI operation in code comments or runbook.
- `handoff/person-a.json` validates.

### Person B handoff gate

- Owns only assigned paths.
- Fixture, miner, authoring, policy, classifiers, adjudicator, receipt, and publisher pass their suites.
- Core full flow passes using frozen fake ports.
- Real `p-timeout` spec is precise and rehearsed locally.
- No Runloop/Reflex SDK import anywhere under B-owned code.
- No Tenor/Slack code or interface.
- `handoff/person-b.json` validates.

### Integration gate — C

- C can swap fake and production A adapters without editing B core.
- Fixture live flow produces verified receipt and proof viewer.
- Negative candidates visibly reject/inconclusive with correct exit codes.
- GitHub publication requires exact digest and produces a draft, test-only PR on a fork.
- Pack/install smoke succeeds from a clean directory.
- CI green; license scan and secret scan clean.
- README commands were executed verbatim.

### Release/demo gate

- Tag `v0.1.0`; immutable release tarball and checksum.
- Public GitHub repository has license, sharp README, architecture, fixture, receipt sample, CI badge, and demo PR link.
- Runloop/Reflex resources, budget, and fallback are preflighted.
- Two full rehearsals under the actual presentation account/network.
- All demo Devbox IDs have an owner and teardown plan.

## 15. Merge order and timebox

Relative schedule for a one-day build:

| Time | A | B | C |
|---|---|---|---|
| T+0:00–0:45 | Read reports/docs/contracts | Read reports/contracts | Bootstrap repo, contracts, package, branches, tag |
| T+0:45–3:30 | Runloop adapter + fake tests | Fixture, miner, ranker, patch policy | CLI skeleton, composition stubs, CI |
| T+3:30–5:30 | Reflex adapter + live smoke | Authoring loop, classifiers, adjudication, receipts | Viewer, package smoke, docs skeleton |
| T+5:30–6:30 | Runbook + handoff manifest | GitHub publisher + real-repo spec + handoff | Review manifests/contracts |
| T+6:30 | stop feature work | stop feature work | merge B with `--no-ff` |
| T+6:45 | available for owned fixes | available for owned fixes | merge A with `--no-ff` |
| T+7:00–8:30 | fix A-owned integration defects | fix B-owned integration defects | wire production composition; fixture/live E2E |
| T+8:30–9:30 | resource teardown check | PR/receipt review | pack/release/README/security/CI |
| T+9:30+ | rehearsal | rehearsal | two rehearsals; no new features |

Merge B first because it supplies the core and fixture C can exercise with fakes. Merge A second because adapters depend only on frozen contracts. Then C adds composition commits. Preserve A/B merge commits; do not squash away the parallel ownership story before judging.

## 16. Handoff manifest

Each lane writes its own JSON file matching:

```json
{
  "schemaVersion": "antibody.handoff/v1",
  "owner": "person-a",
  "branch": "team/person-a-runloop-reflex",
  "baseCommit": "40-char-sha",
  "headCommit": "40-char-sha",
  "ownedPaths": ["src/adapters/runloop/**"],
  "commits": [{"sha": "40-char-sha", "subject": "feat: ..."}],
  "contractsConsumed": ["antibody.verification-request/v1"],
  "commandsRun": ["pnpm vitest run test/adapters/runloop"],
  "testResults": [{"name": "unit", "passed": true, "details": "..."}],
  "liveChecks": [{"name": "paired fixture", "status": "passed", "artifact": "redacted/path"}],
  "requiredEnvironmentNames": ["RUNLOOP_API_KEY"],
  "knownIssues": [],
  "integrationInstructions": ["..."],
  "contractChangeRequests": []
}
```

Never include credential values, private URLs with embedded tokens, or raw live logs.

## 17. Copy-paste prompt for Person A

Paste the following into a separate Codex session configured to **gpt-5.6-sol, xhigh**. Give that session GitHub access and only branch `team/person-a-runloop-reflex`.

```text
You are Person A for the Antibody hackathon project. Work only on the complete Runloop + Reflex infrastructure lane.

MODEL/SESSION REQUIREMENT
- This session must run gpt-5.6-sol at xhigh reasoning.
- Repository: https://github.com/psagar29/Antibody
- Your only branch: team/person-a-runloop-reflex
- Expected base tag: contracts-v1.0.0
- Do not commit, merge, push, or open a PR from any other branch.

OUTCOME
Implement the production Runloop execution adapter and Reflex agent-session adapter behind the frozen contracts. Return raw execution evidence and raw bounded agent final text. Do not implement Antibody domain judgments.

FIRST: INSPECT, DO NOT EDIT
1. Confirm pwd, git remote -v, git status --short --branch, and git rev-parse HEAD.
2. Fetch origin and tags. Switch to team/person-a-runloop-reflex. Verify its merge-base is contracts-v1.0.0. If not, stop and report exact SHAs.
3. Read AGENTS.md, README.md, package.json, tsconfig.json, all of src/contracts/**, all JSON Schemas, docs/architecture.md, and research links referenced by the README.
4. Run corepack enable, pnpm install --frozen-lockfile, pnpm typecheck, and the contract tests before editing.
5. Inspect the installed @runloop/api-client and @runloop/reflex-client generated types. Inspect the official Runloop OpenAPI/docs and Reflex public OpenAPI/SDK repository for every operation you plan to call. Do not infer method names, request shapes, response fields, Persona operations, file operations, or lifecycle states.
6. Write a short implementation checklist in your first commentary update, including exact official operations/types found and any gap. Then code.

PATH OWNERSHIP
You may edit only:
- src/adapters/runloop/**
- src/adapters/reflex/**
- test/adapters/runloop/**
- test/adapters/reflex/**
- docs/runloop-reflex.md
- handoff/person-a.json

Do not edit package.json, pnpm-lock.yaml, root config, src/contracts/**, schemas/**, src/core/**, src/adapters/git/**, src/adapters/github/**, src/cli/**, src/composition/**, src/viewer/**, fixtures/**, README.md, LICENSE, CI, or Person B's handoff. If a dependency or contract is missing, do not work around it with casts or duplicate types. Write handoff/contract-change-person-a.md and notify Person C.

STRICT ROLE SEAM
- Implement AgentSessionPort with Reflex.
- Implement VerificationExecutionPort with Runloop.
- Person B owns prompts, Codex output parsing, retries/repair policy, failure taxonomy/classification, verdicts, receipts, test-only policy, and GitHub publication.
- Your Runloop adapter must not return verified/rejected or classify a failure. It returns RawVerificationEvidenceV1 only.
- Your Reflex adapter must not construct the regression-test prompt or parse the patch. It transports Person B's prompt and returns bounded finalText plus actual provenance.
- Do not import B-owned modules. Import frozen contracts only.

RUNLOOP IMPLEMENTATION
1. Add a private RunloopControl interface around the exact generated SDK calls so tests can use a fake; do not expose this through the external contract.
2. Validate VerificationRequestV1 at entry.
3. Resolve the requested Blueprint/Snapshot and Network Policy through documented calls. Preserve only response fields that actually exist.
4. Provision no more than request.environment.maxParallel Devboxes from an identical environment source.
5. Clone/mount the GitHub repository using documented mechanisms. Checkout each full SHA and verify it with git rev-parse.
6. Transfer the base64-decoded patch as a file through a documented SDK file/object mechanism. Never interpolate patch bytes into a command. Verify patch SHA-256 inside and outside the Devbox.
7. Execute argv-based setup/baseline/candidate/full-suite plans with explicit cwd/env/timeouts. Implement one reviewed POSIX argv renderer if the SDK requires a command string.
8. Baseline parent/fix before applying the patch; apply and verify changed paths; repeat targeted parent/fix tests; then current-head targeted/full suite as requested.
9. Treat Runloop's documented optimistic wait (maximum 25 seconds) as polling only, never command termination. Enforce an in-box timeout plus controller deadline and inspect output-truncation flags. Truncated/missing evidence stays raw and cannot support a verdict.
10. Capture full artifact hashes, bounded content, exit/termination/timing, execution/Devbox IDs, resolved environment metadata, and a canonical resolved Network Policy hash when retrievable. Do not convert absent cost into zero.
11. Persist raw evidence before cleanup. Shutdown every created Devbox in finally; bound shutdown wait and record cleanup success/failure.
12. Respect official constraints: Linux, fresh shell per exec, create-time mounts, explicit Network Policy, finite log retention, and continuing storage cost.

REFLEX IMPLEMENTATION
1. Add a private ReflexControl interface wrapping exact public SDK/OpenAPI operations.
2. New invocation uses documented `POST /api/agent-personas/{id}/launch` with explicit `promptStrategy` and handles asynchronous `201`; continuation sends a message to the existing opaque session using an operation present in the public OpenAPI.
3. Watch/subscribe with heartbeat, reconnect/backoff, replay dedupe, terminal-state handling, timeout, and AbortSignal.
4. Return raw bounded final agent text and only provenance fields the public contract exposes.
5. stop() is idempotent and uses the documented interrupt/stop operation.
6. Do not create a custom plugin. Do not fabricate a create-PR automation action. Persona settings are convenience defaults, not enforcement.
7. Do not fabricate Persona/Automation CRUD. The inspected public surface can list/get/launch Personas but does not expose Persona create/update or Automation CRUD; document those UI steps exactly.
8. Keep the critical-path controller outside the Reflex agent: C's CLI calls both ports. Public docs do not promise nested Runloop credentials inside a Reflex session. Spike restricted secret injection only as optional evidence; do not make the demo depend on it unless live-proven.
9. Document exact setup and live-tested steps in docs/runloop-reflex.md. Clearly label UI-only steps and anything not tested.

SECURITY/QUALITY
- No secret values in logs, fixtures, snapshots, prompts, errors, handoff, or commits.
- Central redaction and output byte limits.
- No shell interpolation of repo paths, patches, issue text, or tokens.
- Validate clone/checkout results and artifact digests.
- Bounded retries only for idempotent vendor reads/provisioning.
- Cleanup tests for every failure stage.
- No any, no @ts-ignore, no unchecked type assertions. Narrow unknown vendor errors.

TESTS
- Exhaustive argv quoting/metacharacter tests.
- Runloop happy path plus failure at resolve/create/clone/setup/baseline/apply/candidate/artifact/head/cleanup.
- Parallel cap, repetitions, exact ordering, abort, timeout, missing fields, artifact truncation/hash, and cleanup idempotency.
- Reflex new/continue, replay dedupe, reconnect, terminal states, timeout/abort, bounded text, redaction, and stop idempotency.
- Contract tests must validate returned objects with frozen Zod schemas.
- Live tests are opt-in and budget-bounded. Record redacted artifact paths and clean resources. Never make normal CI require live secrets.

COMMITS
Commit incrementally after green focused tests. Suggested sequence:
1. test: add Runloop adapter contract fixtures
2. feat: implement paired Runloop raw evidence executor
3. test: cover Runloop lifecycle and failure cleanup
4. test: add Reflex session contract fixtures
5. feat: implement Reflex agent session transport
6. docs: add Runloop and Reflex setup runbook
7. chore: add Person A handoff manifest

Before each commit: git diff --check; focused tests; typecheck for owned code. Never include unrelated generated or user files. Push only team/person-a-runloop-reflex.

DONE GATE
1. Run all A-focused tests, full pnpm typecheck, pnpm lint, and pnpm build.
2. Verify git diff contracts-v1.0.0...HEAD contains only owned paths.
3. Validate handoff/person-a.json against handoff-v1.schema.json.
4. Include exact base/head SHAs, commits, commands, test results, environment-variable NAMES only, live check status, cleanup evidence, known issues, and integration instructions.
5. If live access was unavailable, say exactly what was not verified. Do not simulate a live pass.
6. Push the branch and return a concise handoff; do not merge.
```

## 18. Copy-paste prompt for Person B

Paste the following into a separate Codex session configured to **gpt-5.6-sol, xhigh**. Give that session GitHub access and only branch `team/person-b-core`.

```text
You are Person B for the Antibody hackathon project. Work only on the complete Antibody intelligence/domain lane.

MODEL/SESSION REQUIREMENT
- This session must run gpt-5.6-sol at xhigh reasoning.
- Repository: https://github.com/psagar29/Antibody
- Your only branch: team/person-b-core
- Expected base tag: contracts-v1.0.0
- Ignore obsolete branch team/person-b-core-tenor. Do not delete or modify it.
- Do not commit, merge, push, or open a PR from any other branch.

OUTCOME
Implement history mining, missing-test ranking, Codex authoring/repair, patch policy, failure taxonomy/classifiers, causal adjudication, canonical receipts, GitHub draft publication, deterministic demo fixture, and the real p-timeout demo specification. Use the frozen AgentSessionPort and VerificationExecutionPort; do not implement or import Runloop/Reflex SDKs.

FIRST: INSPECT, DO NOT EDIT
1. Confirm pwd, git remote -v, git status --short --branch, and git rev-parse HEAD.
2. Fetch origin and tags. Switch to team/person-b-core. Verify its merge-base is contracts-v1.0.0. If not, stop and report exact SHAs.
3. Read AGENTS.md, README.md, package.json, all of src/contracts/**, every JSON Schema, docs/architecture.md, and both research reports linked by the README.
4. Inspect official GitHub REST docs and @octokit/rest types for every publisher call. Inspect p-timeout commit ed58372c62d3dddfe6f58de37558fb132e1a4e9b, parent f9ced5e18ad81eab24a9a8d0f07bf3002f7bea64, issue #45, package/test layout, and MIT license.
5. Run corepack enable, pnpm install --frozen-lockfile, pnpm typecheck, and contract tests before editing.
6. Write a short implementation checklist in your first commentary update, including candidate invariants and the truth table. Then code.

PATH OWNERSHIP
You may edit only:
- src/core/**
- src/adapters/git/**
- src/adapters/github/**
- test/core/**
- test/adapters/git/**
- test/adapters/github/**
- fixtures/demo-history/**
- scripts/build-demo-fixture.ts
- docs/domain-model.md
- docs/real-repo-p-timeout.md
- handoff/person-b.json

Do not edit package.json, pnpm-lock.yaml, root config, src/contracts/**, schemas/**, src/adapters/runloop/**, src/adapters/reflex/**, src/cli/**, src/composition/**, src/viewer/**, README.md, LICENSE, CI, or Person A's handoff. If a dependency or contract is missing, do not duplicate types or weaken validation. Write handoff/contract-change-person-b.md and notify Person C.

ABSOLUTE SCOPE EXCLUSION
- No Tenor or Slack implementation.
- No Tenor/Slack adapter, port, interface, stub, mock, schema, environment variable, package, webhook, setup flow, or fake demo.
- Tenor has no public developer contract. Person C may mention it in sponsor documentation only.

STRICT ROLE SEAM
- Build Codex prompt/context/retry/repair logic against AgentSessionPort.
- Build causal recovery against VerificationExecutionPort.
- Person A owns Reflex transport and raw Runloop execution only.
- Your code classifies raw observations and decides verdicts.
- No @runloop/api-client or @runloop/reflex-client import anywhere in your owned paths.

IMPLEMENTATION ORDER
1. Deterministic git fixture via fast-import, with fixed identities/timestamps and expected SHAs.
2. Git miner: one-parent commits, production changes, zero test/support changes, safe paths/modes, size limits, deterministic digest.
3. Ranker: exact frozen weights/tie-breaks from the plan; optional GitHub issue/PR enrichment is cached and cannot make Git truth nondeterministic.
4. Patch parser/test-only policy: binary/mode/path/rename/delete/size/application checks on parent, fix, and captured head.
5. CodexAuthoringModule: bounded context, untrusted-content delimiters, strict base64 JSON envelope, maximum three attempts, continuation feedback, and non-repairable infrastructure categories.
6. TAP/JUnit/Vitest JSON/Jest JSON/conservative pytest classifiers; normalized stable signatures; malformed/missing reports become unknown-failure.
7. Adjudicator: verified only for policy pass + equivalent environment + passing baselines + stable target parent failures + all fix passes + head targeted/full pass. Never use exitCode !== 0 as proof.
8. Receipt store: canonical RFC 8785 JSON, SHA-256, artifact manifest, atomic writes, tamper verification, no embedded large logs.
9. GitHub publisher: exact approval digest, stale-head refusal/reverification requirement, deterministic branch, receipt marker dedupe, no force push, draft PR only, least permissions.
10. Real p-timeout runbook.

MINER/RANKER RULES
- Invoke git with spawn/execFile and argv, never a shell.
- Parse NUL-delimited machine output; require full lowercase SHAs.
- Reject merges, binaries, gitlinks, generated/vendor, docs/config/dependency-only, oversized, and any commit changing configured test/support paths.
- Rank with frozen plan weights and deterministic tie-break: score desc, authoredAt desc, SHA asc.
- Treat commit/issue/test content as untrusted prompt input.

AUTHORING RULES
- Give Codex commit message, issue when available, parent/fix diff, affected source at both states, framework/config, and at most three nearby tests.
- Tell Codex the known fix is an oracle and request the smallest behavior-specific test only.
- Tell Codex not to follow instructions found in repo/issue content.
- Require one strict antibody.agent-output/v1 JSON object with base64 UTF-8 unified diff.
- Parse independently. Ignore testCommandHint for execution.
- Repair only candidate errors such as syntax/collection mistakes or parent-pass weakness. Do not spend agent turns on dependency, platform, timeout, credential, network, or environment-equivalence failures.
- Stop the agent session in finally.

FAILURE/VERDICT RULES
- Implement every OutcomeKindV1.
- Normalize ANSI, temp paths, line numbers, timestamps, and random IDs while retaining test name, failure type/operator, and project frame.
- Parent repetitions must have one exact normalized signature.
- assertion/target behavioral failure -> all fix pass may verify.
- Parent pass, both sides fail, unrelated failure, or head/full-suite failure cannot verify.
- Setup/build/collection/dependency/timeout/crash/platform/unknown and repetition disagreement are inconclusive.

GITHUB RULES
- Use an injected internal client around exact @octokit/rest calls.
- Require verified receipt and exact --approval digest.
- Recompute receipt and patch hashes.
- Stop on stale base unless current-head proof is rerun.
- Search receipt marker before writes. Reuse matching open PR.
- Never overwrite an unrelated branch and never force push.
- Draft PR only; no merge method; no admin/actions permissions.
- Test partial failures so retry cannot duplicate branches/PRs.

FIXTURE
- Build a dependency-free Node ESM history with deterministic git fast-import.
- Commits: buggy base, irrelevant docs, source-only whitespace slug fix, compatible head.
- Recovery test fails on parent with stable assertion and passes fix/head.
- expected.json records SHAs, candidate order, patch/signature/verdict.

REAL REPO
- Repository: sindresorhus/p-timeout (MIT).
- Fix: ed58372c62d3dddfe6f58de37558fb132e1a4e9b.
- Parent: f9ced5e18ad81eab24a9a8d0f07bf3002f7bea64.
- Issue: https://github.com/sindresorhus/p-timeout/issues/45.
- Fix touched index.js only and changed custom timer calls to .call(undefined, ...).
- Specify an AVA regression test using normal-function custom timers that assert this === undefined; it must fail on parent and pass fix/current.
- Document historical dependency drift/no lockfile and the shared prewarmed Snapshot strategy.

SECURITY/QUALITY
- No shell strings, arbitrary clone hosts, traversal paths, binary patches, secrets, token values, or unbounded outputs.
- No any, no @ts-ignore, no unchecked assertions.
- Strict Zod validation at external and persisted-data edges.
- Atomic file writes and canonical digest golden tests.
- HTML/CLI rendering belongs to C; return data, not presentation strings except safe PR Markdown builder tests.

TESTS
- Golden commit shapes and ranking determinism.
- Full patch policy attack matrix.
- Malformed agent envelopes, prompt injection, attempt budget, repair/no-repair categories.
- Exhaustive classifier fixtures and adjudication truth table.
- Receipt canonicalization/tamper and atomic failure tests.
- Publisher approval/stale head/dedupe/conflict/partial failure/draft invariant tests.
- End-to-end core with fake AgentSessionPort and VerificationExecutionPort.
- No ordinary test uses network or live credentials.

COMMITS
Commit incrementally after green focused tests. Suggested sequence:
1. test: add deterministic missing-test history fixture
2. feat: implement history miner and candidate ranker
3. feat: enforce test-only patch policy
4. feat: add bounded Codex authoring loop
5. feat: classify and adjudicate causal evidence
6. feat: build canonical receipts and tamper verification
7. feat: add idempotent GitHub draft publisher
8. docs: specify domain and p-timeout demo
9. chore: add Person B handoff manifest

Before each commit: git diff --check; focused tests; typecheck. Never include unrelated generated or user files. Push only team/person-b-core.

DONE GATE
1. Run all B-focused tests, full pnpm typecheck, pnpm lint, and pnpm build.
2. Verify git diff contracts-v1.0.0...HEAD contains only owned paths.
3. Prove no Runloop/Reflex SDK imports or vendor-specific transport logic exists in B-owned code. Prove no Tenor/Slack implementation identifier exists at all; neutral provider provenance from frozen contracts may be passed through unchanged.
4. Validate handoff/person-b.json against handoff-v1.schema.json.
5. Include exact base/head SHAs, commits, commands, results, known issues, and C integration instructions. No secret values.
6. Push the branch and return a concise handoff; do not merge.
```

## 19. Person C integration checklist

- [ ] Create/bootstrap `main`; freeze schemas/ports/errors; tag `contracts-v1.0.0`; branch A/B/C from it.
- [ ] Confirm `team/person-b-core` is used and obsolete `team/person-b-core-tenor` is absent from merge ancestry.
- [ ] Predeclare exact dependencies; A/B never alter root manifests/lock.
- [ ] Validate both handoff manifests and path ownership before merging.
- [ ] Merge B `--no-ff`; run its tests with fake ports.
- [ ] Merge A `--no-ff`; run its tests; check no domain logic leaked into adapters.
- [ ] Wire composition only in `src/composition/**`; avoid edits inside A/B directories.
- [ ] Implement CLI/exit/stdout contracts and self-contained escaped proof viewer.
- [ ] Regenerate schemas; require zero diff; run typecheck/lint/full tests.
- [ ] Run fixture fake flow, fixture live Runloop/Reflex flow, and negative rejection cases.
- [ ] Run real `p-timeout` twice; save redacted receipt; verify all Devboxes stopped.
- [ ] Publish only to a writable fork, draft only, with exact receipt approval digest.
- [ ] Run clean `npm pack` + global install smoke.
- [ ] Finish security/docs/license/third-party scan; remove every secret/canary.
- [ ] Tag/release; verify GitHub tarball/checksum and npm path if available.
- [ ] Rehearse primary and fallback demo twice. Freeze features.

## 20. Day-of-demo sequence

Target: six minutes; every screen earns its place.

1. **0:00–0:35 — Problem and novelty.** Open the real `p-timeout` fix. Show `index.js` changed, tests did not. Say “Antibody recovers tests omitted from merged fixes”; do not claim first bug-to-test system.
2. **0:35–1:05 — Operator start.** In Reflex, launch/trigger the `Regression Archaeologist` Persona. Show candidate SHA, bounded responsibility, and budget.
3. **1:05–1:50 — Intelligence.** Show Antibody ranking the source-only fix and Codex returning a test-only patch. Briefly show policy rejecting production edits.
4. **1:50–2:50 — Runloop proof.** Show paired Devboxes from the same Snapshot/Blueprint. Exact patch hash appears in both. Parent fails with the target stable signature twice; fix passes twice.
5. **2:50–3:25 — Current safety.** Show the same patch passing captured current head and full suite.
6. **3:25–4:05 — Evidence.** Open static proof viewer: immutable SHAs, environment inputs, commands, attempts, hashes, costs when available, and cleanup status. State the limits plainly.
7. **4:05–4:40 — Human gate.** Show Reflex Inbox/operator approval. Copy exact receipt digest into `antibody publish`.
8. **4:40–5:20 — GitHub result.** Open draft PR on the fork. Show tests only, receipt marker/link, no production changes, and no merge action.
9. **5:20–5:45 — Rejection credibility.** Flip to a prebuilt malformed/pass-pass candidate receipt and show Antibody refusing it. Rejection is part of the product.
10. **5:45–6:00 — Close.** “Runloop makes the historical claim reproducible; Reflex makes it operable; Antibody decides what counts.” End on the public GitHub link.

Before going on stage: run `antibody doctor`; confirm Reflex session, Snapshot/Blueprint, Network Policy, fork token, current head, artifact directory, browser tabs, and all prior Devboxes stopped. Have the deterministic fixture and a pre-recorded real receipt open, but label recorded evidence honestly if used.

## 21. README: now versus later

### Put in README before judging

1. Sharp subtitle and three-step causal predicate.
2. Alpha/status warning and exact limitations.
3. A 60-second fixture quickstart that was executed verbatim.
4. Install instructions that actually exist: source, release tarball, and npm only after publish.
5. Minimal `.antibody.yml` and required environment-variable **names**.
6. CLI command table and exit-code behavior.
7. Small architecture diagram showing B core -> frozen ports -> A adapters -> C CLI, with GitHub publication separate.
8. Screenshot/sample proof receipt and real draft PR link.
9. Security warning: untrusted repo code executes remotely; credentials/scopes; draft-only publication.
10. Honest sponsor use: Runloop execution, Reflex operations; Tenor organizer only/no public integration.
11. Prior art and claim boundary: Repro-Bot, PatchProof, TDD-Bench-Verified, Cleverest, jitgen.
12. Supported/tested reporter formats and Linux limitation.
13. License, contribution, security-reporting, and CI badges.

### Defer until after hackathon

- Hosted dashboard, database, queue, GitHub App service, multi-tenant auth, and automatic merges.
- Language/framework claims beyond exercised reporters.
- Benchmarks, precision/recall, cost/yield claims without a real corpus.
- Receipt signing/attestation, SLSA level claims, or cryptographic Axon claims.
- Tenor integration of any kind until Tenor publishes or supplies a supported developer contract.
- Slack integration, spend-allocation UI, custom Reflex plugin, and Runloop custom Benchmark entitlement.
- Broad automated scanning schedules, organization-wide rollout, or “production-ready” label.
- Marketing claims such as “first,” “formal proof,” “flake-free,” or “perfect historical reproduction.”

## 22. OSS license and attribution

Use Apache-2.0 for Antibody, subject to repository owner's explicit approval. It provides a clear patent grant for an infrastructure tool. Add SPDX package metadata, `LICENSE`, a minimal `NOTICE`, and `THIRD_PARTY_NOTICES.md`.

Implementation policy:

- Write original code from documented behavior and contracts.
- Do not copy Repro-Bot or LIBRO source; no license was detected.
- Do not copy AGPL Qodo Cover source unless the whole project deliberately accepts AGPL obligations; this plan does not.
- PatchProof (Apache-2.0), TDD-Bench-Verified (Apache-2.0), Cleverest (MIT), jitgen (MIT), Runloop SDKs (MIT), Reflex SDK mirror (MIT), and `p-timeout` (MIT) may be studied. If code is copied or adapted, preserve required copyright/license notices and record exact files/commits. Prefer clean original implementation.
- README “Prior art” is scholarly/product honesty even when legal attribution is not required.
- CI emits production dependency license inventory. Fail unknown, unlicensed, copyleft-incompatible, or prohibited licenses pending human review.
- Fixture code is original and Apache-2.0. The real-repo test PR follows upstream's MIT contribution context; Antibody does not redistribute the upstream repository.

## 23. Final cut line

If time collapses, preserve this order:

1. Frozen contracts and deterministic fixture.
2. B's miner -> author -> policy -> classifier -> receipt loop with fakes.
3. A's paired Runloop execution.
4. A's Reflex live session.
5. C's CLI/proof viewer/package smoke.
6. B's GitHub draft publisher.
7. Real `p-timeout` rehearsal.

Cut custom reporters, extra candidate heuristics, full-suite optimization, storage mirroring, fancy UI, and scheduled automation before weakening the test-only causal gate. A smaller honest proof beats sponsor-shaped vaporware. Computers have suffered enough of that.
