import {describe, expect, it} from 'vitest';

import {CommandSpecSchema} from '../../../src/contracts/index.js';
import {withTargetPaths} from '../../../src/adapters/runloop/adapter.js';

function command(argv: readonly [string, ...string[]]) {
  return CommandSpecSchema.parse({argv, cwd: '.', env: {}, timeoutMs: 60_000});
}

describe('Runloop targeted command selection', () => {
  it.each([
    [['node', '--test'], ['node', '--test', 'test/target.test.js']],
    [['npx', 'vitest', 'run'], ['npx', 'vitest', 'run', 'test/target.test.js']],
    [['pytest', '-q'], ['pytest', '-q', 'test/target.test.js']],
  ] as const)('appends generated test paths only for path-aware runners', (argv, expected) => {
    expect(withTargetPaths(command(argv), ['test/target.test.js']).argv).toEqual(expected);
  });

  it('preserves an opaque targeted command when file arguments would change its meaning', () => {
    const configured = command(['mvn', 'test']);
    expect(withTargetPaths(configured, ['src/test/java/TargetTest.java'])).toBe(configured);
  });
});
