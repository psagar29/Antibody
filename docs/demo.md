# Demo guide

## Offline fixture

```bash
antibody demo fixture --output .antibody/demo-runs --json
```

The result contains `simulated: true`, a verdict, receipt digest, and receipt directory. This is a deterministic **simulation**: checked-in Git fast-import history, a fixed authoring response, local worktrees, and Node's built-in test runner. It uses no credentials and makes no Runloop, Reflex, model-provider, or GitHub call.

```bash
antibody receipt verify <receipt-directory> --json
antibody receipt render <receipt-directory> --output proof.html
antibody dashboard .antibody/demo-runs --host 127.0.0.1 --port 0
```

The dashboard is read-only, loopback-only, and long-running. Stop it with Ctrl-C. Non-loopback bind addresses are rejected.

## Live recovery

Live use requires Runloop and Reflex configuration plus credentials listed in [the sponsor runbook](runloop-reflex.md). It may create billable remote resources.

```bash
antibody init . --preset node-test
antibody doctor . --json
antibody scan . --limit 10 --json
antibody recover . --candidate <full-sha-or-candidate-id> --output .antibody/runs --json
antibody run . --output .antibody/runs --json
```

Neither recovery command publishes. After reviewing a verified receipt, patch, and limitations:

```bash
antibody publish <receipt-directory> --approve <sha256:receipt-digest> --repository . --json
```

Publication requires the configured GitHub token, refuses stale or mismatched proof, and creates only a draft test-only PR. No live vendor or publication check is claimed by this guide.
