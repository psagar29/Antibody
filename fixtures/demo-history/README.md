# Deterministic demo history

`history.fi` is a dependency-free Git fast-import stream with fixed identities,
timestamps, paths, modes, and bytes. It creates four commits on `main`:

1. a buggy `slugify` implementation with a passing existing test;
2. an irrelevant documentation change;
3. a source-only fix that collapses repeated whitespace; and
4. an unrelated compatible source addition at current `HEAD`.

`recovered-test.diff` adds the missing behavior-specific Node test. The same
patch fails on the fix parent and passes on the fix and current `HEAD`.

Build a disposable checkout with Node 22+:

```text
node --experimental-strip-types scripts/build-demo-fixture.ts <empty-directory>
```

The builder never deletes or overwrites an existing repository.
