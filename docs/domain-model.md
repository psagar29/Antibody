# Antibody domain model

Antibody's core owns the decisions between immutable Git history and the two frozen transport ports. Runloop returns raw observations; Reflex returns raw bounded agent text. Neither provider decides whether a recovered test proves a regression.

## Candidate invariants

`GitHistoryMiner` invokes local Git with argv arrays and bounded output. It admits only one-parent commits with full lowercase SHAs, at least one configured production path, no configured test/support path, regular safe modes, no binary/rename/copy/gitlink shape, and configured file/line limits. The miner hashes the full binary diff and derives the candidate ID from repository slug, parent SHA, and fix SHA.

Ranking uses frozen weights:

| Signal | Weight |
|---|---:|
| Bug/fix word in subject | 35 |
| Cached linked bug label | 20 |
| At most 100 changed lines | 15 |
| One to three production files | 10 |
| Conditional/error/validation branch change | 10 |
| Issue reference | 5 |
| Fix reachable from captured head | 5 |

Scores are clamped to 0–100. Ties sort by score descending, author time descending, then fix SHA ascending. Optional GitHub enrichment is cached by immutable SHA; failure to enrich never changes Git truth.

## Authoring and patch admission

`CodexAuthoringModule` supplies a bounded commit/issue/diff/source/framework context to `AgentSessionPort`. Every repository-derived section has a unique untrusted-data delimiter and an explicit instruction not to follow embedded instructions. At most three nearby tests and three agent turns are allowed.

The result must be exactly one strict `antibody.agent-output/v1` JSON object. The module independently checks output bytes, candidate identity, canonical base64, UTF-8, and line endings. `testCommandHint` is informational and is never executed. Repair turns reuse only the opaque continuation, normalized category/feedback, and previous patch digest. Dependency, platform, timeout, credential, network, and environment-equivalence evidence ends repair immediately. The agent session is stopped in `finally`.

`evaluateTestPatch` structurally rejects production/workflow paths, unsafe or traversal paths, binary content, rename/copy, deletion, executable/symlink/gitlink modes, empty/support-only patches, and configured byte/file/line excess. It then runs argv-only `git apply --check` in detached temporary worktrees for parent, fix, and captured head.

## Classification and causal truth table

TAP, JUnit, Vitest JSON, Jest JSON, and conservative pytest text are parsed independently. Missing or malformed required reports become `unknown-failure`. ANSI sequences, temporary paths, line/column values, timestamps, and UUIDs are removed before signature hashing while target test name, failure kind, assertion operator, stable message, and project frame remain.

| Parent candidate repetitions | Fix repetitions | Current head | Result |
|---|---|---|---|
| Same target assertion/behavioral signature | All pass | Targeted and configured full suite pass | `verified` |
| Any pass | Any | Any | `rejected` |
| Unrelated failure | Any | Any | `rejected` |
| Stable semantic failure | Semantic failure | Any | `rejected` |
| Valid target failure | All pass | Semantic failure | `rejected` |
| Collection/build/dependency/timeout/crash/platform/unknown | Any | Any | `inconclusive` |
| Signatures disagree | Any | Any | `inconclusive` |
| Environment mismatch, missing attempts/reports, or incomplete cleanup | Any | Any | `inconclusive` |

Passing parent/fix baselines, exact repetition counts, evidence identity, equivalent environment metadata, and complete cleanup records are required. A nonzero exit code never verifies a candidate.

## Receipts

`buildReceipt` validates all frozen inputs, strips artifact bodies from the immutable manifest, and hashes canonical RFC 8785 JSON with SHA-256. `FileReceiptStore` persists candidate, exact patch, redacted raw evidence, classifications, bounded artifacts, canonical receipt, and digest under one run directory. Writes use mode `0600`, file `fsync`, atomic rename, and best-effort directory `fsync`. Existing receipts are immutable and idempotent. Configured literal secrets and high-risk token forms are redacted before raw evidence persistence; a patch containing such material is refused rather than rewritten.

## GitHub publication boundary

`GitHubDraftPublisher` accepts only a schema-valid `verified` receipt with a passing test-only policy, exact approval digest, exact patch digest, and the same current base SHA recorded by the receipt. It uses these official REST operations through a typed private control:

- `git.getRef`, `git.getCommit`, `git.createBlob`, `git.createTree`, `git.createCommit`, `git.createRef`, and `git.updateRef` with `force: false`;
- `pulls.list` and `pulls.create` with `draft: true`; and
- best-effort `issues.addLabels` after the draft exists.

The deterministic branch is never overwritten when it contains unrelated work. A receipt marker deduplicates open drafts; a matching non-draft is a conflict. Git objects and commit identity are deterministic, so retry after a partial branch/PR failure resumes without force-pushing or duplicating the pull request. The publisher exposes no merge operation and needs only Contents read/write plus Pull requests write; label application can also use Pull requests write.

The composition root wires `RecoveryCoordinator` to concrete transport ports and owns CLI/presentation. Core modules import frozen contracts only and contain no Runloop or Reflex SDK transport logic.
