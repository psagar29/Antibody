import {readFile, readdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

import {toJSONSchema} from 'zod';

import {contractSchemas} from '../dist/index.js';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaDirectory = path.join(rootDirectory, 'schemas');
const checkOnly = process.argv.includes('--check');

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }

  return value;
}

function serializeSchema(name, schema) {
  const jsonSchema = toJSONSchema(schema, {
    target: 'draft-2020-12',
    unrepresentable: 'any',
  });

  return `${JSON.stringify(
    sortJson({
      ...jsonSchema,
      $id: `https://github.com/psagar29/Antibody/schemas/${name}.schema.json`,
    }),
    null,
    2,
  )}\n`;
}

const expectedFiles = new Set();
const mismatches = [];

for (const [name, schema] of Object.entries(contractSchemas)) {
  const filename = `${name}.schema.json`;
  expectedFiles.add(filename);
  const destination = path.join(schemaDirectory, filename);
  const expected = serializeSchema(name, schema);

  if (checkOnly) {
    const actual = await readFile(destination, 'utf8').catch(() => undefined);
    if (actual !== expected) {
      mismatches.push(filename);
    }
  } else {
    await writeFile(destination, expected, 'utf8');
  }
}

const existingFiles = await readdir(schemaDirectory);
const unexpectedFiles = existingFiles.filter(
  (filename) => filename.endsWith('.schema.json') && !expectedFiles.has(filename),
);

if (unexpectedFiles.length > 0) {
  mismatches.push(...unexpectedFiles.map((filename) => `${filename} (unexpected)`));
}

if (mismatches.length > 0) {
  console.error(`Generated schemas are stale: ${mismatches.join(', ')}`);
  process.exitCode = 1;
}
