# Person C integration checklist

- [ ] Create/bootstrap `main`; freeze schemas/ports/errors; tag `contracts-v1.0.0`; branch A/B/C from it.
- [ ] Confirm `team/person-b-core` is used and obsolete `team/person-b-core-tenor` is absent from merge ancestry.
- [ ] Predeclare exact dependencies; A/B never alter root manifests/lock.
- [ ] Validate both handoff manifests and path ownership before merging.
- [ ] Merge B `--no-ff`; run its tests with fake ports.
- [ ] Merge A `--no-ff`; run its tests; check no domain logic leaked into adapters.
- [ ] Wire composition only in `src/composition/**`; avoid edits inside A/B directories.
- [ ] Implement CLI/exit/stdout contracts and self-contained escaped proof viewer.
- [ ] Regenerate schemas; require zero diff; run typecheck/lint/full tests.
- [ ] Run fixture fake flow, fixture live Runloop/Reflex flow, and negative rejection cases.
- [ ] Run real `p-timeout` twice; save redacted receipt; verify all Devboxes stopped.
- [ ] Publish only to a writable fork, draft only, with exact receipt approval digest.
- [ ] Run clean `npm pack` + global install smoke.
- [ ] Finish security/docs/license/third-party scan; remove every secret/canary.
- [ ] Tag/release; verify GitHub tarball/checksum and npm path if available.
- [ ] Rehearse primary and fallback demo twice. Freeze features.



Full contracts, merge order, gates, and demo plan: [Implementation plan](../IMPLEMENTATION_PLAN.md).
