# AI contributor guide

This guide turns Antibody's safety model into concrete editing and verification rules.

## Establish ground truth

1. Read root `AGENTS.md`, [architecture](architecture.md), and [security model](security-model.md).
2. Run `git status --short`; preserve unrelated shared-tree changes.
3. Read implementation, callers, and nearest tests before editing.
4. For cross-module or persisted data, read all of `src/contracts/` and the matching generated schema.
5. State whether planned evidence is focused, repository-wide, package/offline, or live.

Current source and tests outrank comments, historical plans, generated schemas, and model memory.

## Common task routing

| Task | Primary module | Start with |
| --- | --- | --- |
| Candidate signals/ranking | `src/core/mining`, `src/core/ranking` | Git miner and ranking tests |
| Agent prompt, output, retry | `src/core/authoring`, `src/core/recover.ts` | authoring, recovery, target-inference tests |
| Patch policy | `src/core/policy` | patch-policy and Git adapter tests |
| Test-report support | contracts, classifier, config, artifact capture | contract, classification, adapter-fixture, config tests |
| Causal verdict | `src/core/adjudication` | adjudication and recovery tests |
| Receipt integrity | `src/core/receipts` | receipt, demo, integration, package smoke |
| Runloop/Reflex behavior | corresponding adapter | unit, lifecycle, contract-fixture tests |
| GitHub publication | `src/adapters/github` | publisher, receipt, CLI tests |
| Config, credentials, wiring, context | `src/composition` | matching integration and CLI tests |
| CLI/dashboard/viewer | presentation module | presentation/integration tests, package smoke |
| Exports or release-facing behavior | package/build configuration | full gate and package smoke |

Raw SDK/process facts belong in adapters; causal meaning belongs in core; dependency construction belongs in composition; formatting belongs in presentation.

## Frozen-contract caution

The v1 seam includes Zod schemas and inferred types, both provider ports, structured errors, persisted `schemaVersion` literals, canonical receipt bytes, generated JSON schemas, and contract fixtures. A change can break compatibility without a TypeScript error: optional-to-required fields, omission-to-`null`, literal changes, array reordering, redaction/canonicalization changes, reason-code changes, or reclassification can invalidate existing receipt digests.

For an intentional contract change:

1. Find every producer, consumer, fixture, persisted file, reader, and export.
2. Decide compatibility and migration before editing. Prefer additive optional fields when semantics allow; never weaken validation for a provider response.
3. Change TypeScript schema first. Never hand-edit `schemas/*.schema.json`.
4. Run `pnpm schema:generate`; inspect every generated diff and update fixtures deliberately.
5. Add round-trip and rejection tests. Verify old receipts if compatibility is promised.
6. Run `pnpm check`, `pnpm package:smoke`, and `git diff --check`.

If compatibility is unclear, stop and raise the seam change. Do not duplicate types or cast around validation.

## Adding framework support

1. Define deterministic argv, test globs, report format/path, timeouts, and full-suite behavior in config.
2. Keep commands as argv with safe relative `cwd`, literal non-secret env values, and bounded timeouts.
3. Capture authoritative structured reports where available; stdout/stderr remains raw evidence.
4. Classify target assertion/behavioral failure separately from unrelated, collection, build, dependency, timeout, crash, platform, malformed/unknown, and pass outcomes.
5. Ensure target test names can be inferred or supplied. No identifiable target means fail closed.
6. Add config, classifier, adjudication, adapter-fixture, and simulated end-to-end coverage, including malformed, truncated, missing, and contradictory evidence.
7. Follow the contract-change process for any enum or schema change.

One happy-path parser fixture is not framework support. Support includes safe failure modes, causal adjudication, configuration, and documented limits.

## Adding provider support

1. Implement `AgentSessionPort` or `VerificationExecutionPort` in `src/adapters/<provider>/` without leaking SDK types.
2. Validate requests before I/O and responses before return. Map auth, rate, timeout/budget, cancellation, unavailable, and malformed-shape failures to sanitized `AntibodyError` values.
3. Bound polling, retries, history, output, artifacts, time, concurrency, and resource lifetime.
4. Return raw evidence plus provenance for equivalence, attribution, cost, and cleanup. Ignore provider-issued causal verdicts.
5. Keep credentials adapter-local and redact literal values; never place secrets in target env, prompts, errors, fixtures, or receipts.
6. Implement cancellation and cleanup in terminal paths. Incomplete cleanup stays visible and makes proof inconclusive.
7. Wire factories only in composition; add deterministic unit, lifecycle, and contract-fixture tests.
8. Live-check only with explicit authorization and record it separately.

If the port cannot express necessary raw facts, propose a contract change; do not import the SDK into core.

## Receipt compatibility checklist

- Does unchanged logical input retain byte-identical canonical JSON?
- Are optional values omitted consistently, and digest-relevant arrays deterministic?
- Are patch, evidence, classification, artifact, size, and identity checks performed on write and read?
- Can cross-run file substitution still be detected?
- Are artifact bytes canonical, bounded, redacted, and matched to their manifest?
- Is `publication.json` excluded from the proof digest?
- Does publication recompute receipt/patch digests, require exact approval, and compare remote base SHA?
- Are old v1 receipts verifiable? If not, is there an explicit version/migration decision?
- Do viewer/dashboard changes display recorded facts without inventing stronger claims?

Hashes detect mutation; they do not prove remote execution, authorship, or global correctness.

## Verification matrix

| Change | Focused evidence | Before handoff |
| --- | --- | --- |
| Docs/metadata | link/syntax/render checks | `git diff --check` |
| Core | nearest core tests | `pnpm check`, diff check |
| Adapter | unit + lifecycle/contract fixtures | `pnpm check`, diff check |
| Contracts/schemas | contract + producer/consumer tests, schema check | `pnpm check`, package smoke, diff check |
| Composition/config | integration + CLI tests | `pnpm check`, diff check |
| Receipt/publication | receipt, recovery, publisher, CLI/integration | `pnpm check`, package smoke, diff check |
| Presentation/packaging | nearest integration tests | `pnpm check`, package smoke, diff check |
| Live provider | automated gates first; `doctor` checks readiness only | separately authorized run, sanitized evidence, confirmed cleanup |

Focused example: `pnpm exec vitest run test/core/adjudication.test.ts`. `pnpm package:smoke` packs and installs current source, checks package files/binary, runs the simulated offline fixture, and verifies its receipt. It performs no live vendor access.

## Definition of done

- Ownership is clear; domain judgment did not leak into transport or presentation.
- Untrusted input is bounded and schema-validated at its seam.
- Causal, test-only, cleanup, digest, and draft-only invariants fail closed.
- Secrets cannot enter source, target commands, prompts, durable artifacts, errors, or fixtures.
- Expected failures preserve error code/category/retryability semantics.
- Tests cover success and dangerous malformed, missing, conflicting, timeout, and partial-cleanup paths.
- Generated files changed only through their generator and only intentionally.
- Applicable gates passed with exact commands/results; simulated/package/live evidence is labeled accurately.
- No unrelated work was overwritten, reformatted, or committed.
