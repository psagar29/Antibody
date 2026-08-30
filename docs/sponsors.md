# Sponsor integrations

## Runloop

Antibody uses `@runloop/api-client` to provision isolated Linux Devboxes from one configured Blueprint or Snapshot, mount the repository at creation, upload the candidate patch as bytes, and run bounded commands against exact parent, fix, and current-head SHAs. It resolves the environment source and optional Network Policy, checks patch digests, records command/artifact metadata, and attempts shutdown for every confirmed Devbox.

The adapter returns raw observations only. Antibody classifies failures, decides the causal verdict, and builds the receipt. Missing or truncated reports, environment mismatch, or incomplete cleanup cannot verify a candidate. Runloop cost is omitted when the API operations do not return an attributable cost.

## Reflex

Antibody uses `@runloop/reflex-client` to launch an existing Persona with a bounded authoring prompt, continue limited repair turns, consume replay-safe streamed events with bounded polling fallback, and stop the session. It records only provenance exposed by the public API.

Persona creation is a UI prerequisite because the installed public client exposes Persona list/get/launch, not create/update. Reflex authors raw final text; it does not approve the patch, control Runloop proof, build the receipt, or publish a PR. The critical controller stays outside the agent session.

Both live integrations require operator-provided accounts, resource configuration, credentials, and billable-use authorization. No live Runloop or Reflex check was performed or is claimed by these documents. Generated SDK types and secret-free fakes cover the implemented boundary; live connectivity, billing, mounts, and UI state still require operator validation. See [the adapter runbook](runloop-reflex.md).

## Tenor

Tenor is not used. Antibody contains no Tenor or Slack SDK, adapter, port, environment variable, API call, stub, mock, or hidden dependency. Event sponsorship is not a developer integration. Adding one would require a supported public contract and separate security review.
