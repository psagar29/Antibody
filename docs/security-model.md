# Security model

Antibody assumes repository content, history, patches, issue text, agent output, test commands, reports, and logs are hostile. Strict schemas, bounded I/O, argv-only process execution, and digest checks protect the controller boundary.

## Admission and publication

- Candidate patches may modify configured test paths and explicitly allowed test-support fixtures only. They must add a test. Production code, workflows, binaries, deletions, renames, executable files, symlinks, submodules, traversal paths, and oversized patches are rejected.
- Parent failures must repeat with the same intended behavioral signature. Fix and current-head checks must pass under equivalent recorded environments.
- Missing, truncated, malformed, mismatched, flaky, setup, dependency, timeout, crash, or platform evidence fails closed as rejected or inconclusive. It cannot produce a publishable receipt.
- Publication is separate from recovery. A human supplies the exact canonical receipt digest. The publisher rechecks verified verdict, patch digest, test-only policy, and current base SHA.
- Publication creates only a draft PR. There is no merge operation or force-push path.

Configured file, byte, line, repetition, timeout, output, artifact, and parallelism limits constrain cost and blast radius. They do not make hostile code safe.

## Execution and credentials

Normal scanning uses local Git without running target code. Live setup and test commands execute in isolated Runloop Linux Devboxes. Use an immutable Blueprint or Snapshot and restrictive Network Policy. Provider administrators and the remote environment remain trusted dependencies.

Secrets are loaded from named environment variables at the composition boundary. They must not appear in config, prompts, fixtures, receipts, or logs. `doctor` reports credential presence, never values. Use separate least-privilege credentials for Runloop, Reflex, private source access, and GitHub publication.

The offline fixture is trusted local test material and is always labeled simulated. It does not validate live credentials, vendor connectivity, billing, mount authentication, or cleanup dashboards.

## Evidence limits

Receipt SHA-256 digests detect later mutation; they are not signatures, remote attestation, or proof that a provider, dependency, operating system, or historical build is uncompromised. A causal red/green result demonstrates regression sensitivity under recorded conditions, not general program correctness.

Runloop Devboxes are Linux-only. Antibody does not claim macOS, Xcode, iOS, or hardware-specific reproduction. Old dependencies may be unavailable or unsafe. Non-reproducible history remains inconclusive. Cleanup can fail; operators must inspect cleanup evidence and stop remaining resources.

The local dashboard escapes rendered receipt values and uses a restrictive content security policy. Retain the default `127.0.0.1` binding and avoid serving sensitive receipts to other users.
