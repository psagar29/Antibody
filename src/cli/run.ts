import {mkdir, readFile} from 'node:fs/promises';
import {basename, dirname, resolve} from 'node:path';

import {Octokit} from '@octokit/rest';
import {Command, CommanderError, InvalidArgumentError} from 'commander';
import packageManifest from '../../package.json' with {type: 'json'};

import {createGitHubDraftPublisher} from '../adapters/github/publisher.js';
import {startDashboard} from '../dashboard/index.js';
import type {ReceiptV1} from '../contracts/index.js';
import {AntibodyError, exitCodeByErrorCode} from '../contracts/index.js';
import {FileAtomicWriter, FileReceiptStore, Redactor} from '../core/receipts/receipt-store.js';
import type {ConfigPreset} from '../composition/config.js';
import {loadConfig, renderDefaultConfig, writeConfig} from '../composition/config.js';
import {runLiveRecovery} from '../composition/live.js';
import {doctor, scanRepository} from '../composition/local.js';
import {runOfflineFixtureDemo} from '../composition/offline-demo.js';
import {renderReceiptHtml} from '../viewer/render.js';

const packageVersion = packageManifest.version;
const presets = ['node-test', 'ava', 'vitest', 'jest', 'pytest'] as const;

export interface CliIo {
  readonly stdout: {write(value: string): unknown};
  readonly stderr: {write(value: string): unknown};
}

interface OutputOptions {
  readonly json?: boolean;
}

