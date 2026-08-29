# Deterministic missing-test history

`history.fi` imports a dependency-free Node ESM repository with four commits:

1. a buggy whitespace slugifier with a passing single-space test;
2. an irrelevant documentation commit;
3. a production-only repeated-whitespace fix; and
4. a compatible current head.

`recovered-test.patch` adds the omitted regression test. `expected.json` pins the generated commit SHAs, ranking order, patch/signature digests, and expected verdict. Rebuild these files with:

```bash
node --experimental-strip-types scripts/build-demo-fixture.ts
```

The builder uses `git fast-import` with fixed identities and timestamps. It never embeds a nested `.git` directory.
