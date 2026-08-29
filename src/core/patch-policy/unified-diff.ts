import {z} from 'zod';

import {RepoPathSchema, type RepoPath} from '../../contracts/index.js';
import {normalizeLf} from '../digest.js';

const diffHeaderPattern = /^diff --git a\/([^\s]+) b\/([^\s]+)$/u;
const hunkHeaderPattern = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(?: .*)?$/u;
const modePattern = /^(?:old mode|new mode|new file mode|deleted file mode) ([0-7]{6})$/u;

export type UnifiedDiffFile = Readonly<{
	oldPath: RepoPath | null;
	newPath: RepoPath | null;
	modes: readonly string[];
	isBinary: boolean;
	isRenameOrCopy: boolean;
	isDeleted: boolean;
	addedLines: number;
	deletedLines: number;
	addedExecutableTestLines: number;
}>;

export type UnifiedDiff = Readonly<{
	text: string;
	files: readonly UnifiedDiffFile[];
	addedLines: number;
	deletedLines: number;
}>;

function parseHeaderPath(value: string, expectedPrefix: 'a/' | 'b/'): RepoPath | null {
	if (value === '/dev/null') {
		return null;
	}

	if (!value.startsWith(expectedPrefix)) {
		throw new Error(`Expected ${expectedPrefix} path in unified diff header`);
	}

	return RepoPathSchema.parse(value.slice(expectedPrefix.length));
}

function isExecutableTestLine(value: string): boolean {
	return /(?:\b(?:test|it|describe)\s*\(|\b(?:assert|expect)\s*[.(]|\bpytest\b|\bunittest\b|\bTest[A-Z]\w*)/u.test(
		value,
	);
}

function parseFileBlock(lines: readonly string[]): UnifiedDiffFile {
	const firstLine = z.string().parse(lines[0]);
	const headerMatch = diffHeaderPattern.exec(firstLine);
	if (headerMatch === null) {
		throw new Error('Malformed diff --git header');
	}

	const headerOldPath = RepoPathSchema.parse(headerMatch[1]);
	const headerNewPath = RepoPathSchema.parse(headerMatch[2]);
	const modes: string[] = [];
	let oldPath: RepoPath | null | undefined;
	let newPath: RepoPath | null | undefined;
	let isBinary = false;
	let isRenameOrCopy = false;
	let isDeleted = false;
	let addedLines = 0;
	let deletedLines = 0;
	let addedExecutableTestLines = 0;
	let inHunk = false;

	for (const line of lines.slice(1)) {
		const modeMatch = modePattern.exec(line);
		if (modeMatch !== null) {
			modes.push(z.string().length(6).parse(modeMatch[1]));
			if (line.startsWith('deleted file mode')) {
				isDeleted = true;
			}
			continue;
		}

		if (line.startsWith('rename from ') || line.startsWith('rename to ')
			|| line.startsWith('copy from ') || line.startsWith('copy to ')
			|| line.startsWith('similarity index ')) {
			isRenameOrCopy = true;
			continue;
		}

		if (line === 'GIT binary patch' || line.startsWith('Binary files ')) {
			isBinary = true;
			continue;
		}

		if (line.startsWith('--- ')) {
			oldPath = parseHeaderPath(line.slice(4), 'a/');
			continue;
		}

		if (line.startsWith('+++ ')) {
			newPath = parseHeaderPath(line.slice(4), 'b/');
			continue;
		}

		if (hunkHeaderPattern.test(line)) {
			inHunk = true;
			continue;
		}

		if (!inHunk) {
			continue;
		}

		if (line.startsWith('+')) {
			addedLines += 1;
			if (isExecutableTestLine(line.slice(1))) {
				addedExecutableTestLines += 1;
			}
		} else if (line.startsWith('-')) {
			deletedLines += 1;
		} else if (line !== '' && !line.startsWith(' ') && line !== '\\ No newline at end of file') {
			throw new Error('Malformed unified diff hunk body');
		}
	}

	if (oldPath === undefined || newPath === undefined) {
		throw new Error('Unified diff file is missing --- or +++ path headers');
	}

	if (oldPath !== null && oldPath !== headerOldPath) {
		throw new Error('Old path does not match diff --git header');
	}

	if (newPath !== null && newPath !== headerNewPath) {
		throw new Error('New path does not match diff --git header');
	}

	if (oldPath === null && newPath === null) {
		throw new Error('Unified diff cannot use /dev/null for both paths');
	}

	return {
		oldPath,
		newPath,
		modes,
		isBinary,
		isRenameOrCopy,
		isDeleted: isDeleted || newPath === null,
		addedLines,
		deletedLines,
		addedExecutableTestLines,
	};
}

export function parseUnifiedDiff(value: string): UnifiedDiff {
	const text = normalizeLf(value);
	if (text.trim().length === 0) {
		throw new Error('Unified diff is empty');
	}

	if (text.includes('\0')) {
		throw new Error('Unified diff contains NUL');
	}

	const lines = text.split('\n');
	const blocks: string[][] = [];
	let current: string[] | undefined;
	for (const line of lines) {
		if (line.startsWith('diff --git ')) {
			current = [line];
			blocks.push(current);
		} else if (current !== undefined) {
			current.push(line);
		} else if (line.trim().length > 0) {
			throw new Error('Unified diff has content before its first file header');
		}
	}

	if (blocks.length === 0) {
		throw new Error('Unified diff contains no file blocks');
	}

	const files = blocks.map(block => parseFileBlock(block));
	return {
		text,
		files,
		addedLines: files.reduce((total, file) => total + file.addedLines, 0),
		deletedLines: files.reduce((total, file) => total + file.deletedLines, 0),
	};
}
