# Core notes

Root `AGENTS.md` remains authoritative.

- Core owns domain judgment: mining, ranking, prompts/review, patch policy, classification, adjudication, recovery, and receipt integrity.
- Keep SDK types and provider control flow out. Core consumes contract ports and raw evidence.
- Mining and patch applicability currently default to the Git adapter; inject runners/checkers in tests.
- Classification creates outcomes; adjudication alone creates `verified`, `rejected`, or `inconclusive`.
- Exit code alone never proves intent. Missing target names, malformed reports, unstable signatures, identity/environment mismatch, or incomplete cleanup fail closed.
- Patch normalization, P/F/H applicability, canonical receipt bytes, redaction, and artifact digests are security-sensitive interfaces.
- Prefer deterministic helpers; inject time, IDs, runners, and writers.

Closest tests are in `test/core/`; mining also uses the Git miner tests. Receipt/recovery changes usually require integration and package smoke.
