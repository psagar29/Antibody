# Person A Codex prompt

> Prerequisite: Person C must first publish the frozen `contracts-v1.0.0` baseline and fast-forward this branch to it. If the tag is absent, stop instead of inventing contracts.

Copy everything below into a Codex session running `gpt-5.6-sol` at `xhigh`.

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
