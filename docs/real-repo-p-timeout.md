# Real repository demonstration: `sindresorhus/p-timeout`

This runbook specifies the real-repository Antibody demonstration without publishing to upstream.

## Historical target

- Repository: <https://github.com/sindresorhus/p-timeout>
- Issue: <https://github.com/sindresorhus/p-timeout/issues/45>
- Parent: `f9ced5e18ad81eab24a9a8d0f07bf3002f7bea64`
- Fix: `ed58372c62d3dddfe6f58de37558fb132e1a4e9b`
- Inspected upstream HEAD: `245066ef7daa5e74024d5b6a188ae599a1b7bfdf`
- License: MIT (`license: "MIT"` in `package.json` and the upstream `license` file)

The fix changes only `index.js` (+4/−2). It invokes both custom timer functions with `.call(undefined, ...)`. The parent invokes them as object properties, so ordinary functions observe the `customTimers` object as `this`.

The historical package is `p-timeout` 7.0.0, requires Node 20 or newer, runs `xo && ava && tsd`, and declares ranges such as AVA `^6.4.1`. It has no committed lockfile. A fresh install today is therefore not the same dependency environment that existed when the fix landed. Dependency drift must not be confused with product behavior.

## Recovered AVA test

Add the following behavior-specific test beside the existing `accepts customTimers option` coverage in `test.js`. Method shorthand is intentional: these are normal functions whose receiver is observable, not arrows.

```js
test('calls custom timers without a receiver', async t => {
	t.plan(2);

	await pTimeout(delay(50), {
		milliseconds: 123,
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

The target is the receiver contract, not implementation text. The parent must fail the new test because at least one custom timer receives the options object. The fix and current upstream code must pass.

The expected normalized parent signature retains:

- test name: `calls custom timers without a receiver`;
- error type: AVA assertion failure / `AssertionError`;
- operator: equality (`is`/strict equality as emitted by the selected AVA reporter);
- first project frame: `test.js:<line>:<column>`;
- message: the receiver was expected to be `undefined`.

Volatile absolute paths, line numbers, timing, ANSI, temporary-directory names, and identifiers are normalized. Two parent repetitions must yield the exact same canonical signature; the exit code alone is not evidence.

## Shared prewarmed Runloop Snapshot

Use one Linux x86_64 Runloop Snapshot for every lane. Seed it once with Node 20+ and one successful install at the target repository state, then freeze the resulting repository cache and `node_modules`. Record `node --version`, `npm --version`, and `npm ls --all` as snapshot provenance. Do not run independent fresh dependency resolution in the parent and fix lanes.

The Snapshot strategy is the environmental control necessitated by the missing lockfile:

1. Create a disposable seed Devbox from the configured Blueprint.
2. Clone the repository and fetch the parent, fix, and current commits.
3. Check out the fix detached and run `npm install --ignore-scripts=false` once.
4. Run the unmodified suite once to prove the seed is usable.
5. Capture a Snapshot and configure every causal lane from that exact Snapshot ID, architecture, shape, and Network Policy.
6. Record resolved Snapshot/Network Policy provenance in raw evidence and compare it before adjudication.

Runloop ordinary executions start fresh shells, so every operation supplies explicit cwd and environment. Use an in-box timeout plus the controller deadline; an optimistic SDK wait is not a kill switch.

## Exact lane commands

In a prewarmed lane, use argv commands equivalent to the following. Substitute the full lane SHA; never interpolate an untrusted ref into a shell string.

```text
["git", "checkout", "--detach", "<full-lane-sha>"]
["git", "rev-parse", "HEAD"]
["git", "status", "--porcelain=v1", "-z"]
["git", "apply", "--check", "candidate.diff"]
["git", "apply", "candidate.diff"]
["npm", "exec", "--", "ava", "test.js", "--match=calls custom timers without a receiver", "--tap"]
```

Run the targeted AVA command twice on the parent and twice on the fix. Run it on current HEAD after the two historical lanes establish the red/green relation. On current HEAD also run the configured full suite:

```text
["npm", "test"]
```

For each lane, verify `git rev-parse HEAD` is the requested full SHA before applying the patch. Hash the patch in the controller and in the lane, retain bounded complete reporter output, and treat truncation or malformed TAP as inconclusive. The expected result is:

| Lane | Targeted result |
|---|---|
| Parent `f9ced5e…` | stable assertion failure in both repetitions |
| Fix `ed58372…` | pass in both repetitions |
| Inspected/current HEAD | targeted pass and full-suite pass |

## Publication safety

The upstream repository is read-only for this demo. Configure Antibody's `RepositoryRef` and GitHub write token for a writable fork, keep the upstream SHAs in the receipt, and set the fork's base branch to a commit containing the captured verified HEAD. The publisher must stop if that branch moves, require the exact receipt digest approval, create a draft PR only, and never merge or force-push.

Retain the upstream MIT license and attribution. The recovered test may be proposed to the writable fork; no claim is made that Antibody has permission to publish directly to `sindresorhus/p-timeout`.
