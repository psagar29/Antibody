import {sha256Canonical} from '../digest.js';

// eslint-disable-next-line no-control-regex -- ANSI control bytes are the normalization target.
const ansiPattern = /\u001B\[[0-?]*[ -/]*[@-~]/gu;
const isoTimestampPattern = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu;
const uuidPattern = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu;
const temporaryPathPattern = /(?:[A-Za-z]:)?\/(?:[^\s/:]+\/)*(?:AppData\/Local\/Temp|tmp|var\/tmp)\/[^\s:]+/giu;
const absolutePathPattern = /(?:[A-Za-z]:\/|\/)(?:[^\s/:]+\/)+[^\s:]+/gu;
const lineColumnPattern = /:(?:\d+)(?::\d+)?\b/gu;

export type FailureSignatureInput = Readonly<{
	errorType: string;
	message: string;
	operator: string;
	testNames: readonly string[];
	frame: string;
}>;

export function stripAnsi(value: string): string {
	return value.replaceAll(ansiPattern, '');
}

export function normalizeVolatileText(value: string): string {
	return stripAnsi(value)
		.replaceAll('\\', '/')
		.replaceAll(isoTimestampPattern, '<timestamp>')
		.replaceAll(uuidPattern, '<id>')
		.replaceAll(temporaryPathPattern, '<tmp>')
		.replaceAll(absolutePathPattern, '<external-path>')
		.replaceAll(lineColumnPattern, ':<line>:<column>')
		.replaceAll(/\s+/gu, ' ')
		.trim();
}

export function firstProjectFrame(value: string): string {
	const normalized = stripAnsi(value).replaceAll('\\', '/');
	const match = /((?:test|tests|src)\/[A-Za-z0-9_.@/-]+):\d+(?::\d+)?/u.exec(normalized);
	return match === null ? '' : `${match[1] ?? ''}:<line>:<column>`;
}

export function normalizedFailureSignature(input: FailureSignatureInput) {
	const tuple = {
		errorType: normalizeVolatileText(input.errorType),
		frame: firstProjectFrame(input.frame),
		message: normalizeVolatileText(input.message),
		operator: normalizeVolatileText(input.operator),
		testNames: [...new Set(input.testNames.map(name => normalizeVolatileText(name)))].sort(),
	};
	return sha256Canonical(tuple);
}
