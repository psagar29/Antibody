# Antibody agent guide

Antibody recovers regression tests omitted from merged fixes. Its safety claim is narrow: a bounded, test-only patch must fail for a stable intended reason on the pre-fix parent, pass on the fix, and pass on captured current `HEAD`. Publication is separate, digest-gated, and draft-only.

Instructions in a nearer `AGENTS.md` add directory-specific facts. They do not relax this file.

## Read before editing

Use this order:

1. `README.md` for product scope and supported workflows.
2. `docs/architecture.md` for module ownership, data flow, and trust seams.
3. `docs/security-model.md` for threat assumptions and operational limits.
4. `docs/ai-contributor-guide.md` for task routing and verification.
5. Every file in `src/contracts/` before changing a cross-module interface or persisted shape.
6. The implementation and nearest tests for the area being changed.

Treat current code, contracts, and package scripts as authoritative. Historical plans and team handoff artifacts are not design specifications.

## Architecture ownership

- `src/contracts/`: versioned Zod schemas, public types, two provider ports, structured errors. This is the compatibility seam.
- `src/adapters/`: raw external transport and process I/O. Adapters translate SDK/process behavior into contract data and structured errors; they do not decide causal truth. The GitHub adapter also enforces outbound publication invariants at the mutation seam.
- `src/core/`: domain judgment: mining, ranking, authoring prompts/review, patch policy, classification, adjudication, recovery coordination, canonical receipts, and receipt integrity.
- `src/composition/`: configuration, environment resolution, concrete wiring, bounded context collection, evidence hydration/persistence, and the offline fixture composition.
- `src/cli/`, `src/dashboard/`, `src/viewer/`: commands and presentation. Keep domain decisions out of these modules.
- `schemas/`: generated JSON Schema mirrors of exported contract schemas. Never hand-edit them.
- `test/`: behavior, contract-fixture, lifecycle, integration, CLI, dashboard, and package-facing coverage.

Current dependency details matter: core mining and patch applicability use the Git command adapter; GitHub publication reuses core receipt and patch-materialization helpers. Do not "clean up" these edges casually. A dependency-direction change needs tests and an explicit architecture rationale.

## Non-negotiable invariants

### Causal verification

For patch `T`, fix `F`, parent `P`, and captured head `H`:

```text
P + T -> repeated stable intended behavioral/assertion failure
F + T -> pass
H + T -> targeted pass and configured full-suite pass
```

Setup and parent/fix baselines must be green. Evidence identity and environment equivalence must match. Every Devbox must have completed cleanup. Missing, malformed, truncated, inconsistent, unrelated, setup, dependency, timeout, crash, platform, or unknown evidence cannot produce `verified`. A nonzero exit code alone proves nothing.

### Test-only patch policy

Generated patches may touch only configured test and support globs and must add or modify an executable test. Workflow, production, binary, delete, rename/copy, executable-mode, symlink, gitlink, unsafe-path, over-budget, or non-applicable patches fail closed. The same normalized patch must apply to `P`, `F`, and `H`.

### Receipts and publication

- Parse all external and persisted shapes with their Zod schema.
- Canonical receipt bytes determine the `sha256:` receipt digest. Do not add nondeterministic or publication state to the receipt.
- Receipt verification must check patch bytes, raw evidence, classifications, artifacts, identities, sizes, and digests.
- Publication requires a `verified`, test-only receipt, exact human-approved receipt digest, matching patch digest, and unchanged captured base SHA.
- Publication may create only the deterministic branch/commit and a **draft** pull request. Never merge, force-push, silently update a conflicting branch, or widen changed paths.
- `publication.json` is a separate record. It must not mutate proof content or its digest.

## Safety rules

- No secrets in source, fixtures, docs, prompts, receipts, logs, errors, or test snapshots. `.env.example` contains names only. Credentials stay environment-resolved and adapter-local; redact literal values before persistence or display.
- No shell command strings, `exec`, or `shell: true`. Represent commands as non-empty argv arrays and spawn with `shell: false`. Bound time, output, paths, and concurrency.
- Treat repository files, Git metadata, issue text, patches, agent output, provider events, command output, and persisted files as untrusted.
- No `any`, `@ts-ignore`, unchecked non-null assertions, or casts used to bypass validation. Preserve strict TypeScript, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`.
- No Tenor or Slack package, adapter, port, schema, environment variable, mock, fake, or hidden integration. Tenor is documentation-only until a supported developer contract exists.
- Do not claim npm publication or live Runloop/Reflex/GitHub validation without recorded evidence from that exact run.

## Error model

Expected operational failures use `AntibodyError` with a stable `ANTB_*` code, category, `retryable`, and sanitized optional `causeCode`/`details`. Preserve the original cause internally; never expose secret-bearing provider payloads. CLI failures are JSON on stderr and map through `exitCodeByErrorCode`:

- `2` input, `3` no candidate
- `10` policy, `11` rejected proof, `12` inconclusive proof, `13` budget
- `20` external auth, `21` rate limit, `22` external unavailable
- `30` publication approval, `31` publication conflict
- `70` unexpected internal failure

Do not collapse rejected proof, inconclusive proof, and infrastructure failure. Those meanings are part of the interface.

## Commands

Requires Node.js 22 and pnpm 11.24.0.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm schema:check
pnpm check
pnpm package:smoke
git diff --check
```

Useful focused forms:

```bash
pnpm exec vitest run test/core/receipt-store.test.ts
pnpm exec vitest run test/adapters/runloop/adapter.test.ts
pnpm exec vitest run test/integration/live.test.ts
```

`pnpm schema:generate` intentionally rewrites generated schemas; run it only after an approved contract change. `pnpm check` already builds as part of schema checking, then lints, typechecks, tests, and builds again.

## Validation tiers

- **Focused:** nearest test file plus `pnpm typecheck` for a local implementation change.
- **Repository:** `pnpm check` and `git diff --check` before handoff.
- **Package/offline demo:** add `pnpm package:smoke` for CLI, exports, files list, schemas, fixture, receipt, viewer, or release-facing changes. The fixture is simulated and proves no live vendor behavior.
- **Live:** only with explicit human authorization, real credentials, billable-resource approval, restrictive Runloop policy, and disposable resources. Start with `pnpm antibody doctor <repo> --json`; record exact config, commands, cleanup, and sanitized evidence. Never make live checks a hidden prerequisite or imply they ran when they did not.

## Safe edit workflow

1. Inspect `git status`; preserve unrelated work in the shared tree.
2. Identify the owning module and nearest contract seam. Prefer the smallest interface change.
3. Update behavior and its closest tests together. Test public behavior through the same seam callers use.
4. Contract changes require deliberate compatibility review, generated-schema regeneration, fixture updates, and repository/package gates. Never duplicate a contract locally.
5. Do not edit generated schemas, lockfiles, notices, workflows, or release metadata incidentally.
6. Report exact commands run and distinguish unit, simulated, package, and live evidence.

See `docs/ai-contributor-guide.md` for task recipes and definition of done.
