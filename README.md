# Antibody

Antibody recovers regression tests omitted from merged bug fixes. It admits a candidate only when the same test-only patch fails for the intended behavioral reason on the pre-fix parent, passes on the fix, and passes on current `HEAD`. Publication is a separate, human-approved operation that can create only a draft pull request.

[![CI](https://github.com/psagar29/Antibody/actions/workflows/ci.yml/badge.svg)](https://github.com/psagar29/Antibody/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Antibody 0.1.0 is early-stage software. It is deliberately narrow, fail-closed, and not a substitute for reviewing generated tests or pull requests.

## Install

Requires Node.js 22 or newer. After version 0.1.0 is published to npm:

```bash
npm install --save-dev @psagar29/antibody@0.1.0
npx antibody --help
```

One-off execution uses the package explicitly, avoiding ambiguity with the unrelated unscoped package:

```bash
npx --package=@psagar29/antibody@0.1.0 antibody --version
```

Global installation, also only after publication:

```bash
npm install --global @psagar29/antibody@0.1.0
antibody --help
```

From a source checkout:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm antibody --help
```

This repository does not claim npm publication or live vendor checks have occurred. Test a release tarball locally with `pnpm package:smoke`.

## Simulated offline fixture

```bash
antibody demo fixture --output .antibody/demo-runs --json
antibody receipt verify <receipt-directory> --json
antibody receipt render <receipt-directory> --output proof.html
antibody dashboard .antibody/demo-runs --host 127.0.0.1 --port 0
```

The fixture is **simulated**. It uses checked-in deterministic Git history, a fixed authoring response, and local worktrees. It contacts no Runloop, Reflex, model, or GitHub service and must not be presented as live evidence. See [the demo guide](docs/demo.md).

## Live workflow

Live recovery requires configured Runloop and Reflex accounts, billable-resource authorization, and credentials. GitHub credentials are additionally required to publish.

```bash
antibody init . --preset node-test
antibody doctor . --json
antibody scan . --limit 10 --json
antibody recover . --candidate <full-sha-or-candidate-id> --output .antibody/runs --json
antibody run . --output .antibody/runs --json
antibody publish <receipt-directory> --approve <sha256:receipt-digest> --repository . --json
```

`recover` handles one selected candidate. `run` selects the best-ranked candidate unless `--candidate` is supplied. Neither publishes. `publish` requires the exact human-approved receipt digest and creates a draft test-only PR; it cannot merge or force-push.

## Causal gate

For fix `F`, parent `P`, current head `H`, and candidate test patch `T`:

```text
P + T  -> repeated, stable intended behavioral failure
F + T  -> pass
H + T  -> targeted test pass and configured suite pass
T      -> approved test and fixture paths only
```

A nonzero exit code proves nothing by itself. Missing, truncated, malformed, inconsistent, setup, dependency, timeout, crash, or platform evidence yields an inconclusive result and cannot be published.

Receipts are canonical JSON with immutable commit identities, patch and evidence hashes, execution metadata, classifications, cleanup state, and the verdict. Hashes detect mutation; they are not signatures or remote attestation.

## Sponsor integrations

- **Runloop** supplies isolated Linux Devboxes for execution against parent, fix, and current-head revisions. Antibody requires equivalent environment metadata, bounded evidence, and recorded cleanup before deciding a verdict.
- **Reflex** launches a preconfigured Persona for bounded test authoring sessions. Reflex returns raw agent text and provenance; Antibody parses the patch and owns policy, verification, receipts, and publication.
- **Tenor is not used.** Antibody has no Tenor or Slack package, adapter, API call, mock, or hidden dependency.

No live Runloop or Reflex check is claimed here. See [sponsor integrations](docs/sponsors.md) and the detailed [adapter runbook](docs/runloop-reflex.md).

## Security

Target repositories, patches, model output, and command output are untrusted. Production source and workflow changes are rejected. Live test commands run in Runloop, not on the operator machine. Publication is digest-gated, draft-only, and fail-closed. Read [the security model](docs/security-model.md) before using live credentials.

## Development

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm package:smoke
git diff --check
```

The npm tarball contains compiled output, generated schemas, the deterministic demo fixture, and license/notice files. Dependencies and Actions are pinned; CI runs on Node.js 22.

Apache-2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE), and [third-party notices](THIRD_PARTY_NOTICES.md).
