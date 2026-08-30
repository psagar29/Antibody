# Test notes

Root `AGENTS.md` remains authoritative.

- Put coverage beside the seam whose promise changed: core, adapter, contract, integration, CLI, or dashboard.
- Use deterministic clocks, IDs, fixtures, writers, and fakes. Default tests require no credentials, network, billable resources, or live GitHub mutation.
- Contract fixtures prove schema compatibility; lifecycle tests prove cancellation/cleanup. Neither is a live check.
- Cover malformed/truncated output, identity mismatch, unrelated failure, timeout, partial cleanup, digest mismatch, stale base, unsafe paths, and publication conflict.
- Assert stable payloads, reason/error codes, digests, exit codes, and sanitized output—not private call order unless lifecycle is the contract.
- Isolate and clean temporary repositories/directories. Child processes use argv and `shell: false`.

Use `pnpm exec vitest run <test-files>`, full `pnpm check`, and package smoke for package/CLI/fixture/receipt/presentation changes.
