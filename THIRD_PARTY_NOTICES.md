# Third-party notices

Antibody depends on npm packages distributed under their own licenses. No third-party source code is copied into this repository or bundled into Antibody's compiled output.

Direct production dependencies at version 0.1.0:

| Package | Version | License |
| --- | ---: | --- |
| `@octokit/rest` | 22.0.1 | MIT |
| `@runloop/api-client` | 1.31.0 | MIT |
| `@runloop/reflex-client` | 0.20.0 | MIT |
| `commander` | 15.0.0 | MIT |
| `ignore` | 7.0.6 | MIT |
| `json-canonicalize` | 3.0.0 | MIT |
| `yaml` | 2.9.0 | ISC |
| `zod` | 4.5.4 | MIT |

Transitive production dependencies in `pnpm-lock.yaml` use MIT, ISC, Apache-2.0, BlueOak-1.0.0, and BSD-2-Clause licenses. Review the exact resolved inventory for a release with:

```bash
pnpm install --frozen-lockfile
pnpm licenses list --prod
```

Copyrights, licenses, and notices remain with their respective authors. The package manager installs dependencies separately; consult each installed package's license file for complete terms.
