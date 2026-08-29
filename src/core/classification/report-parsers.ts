import {z} from 'zod';

export type ParsedTestReport = Readonly<{
	status: 'pass' | 'failure' | 'malformed';
	failingTestNames: readonly string[];
	errorType: string;
	message: string;
	operator: string;
	rawFailure: string;
}>;

function malformed(): ParsedTestReport {
	return {
		status: 'malformed',
		failingTestNames: [],
		errorType: '',
		message: '',
		operator: '',
		rawFailure: '',
	};
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values.map(value => value.trim()).filter(value => value.length > 0))];
}

function extractCommonFailureFields(value: string): Readonly<{
	errorType: string;
	message: string;
	operator: string;
}> {
	const errorType = /\b(AssertionError|AssertionError \[[^\]]+\]|TypeError|ReferenceError|RangeError|SyntaxError|ImportError|ModuleNotFoundError|[A-Za-z]+Error)\b/u.exec(value)?.[1] ?? '';
	const yamlName = /^\s*name:\s*['"]?([^'"\r\n]+)['"]?\s*$/mu.exec(value)?.[1] ?? '';
	const message = /^\s*error:\s*\|-\s*\r?\n\s*([^\r\n]+)/mu.exec(value)?.[1]
		?? /^\s*(?:message|error):\s*['"]?([^'"\r\n]+)['"]?\s*$/mu.exec(value)?.[1]
		?? /\b(?:AssertionError|TypeError|ReferenceError|RangeError|SyntaxError|ImportError|ModuleNotFoundError):\s*([^\r\n]+)/u.exec(value)?.[1]
		?? '';
	const operator = /^\s*operator:\s*['"]?([^'"\r\n]+)['"]?\s*$/mu.exec(value)?.[1] ?? '';
	return {errorType: errorType === '' ? yamlName : errorType, message, operator};
}

export function parseTapReport(value: string): ParsedTestReport {
	if (!/^TAP version \d+/mu.test(value) && !/^\s*(?:not )?ok \d+/mu.test(value)) {
		return malformed();
	}

	const failures = unique([...value.matchAll(/^\s*not ok \d+\s+-\s+(.+?)\s*$/gmu)]
		.map(match => match[1] ?? ''));
	if (failures.length === 0) {
		if (/^\s*ok \d+/mu.test(value) || /^# fail 0\s*$/mu.test(value)) {
			return {...malformed(), status: 'pass'};
		}
		return malformed();
	}

	return {
		status: 'failure',
		failingTestNames: failures,
		...extractCommonFailureFields(value),
		rawFailure: value,
	};
}

function decodeXml(value: string): string {
	return value
		.replaceAll('&quot;', '"')
		.replaceAll('&apos;', "'")
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&amp;', '&');
}

export function parseJunitReport(value: string): ParsedTestReport {
	if (!/<testsuites?\b/u.test(value) || !/<\/testsuites?>/u.test(value)) {
		return malformed();
	}

	const failureBlocks = [...value.matchAll(
		/<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/gu,
	)].filter(match => /<(?:failure|error)\b/u.test(match[2] ?? ''));
	if (failureBlocks.length === 0) {
		const counts = [...value.matchAll(/<testsuite\b([^>]*)>/gu)];
		const hasFailureCount = counts.some(match =>
			/\b(?:failures|errors)="[1-9]\d*"/u.test(match[1] ?? ''));
		return hasFailureCount ? malformed() : {...malformed(), status: 'pass'};
	}

	const names = unique(failureBlocks.map(match =>
		decodeXml(/\bname="([^"]+)"/u.exec(match[1] ?? '')?.[1] ?? '')));
	const firstBlock = failureBlocks[0]?.[2] ?? '';
	const failureTag = /<(?:failure|error)\b([^>]*)>([\s\S]*?)<\/(?:failure|error)>/u.exec(firstBlock);
	if (failureTag === null) {
		return malformed();
	}

	const attributes = failureTag[1] ?? '';
	const body = decodeXml(failureTag[2] ?? '');
	const errorType = decodeXml(/\btype="([^"]+)"/u.exec(attributes)?.[1] ?? '');
	const attributeMessage = decodeXml(/\bmessage="([^"]+)"/u.exec(attributes)?.[1] ?? '');
	const bodyMessage = body.trim().split(/\r?\n/u)[0] ?? '';
	const message = attributeMessage === '' ? bodyMessage : attributeMessage;
	return {
		status: 'failure',
		failingTestNames: names,
		errorType,
		message,
		operator: '',
		rawFailure: body,
	};
}

const JsonAssertionSchema = z.object({
	ancestorTitles: z.array(z.string()).optional(),
	title: z.string().optional(),
	fullName: z.string().optional(),
	name: z.string().optional(),
	status: z.string(),
	failureMessages: z.array(z.string()).optional(),
	errors: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).optional(),
}).catchall(z.unknown());

const JsonTestFileSchema = z.object({
	assertionResults: z.array(JsonAssertionSchema).optional(),
	testResults: z.array(JsonAssertionSchema).optional(),
}).catchall(z.unknown());

const JsonReportSchema = z.object({
	success: z.boolean().optional(),
	testResults: z.array(JsonTestFileSchema),
}).catchall(z.unknown());

export function parseJsonTestReport(value: string): ParsedTestReport {
	let decoded: unknown;
	try {
		decoded = JSON.parse(value);
	} catch {
		return malformed();
	}

	const parsed = JsonReportSchema.safeParse(decoded);
	if (!parsed.success) {
		return malformed();
	}

	const assertions = parsed.data.testResults.flatMap(file =>
		file.assertionResults ?? file.testResults ?? []);
	if (assertions.length === 0) {
		return malformed();
	}

	const failures = assertions.filter(assertion =>
		assertion.status === 'failed' || assertion.status === 'failure');
	if (failures.length === 0) {
		const allPassed = assertions.every(assertion =>
			assertion.status === 'passed' || assertion.status === 'pass');
		return allPassed ? {...malformed(), status: 'pass'} : malformed();
	}

	const names = unique(failures.map(assertion =>
		assertion.fullName
		?? [...(assertion.ancestorTitles ?? []), assertion.title ?? assertion.name ?? ''].join(' ')));
	const failureText = failures.flatMap(assertion => [
		...(assertion.failureMessages ?? []),
		...(assertion.errors ?? []).map(error =>
			typeof error === 'string' ? error : JSON.stringify(error)),
	]).join('\n');
	return {
		status: 'failure',
		failingTestNames: names,
		...extractCommonFailureFields(failureText),
		rawFailure: failureText,
	};
}

export function parsePytestReport(value: string): ParsedTestReport {
	if (!/(?:^|\n)(?:FAILED|ERROR)\s+[^\r\n]+|\b\d+ passed\b|ERROR collecting/u.test(value)) {
		return malformed();
	}

	const failures = [...value.matchAll(/^FAILED\s+([^\s]+)(?:\s+-\s+(.+))?$/gmu)];
	const errors = [...value.matchAll(/^ERROR\s+(?:collecting\s+)?([^\s]+)(?:\s+-\s+(.+))?$/gmu)];
	if (failures.length === 0 && errors.length === 0) {
		return /\b\d+ passed\b/u.test(value)
			? {...malformed(), status: 'pass'}
			: malformed();
	}

	const records = [...failures, ...errors];
	const names = unique(records.map(match => match[1] ?? ''));
	const inlineMessage = records[0]?.[2] ?? '';
	return {
		status: 'failure',
		failingTestNames: names,
		...extractCommonFailureFields(`${inlineMessage}\n${value}`),
		message: inlineMessage,
		rawFailure: value,
	};
}
