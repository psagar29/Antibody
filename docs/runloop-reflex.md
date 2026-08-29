# Runloop and Reflex adapter runbook

This runbook covers the Person A infrastructure seam only. The Runloop adapter returns
`RawVerificationEvidenceV1`; the Reflex adapter returns bounded raw `finalText` and public
provenance. Verdicts, patch parsing, repair policy, prompts, receipts, and publication remain
outside these adapters.

## Required configuration

Load secret values in the composition root and pass them to the adapter factories. Never put
values in `.antibody.yml`, logs, prompts, evidence, test fixtures, or handoff files.

| Environment name | Purpose | Required when |
| --- | --- | --- |
| `RUNLOOP_API_KEY` | Runloop API authentication | Always for verification |
| `ANTIBODY_RUNLOOP_BLUEPRINT_ID` | Immutable environment source id | Blueprint configuration only |
| `ANTIBODY_RUNLOOP_SNAPSHOT_ID` | Immutable environment source id | Snapshot configuration only |
| `ANTIBODY_RUNLOOP_NETWORK_POLICY_ID` | Explicit Devbox egress policy | Production verification |
| `GITHUB_TOKEN` | Private GitHub code mount credential | Private repositories only |
| `REFLEX_API_KEY` | Reflex personal API key | Always for authoring |
| `REFLEX_BASE_URL` | Reflex server origin, without `/api` | Always for authoring |
| `REFLEX_ORGANIZATION_ID` | Organization id or slug used for request scope | Always for authoring |
| `ANTIBODY_REFLEX_PERSONA_ID` | Existing Persona launched for a new session | Always for new authoring sessions |

The source kind and identifier come from the frozen `VerificationRequestV1`. Configure exactly
one Blueprint or Snapshot source. Production operation should supply a Network Policy; the
frozen contract permits omission, but an omitted policy has no digest and must be treated by the
domain layer as an explicit operator choice.

## Runloop setup

1. Create a Linux Blueprint or Snapshot containing the repository's system dependencies. Record
   its immutable id, not a display name. Snapshot status must be `complete`; Blueprint state must
   be `created` and status `build_complete`.
2. Create a Network Policy with only the package registries and services the setup and test plans
   need. Record its immutable id. The adapter retrieves the policy and hashes the explicit public
   policy fields into `resolvedNetworkPolicySha256`.
3. For a private repository, supply a GitHub token to the factory's `githubToken` option. The token
   is used only in the create-time `code_mount` and is registered with the shared redactor. Public
   repositories do not need it.
4. Construct `createRunloopVerificationAdapter` with persistence functions for artifacts and raw
   evidence. Evidence persistence is required, not optional: the adapter persists before cleanup
   and again with final cleanup outcomes.

The implementation uses these generated `@runloop/api-client` operations and response types:

- `blueprints.retrieve` → `BlueprintView`
- `devboxes.diskSnapshots.queryStatus` → `DevboxSnapshotAsyncStatusView`
- `networkPolicies.retrieve` → `NetworkPolicyView`
- `devboxes.create` and `devboxes.retrieve` → `DevboxView`
- `devboxes.uploadFile` with `toFile` for patch bytes
- `devboxes.executeAsync`, `devboxes.executions.retrieve`, and
  `devboxes.executions.kill`
- `devboxes.readFileContents` for an optional test report
- `devboxes.shutdown` followed by bounded status polling

Provisioning is explicit create-then-poll. This preserves the returned Devbox id before waiting,
so a later provisioning or controller failure still has a cleanup target. SDK retries are disabled
globally; only bounded idempotent reads use two SDK retries.

Each command runs in a fresh shell. The one reviewed renderer single-quotes every argv/env/cwd word,
sets an absolute repository cwd, and wraps execution with GNU `timeout`. The controller separately
polls the async execution and kills the process group at its deadline. Patch bytes are uploaded as
a file, never interpolated into a command, and SHA-256 is checked both before upload and inside the
Devbox.

The adapter records truncation by using a `.truncated` artifact name and a `platform-error`
termination. It never converts missing or truncated evidence into a verdict. Full redacted bytes
go to the artifact persistence callback; contract-inline content is omitted above the configured
limit. Runloop cost is omitted because the operations used here do not return an attributable cost.

Runloop lifecycle constraints that matter operationally:

- Devboxes are Linux environments.
- A code mount is a create-time mount.
- Each execution starts a fresh shell, so setup state must live on disk rather than in shell-local
  variables.
- Async execution polling does not terminate a process; the in-box and controller deadlines are
  both required.
- Provider log windows are finite, so artifacts must be persisted while the Devbox is available.
- A Devbox can continue incurring storage cost after compute stops; successful shutdown is recorded
  for every confirmed id and cleanup failures require operator follow-up.

