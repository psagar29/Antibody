# Dashboard notes

Root `AGENTS.md` remains authoritative.

- Dashboard is read-only presentation over verified local receipt directories; it cannot publish, repair, or reinterpret proof.
- Verify before building view models. Invalid/partial runs must never display as verified.
- Bind loopback by default. Treat routes, names, receipt text, and artifacts as untrusted; preserve path containment and HTML escaping.
- Keep model, HTML, and server lifecycle independently testable. Add no remote assets, telemetry, credentials, or unsafe inline content.

Run dashboard tests; viewer/receipt changes also need integration tests and package smoke.
