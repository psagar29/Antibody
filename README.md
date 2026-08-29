# Antibody

> Recover regression tests omitted from merged bug fixes, prove them against the exact historical code states, and open a test-only pull request with replayable evidence.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

## Status

Antibody is under active development for the SF Codex Community Hackathon. The architecture and team contracts are frozen in the [implementation plan](docs/IMPLEMENTATION_PLAN.md). Person A and Person B have separate [Codex handoff prompts](docs/team/), and Person C owns integration and release.

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

Tenor helped organize the event but currently exposes no documented public developer API, SDK, CLI, or webhook contract. Antibody contains no Tenor or Slack implementation, adapter, stub, mock, or hidden dependency. A future integration requires supported documentation and access from Tenor.

## Planned CLI

The installable package will expose one command:

```bash
antibody init --repo .
antibody doctor
antibody scan --repo . --limit 10
antibody recover --repo . --commit <full-sha>
antibody publish --receipt ./receipt.json --approval <sha256:...>
antibody receipt verify ./receipt.json
antibody receipt render ./receipt.json --output ./proof.html
antibody demo fixture
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
src/
  contracts/          Frozen Zod schemas, types, ports, and errors
  adapters/
    runloop/           Paired Devbox raw-evidence executor
    reflex/            Codex Persona session transport
    git/               Historical commit mining
    github/            Draft test-only PR publication
  core/                Ranking, authoring, policy, classification, receipts
  cli/                 Installable antibody command
  composition/         Production and fake adapter wiring
  viewer/              Self-contained static proof renderer
fixtures/
  demo-history/        Deterministic git fast-import history
docs/
  implementation plan, architecture, security, demo, and handoffs
```

## Parallel team branches

- `team/person-a-runloop-reflex` — Runloop execution and Reflex orchestration
- `team/person-b-core` — Antibody mining, authoring, classification, receipts, and GitHub publication
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

The frozen contract baseline requires Node 22+ and pnpm 11.24.0:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm antibody --help
```

`pnpm check` regenerates the JSON Schemas in check-only mode, then runs lint, strict type-checking, tests, and the production build. The offline demo is not implemented yet. Future live Runloop, Reflex, GitHub, and model-provider use will be opt-in and documented separately.

## License

Apache License 2.0. See [LICENSE](LICENSE).
