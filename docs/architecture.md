# Architecture

Antibody recovers regression tests missing from already-merged fixes and admits them only after causal verification against immutable Git states. It separates raw observation from domain judgment, then separates proof from publication.

## System shape

```text
                      src/contracts
             schemas + ports + errors (v1)
                       /         \
                      /           \
     src/adapters                    src/core
 Git / Runloop / Reflex / GitHub     mining + ranking
 raw I/O + provenance                authoring + patch policy
 provider error normalization        classification + adjudication
                                      receipts + recovery
                      \           /
                       \         /
                    src/composition
       config + credentials + concrete wiring + persistence
                            |
                 CLI + dashboard + viewer
                    presentation only
```

This is a responsibility map, not a claim of perfectly one-way imports. Two intentional implementation edges exist today:

- Core mining and patch-applicability modules default to the Git command adapter.
- The GitHub publication adapter reuses core receipt-digest and patch-materialization helpers so the outbound mutation is checked against the same canonical proof.

Composition remains the only place Runloop and Reflex concrete adapters meet the recovery coordinator.

## Module ownership

### Contracts: shared interface and compatibility seam

`src/contracts/` owns strict Zod schemas, inferred public types, `AgentSessionPort`, `VerificationExecutionPort`, and the `AntibodyError` taxonomy. Contract payloads contain no vendor SDK types. Repository paths are slash-normalized and traversal-safe; Git identities are full lowercase SHAs; commands are argv arrays; text, artifact, timeout, and concurrency fields are bounded.

`CONTRACT_VERSION` is `1.0.0`, while persisted shapes use explicit identifiers such as `antibody.receipt/v1`. The JSON files in `schemas/` are generated projections, not an independent source of truth.

### Adapters: transport and raw observations

`src/adapters/git/` executes bounded Git argv without a shell. The history miner and patch applicability checker use this seam.

`src/adapters/reflex/` launches or resumes a Persona session, follows bounded event/history state, returns raw final text plus provider provenance, supports cancellation, and maps provider failures into structured Antibody errors. It does not parse a candidate into truth or decide whether the test proves the fix.

`src/adapters/runloop/` provisions isolated Devboxes from a configured snapshot or blueprint, checks out exact commits, applies the candidate patch, executes setup/baseline/candidate/full-suite phases, captures bounded raw artifacts and provider metadata, compares environment identity, and records cleanup. It does not classify test output or issue a verdict.

`src/adapters/github/` is the sole remote publication mutation. It re-verifies receipt, approval, patch, base SHA, changed paths, branch, commit, and draft state immediately before mutation. Idempotency is tied to the receipt marker and deterministic branch. It never merges or force-pushes.

### Core: domain judgment

`src/core/mining/` finds bounded production-only fix candidates from Git history. `ranking/` assigns deterministic candidate priority.

`authoring/` builds bounded prompts and parses strict agent output. It can retry a rejected candidate with categorical feedback, but caps attempts and prompt/output bytes.

`policy/` normalizes and inspects unified diffs. It enforces configured test/support paths, executable-test presence, file/line/byte limits, safe modes and paths, forbidden operations, and applicability to parent, fix, and head.

`classification/` interprets runner-specific evidence into domain outcomes and stable failure signatures. `adjudication/` applies the causal gate; adapters cannot override it.

`receipts/` canonicalizes, redacts, hashes, persists, and verifies proof material. `recover.ts` coordinates authoring, policy review, remote execution, classification, adjudication, and receipt construction.

### Composition: wiring and lifecycle

`src/composition/config.ts` owns `.antibody.yml` creation and parsing. `local.ts` implements non-live diagnostics, repository identity, and scanning. `live.ts` resolves environment references and credentials, collects bounded authoring context from immutable revisions, wires Reflex and Runloop, hydrates spooled artifacts, persists a receipt, re-verifies it, and cleans its local spool. `offline-demo.ts` wires deterministic local fakes to the checked-in simulated fixture.

### Presentation

`src/cli/` parses commands, delegates to composition, formats output, and maps structured errors to exit codes. `src/dashboard/` discovers and verifies receipt directories before building a read-only dashboard model. `src/viewer/` renders a verified receipt as self-contained HTML. These modules may select representation; they must not reinterpret causal evidence.

