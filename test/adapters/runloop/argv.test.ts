import {describe, expect, it} from 'vitest';

import {CommandSpecSchema} from '../../../src/contracts/schemas.js';
import {quotePosixArgument, renderPosixCommand} from '../../../src/adapters/runloop/argv.js';

describe('Runloop POSIX argv renderer', () => {
  it.each([
    ['spaces', 'two words', "'two words'"],
    ['single quotes', "it's", `'it'"'"'s'`],
    ['command substitution', '$(touch /tmp/no)', "'$(touch /tmp/no)'"],
    ['backticks', '`touch /tmp/no`', "'`touch /tmp/no`'"],
    ['newlines', 'first\nsecond', "'first\nsecond'"],
    ['globs', '*.ts', "'*.ts'"],
    ['leading dashes', '--preserve-root', "'--preserve-root'"],
    ['Unicode', '雪-🧪', "'雪-🧪'"],
  ])('quotes %s as exactly one shell word', (_label, input, expected) => {
    expect(quotePosixArgument(input)).toBe(expected);
  });

  it('renders explicit sorted env, cwd, timeout and argv boundaries', () => {
    const command = CommandSpecSchema.parse({
      argv: ['node', '-e', 'console.log($(no))', '*.ts'],
      cwd: 'packages/app',
      env: {ZED: 'last', ALPHA: "it's first"},
      timeoutMs: 1_001,
    });

    expect(renderPosixCommand(command, '/home/user/project')).toBe(
      "cd -- '/home/user/project/packages/app' && env -- 'ALPHA=it'\"'\"'s first' 'ZED=last' " +
      "timeout --signal=TERM --kill-after=5s '2s' -- 'node' '-e' 'console.log($(no))' '*.ts'",
    );
  });

  it('rejects NUL bytes before reaching a shell', () => {
    expect(() => quotePosixArgument(`bad${String.fromCodePoint(0)}value`)).toThrow('NUL');
  });
});