## Reflex setup

The installed public client exposes Persona list/get/launch, but no public Persona create or update
operation. Persona creation is therefore a UI-only prerequisite, not something this adapter
fabricates.

1. In Reflex, select the target organization. Under **Organization → Model Providers**, add the
   provider credential needed by the chosen agent/model if it is not already available.
2. Open **Agent Sessions**, click **New agent**, select the agent type and model, select the prepared
   Blueprint/repository, and review the **Advanced** settings. Do not attach a create-PR Automation;
   Antibody's controller and GitHub publisher remain outside the agent.
3. Run a harmless validation task. After the session behaves correctly, save that successful setup
   as a Persona, or create the equivalent Persona in the Persona form. The Persona owns the agent
   harness, model, Blueprint, and tools; Person B supplies the per-invocation prompt.
4. Use the public Persona list operation to retrieve its opaque id and store only that id as
   `ANTIBODY_REFLEX_PERSONA_ID`.
5. In **Security → API keys**, mint a personal API key for the adapter. Store it as
   `REFLEX_API_KEY`; never paste it into a Persona prompt or environment variable visible to the
   agent.

`createReflexAgentSessionAdapter` configures the public client with the base URL, API key, and
organization. A new invocation calls `launchAgentFromPersona` (`POST
/api/agent-personas/{id}/launch`) with `promptStrategy: "replace"`, the exact Person B prompt,
`repoSlug`, and the full checkout SHA as `repoBranch`. A continuation first records the current
stream boundary, then calls `sendAgentMessage` on the existing opaque agent id.

The adapter combines `ReflexSocket` with `getAgentStream` and `getAgent`. The public socket supplies
application ping/pong heartbeats, exponential reconnect, subscription replay, and resubscription.
The adapter deduplicates replayed event ids, filters continuation history at the captured sequence,
polls as a bounded fallback, and recognizes public event dialects used by Reflex (flat chunks, ACP
`session/update`, native Codex deltas/completions, and native Claude assistant/result events).
Timeout or caller abort interrupts the current turn. `stop()` is idempotent in-process: it uses the
documented interrupt operation before the documented stop operation and treats already absent or
terminal sessions as stopped. The result includes only actual `agentId`, `streamId`, and `personaId`
fields exposed by the public API. It does not invent `axonId`, token usage, or model cost.

## Verification and live-check procedure

Normal CI is secret-free:

```text
pnpm vitest run test/adapters/runloop test/adapters/reflex
pnpm typecheck
pnpm lint
pnpm build
```

Live checks are opt-in and must use a disposable repository/Persona, short timeouts, and a hard
provider budget.

1. Run one `maxParallel: 1` Runloop request with a tiny patch and short commands. Confirm the
   resolved source/policy metadata, local and remote patch digests, parent/fix/head attempt order,
   pre-cleanup evidence persistence, and one successful cleanup record per Devbox. Confirm the same
   Devbox ids are `shutdown` in the Runloop dashboard.
2. Launch one Reflex invocation with a small output cap, continue the returned `continuationId`
   once, and call `stop()` twice. Confirm the second stop causes no additional interrupt/stop and the
   UI shows the session stopped. Check that replayed stream events do not duplicate `finalText`.
3. Revoke or discard disposable credentials and inspect persisted artifacts for redaction before
   retaining them.

No live Runloop or Reflex call was performed during Person A implementation because credentials and
billable-resource authorization were not available in the development session. The SDK/OpenAPI
shapes and all lifecycle behavior were verified with generated types and secret-free fakes; live
provisioning, mount authentication, vendor billing, WebSocket connectivity, and UI state remain to
be verified by the integration owner.

## Integration boundary

Person C should instantiate these adapters in the composition root and pass them through the frozen
ports. The critical proof controller must remain outside Reflex: Reflex authors raw final text;
Person B parses and validates the patch; Runloop independently executes the paired proof; Person B
classifies evidence and publishes through the GitHub adapter. A Reflex session never needs Runloop
credentials for this critical path.

Official references:

- <https://docs.runloop.ai/docs/devboxes/execute-commands>
- <https://docs.runloop.ai/docs/devboxes/files>
- <https://docs.runloop.ai/docs/devboxes/mounts/overview>
- <https://docs.runloop.ai/docs/devboxes/mounts/code-mounts>
- <https://docs.runloop.ai/docs/devboxes/snapshots>
- <https://docs.runloop.ai/docs/devboxes/start-stop>
- <https://github.com/runloopai/api-client-ts>
- <https://github.com/runloopai/reflex-os>
- <https://reflex.runloop.ai/docs/concepts/agents>
