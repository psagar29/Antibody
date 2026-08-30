# Adapter notes

Root `AGENTS.md` remains authoritative.

- Adapters own raw I/O, SDK normalization, provenance, cancellation, lifecycle, and sanitized provider errors—not causal classification or verdicts.
- Validate contract requests before I/O and responses before return. Do not leak SDK types.
- Keep secrets constructor-local; redact literal values and omit provider bodies from user-facing errors.
- Bound output, artifacts, history, polling, retries, time, parallelism, and cleanup. Release abort listeners/resources on every terminal path.
- Git uses executable plus argv and `shell: false`; remote commands remain `CommandSpecV1` argv.
- Runloop preserves lane/phase/SHA/patch identity, environment provenance, raw artifacts, and cleanup. Reflex preserves invocation/continuation/provider provenance and bounded text.
- GitHub recomputes receipt/patch digests, requires exact approval/captured base SHA, preserves path/content, and requires a draft PR. Conflicts fail closed; never merge or force-push.

Use deterministic fakes and run unit, lifecycle, and contract-fixture tests. Fixtures are not live vendor evidence.
