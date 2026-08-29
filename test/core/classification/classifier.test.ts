import {describe, expect, test} from 'vitest';

import {
	RawExecutionAttemptSchema,
	type RawExecutionAttemptV1,
} from '../../../src/contracts/index.js';
import {sha256Bytes} from '../../../src/core/digest.js';
import {classifyAttempt} from '../../../src/core/classification/classifier.js';
import {normalizeVolatileText} from '../../../src/core/classification/failure-normalization.js';
import {
	parseJsonTestReport,
	parseJunitReport,
	parsePytestReport,
	parseTapReport,
} from '../../../src/core/classification/report-parsers.js';

function artifact(name: string, text: string) {
	const bytes = Buffer.from(text, 'utf8');
	return {
		name,
		mediaType: 'text/plain; charset=utf-8',
		sha256: sha256Bytes(bytes),
		sizeBytes: bytes.byteLength,
		contentBase64: bytes.toString('base64'),
	};
}

function attempt(input: Readonly<{
	report?: string;
	stderr?: string;
	exitCode?: number | null;
	termination?: RawExecutionAttemptV1['termination'];
	phase?: RawExecutionAttemptV1['phase'];
}> = {}): RawExecutionAttemptV1 {
	return RawExecutionAttemptSchema.parse({
		lane: 'parent',
		phase: input.phase ?? 'candidate',
		attempt: 0,
		checkoutSha: '66e82fb6b511eccffc879042c61bf45100067881',
		patchSha256: `sha256:${'a'.repeat(64)}`,
		command: {argv: ['node', '--test'], cwd: '.', env: {}, timeoutMs: 10_000},
		startedAt: '2024-01-01T00:00:00.000Z',
		finishedAt: '2024-01-01T00:00:01.000Z',
		durationMs: 1000,
		termination: input.termination ?? 'exited',
		exitCode: input.exitCode ?? 1,
		stdout: artifact('stdout', ''),
		stderr: artifact('stderr', input.stderr ?? ''),
		...(input.report === undefined ? {} : {report: artifact('report', input.report)}),
		provider: {devboxId: 'devbox-1'},
	});
}

const tapAssertion = [
	'TAP version 13',
	'not ok 1 - collapses repeated whitespace',
	'  error: |-',
	'    Expected values to be strictly equal:',
	"  name: 'AssertionError'",
	"  operator: 'strictEqual'",
	'  stack: |-',
	'    AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
	'        at TestContext.<anonymous> (C:\\bounded-temp\\repo\\test\\slug.test.js:8:10)',
	'1..1',
].join('\n');

describe('report parsers', () => {
	test.each([
		['tap', parseTapReport, 'TAP version 13\nok 1 - behavior\n1..1'],
		['junit', parseJunitReport, '<testsuite tests="1" failures="0" errors="0"><testcase name="behavior"/></testsuite>'],
		['vitest/jest JSON', parseJsonTestReport, JSON.stringify({
			success: true,
			testResults: [{assertionResults: [{fullName: 'behavior', status: 'passed'}]}],
		})],
		['pytest', parsePytestReport, '================ 1 passed in 0.01s ================'],
	] as const)('recognizes %s pass output', (_label, parser, report) => {
		expect(parser(report).status).toBe('pass');
	});

	test('is conservative for malformed output in every format', () => {
		for (const parser of [parseTapReport, parseJunitReport, parseJsonTestReport, parsePytestReport]) {
			expect(parser('not a reporter document').status).toBe('malformed');
		}
	});
});

describe('classifyAttempt', () => {
	test('produces the deterministic fixture assertion signature', () => {
		const classified = classifyAttempt(
			0,
			attempt({report: tapAssertion}),
			'tap',
			['collapses repeated whitespace'],
		);
		expect(classified).toMatchObject({
			outcome: 'assertion-failure',
			signature: 'sha256:88d2095e77d1193bb64328ad42670eb9f6ccfd869ac666a71ce915ab2370d962',
			confidence: 'high',
		});
	});

	test.each([
		{
			name: 'pass',
			format: 'tap',
			raw: attempt({report: 'TAP version 13\nok 1 - target behavior\n1..1', exitCode: 0}),
			expected: 'pass',
		},
		{
			name: 'behavioral-failure',
			format: 'junit',
			raw: attempt({report: '<testsuite tests="1" failures="1"><testcase name="target behavior"><failure type="TypeError" message="wrong receiver">TypeError: wrong receiver\n at test/receiver.test.js:4:2</failure></testcase></testsuite>'}),
			expected: 'behavioral-failure',
		},
		{
			name: 'unrelated-test-failure',
			format: 'jest-json',
			raw: attempt({report: JSON.stringify({
				success: false,
				testResults: [{assertionResults: [{
					fullName: 'existing unrelated behavior',
					status: 'failed',
					failureMessages: ['AssertionError: unrelated'],
				}]}],
			})}),
			expected: 'unrelated-test-failure',
		},
		{
			name: 'collection-failure',
			format: 'pytest-text',
			raw: attempt({report: 'ERROR collecting test/test_slug.py - SyntaxError: invalid syntax'}),
			expected: 'collection-failure',
		},
		{
			name: 'build-failure',
			format: 'tap',
			raw: attempt({report: 'garbage', stderr: 'compiler error TS2322: type mismatch'}),
			expected: 'build-failure',
		},
		{
			name: 'dependency-failure',
			format: 'tap',
			raw: attempt({report: 'garbage', stderr: 'Error: Cannot find module left-pad'}),
			expected: 'dependency-failure',
		},
		{
			name: 'timeout',
			format: 'tap',
			raw: attempt({termination: 'timed-out', exitCode: null}),
			expected: 'timeout',
		},
		{
			name: 'crash',
			format: 'tap',
			raw: attempt({termination: 'signaled', exitCode: null}),
			expected: 'crash',
		},
		{
			name: 'platform-failure',
			format: 'tap',
			raw: attempt({termination: 'platform-error', exitCode: null}),
			expected: 'platform-failure',
		},
		{
			name: 'unknown-failure',
			format: 'tap',
			raw: attempt({report: 'garbage'}),
			expected: 'unknown-failure',
		},
	] as const)('classifies $name', scenario => {
		expect(classifyAttempt(0, scenario.raw, scenario.format, ['target behavior']).outcome).toBe(
			scenario.expected,
		);
	});

	test('classifies assertion failures from Vitest JSON', () => {
		const report = JSON.stringify({
			success: false,
			testResults: [{assertionResults: [{
				fullName: 'target behavior',
				status: 'failed',
				failureMessages: ['AssertionError: expected true to be false\n at test/target.test.ts:9:3'],
			}]}],
		});
		expect(classifyAttempt(0, attempt({report}), 'vitest-json', ['target behavior']).outcome).toBe(
			'assertion-failure',
		);
	});

	test('does not treat a nonzero exit code without reporter evidence as proof', () => {
		expect(classifyAttempt(0, attempt({exitCode: 7}), 'tap', ['target']).outcome).toBe(
			'unknown-failure',
		);
	});

	test('normalizes external paths, timestamps, line numbers, IDs, temp roots, and ANSI', () => {
		const value = '\u001B[31mError at C:\\agents\\checkout\\outside.js:41:9 '
			+ '/home/runner/work/repo/outside.js:7 '
			+ '2024-01-01T00:00:00.000Z 11111111-1111-4111-8111-111111111111\u001B[0m';
		expect(normalizeVolatileText(value)).toBe(
			'Error at <external-path>:<line>:<column> <external-path>:<line>:<column> <timestamp> <id>',
		);
	});
});