## Recovery data flow

```text
Git history
  -> RecoveryCandidateV1
  -> bounded parent/fix context
  -> AgentInvocationV1
  -> raw Reflex finalText
  -> strict AgentOutputV1 + normalized patch
  -> test-only policy + applicability at P/F/H
  -> VerificationRequestV1
  -> raw Runloop attempts/artifacts/provenance/cleanup
  -> runner-specific classifications
  -> adjudication verdict + reason codes
  -> canonical ReceiptV1 + detached artifacts
  -> persisted directory, then immediate integrity verification
```

External and persisted data is parsed at the seam. A receipt directory contains the canonical receipt and digest plus the material needed to reproduce its integrity checks: candidate, patch, raw evidence, classifications, artifact manifest, and hydrated artifacts. Raw provider output is redacted before durable persistence.

## Causal gate

For test patch `T`, fix `F`, its parent `P`, and captured current head `H`:

```text
P baseline       -> pass
F baseline       -> pass
P + T            -> repeated stable intended failure
F + T            -> pass for every configured repetition
H + T            -> targeted pass
H + T full suite -> pass when configured
T                -> approved test/support paths only
```

Setup must pass on all provisioned lanes. Request, candidate, patch, and evidence identities must match. Environments must be equivalent across lanes. All Devboxes must have requested and completed cleanup.

`rejected` means sufficient evidence contradicts the candidate or policy. `inconclusive` means proof is insufficient or infrastructure/environment integrity failed. Those results are not interchangeable. Setup, collection, dependency, build, timeout, crash, platform, malformed-report, unrelated-test, missing repetition, unstable-signature, and incomplete-cleanup evidence cannot become `verified`. Exit status is only one input to classification.

## Receipt integrity and compatibility

Canonical JSON makes receipt hashing deterministic. The receipt binds candidate identity, patch digest and paths, policy decision, environment comparison, classified attempts, raw-evidence digest, artifact metadata, cleanup, cost metadata, verdict, reasons, and creation time. Artifact content lives outside the receipt but is checked by digest and size.

Hashes provide mutation detection, not signatures, remote attestation, or proof that a provider behaved honestly. Compatibility depends on both the `schemaVersion` literal and canonicalization. Renaming a field, changing omission/null behavior, reordering arrays, changing redaction, or altering classification output can change a receipt digest even when TypeScript still compiles. Treat such work as a contract change.

## Publication flow

```text
verified receipt directory
  -> verify every persisted digest and identity
  -> require exact human-approved receipt digest
  -> require approved patch bytes and path set
  -> require GitHub base branch still equals captured head SHA
  -> create/reuse deterministic test-only commit
  -> create/reuse draft pull request with receipt marker
  -> write separate publication.json
```

Publication is intentionally later than proof. GitHub state is mutable; the receipt is not. `publication.json` records the result without entering the proof digest. Any conflicting branch, commit, base, path, marker, or draft state fails closed.

## Trust and process boundaries

Untrusted inputs include target repository content, Git history and metadata, issue text, generated patches, model output, provider events, command output, reports, artifacts, and persisted receipt directories. Credentials are resolved in composition, passed only to the relevant adapter, and included in literal-value redaction. The local dashboard defaults to loopback and must remain read-only.

All child processes use an executable plus argv and `shell: false`. Live test execution belongs in isolated Runloop Devboxes, not the operator machine. Network policy, environment source, architecture/shape provenance, output bounds, timeouts, concurrency, and cleanup are proof-relevant facts.

Tenor and Slack are outside the system. No package, port, adapter, schema, environment variable, fake, mock, or runtime claim exists for either.

## Validation surfaces

- Contract fixtures prove adapter outputs conform to frozen schemas without requiring live providers.
- Core tests prove policy, parsing, classification, adjudication, receipt integrity, and recovery behavior.
- Integration tests prove configuration, composition, artifact hydration, CLI-facing workflows, and presentation using controlled doubles.
- The offline fixture proves deterministic end-to-end packaging and receipt verification locally. It is explicitly simulated.
- Live vendor validation is separate, credentialed, billable, and human-authorized. Repository tests do not claim it has run.

Contributor routing and the verification matrix live in [the AI contributor guide](ai-contributor-guide.md).
