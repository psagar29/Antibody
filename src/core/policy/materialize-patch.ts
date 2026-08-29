import type {RepoPath} from '../../contracts/index.js';
import {RepoPathSchema} from '../../contracts/index.js';

interface PatchHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: readonly string[];
}

interface FilePatch {
  readonly path: RepoPath;
  readonly isNew: boolean;
  readonly hunks: readonly PatchHunk[];
}

export function materializeUnifiedDiff(
  patch: string,
  baseFiles: ReadonlyMap<string, Buffer | undefined>,
): ReadonlyMap<RepoPath, Buffer> {
  const filePatches = parseFilePatches(patch);
  if (filePatches.length === 0) throw new Error('Approved patch contains no file diffs');
  const materialized = new Map<RepoPath, Buffer>();
  for (const filePatch of filePatches) {
    if (materialized.has(filePatch.path)) throw new Error('Approved patch repeats a file path');
    const baseBytes = baseFiles.get(filePatch.path);
    if (filePatch.isNew && baseBytes !== undefined) {
      throw new Error('Approved new-file patch conflicts with an existing base file');
    }
    if (!filePatch.isNew && baseBytes === undefined) {
      throw new Error('Approved patch base file is missing');
    }
    let baseText = '';
    if (baseBytes !== undefined) {
      try {
        baseText = new TextDecoder('utf-8', {fatal: true}).decode(baseBytes);
      } catch {
        throw new Error('Approved patch base file is not UTF-8 text');
      }
    }
    materialized.set(filePatch.path, Buffer.from(applyFilePatch(baseText, filePatch), 'utf8'));
  }
  return materialized;
}

function parseFilePatches(patch: string): FilePatch[] {
  const lines = patch.split('\n');
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (line.startsWith('diff --git ')) starts.push(index);
  });
  return starts.map((start, index) =>
    parseFilePatch(lines.slice(start, starts[index + 1] ?? lines.length)),
  );
}

function parseFilePatch(lines: readonly string[]): FilePatch {
  const header = lines[0] ?? '';
  const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(header);
  if (match === null || match[1] !== match[2]) {
    throw new Error('Approved patch contains an unsupported file header');
  }
  const path = RepoPathSchema.parse(match[2]);
  const oldMarker = lines.find((line) => line.startsWith('--- '));
  const newMarker = lines.find((line) => line.startsWith('+++ '));
  const isNew = oldMarker === '--- /dev/null';
  if (
    oldMarker === undefined ||
    newMarker !== `+++ b/${path}` ||
    (!isNew && oldMarker !== `--- a/${path}`)
  ) {
    throw new Error('Approved patch markers do not match its file path');
  }
  if (lines.some((line) => line === '\\ No newline at end of file')) {
    throw new Error('Approved patch uses unsupported no-newline semantics');
  }
  const hunks: PatchHunk[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.startsWith('@@ ')) continue;
    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u.exec(line);
    if (hunkMatch === null) throw new Error('Approved patch contains an invalid hunk header');
    const body: string[] = [];
    for (index += 1; index < lines.length; index += 1) {
      const bodyLine = lines[index] ?? '';
      if (bodyLine.startsWith('@@ ')) {
        index -= 1;
        break;
      }
      if (bodyLine === '' && index === lines.length - 1) break;
      if (!bodyLine.startsWith(' ') && !bodyLine.startsWith('+') && !bodyLine.startsWith('-')) {
        throw new Error('Approved patch contains an invalid hunk line');
      }
      body.push(bodyLine);
    }
    hunks.push({
      oldStart: parseCount(hunkMatch[1]),
      oldCount: parseCount(hunkMatch[2] ?? '1'),
      newStart: parseCount(hunkMatch[3]),
      newCount: parseCount(hunkMatch[4] ?? '1'),
      lines: body,
    });
  }
  if (hunks.length === 0) throw new Error('Approved patch contains no hunks');
  return {path, isNew, hunks};
}

function applyFilePatch(baseText: string, filePatch: FilePatch): string {
  const baseHasFinalNewline = baseText.endsWith('\n');
  const baseLines = baseText === ''
    ? []
    : baseText.slice(0, baseHasFinalNewline ? -1 : undefined).split('\n');
  const output: string[] = [];
  let baseIndex = 0;
  let expectedNewIndex = 0;
  for (const hunk of filePatch.hunks) {
    const hunkBaseIndex = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    const hunkNewIndex = hunk.newStart === 0 ? 0 : hunk.newStart - 1;
    if (hunkBaseIndex < baseIndex || hunkNewIndex < expectedNewIndex) {
      throw new Error('Approved patch hunks overlap or are out of order');
    }
    output.push(...baseLines.slice(baseIndex, hunkBaseIndex));
    expectedNewIndex += hunkBaseIndex - baseIndex;
    if (expectedNewIndex !== hunkNewIndex) {
      throw new Error('Approved patch new-file positions are inconsistent');
    }
    baseIndex = hunkBaseIndex;
    let oldConsumed = 0;
    let newProduced = 0;
    for (const line of hunk.lines) {
      const marker = line[0];
      const content = line.slice(1);
      if (marker === ' ' || marker === '-') {
        if (baseLines[baseIndex] !== content) {
          throw new Error('Approved patch context does not match base file');
        }
        baseIndex += 1;
        oldConsumed += 1;
      }
      if (marker === ' ' || marker === '+') {
        output.push(content);
        expectedNewIndex += 1;
        newProduced += 1;
      }
    }
    if (oldConsumed !== hunk.oldCount || newProduced !== hunk.newCount) {
      throw new Error('Approved patch hunk counts are inconsistent');
    }
  }
  output.push(...baseLines.slice(baseIndex));
  return `${output.join('\n')}\n`;
}

function parseCount(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Approved patch count is invalid');
  return parsed;
}
