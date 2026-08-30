import {spawn} from 'node:child_process';
import {resolve} from 'node:path';

import type {ConfigV1, RecoveryCandidateV1, RepositoryRefV1} from '../contracts/index.js';
import {AntibodyError, RepositoryRefSchema} from '../contracts/index.js';
import {GitHistoryMiner} from '../core/mining/miner.js';

import {configPath, loadConfig} from './config.js';

export interface DoctorReport {
  readonly ok: boolean;
  readonly liveReady: boolean;
  readonly nodeVersion: string;
  readonly gitVersion: string;
  readonly repositoryPath: string;
  readonly configPath: string;
  readonly configValid: boolean;
  readonly remote: string | null;
  readonly credentials: Readonly<Record<string, boolean>>;
}

export async function doctor(repositoryPath: string): Promise<DoctorReport> {
  const resolvedRepository = resolve(repositoryPath);
  const gitVersion = (await run('git', ['--version'], resolvedRepository)).stdout.trim();
  let config: ConfigV1 | undefined;
  try {
    config = await loadConfig(resolvedRepository);
  } catch {
    config = undefined;
  }
  const remoteResult = await run('git', ['config', '--get', 'remote.origin.url'], resolvedRepository, true);
  const credentialNames = config === undefined ? [] : credentialEnvironmentNames(config);
  const credentials = Object.fromEntries(
    credentialNames.map((name) => [name, (process.env[name]?.trim().length ?? 0) > 0]),
  );
  return {
    ok: config !== undefined,
    liveReady: config !== undefined && requiredLiveEnvironmentNames(config).every(
      (name) => credentials[name] === true,
    ),
    nodeVersion: process.version,
    gitVersion,
    repositoryPath: resolvedRepository,
    configPath: configPath(resolvedRepository),
    configValid: config !== undefined,
    remote: remoteResult.exitCode === 0 && remoteResult.stdout.trim() !== ''
      ? safeRemoteDescription(remoteResult.stdout.trim())
      : null,
    credentials,
  };
}

export async function scanRepository(
  repositoryPath: string,
  limit: number,
): Promise<RecoveryCandidateV1[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw inputError('--limit must be an integer from 1 to 1000');
  }
  const resolvedRepository = resolve(repositoryPath);
  const config = await loadConfig(resolvedRepository);
  const repository = await resolveRepositoryRef(resolvedRepository, config);
  const candidates = await new GitHistoryMiner().scan({
    repositoryPath: resolvedRepository,
    repository,
    scan: config.scan,
  });
  return candidates.slice(0, limit);
}

export async function resolveRepositoryRef(
  repositoryPath: string,
  config: ConfigV1,
): Promise<RepositoryRefV1> {
  if (config.repository.slug !== undefined) {
    return RepositoryRefSchema.parse({
      slug: config.repository.slug,
      cloneUrl: `https://github.com/${config.repository.slug}.git`,
    });
  }
  const remote = await run('git', ['config', '--get', 'remote.origin.url'], repositoryPath, true);
  if (remote.exitCode !== 0) throw inputError('Cannot infer repository slug without an origin remote');
  const slug = parseGitHubRepositorySlug(remote.stdout.trim());
  if (slug === undefined) throw inputError('Origin must be a credential-free github.com HTTPS or SSH URL');
  return RepositoryRefSchema.parse({slug, cloneUrl: `https://github.com/${slug}.git`});
}

export function parseGitHubRepositorySlug(remote: string): string | undefined {
  const patterns = [
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u,
    /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u,
    /^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u,
  ];
  for (const pattern of patterns) {
    const slug = pattern.exec(remote)?.[1];
    if (slug !== undefined) return slug;
  }
  return undefined;
}

function safeRemoteDescription(remote: string): string {
  const slug = parseGitHubRepositorySlug(remote);
  return slug === undefined ? '[configured but unsupported]' : `https://github.com/${slug}.git`;
}

function credentialEnvironmentNames(config: ConfigV1): string[] {
  const names = [
    ...requiredLiveEnvironmentNames(config),
    config.publication.tokenEnv,
  ];
  return [...new Set(names)].sort();
}

function requiredLiveEnvironmentNames(config: ConfigV1): string[] {
  return [
    'REFLEX_API_KEY',
    'REFLEX_BASE_URL',
    'REFLEX_ORGANIZATION_ID',
    'RUNLOOP_API_KEY',
    config.authoring.personaIdEnv,
    config.verification.environment.source.idEnv,
    ...(config.verification.environment.networkPolicyIdEnv === undefined
      ? []
      : [config.verification.environment.networkPolicyIdEnv]),
  ];
}

async function run(
  command: string,
  argv: readonly string[],
  cwd: string,
  allowFailure = false,
): Promise<{stdout: string; stderr: string; exitCode: number}> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, argv, {cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe']});
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      const exitCode = code ?? 70;
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode,
      };
      if (exitCode === 0 || allowFailure) resolvePromise(result);
      else reject(inputError(`${command} ${argv.join(' ')} failed`));
    });
  });
}

function inputError(message: string): AntibodyError {
  return new AntibodyError(message, {
    code: 'ANTB_INPUT_INVALID',
    category: 'input',
    retryable: false,
  });
}