export async function runCli(
  argv: readonly string[],
  io: CliIo = {stdout: process.stdout, stderr: process.stderr},
): Promise<number> {
  let commandExitCode = 0;
  const program = new Command()
    .name('antibody')
    .description('Recover and causally verify regression tests omitted from merged bug fixes.')
    .version(packageVersion)
    .showSuggestionAfterError()
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: (value) => io.stdout.write(value),
      writeErr: (value) => io.stderr.write(value),
    });

  program
    .command('init')
    .description('Create a strict .antibody.yml configuration.')
    .argument('[repository]', 'repository path', '.')
    .option('--preset <name>', `test runner preset (${presets.join(', ')})`, parsePreset, 'node-test')
    .option('--force', 'replace an existing configuration', false)
    .action(async (repository: string, options: {preset: ConfigPreset; force: boolean}) => {
      const path = await writeConfig(repository, renderDefaultConfig(options.preset), options.force);
      writeLine(io.stdout, path);
    });

  program
    .command('doctor')
    .description('Check local repository configuration and credential presence.')
    .argument('[repository]', 'repository path', '.')
    .option('--json', 'emit machine-readable JSON', false)
    .action(async (repository: string, options: OutputOptions) => {
      const report = await doctor(repository);
      if (options.json === true) writeJson(io.stdout, report);
      else renderDoctor(report, io.stdout);
      if (!report.ok) commandExitCode = exitCodeByErrorCode.ANTB_INPUT_INVALID;
    });

  program
    .command('scan')
    .description('Rank historical production-only fixes that lack regression tests.')
    .argument('[repository]', 'repository path', '.')
    .option('--limit <count>', 'maximum candidates', parsePositiveInteger, 10)
    .option('--json', 'emit machine-readable JSON', false)
    .action(async (repository: string, options: OutputOptions & {limit: number}) => {
      const candidates = await scanRepository(repository, options.limit);
      if (options.json === true) writeJson(io.stdout, candidates);
      else if (candidates.length === 0) writeLine(io.stdout, 'No eligible candidates.');
      else {
        for (const candidate of candidates) {
          writeLine(
            io.stdout,
            `${candidate.fixSha.slice(0, 12)}  score=${String(candidate.score).padStart(3)}  ${candidate.commit.subject}`,
          );
        }
      }
    });

  addRecoveryCommand(program, 'recover', true, io, (code) => {
    commandExitCode = code;
  });
  addRecoveryCommand(program, 'run', false, io, (code) => {
    commandExitCode = code;
  });

  program
    .command('publish')
    .description('Create an approved draft pull request from a verified receipt.')
    .argument('<receipt-directory>', 'persisted receipt directory or receipt.json')
    .requiredOption('--approve <digest>', 'exact sha256 receipt digest approved by a human')
    .option('--repository <path>', 'repository containing .antibody.yml', '.')
    .option('--json', 'emit machine-readable JSON', false)
    .action(async (
      receiptInput: string,
      options: OutputOptions & {approve: string; repository: string},
    ) => {
      const receiptDirectory = resolveReceiptDirectory(receiptInput);
      const config = await loadConfig(options.repository);
      const receipt = await verifyReceiptDirectory(receiptDirectory);
      const normalizedPatch = await readFile(resolve(receiptDirectory, 'patch.diff'), 'utf8');
      const token = requiredEnvironment(config.publication.tokenEnv);
      const publisher = createGitHubDraftPublisher(new Octokit({auth: token}));
      const record = await publisher.publish({
        receipt,
        approval: options.approve,
        normalizedPatch,
        baseBranch: config.repository.baseBranch,
        branchPrefix: config.publication.branchPrefix,
        labels: config.publication.labels,
      });
      await new FileAtomicWriter().write(
        resolve(receiptDirectory, 'publication.json'),
        Buffer.from(`${JSON.stringify(record, undefined, 2)}\n`, 'utf8'),
      );
      if (options.json === true) writeJson(io.stdout, record);
      else writeLine(io.stdout, `Draft PR: ${record.pullRequestUrl}`);
    });

  const receipt = program.command('receipt').description('Inspect durable proof receipts.');
  receipt
    .command('verify')
    .description('Verify every digest, identity, artifact, and classification in a receipt directory.')
    .argument('<receipt-directory>', 'persisted receipt directory or receipt.json')
    .option('--json', 'emit machine-readable JSON', false)
    .action(async (receiptInput: string, options: OutputOptions) => {
      const receiptDirectory = resolveReceiptDirectory(receiptInput);
      const verified = await verifyReceiptDirectory(receiptDirectory);
      const result = {
        valid: true,
        verdict: verified.verdict,
        runId: verified.runId,
        receiptSha256: (await readFile(resolve(receiptDirectory, 'receipt.sha256'), 'utf8')).trim(),
        directory: receiptDirectory,
      };
      if (options.json === true) writeJson(io.stdout, result);
      else writeLine(io.stdout, `VALID ${result.receiptSha256} ${result.verdict}`);
    });
  receipt
    .command('render')
    .description('Render a verified receipt as a self-contained HTML proof.')
    .argument('<receipt-directory>', 'persisted receipt directory or receipt.json')
    .requiredOption('--output <path>', 'HTML output path')
    .action(async (receiptInput: string, options: {output: string}) => {
      const receiptDirectory = resolveReceiptDirectory(receiptInput);
      const verified = await verifyReceiptDirectory(receiptDirectory);
      const outputPath = resolve(options.output);
      await new FileAtomicWriter().write(outputPath, Buffer.from(renderReceiptHtml(verified), 'utf8'));
      writeLine(io.stdout, outputPath);
    });

  program
    .command('dashboard')
    .description('Browse local proof runs in a read-only dashboard.')
    .argument('[runs-directory]', 'directory containing receipt run directories', '.antibody/runs')
    .option('--host <host>', 'listen host', '127.0.0.1')
    .option('--port <port>', 'listen port (0 chooses an available port)', parsePort, 0)
    .action(async (runsDirectory: string, options: {host: string; port: number}) => {
      const resolvedRunsDirectory = resolve(runsDirectory);
      await mkdir(resolvedRunsDirectory, {recursive: true, mode: 0o700});
      const dashboard = await startDashboard({
        runsDirectory: resolvedRunsDirectory,
        host: options.host,
        port: options.port,
      });
      writeLine(io.stdout, dashboard.url);
      await waitForShutdown(() => dashboard.close());
    });

  const demo = program.command('demo').description('Run deterministic demonstrations.');
  demo
    .command('fixture')
    .description('Run the fully offline simulated fixture and persist its proof.')
    .option('--output <directory>', 'receipt output directory', '.antibody/demo-runs')
    .option('--json', 'emit machine-readable JSON', false)
    .action(async (options: OutputOptions & {output: string}) => {
      const result = await runOfflineFixtureDemo({outputDirectory: resolve(options.output)});
      const summary = {
        simulated: true,
        verdict: result.receipt.verdict,
        receiptSha256: result.receiptSha256,
        directory: result.directory,
      } as const;
      if (options.json === true) writeJson(io.stdout, summary);
      else {
        writeLine(io.stdout, 'SIMULATED OFFLINE FIXTURE');
        writeLine(io.stdout, `${summary.verdict.toUpperCase()} ${summary.receiptSha256}`);
        writeLine(io.stdout, summary.directory);
      }
    });

  try {
    await program.parseAsync([...argv], {from: 'user'});
    return commandExitCode;
  } catch (error: unknown) {
    if (error instanceof CommanderError) return error.exitCode;
    const normalized = normalizeError(error);
    writeJson(io.stderr, normalized.body);
    return normalized.exitCode;
  }
}

