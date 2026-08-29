# Contributing

Read `AGENTS.md` and `docs/architecture.md` before changing code. Keep changes inside the documented ownership boundary and include tests for externally visible behavior.

Required local gate:

```bash
pnpm install --frozen-lockfile
pnpm check
git diff --check
```

Do not commit credentials, private fixtures, copied code without a compatible license, or generated artifacts that cannot be reproduced. Record third-party copied or modified code in `THIRD_PARTY_NOTICES.md`.
