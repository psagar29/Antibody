import {AntibodyError} from '../../contracts/errors.js';
import type {CommandSpecV1} from '../../contracts/schemas.js';

function rejectNul(value: string): void {
  if (value.includes(String.fromCodePoint(0))) {
    throw new AntibodyError('Command arguments must not contain NUL bytes', {
      code: 'ANTB_INPUT_INVALID',
      category: 'input',
      retryable: false,
      causeCode: 'COMMAND_NUL',
    });
  }
}

/** Render one argument as one POSIX-shell word without permitting expansion. */
export function quotePosixArgument(value: string): string {
  rejectNul(value);
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function absoluteCommandCwd(repositoryRoot: string, cwd: string): string {
  rejectNul(repositoryRoot);
  if (!repositoryRoot.startsWith('/') || repositoryRoot.endsWith('/')) {
    throw new AntibodyError('Repository root must be an absolute normalized path', {
      code: 'ANTB_INTERNAL',
      category: 'internal',
      retryable: false,
      causeCode: 'INVALID_REPOSITORY_ROOT',
    });
  }
  return cwd === '.' ? repositoryRoot : `${repositoryRoot}/${cwd}`;
}

/**
 * Runloop's execution API accepts a shell string. This is the only renderer used by
 * the adapter: every untrusted value becomes a single-quoted word, cwd and env are
 * explicit, and GNU timeout is the in-box process deadline.
 */
export function renderPosixCommand(command: CommandSpecV1, repositoryRoot: string): string {
  const cwd = absoluteCommandCwd(repositoryRoot, command.cwd);
  const environment = Object.entries(command.env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => quotePosixArgument(`${name}=${value}`));
  const timeoutSeconds = Math.max(1, Math.ceil(command.timeoutMs / 1000));
  const argv = command.argv.map((argument) => quotePosixArgument(argument));

  return [
    'cd',
    '--',
    quotePosixArgument(cwd),
    '&&',
    'env',
    '--',
    ...environment,
    'timeout',
    '--signal=TERM',
    '--kill-after=5s',
    quotePosixArgument(`${timeoutSeconds}s`),
    '--',
    ...argv,
  ].join(' ');
}
