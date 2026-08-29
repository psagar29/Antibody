# Architecture

Antibody recovers regression tests missing from already-merged fixes and admits them only after causal verification against immutable Git states.

```text
                 frozen contracts
                       |
       +---------------+---------------+
       |                               |
Person B domain                    Person A transport
Git mining                         Reflex agent session
Codex prompt + repair    ports      Runloop execution
patch policy             <---->     raw evidence only
classification
adjudication
receipt + GitHub draft
       |
       +---------------+---------------+
                       |
                Person C composition
                 CLI + proof viewer
```

## Dependency rule

`src/contracts` has no project-internal dependency. Person A and Person B depend on contracts only and never import one another. Person C's composition root is the sole place concrete adapters and domain modules meet.

The two shared ports are intentionally small:

- `AgentSessionPort` transports a bounded prompt to Reflex and returns raw bounded final text plus provider provenance.
- `VerificationExecutionPort` sends an immutable verification plan to Runloop and returns raw process evidence.

Neither port exposes vendor SDK types. Neither port decides whether a test proves a regression.

## Trust boundary

Repository data, commit and issue text, patches, agent output, and command output are untrusted. Credentials stay adapter-local. All shared and persisted payloads cross strict Zod boundaries. Git identities use full lowercase SHAs; repository paths are relative and traversal-safe; commands remain argv arrays.

## Causal gate

For test patch `T`, fix `F`, its parent `P`, and captured current head `H`:

```text
P + T => stable intended behavioral failure
F + T => pass
H + T => pass
T     => approved test/support paths only
```

Setup, dependency, build, collection, timeout, crash, platform, malformed-report, unrelated-test, or inconsistent failures cannot produce a verified verdict. A nonzero exit code alone proves nothing.

## Publication boundary

Verification creates an immutable canonical receipt. Publication is a later, explicit operation requiring the exact receipt digest. It may create only a draft test-only pull request, never merge or force-push. A separate publication record prevents GitHub state from mutating the proof digest.
