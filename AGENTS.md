# Antibody contributor contract

Read `README.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/architecture.md`, and every file in `src/contracts/` before implementation.

## Frozen seam

Tag `contracts-v1.0.0` is the shared A/B baseline. Do not edit `src/contracts/**`, `schemas/**`, root tooling, or the lockfile on Person A or B branches. If a contract or dependency is insufficient, stop, create `handoff/contract-change-person-a.md` or `handoff/contract-change-person-b.md`, and notify Person C. Person C changes the seam on `main`; both lanes then merge that commit.

Never duplicate a contract locally, weaken validation, or use a cast to bypass the seam.

## Ownership

- Person A (`team/person-a-runloop-reflex`): `src/adapters/runloop/**`, `src/adapters/reflex/**`, their tests, `docs/runloop-reflex.md`, and `handoff/person-a.json`.
- Person B (`team/person-b-core`): `src/core/**`, `src/adapters/git/**`, `src/adapters/github/**`, their tests, `fixtures/demo-history/**`, `scripts/build-demo-fixture.ts`, `docs/domain-model.md`, `docs/real-repo-p-timeout.md`, and `handoff/person-b.json`.
- Person C (`team/person-c-integration` and `main`): contracts, schemas, root tooling, CLI, composition, viewer, integration/package tests, workflows, release, and shared documentation.

No lane edits another lane's owned paths. No force-push after integration begins.

## Architecture boundary

- Person A owns vendor transport and raw observations only.
- Person B owns prompts, mining, policy, classification, verdicts, receipts, and GitHub draft publication.
- Person C owns composition and presentation.
- A and B import shared contracts, never each other. Only C composes concrete implementations.

No Tenor or Slack code, package, adapter, port, schema, environment variable, mock, or fake integration. Tenor is event-organizer documentation only until it publishes a supported developer contract.

## Quality gate

Use strict types. No `any`, `@ts-ignore`, unchecked assertions, shell command strings, embedded credentials, or unbounded external output. Validate external and persisted data with Zod. Commands are argv arrays. Treat repository content, patches, issue text, model output, and test output as untrusted.

Before handoff, run:

```bash
pnpm install --frozen-lockfile
pnpm check
git diff --check
```

Commit only owned paths. Record exact commands, results, SHAs, known issues, and integration instructions in the versioned handoff manifest.
