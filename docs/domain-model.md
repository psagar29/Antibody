# Antibody intelligence domain model

Antibody recovers tests that were historically missing. It does not claim to discover an unknown production bug: a one-parent source-only fix is the oracle, and the proof is a test that is red on the fix parent and green on the fix and the captured current `HEAD`.

## Trust boundaries

The domain lane consumes the frozen `AgentSessionPort` and `VerificationExecutionPort`. The ports transport bounded agent text and raw execution observations; they do not decide whether a commit is interesting, whether a patch is test-only, what a failure means, or whether evidence is causal. No Runloop or Reflex SDK is imported by this lane.

Git is authoritative for commit ancestry, modes, paths, statistics, and diffs. GitHub issue and pull-request data can enrich a score but cannot prove that a commit left tests untouched. Commit messages, issue text, source, and existing tests are untrusted prompt evidence.

The pipeline is:

```text
Git history -> candidate invariants -> deterministic ranking
            -> bounded Codex authoring through AgentSessionPort
            -> structural patch policy + three-tree git apply check
            -> raw execution through VerificationExecutionPort
            -> reporter classification + normalized signatures
            -> causal adjudication -> canonical receipt -> approved draft PR
```

## Candidate invariants and ranking

A candidate is a complete lowercase 40-character one-parent commit. It changes at least one configured production path and no configured test or support path. The miner rejects merges, roots, binary changes, symlinks, gitlinks, renames/copies, generated or vendor paths, docs/config/dependency-only shapes, and configured file or line limits. It parses NUL-delimited Git output and invokes Git with argv, never a shell.

Candidate IDs and diff hashes are deterministic. Ranking uses the frozen weights:

| Signal | Weight |
|---|---:|
| Fix-related subject word | 35 |
| Linked bug/regression label | 20 |
| At most 100 changed lines | 15 |
| One to three production files | 10 |
| Conditional, validation, or error branch | 10 |
| Issue reference | 5 |
| Current `HEAD` retains the fixed region | 5 |

Scores are clamped to 0–100. Ties sort by score descending, authored time descending, then fix SHA ascending.

## Authoring and patch policy

The author sees only bounded commit/issue text, the parent-to-fix diff, affected source at both states, framework/configuration data, and at most three nearby tests. Each untrusted section is length-limited and explicitly framed as inert evidence. The known fix is named as an oracle. Output must be exactly one strict `antibody.agent-output/v1` JSON object containing canonical base64 for a valid UTF-8 unified diff.

At most three authoring attempts are allowed. Later turns stay on the opaque continuation and receive only a normalized category, bounded feedback, and the previous patch digest. Format, policy, syntax, collection, and parent-pass overgeneralization are repairable. Installation, build, dependency, platform, timeout, credential, network, and environment-equivalence failures terminate authoring without spending another attempt. The session is stopped in `finally`.

The patch parser—not the model's description—enforces test-only scope. It rejects:

- paths outside configured test/support globs, production/dependency/build/config/workflow paths, and every `.github/workflows/**` path;
- absolute, traversal, backslash, NUL, malformed, rename, or copy paths;
- binary patches, symlink/gitlink modes, executable mode changes, and test-file deletion;
- empty patches, patches without an added/changed executable test, and configured byte/file/added-line excesses;
- any patch that fails `git apply --check --cached` in temporary indexes seeded from parent, fix, or captured `HEAD`.

## Classification and stable signatures

TAP, JUnit XML, Vitest JSON, Jest JSON, and conservative pytest text are parsed independently. Missing or malformed reporter content is `unknown-failure`; a nonzero exit code alone is never proof of a behavioral regression.

Every frozen outcome is represented: `pass`, `assertion-failure`, `behavioral-failure`, `unrelated-test-failure`, `collection-failure`, `build-failure`, `dependency-failure`, `timeout`, `crash`, `platform-failure`, and `unknown-failure`.

Failure signatures canonicalize a tuple containing the target test names, error type, assertion operator, message, and first project frame. ANSI sequences, external/temporary paths, line and column numbers, timestamps, and random identifiers are normalized. Parent repetitions must have one exact signature.

## Causal verdict table

Policy failure, a current-HEAD patch conflict, a passing parent, a failure unrelated to the target, a semantic failure on the fix or current HEAD, or a semantic full-suite failure is rejected. Infrastructure/malformed evidence, environment mismatch, missing observations, and unstable repetitions are inconclusive.

| Required gate | Verified value | Otherwise |
|---|---|---|
| Patch policy | test-only, applies to all three trees | rejected |
| Environment | equivalent compared fields | inconclusive |
| Setup/baseline | all pass | semantic: rejected; infrastructure: inconclusive |
| Parent repetitions | all target assertion/behavioral failures | pass/unrelated: rejected; infrastructure: inconclusive |
| Parent signature | present and identical every time | inconclusive |
| Fix repetitions | all pass | semantic: rejected; infrastructure: inconclusive |
| Current-HEAD target | pass | semantic: rejected; infrastructure: inconclusive |
| Configured HEAD full suite | pass | semantic: rejected; infrastructure: inconclusive |

Only the all-green right side after a stable parent red produces `verified` with `causal-red-green-confirmed`.

## Evidence, receipts, and publication

Before persistence, configured secrets and high-risk token shapes are replaced and artifact manifests are rehashed. JSON is RFC 8785 canonicalized. A run directory contains the candidate, patch, redacted raw evidence, classifications, individual artifacts, receipt, and receipt digest. Each file is written to a user-only temporary file, `fsync`ed, then renamed. An existing non-identical file is never overwritten. Verification reparses every frozen schema, requires canonical bytes, and recomputes receipt, patch, raw-evidence, candidate, classification, artifact-manifest, and stored-artifact hashes.

Publication requires a verified, policy-clean receipt; an exact approval equal to its recomputed canonical digest; and patch bytes and paths matching the receipt. The base branch must still equal the verified `HEAD`. The publisher searches for the deterministic receipt marker before writes, reuses a matching open draft PR, creates `antibody/<fix-short>-<run-short>`, never force-pushes or merges, and opens a draft only. A retry can resume a receipt-marked branch commit after partial failure without duplicating the branch, commit, or PR. The default commit contains only materialized test files; an in-repository canonical receipt is an explicit project-policy opt-in.

The GitHub token needs only repository contents read/write and pull requests write.