function addRecoveryCommand(
  program: Command,
  name: 'recover' | 'run',
  candidateRequired: boolean,
  io: CliIo,
  setExitCode: (code: number) => void,
): void {
  const command = program
    .command(name)
    .description(candidateRequired
      ? 'Recover and causally verify one selected candidate with Reflex and Runloop.'
      : 'Recover and causally verify the best-ranked candidate with Reflex and Runloop.')
    .argument('[repository]', 'repository path', '.');
  if (candidateRequired) command.requiredOption('--candidate <sha-or-id>', 'fix SHA or candidate digest prefix');
  else command.option('--candidate <sha-or-id>', 'override the best-ranked candidate');
  command
    .option('--output <directory>', 'receipt output directory')
    .option('--json', 'emit machine-readable JSON', false)
    .action(async (
      repository: string,
      options: OutputOptions & {candidate?: string; output?: string},
    ) => {
      const result = await runLiveRecovery({
        repositoryPath: repository,
        ...(options.candidate === undefined ? {} : {candidateRef: options.candidate}),
        ...(options.output === undefined ? {} : {outputDirectory: options.output}),
      });
      const summary = {
        verdict: result.receipt.verdict,
        receiptSha256: result.receiptSha256,
        runId: result.receipt.runId,
        candidateId: result.receipt.candidate.candidateId,
        fixSha: result.receipt.candidate.fixSha,
        directory: result.directory,
      };
      if (options.json === true) writeJson(io.stdout, summary);
      else {
        writeLine(io.stdout, `${summary.verdict.toUpperCase()} ${summary.receiptSha256}`);
        writeLine(io.stdout, summary.directory);
      }
      if (result.receipt.verdict === 'rejected') setExitCode(exitCodeByErrorCode.ANTB_PROOF_REJECTED);
      if (result.receipt.verdict === 'inconclusive') setExitCode(exitCodeByErrorCode.ANTB_PROOF_INCONCLUSIVE);
    });
}

function renderDoctor(
  report: Awaited<ReturnType<typeof doctor>>,
  output: CliIo['stdout'],
): void {
  writeLine(output, `${report.ok ? 'OK' : 'NOT READY'} ${report.repositoryPath}`);
  writeLine(output, `Live recovery: ${report.liveReady ? 'ready' : 'not ready'}`);
  writeLine(output, `Node ${report.nodeVersion}; ${report.gitVersion}`);
  writeLine(output, `Config ${report.configValid ? 'valid' : 'missing/invalid'}: ${report.configPath}`);
  writeLine(output, `Origin: ${report.remote ?? 'not configured'}`);
  for (const [name, present] of Object.entries(report.credentials)) {
    writeLine(output, `${present ? 'present' : 'missing'} ${name}`);
  }
}

