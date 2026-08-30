# Contributing

Read [AGENTS.md](AGENTS.md), [the architecture](docs/architecture.md), and [the security model](docs/security-model.md) before changing code. Keep changes inside documented ownership boundaries. Preserve strict types and add tests for externally visible behavior.

Required local gate:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm package:smoke
git diff --check
```

`pnpm package:smoke` packs the package, installs the tarball in an isolated temporary project, runs its binary, executes the simulated offline fixture, and verifies the resulting receipt.

Do not commit credentials, private fixtures, copied code without a compatible license, or generated artifacts that cannot be reproduced. Record copied or modified third-party code in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Security reports belong in the private channel described in [SECURITY.md](SECURITY.md), not a public issue.
