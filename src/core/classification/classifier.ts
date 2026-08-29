import {z} from 'zod';

import {
	ClassifiedAttemptSchema,
	ConfigSchema,
	RawExecutionAttemptSchema,
	type ClassifiedAttemptV1,
	type OutcomeKindV1,
	type RawExecutionAttemptV1,
} from '../../contracts/index.js';
import {firstProjectFrame, normalizedFailureSignature} from './failure-normalization.js';
import {
	parseJsonTestReport,
	parseJunitReport,
	parsePytestReport,
	parseTapReport,
	type ParsedTestReport,
} from './report-parsers.js';

const TargetNamesSchema = z.array(z.string().min(1).max(1024)).min(1).max(128);
type ReportFormat = z.infer<typeof ConfigSchema.shape.verification.shape.report.shape.format>;

function decodeArtifact(artifact: RawExecutionAttemptV1['stdout']): string | undefined {
	if (artifact.contentBase64 === undefined) {
		return undefined;
	}

	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(artifact.contentBase64)) {
		return undefined;
	}

	const bytes = Buffer.from(artifact.contentBase64, 'base64');
	if (bytes.toString('base64') !== artifact.contentBase64 || bytes.byteLength !== artifact.sizeBytes) {
		return undefined;
	}

	try {
		return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
	} catch {
		return undefined;
	}
}

function parseReport(format: ReportFormat, value: string): ParsedTestReport {
	switch (format) {
		case 'tap': return parseTapReport(value);
		case 'junit': return parseJunitReport(value);
		case 'vitest-json':
		case 'jest-json': return parseJsonTestReport(value);
		case 'pytest-text': return parsePytestReport(value);
	}
}

function matchesTarget(failureName: string, targets: readonly string[]): boolean {
	return targets.some(target => failureName.includes(target) || target.includes(failureName));
}

function infrastructureOutcome(value: string): OutcomeKindV1 | undefined {
	if (/\b(?:timed? out|timeout|ETIMEDOUT)\b/iu.test(value)) return 'timeout';
	if (/\b(?:Cannot find module|ModuleNotFoundError|ImportError|ERR_MODULE_NOT_FOUND|dependency resolution|npm ERR! code ERESOLVE)\b/iu.test(value)) return 'dependency-failure';
	if (/\b(?:build failed|compilation failed|compiler error|TS\d{4}:)\b/iu.test(value)) return 'build-failure';
	if (/\b(?:error during collection|ERROR collecting|no tests collected|SyntaxError)\b/iu.test(value)) return 'collection-failure';
	if (/\b(?:segmentation fault|SIGSEGV|fatal signal|core dumped)\b/iu.test(value)) return 'crash';
	if (/\b(?:unsupported platform|architecture mismatch|platform error)\b/iu.test(value)) return 'platform-failure';
	return undefined;
}

function classifyFailure(
	report: ParsedTestReport,
	targets: readonly string[],
): Readonly<{outcome: OutcomeKindV1; signature: ReturnType<typeof normalizedFailureSignature>}> {
	const infra = infrastructureOutcome(`${report.errorType}\n${report.message}\n${report.rawFailure}`);
	let outcome: OutcomeKindV1;
	if (infra !== undefined) {
		outcome = infra;
	} else if (report.failingTestNames.length > 0
		&& !report.failingTestNames.some(name => matchesTarget(name, targets))) {
		outcome = 'unrelated-test-failure';
	} else if (/Assertion|ERR_ASSERTION/iu.test(report.errorType) || report.operator.length > 0) {
		outcome = 'assertion-failure';
	} else {
		outcome = 'behavioral-failure';
	}

	return {
		outcome,
		signature: normalizedFailureSignature({
			errorType: report.errorType,
			message: report.message,
			operator: report.operator,
			testNames: report.failingTestNames.filter(name => matchesTarget(name, targets)),
			frame: report.rawFailure,
		}),
	};
}

export function classifyAttempt(
	rawAttemptIndex: number,
	rawInput: RawExecutionAttemptV1,
	formatInput: ReportFormat,
	targetNamesInput: readonly string[],
): ClassifiedAttemptV1 {
	const raw = RawExecutionAttemptSchema.parse(rawInput);
	const format = ConfigSchema.shape.verification.shape.report.shape.format.parse(formatInput);
	const targetNames = TargetNamesSchema.parse(targetNamesInput);
	let outcome: OutcomeKindV1;
	let signature: ReturnType<typeof normalizedFailureSignature> | undefined;
	let explanation: string;
	let confidence: 'high' | 'medium' | 'low';

	if (raw.termination === 'timed-out') {
		outcome = 'timeout';
		explanation = 'The execution controller recorded a timeout';
		confidence = 'high';
	} else if (raw.termination === 'signaled') {
		outcome = 'crash';
		explanation = 'The process terminated by signal';
		confidence = 'high';
	} else if (raw.termination === 'platform-error') {
		outcome = 'platform-failure';
		explanation = 'The execution provider recorded a platform error';
		confidence = 'high';
	} else {
		const stdout = decodeArtifact(raw.stdout);
		const stderr = decodeArtifact(raw.stderr);
		const reportText = raw.report === undefined ? undefined : decodeArtifact(raw.report);
		const combined = `${stdout ?? ''}\n${stderr ?? ''}`;
		if (raw.phase === 'setup') {
			const infra = infrastructureOutcome(combined);
			if (raw.exitCode === 0) {
				outcome = 'pass';
				explanation = 'Setup command exited successfully';
				confidence = 'high';
			} else {
				outcome = infra ?? 'unknown-failure';
				explanation = infra === undefined
					? 'Setup failed without a recognized infrastructure category'
					: 'Setup output matched a recognized infrastructure category';
				confidence = infra === undefined ? 'low' : 'high';
			}
		} else {
			const reporterInput = reportText ?? stdout;
			const parsed = reporterInput === undefined ? undefined : parseReport(format, reporterInput);
			if (parsed?.status === 'pass') {
				outcome = 'pass';
				explanation = 'The configured reporter recorded all target tests passing';
				confidence = 'high';
			} else if (parsed?.status === 'failure') {
				const classified = classifyFailure(parsed, targetNames);
				outcome = classified.outcome;
				signature = classified.signature;
				explanation = `The configured reporter recorded ${outcome}`;
				confidence = outcome === 'behavioral-failure' ? 'medium' : 'high';
			} else {
				outcome = infrastructureOutcome(combined) ?? 'unknown-failure';
				explanation = outcome === 'unknown-failure'
					? 'Reporter output was missing or malformed'
					: 'Raw output matched an infrastructure category but the reporter was unusable';
				confidence = outcome === 'unknown-failure' ? 'low' : 'medium';
			}
		}
	}

	return ClassifiedAttemptSchema.parse({
		rawAttemptIndex,
		outcome,
		...(signature === undefined ? {} : {signature}),
		targetTestNames: targetNames,
		explanation,
		confidence,
	});
}

export {firstProjectFrame};
