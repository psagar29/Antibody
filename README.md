# Antibody

> Recover regression tests omitted from merged bug fixes, prove them against the exact historical code states, and open a test-only pull request with replayable evidence.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

## Status

Antibody is under active development for the SF Codex Community Hackathon. The public contracts and team boundaries are being defined before parallel implementation begins.

## The problem

A bug fix repairs production behavior, but the lesson is often never encoded as a regression test. The same defect can return months later because the repository remembers the patch but not the failure that justified it.

Antibody turns Git history into regression memory.

Given a repository and a historical fix commit, Antibody:

1. identifies fixes that changed production code without adding meaningful regression coverage;
2. asks Codex to generate a focused test-only patch;
3. applies the exact same patch to the fix commit and its parent;
4. accepts the candidate only when it fails on the parent for the intended behavioral reason and passes on the fix;
5. checks the test against current `HEAD`;
6. emits a machine-readable evidence receipt; and
7. opens a draft pull request containing tests only.

## Causal acceptance gate

For fix commit `F`, parent `P = parent(F)`, and generated test patch `T`:

```text
test(P + T) = expected behavioral failure
test(F + T) = pass
test(current HEAD + T) = pass
diff(T) = approved test and fixture paths only
```

A nonzero exit code is not automatically evidence. Compilation errors, dependency failures, timeouts, unrelated crashes, flaky outcomes, and malformed tests are rejected or marked inconclusive.

This establishes regression sensitivity under the recorded environment. It does not claim formal proof that the entire fix is correct.

## Architecture

```text
GitHub merge event or scheduled audit
                 |
                 v
        Reflex Automation
                 |
                 v
  Codex Regression Archaeologist Persona
                 |
                 v
     Antibody miner and test author
                 |
          test-only patch T
            /           \
           v             v
 Runloop Devbox P   Runloop Devbox F
 parent + T: FAIL    fix + T: PASS
            \           /
             v         v
          Evidence receipt
                 |
         Reflex approval gate
                 |
                 v
       GitHub draft test-only PR
```

### Runloop

Runloop supplies isolated Linux Devboxes for the parent and fix revisions. Both sides use the same Blueprint, architecture, resource policy, command, environment allowlist, and test-patch hash. Execution identifiers, exit codes, classified output, timings, and artifact hashes feed the receipt.

### Reflex

Reflex supplies the repeatable Codex Persona, GitHub or scheduled Automation, durable session history, human Inbox, and approval path. Antibody owns the mining and causal policy; Reflex operates the workflow.

### Tenor

Tenor is an optional accountability layer when the organizers provide supported access. The intended worker responsibility is:

> Continuously audit merged bug fixes for missing regression tests within an explicit token, compute, repository, and write-authority budget.

Tenor currently has no public developer API, SDK, or CLI. Antibody therefore keeps this integration behind an adapter and does not depend on undocumented behavior.

## Planned CLI

The installable package will expose one command:

```bash
antibody scan owner/repository
antibody inspect owner/repository --fix <full-sha>
antibody verify --fix <full-sha> --patch ./candidate.patch
antibody publish --receipt ./antibody.receipt.json
antibody run owner/repository --fix <full-sha>
```

The exact package name and release command will be documented once the first executable vertical slice lands. Until then, commands above are the stable product contract, not a claim that a package is already published.

## Evidence receipt

Every verified candidate produces canonical JSON containing at least:

- repository identity;
- immutable parent and fix SHAs;
- fix-diff and test-patch SHA-256 hashes;
- Blueprint, architecture, network policy, and toolchain identity;
- exact commands and normalized outcomes;
- Runloop Devbox and execution identifiers;
- repeated-run results and failure classification;
- Reflex session and Persona identifiers;
- token and infrastructure cost when available;
- test-only policy decision; and
- durable artifact references.

Receipts and selected raw logs are persisted outside transient platform execution history. Hashes detect mutation; they are not signatures or remote attestation.

## Safety boundaries

Antibody is intentionally conservative:

- no production source modifications;
- no automatic merge;
- no pull request without a verified receipt;
- no raw credentials in prompts, logs, or committed configuration;
- no unrestricted network during proof execution;
- no acceptance of setup or infrastructure failures as behavioral evidence;
- no silent fallback when an old revision cannot be reproduced; and
- no claim of macOS or Xcode execution on Runloop's Linux Devboxes.

## Repository layout

The parallel implementation will converge on:

```text
apps/
  proof-viewer/       Judge-facing receipt visualization
packages/
  contracts/          Shared schemas and typed interfaces
  core/               Mining, candidate policy, failure taxonomy
  author/             Codex context and test-generation orchestration
  runloop/            Paired Devbox verifier
  reflex/             Persona and Automation integration
  tenor/              Optional accountability adapter
  github/             Test-only branch and pull-request publisher
  receipt/            Canonical evidence format and hashing
fixtures/
  omitted-regression/ Deterministic historical bug/fix demo
docs/
  architecture, threat model, prior art, operations, and handoffs
```

## Parallel team branches

- `team/person-a-runloop-reflex` — Runloop execution and Reflex orchestration
- `team/person-b-core-tenor` — Antibody domain core, authoring, and Tenor-compatible accountability boundary
- `team/person-c-integration` — integration, release engineering, installer, documentation, and final demo

Changes merge through reviewed pull requests. Shared contracts are frozen before implementation so the two primary lanes can work without editing each other's directories.

## Open-source policy

Antibody is licensed under Apache-2.0. Contributions must:

- preserve applicable copyright and license notices;
- record copied or modified third-party code in `THIRD_PARTY_NOTICES.md`;
- avoid source from repositories without an explicit compatible license;
- never commit credentials, customer data, generated secrets, or private fixture content; and
- include tests and documentation for externally visible behavior.

Relevant prior art will be documented explicitly. Antibody's differentiated claim is recovery of tests missing from already-merged fixes, followed by production admission against immutable parent/fix states and publication as an independently reviewable test-only PR.

## Development

Bootstrap, test, lint, type-check, packaging, and local-demo commands will be added with the first implementation slice. The target developer experience is:

```bash
pnpm install
pnpm check
pnpm demo:offline
```

The offline demo will require no cloud credentials. Live Runloop, Reflex, GitHub, model-provider, and optional Tenor credentials will be opt-in and documented separately.

## License

Apache License 2.0. See [LICENSE](LICENSE).
