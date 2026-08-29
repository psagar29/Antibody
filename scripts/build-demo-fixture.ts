import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const repositorySlug = 'antibody/demo-history';
const identity = 'Antibody Fixture <fixture@antibody.invalid>';

interface CommitFile {
  readonly path: string;
  readonly content: string;
}

interface FixtureExpected {
  readonly schemaVersion: 'antibody.demo-history/v1';
  readonly shas: {
    readonly base: string;
    readonly docs: string;
    readonly fix: string;
    readonly head: string;
  };
  readonly candidateOrder: readonly string[];
  readonly candidateId: string;
  readonly patchSha256: string;
  readonly normalizedParentSignature: string;
  readonly changedPaths: readonly string[];
  readonly verdict: 'verified';
}

function data(value: string): string {
  return `data ${Buffer.byteLength(value, 'utf8')}\n${value}\n`;
}

function fileCommands(files: readonly CommitFile[]): string {
  return files
    .map((file) => `M 100644 inline ${file.path}\n${data(file.content)}`)
    .join('');
}

function commit(options: {
  readonly mark: number;
  readonly parentMark?: number;
  readonly timestamp: number;
  readonly message: string;
  readonly files: readonly CommitFile[];
}): string {
  const parent = options.parentMark === undefined ? '' : `from :${options.parentMark}\n`;
  return [
    'commit refs/heads/main\n',
    `mark :${options.mark}\n`,
    `author ${identity} ${options.timestamp} +0000\n`,
    `committer ${identity} ${options.timestamp} +0000\n`,
    data(options.message),
    parent,
    fileCommands(options.files),
    '\n',
  ].join('');
}

export function buildFixtureStream(): string {
  const packageJson = `${JSON.stringify(
    {
      name: 'antibody-demo-history',
      private: true,
      type: 'module',
      scripts: {test: 'node --test'},
    },
    undefined,
    2,
  )}\n`;
  const buggySlug = [
    'export function slugify(value) {',
    "  return value.trim().toLowerCase().replace(' ', '-');",
    '}',
    '',
  ].join('\n');
  const fixedSlug = [
    'export function slugify(value) {',
    "  return value.trim().toLowerCase().replace(/\\s+/gu, '-');",
    '}',
    '',
  ].join('\n');
  const compatibleHead = [
    "export const slugSeparator = '-';",
    '',
    'export function slugify(value) {',
    '  return value.trim().toLowerCase().replace(/\\s+/gu, slugSeparator);',
    '}',
    '',
  ].join('\n');
  const initialTest = [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    '',
    "import {slugify} from '../src/slug.js';",
    '',
    "test('slugifies two words', () => {",
    "  assert.equal(slugify('Hello World'), 'hello-world');",
    '});',
    '',
  ].join('\n');

  return [
    'feature done\n',
    commit({
      mark: 1,
      timestamp: 1_704_067_200,
      message: 'feat: add slug helper',
      files: [
        {path: 'package.json', content: packageJson},
        {path: 'src/slug.js', content: buggySlug},
        {path: 'test/slug.test.js', content: initialTest},
      ],
    }),
    commit({
      mark: 2,
      parentMark: 1,
      timestamp: 1_704_153_600,
      message: 'docs: explain slug output',
      files: [{path: 'README.md', content: '# Slugs\n\nLowercase words joined by hyphens.\n'}],
    }),
    commit({
      mark: 3,
      parentMark: 2,
      timestamp: 1_704_240_000,
      message: 'fix: collapse repeated whitespace in slugs',
      files: [{path: 'src/slug.js', content: fixedSlug}],
    }),
    commit({
      mark: 4,
      parentMark: 3,
      timestamp: 1_704_326_400,
      message: 'refactor: name the slug separator',
      files: [{path: 'src/slug.js', content: compatibleHead}],
    }),
    'done\n',
  ].join('');
}

async function runGit(
  repositoryPath: string,
  arguments_: readonly string[],
  input?: string,
): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn('git', arguments_, {
      cwd: repositoryPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`git ${arguments_.join(' ')} failed: ${Buffer.concat(stderr).toString('utf8')}`));
        return;
      }
      resolvePromise(Buffer.concat(stdout).toString('utf8'));
    });
    child.stdin.end(input);
  });
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export async function buildDemoFixture(outputDirectory: string): Promise<FixtureExpected> {
  const stream = buildFixtureStream();
  const temporaryRepository = await mkdtemp(join(tmpdir(), 'antibody-demo-history-'));
  try {
    await runGit(temporaryRepository, ['init', '--initial-branch=main']);
    await runGit(temporaryRepository, ['fast-import', '--date-format=raw'], stream);
    const shas = (await runGit(temporaryRepository, ['rev-list', '--reverse', 'main']))
      .trim()
      .split('\n');
    if (shas.length !== 4 || shas.some((sha) => !/^[0-9a-f]{40}$/u.test(sha))) {
      throw new Error('Fixture import did not produce exactly four full commit SHAs');
    }
    const [base, docs, fix, head] = shas;
    if (base === undefined || docs === undefined || fix === undefined || head === undefined) {
      throw new Error('Fixture commit SHAs are incomplete');
    }

    await runGit(temporaryRepository, ['checkout', '--detach', fix]);
    const testPath = join(temporaryRepository, 'test/slug.test.js');
    const existingTest = await readFile(testPath, 'utf8');
    const recoveredTest = [
      existingTest.trimEnd(),
      '',
      "test('collapses repeated whitespace', () => {",
      "  assert.equal(slugify('Hello   World'), 'hello-world');",
      '});',
      '',
    ].join('\n');
    await writeFile(testPath, recoveredTest, {encoding: 'utf8', mode: 0o600});
    const patch = await runGit(temporaryRepository, [
      'diff',
      '--no-ext-diff',
      '--no-color',
      '--binary',
      '--',
      'test/slug.test.js',
    ]);

    const expected: FixtureExpected = {
      schemaVersion: 'antibody.demo-history/v1',
      shas: {base, docs, fix, head},
      candidateOrder: [fix, head],
      candidateId: sha256(`${repositorySlug}\u0000${docs}\u0000${fix}`),
      patchSha256: sha256(patch),
      normalizedParentSignature: sha256(
        [
          'collapses repeated whitespace',
          'assertion-failure',
          'strictEqual',
          'Expected values to be strictly equal',
          'test/slug.test.js',
        ].join('\u0000'),
      ),
      changedPaths: ['test/slug.test.js'],
      verdict: 'verified',
    };

    await mkdir(outputDirectory, {recursive: true});
    await writeFile(join(outputDirectory, 'history.fi'), stream, {encoding: 'utf8', mode: 0o600});
    await writeFile(join(outputDirectory, 'recovered-test.patch'), patch, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await writeFile(join(outputDirectory, 'expected.json'), `${JSON.stringify(expected, undefined, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    return expected;
  } finally {
    await rm(temporaryRepository, {recursive: true, force: true});
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const outputDirectory = resolve(process.argv[2] ?? 'fixtures/demo-history');
  await buildDemoFixture(outputDirectory);
}
