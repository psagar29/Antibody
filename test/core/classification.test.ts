import {createHash} from 'node:crypto';

import {describe, expect, it} from 'vitest';

import {RawExecutionAttemptSchema} from '../../src/contracts/index.js';
import {classifyAttempt} from '../../src/core/classification/classifier.js';

const digest = `sha256:${'a'.repeat(64)}`;

function artifact(name: string, content: string) {
  const bytes = Buffer.from(content);
  return {
    name,
    mediaType: 'text/plain',
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    sizeBytes: bytes.byteLength,
    contentBase64: bytes.toString('base64'),
  };
}

function attempt(options: {
  report?: string;
  exitCode?: number;
  termination?: 'exited' | 'timed-out' | 'signaled' | 'platform-error';
  stderr?: string;
  phase?: 'baseline' | 'candidate' | 'full-suite';
}) {
  return RawExecutionAttemptSchema.parse({
    lane: 'parent',
    phase: options.phase ?? 'candidate',
    attempt: 0,
    checkoutSha: '1'.repeat(40),
    patchSha256: digest,
    command: {argv: ['node', '--test'], cwd: '.', env: {}, timeoutMs: 60_000},
    startedAt: '2026-08-29T00:00:00.000Z',
    finishedAt: '2026-08-29T00:00:01.000Z',
    durationMs: 1000,
    termination: options.termination ?? 'exited',
    exitCode: options.exitCode ?? 1,
    stdout: artifact('stdout', ''),
    stderr: artifact('stderr', options.stderr ?? ''),
    ...(options.report === undefined ? {} : {report: artifact('report', options.report)}),
    provider: {devboxId: 'devbox-1'},
  });
}

const tapAssertion = [
  'TAP version 13',
  'not ok 1 - collapses repeated whitespace',
  '  error: |- ',
  '    Expected values to be strictly equal:',
  "  code: 'ERR_ASSERTION'",
  "  name: 'AssertionError'",
  "  operator: 'strictEqual'",
  '  stack: |- ',
  '    TestContext.<anonymous> (/tmp/work/test/slug.test.js:12:10)',
  '1..1',
].join('\n');

describe('framework classifiers', () => {
  it.each([
    ['tap', tapAssertion],
    [
      'junit',
      '<testsuite><testcase name="collapses repeated whitespace"><failure type="AssertionError" message="Expected values to be strictly equal">at /tmp/work/test/slug.test.js:12:10 operator: strictEqual</failure></testcase></testsuite>',
    ],
    [
      'vitest-json',
      JSON.stringify({testResults: [{assertionResults: [{fullName: 'collapses repeated whitespace', status: 'failed', failureMessages: ['AssertionError: Expected values to be strictly equal\n at /tmp/work/test/slug.test.js:12:10\noperator: strictEqual']}]}]}),
    ],
    [
      'jest-json',
      JSON.stringify({testResults: [{assertionResults: [{fullName: 'collapses repeated whitespace', status: 'failed', failureMessages: ['AssertionError: Expected values to be strictly equal\n at /tmp/work/test/slug.test.js:12:10\noperator: strictEqual']}]}]}),
    ],
    [
      'pytest-text',
      'FAILED test/test_slug.py::test_collapses_repeated_whitespace - AssertionError: Expected values to be strictly equal\n at /tmp/work/test/slug.test.js:12:10\noperator: strictEqual',
    ],
  ] as const)('classifies target assertions from %s', (format, report) => {
    const target = format === 'pytest-text' ? 'test_collapses_repeated_whitespace' : 'collapses repeated whitespace';
    const classified = classifyAttempt(attempt({report}), format, [target]);
    expect(classified.outcome).toBe('assertion-failure');
    expect(classified.signature).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('matches the deterministic fixture signature and ignores volatile noise', () => {
    const first = classifyAttempt(attempt({report: tapAssertion}), 'tap', ['collapses repeated whitespace']);
    const noisy = tapAssertion
      .replace('/tmp/work', '/private/tmp/random-run')
      .replace('12:10', '999:3')
      .concat('\nrun 550e8400-e29b-41d4-a716-446655440000 at 2026-08-29T04:05:06Z');
    const second = classifyAttempt(attempt({report: noisy}), 'tap', ['collapses repeated whitespace']);
    expect(first.signature).toBe(second.signature);
    const expected = {
      signature: `sha256:${createHash('sha256')
        .update(
          [
            'collapses repeated whitespace',
            'assertion-failure',
            'strictEqual',
            'Expected values to be strictly equal',
            'test/slug.test.js',
          ].join('\u0000'),
        )
        .digest('hex')}`,
    };
    expect(first.signature).toBe(expected.signature);
  });

  it('normalizes external paths across operating systems', () => {
    const unix = [
      'TAP version 13',
      'not ok 1 - target',
      'TypeError: cannot open /home/alice/cache/state.json',
      ' at /home/alice/repo/test/target.test.js:4:2',
      '1..1',
    ].join('\n');
    const windows = [
      'TAP version 13',
      'not ok 1 - target',
      String.raw`TypeError: cannot open C:\Users\runner\cache\state.json`,
      String.raw` at C:\Users\runner\repo\test\target.test.js:91:17`,
      '1..1',
    ].join('\n');

    const first = classifyAttempt(attempt({report: unix}), 'tap', ['target']);
    const second = classifyAttempt(attempt({report: windows}), 'tap', ['target']);
    expect(first.signature).toBe(second.signature);
  });

  it.each([
    ['pass', attempt({report: 'TAP version 13\nok 1 - target\n1..1', exitCode: 0}), 'tap'],
    ['unrelated-test-failure', attempt({report: 'TAP version 13\nnot ok 1 - other test\nAssertionError\n1..1'}), 'tap'],
    ['collection-failure', attempt({report: 'bad', stderr: 'No tests found'}), 'tap'],
    ['build-failure', attempt({report: 'bad', stderr: 'Build failed'}), 'tap'],
    ['dependency-failure', attempt({report: 'bad', stderr: 'Cannot find module x'}), 'tap'],
    ['timeout', attempt({termination: 'timed-out'}), 'tap'],
    ['crash', attempt({termination: 'signaled'}), 'tap'],
    ['platform-failure', attempt({termination: 'platform-error'}), 'tap'],
    ['unknown-failure', attempt({report: 'malformed'}), 'tap'],
  ] as const)('classifies %s', (outcome, rawAttempt, format) => {
    expect(classifyAttempt(rawAttempt, format, ['target']).outcome).toBe(outcome);
  });

  it('classifies a target thrown error as behavioral', () => {
    const report = 'TAP version 13\nnot ok 1 - target\nTypeError: illegal invocation\n at /tmp/work/test/a.test.js:4:2\n1..1';
    expect(classifyAttempt(attempt({report}), 'tap', ['target']).outcome).toBe('behavioral-failure');
  });

  it('never treats an empty target list as proof of a target failure', () => {
    expect(classifyAttempt(attempt({report: tapAssertion}), 'tap', []).outcome).toBe(
      'unrelated-test-failure',
    );
  });

  it('never accepts a passing report that omitted the generated target', () => {
    const report = 'TAP version 13\nok 1 - unrelated test\n1..1';
    expect(classifyAttempt(attempt({report, exitCode: 0}), 'tap', ['target']).outcome).toBe(
      'collection-failure',
    );
  });
});
