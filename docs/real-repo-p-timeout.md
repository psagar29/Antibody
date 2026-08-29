# Real-repository rehearsal: `sindresorhus/p-timeout`

This runbook pins the public MIT-licensed `sindresorhus/p-timeout` regression used for the Antibody demo.

## Immutable oracle

- Fix: `ed58372c62d3dddfe6f58de37558fb132e1a4e9b` — `Fix "Illegal invocation" error with custom timers`
- Parent: `f9ced5e18ad81eab24a9a8d0f07bf3002f7bea64`
- Issue: [#45, “Uncaught (in promise) TypeError: Illegal invocation”](https://github.com/sindresorhus/p-timeout/issues/45)
- Rehearsed current head on 2026-08-29: `245066ef7daa5e74024d5b6a188ae599a1b7bfdf`

The fix changes only `index.js`: two property calls become `.call(undefined, ...)`, with explanatory comments. No test file changed. The parent package uses Node 20+, AVA 6, `test.js`, and `npm test`; it has no lockfile. The repository license file is MIT.

## Regression test

Add this test after the existing `accepts \`customTimers\` option` case in `test.js`:

```js
test('calls custom timers without a receiver', async t => {
	t.plan(2);

	await pTimeout(delay(10), {
		milliseconds: 100,
		customTimers: {
			setTimeout(function_, milliseconds) {
				t.is(this, undefined);
				return setTimeout(function_, milliseconds);
			},
			clearTimeout(timeoutId) {
				t.is(this, undefined);
				return clearTimeout(timeoutId);
			},
		},
	});
});
```

Normal function methods expose their receiver. On the parent, `customTimers.setTimeout(...)` binds the timer object as `this`; AVA reports the object where `undefined` was expected. On the fix and current head, `.call(undefined, ...)` makes both assertions pass.

## Local rehearsal evidence

The exact test above was run on 2026-08-29 with dependencies installed once from the parent `package.json` using `npm install --ignore-scripts --no-package-lock --no-audit --no-fund`:

```text
parent f9ced5e18ad81eab24a9a8d0f07bf3002f7bea64: exit 1
  AVA failure at test.js: t.is(this, undefined)
  actual receiver: customTimers object

fix ed58372c62d3dddfe6f58de37558fb132e1a4e9b: exit 0, 1 test passed
head 245066ef7daa5e74024d5b6a188ae599a1b7bfdf: exit 0, 1 test passed
```

This was a local public-repository rehearsal, not Runloop evidence and not a publishable Antibody receipt.

## Runloop proof plan

Historical dependency resolution is mutable because the repository has no lockfile and uses semver ranges. Before the live proof:

1. Create one prewarmed Linux Snapshot after installing the historical dependency tree with lifecycle scripts disabled for the install inspection step, then enable only the exact tested command plan required for proof.
2. Record Node/npm versions and a deterministic inventory/hash of `node_modules` or the resolved package tree.
3. Use that identical Snapshot, architecture, shape, literal environment, and Network Policy for parent and fix lanes.
4. Run baseline `npm test` before applying the patch on both lanes.
5. Upload one patch file and verify the same SHA-256 inside each Devbox.
6. Run the targeted AVA case twice on parent and twice on fix. The parent signature must be identical; both fix runs must pass.
7. Check out captured current head, apply the same patch, run the targeted test and full `npm test`.
8. Persist raw evidence before bounded shutdown and record cleanup for every Devbox.

Suggested targeted argv (the final command must match the prewarmed Snapshot and be recorded verbatim):

```json
["npx", "ava", "test.js", "--match=calls custom timers without a receiver"]
```

No live Runloop or Reflex credentials were used in this Person B rehearsal. Person C must run the budget-bounded live proof with Person A’s adapter and label recorded versus live evidence honestly.