function receiptStoreFor(directory: string): FileReceiptStore {
  return new FileReceiptStore({baseDirectory: dirname(directory), redactor: new Redactor([])});
}

async function verifyReceiptDirectory(directory: string): Promise<ReceiptV1> {
  try {
    return await receiptStoreFor(directory).verify(directory);
  } catch (error: unknown) {
    throw new AntibodyError('Receipt directory failed integrity verification', {
      code: 'ANTB_INPUT_INVALID',
      category: 'input',
      retryable: false,
      causeCode: 'RECEIPT_INTEGRITY',
      cause: error,
    });
  }
}

function resolveReceiptDirectory(input: string): string {
  const path = resolve(input);
  return basename(path) === 'receipt.json' ? dirname(path) : path;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new AntibodyError(`Required environment variable is missing: ${name}`, {
      code: 'ANTB_INPUT_INVALID',
      category: 'input',
      retryable: false,
    });
  }
  return value;
}

function normalizeError(error: unknown): {
  readonly exitCode: number;
  readonly body: Readonly<Record<string, unknown>>;
} {
  if (error instanceof AntibodyError) {
    return {
      exitCode: exitCodeByErrorCode[error.code],
      body: {
        error: {
          code: error.code,
          category: error.category,
          message: error.message,
          retryable: error.retryable,
          ...(error.causeCode === undefined ? {} : {causeCode: error.causeCode}),
          ...(error.details === undefined ? {} : {details: error.details}),
        },
      },
    };
  }
  const status = httpStatus(error);
  if (status === 401 || status === 403) {
    return {
      exitCode: exitCodeByErrorCode.ANTB_EXTERNAL_AUTH,
      body: {error: {code: 'ANTB_EXTERNAL_AUTH', category: 'external', message: 'External service authorization failed', retryable: false}},
    };
  }
  if (status === 429) {
    return {
      exitCode: exitCodeByErrorCode.ANTB_EXTERNAL_RATE_LIMIT,
      body: {error: {code: 'ANTB_EXTERNAL_RATE_LIMIT', category: 'external', message: 'External service rate limit reached', retryable: true}},
    };
  }
  if (status !== undefined && status >= 500) {
    return {
      exitCode: exitCodeByErrorCode.ANTB_EXTERNAL_UNAVAILABLE,
      body: {error: {code: 'ANTB_EXTERNAL_UNAVAILABLE', category: 'external', message: 'External service is unavailable', retryable: true}},
    };
  }
  return {
    exitCode: exitCodeByErrorCode.ANTB_INTERNAL,
    body: {error: {code: 'ANTB_INTERNAL', category: 'internal', message: safeMessage(error), retryable: false}},
  };
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status: unknown = Reflect.get(error, 'status');
  return typeof status === 'number' ? status : undefined;
}

function parsePreset(value: string): ConfigPreset {
  if ((presets as readonly string[]).includes(value)) return value as ConfigPreset;
  throw new InvalidArgumentError(`expected one of: ${presets.join(', ')}`);
}

function parsePositiveInteger(value: string): number {
  if (!/^\d+$/u.test(value)) throw new InvalidArgumentError('expected a positive integer');
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_000) {
    throw new InvalidArgumentError('expected an integer from 1 to 1000');
  }
  return parsed;
}

function parsePort(value: string): number {
  if (!/^\d+$/u.test(value)) throw new InvalidArgumentError('expected a port number');
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new InvalidArgumentError('expected a port from 0 to 65535');
  }
  return parsed;
}

async function waitForShutdown(close: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    const shutdown = (): void => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      void close().finally(resolvePromise);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected internal error';
}

function writeJson(output: CliIo['stdout'] | CliIo['stderr'], value: unknown): void {
  output.write(`${JSON.stringify(value, undefined, 2)}\n`);
}

function writeLine(output: CliIo['stdout'], value: string): void {
  output.write(`${value}\n`);
}
