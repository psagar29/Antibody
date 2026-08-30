# Composition notes

Root `AGENTS.md` remains authoritative.

- Composition owns wiring, config, environment lookup, context resolution, artifact hydration, persistence, and offline-demo setup.
- Keep causal decisions in core and provider quirks in adapters.
- Collect bounded content from captured revisions, not the mutable working tree. Preserve byte caps and safe Git argv.
- Resolve validated environment names to nonblank values; feed secret values to redaction and never persist them.
- Hydrated artifacts must match provider digest/size and content bounds.
- Verify after receipt persistence. Local spool cleanup and remote cleanup are distinct.
- Offline demo is credential-free and simulated, never live evidence.

Use matching integration tests, CLI tests for visible behavior, and package smoke for fixture/package paths.
