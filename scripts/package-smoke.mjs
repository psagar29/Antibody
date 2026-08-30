import {spawn} from 'node:child_process';
import {Buffer} from 'node:buffer';
import {access, mkdtemp, mkdir, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'antibody-package-smoke-'));

try {
  const packDirectory = join(temporaryRoot, 'pack');
  const projectDirectory = join(temporaryRoot, 'project');
  const runsDirectory = join(temporaryRoot, 'runs');
  await Promise.all([
    mkdir(packDirectory),
    mkdir(projectDirectory),
    mkdir(runsDirectory),
  ]);

  await run('npm', [
    'pack',
    '--silent',
    '--pack-destination',
    packDirectory,
  ], root);
  const tarballs = (await readdir(packDirectory)).filter((name) => name.endsWith('.tgz'));
  if (tarballs.length !== 1 || tarballs[0] !== 'psagar29-antibody-0.1.0.tgz') {
    throw new Error(`npm pack produced unexpected files: ${tarballs.join(', ')}`);
  }
  const tarball = join(packDirectory, tarballs[0]);
  await writeFile(join(projectDirectory, 'package.json'), '{"private":true,"type":"module"}\n');
  await run('npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    tarball,
  ], projectDirectory);

  const installedPackage = join(projectDirectory, 'node_modules', '@psagar29', 'antibody');
  for (const required of [
    'dist/cli.js',
    'dist/contracts.js',
    'dist/index.js',
    'fixtures/demo-history/history.fi',
    'schemas/receipt-v1.schema.json',
    'LICENSE',
    'NOTICE',
    'THIRD_PARTY_NOTICES.md',
  ]) {
    await access(join(installedPackage, required));
  }

  const binary = join(projectDirectory, 'node_modules', '.bin', 'antibody');
  await access(binary);
  const version = (await run(binary, ['--version'], projectDirectory)).stdout.trim();
  if (version !== '0.1.0') throw new Error(`Installed binary reported version ${version}`);

  const demo = JSON.parse((await run(binary, [
    'demo',
    'fixture',
    '--output',
    runsDirectory,
    '--json',
  ], projectDirectory)).stdout);
  if (demo.simulated !== true || demo.verdict !== 'verified') {
    throw new Error('Offline demo did not report a simulated verified result');
  }
  if (typeof demo.directory !== 'string' || !demo.directory.startsWith(`${runsDirectory}/`)) {
    throw new Error('Offline demo wrote outside the isolated runs directory');
  }

  const verification = JSON.parse((await run(binary, [
    'receipt',
    'verify',
    demo.directory,
    '--json',
  ], projectDirectory)).stdout);
  if (verification.valid !== true || verification.receiptSha256 !== demo.receiptSha256) {
    throw new Error('Installed binary could not verify its offline-demo receipt');
  }

  process.stdout.write(`package smoke passed: ${tarballs[0]}\n`);
} finally {
  await rm(temporaryRoot, {recursive: true, force: true});
}

async function run(command, argv, cwd) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, argv, {
      cwd,
      env: {...process.env, NO_COLOR: '1'},
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (code === 0) resolvePromise(result);
      else reject(new Error(`${command} failed with exit code ${code}: ${result.stderr.trim()}`));
    });
  });
}
