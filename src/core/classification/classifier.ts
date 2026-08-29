import {createHash} from 'node:crypto';

import type {
  ClassifiedAttemptV1,
  OutcomeKindV1,
  RawExecutionAttemptV1,
  VerificationRequestV1,
} from '../../contracts/index.js';
import {ClassifiedAttemptSchema, RawExecutionAttemptSchema} from '../../contracts/index.js';

// eslint-disable-next-line no-control-regex -- ANSI escape removal requires matching ESC.
const ansiPattern = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const infrastructurePatterns: readonly [OutcomeKindV1, RegExp][] = [
  ['dependency-failure', /(?:cannot find module|module not found|ERR_MODULE_NOT_FOUND|npm ERR!|ImportError|ModuleNotFoundError|ENOTFOUND)/iu],
  ['collection-failure', /(?:no tests? found|failed to collect|collection error|test suite failed to run|SyntaxError)/iu],
  ['build-failure', /(?:build failed|compilation failed|typescript error|tsc: error|Syntax error in production)/iu],
  ['timeout', /(?:timed? out|timeout exceeded|deadline exceeded)/iu],
  ['crash', /(?:segmentation fault|SIGSEGV|out of memory|heap limit|core dumped)/iu],
  ['platform-failure', /(?:unsupported platform|not supported on this platform|requires (?:darwin|windows|linux))/iu],
];

interface ParsedReport {
  readonly failingTests: readonly string[];
  readonly passingTests: readonly string[];
  readonly failureText: string;
  readonly failureType?: string;
  readonly operator?: string;
}

export function classifyAttempt(
  attemptInput: RawExecutionAttemptV1,
  reportFormat: VerificationRequestV1['report']['format'],
  targetTestNames: readonly string[],
): ClassifiedAttemptV1 {
  const attempt = RawExecutionAttemptSchema.parse(attemptInput);
  if (attempt.termination === 'timed-out') {
    return classification(attempt, 'timeout', [], 'Process exceeded its execution timeout', 'high');
  }
  if (attempt.termination === 'signaled') {
    return classification(attempt, 'crash', [], 'Process terminated by signal', 'high');
  }
  if (attempt.termination === 'platform-error') {
    return classification(attempt, 'platform-failure', [], 'Execution provider reported a platform error', 'high');
  }

  const stdout = decodeArtifact(attempt.stdout.contentBase64);
  const stderr = decodeArtifact(attempt.stderr.contentBase64);
  const reportText = decodeArtifact(attempt.report?.contentBase64);
  const combined = normalizeNoise([stdout, stderr, reportText].filter(Boolean).join('\n'));
  const infrastructure = classifyInfrastructure(combined);
  if (infrastructure !== undefined) {
    return classification(
      attempt,
      infrastructure,
      [],
      `Output matches ${infrastructure}`,
      'high',
    );
  }

  if (attempt.phase !== 'candidate' && attempt.exitCode === 0) {
    return classification(attempt, 'pass', [], 'Command exited successfully', 'high');
  }
  if (reportText === '') {
    return classification(
      attempt,
      'unknown-failure',
      [],
      'Required structured reporter output is missing',
      'low',
    );
  }
  const parsed = parseReport(reportFormat, reportText);
  if (parsed === undefined) {
    return classification(
      attempt,
      'unknown-failure',
      [],
      'Reporter output is malformed or unsupported',
      'low',
    );
  }
  if (parsed.failingTests.length === 0 && attempt.exitCode === 0) {
    return classification(attempt, 'pass', parsed.passingTests, 'All reported tests passed', 'high');
  }
  if (parsed.failingTests.length === 0) {
    return classification(
      attempt,
      'unknown-failure',
      [],
      'Nonzero exit had no reporter-attributed failing test',
      'low',
    );
  }
  const targetFailures = parsed.failingTests.filter((name) => matchesTarget(name, targetTestNames));
  if (targetFailures.length === 0) {
    return classification(
      attempt,
      'unrelated-test-failure',
      parsed.failingTests,
      'Reporter attributes failure only to tests outside the generated target',
      'high',
    );
  }
  const assertion = isAssertionFailure(parsed.failureText, parsed.failureType);
  const outcome: OutcomeKindV1 = assertion ? 'assertion-failure' : 'behavioral-failure';
  const signature = signatureFor({
    testName: targetFailures[0] ?? 'unknown-target',
    outcome,
    operator: parsed.operator ?? extractOperator(parsed.failureText, assertion),
    message: extractMessage(parsed.failureText, assertion),
    frame: extractProjectFrame(parsed.failureText),
  });
  return ClassifiedAttemptSchema.parse({
    rawAttemptIndex: attempt.attempt,
    outcome,
    signature,
    targetTestNames: targetFailures,
    explanation: assertion
      ? 'Target reporter entry contains an assertion failure'
      : 'Target reporter entry contains a behavioral error',
    confidence: assertion ? 'high' : 'medium',
  });
}

export function classifyEvidenceAttempts(
  attempts: readonly RawExecutionAttemptV1[],
  reportFormat: VerificationRequestV1['report']['format'],
  targetTestNames: readonly string[],
): ClassifiedAttemptV1[] {
  return attempts.map((attempt, index) => {
    const classified = classifyAttempt(attempt, reportFormat, targetTestNames);
    return ClassifiedAttemptSchema.parse({...classified, rawAttemptIndex: index});
  });
}

function parseReport(format: VerificationRequestV1['report']['format'], report: string): ParsedReport | undefined {
  switch (format) {
    case 'tap':
      return parseTap(report);
    case 'junit':
      return parseJunit(report);
    case 'vitest-json':
    case 'jest-json':
      return parseJsonReport(report);
    case 'pytest-text':
      return parsePytest(report);
  }
}

function parseTap(report: string): ParsedReport | undefined {
  if (!/(?:^|\n)TAP version \d+/u.test(report) && !/(?:^|\n)(?:not )?ok \d+/u.test(report)) {
    return undefined;
  }
  const failingTests = [...report.matchAll(/^not ok \d+ - (.+)$/gmu)].map((match) => cleanTestName(match[1]));
  const passingTests = [...report.matchAll(/^ok \d+ - (.+)$/gmu)].map((match) => cleanTestName(match[1]));
  return {
    failingTests,
    passingTests,
    failureText: report,
    ...optionalFailureDetails(report),
  };
}

function parseJunit(report: string): ParsedReport | undefined {
  if (!report.includes('<testsuite') && !report.includes('<testsuites')) return undefined;
  const failingTests: string[] = [];
  const passingTests: string[] = [];
  let failureText = '';
  let failureType: string | undefined;
  for (const match of report.matchAll(/<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/gu)) {
    const attributes = match[1] ?? '';
    const body = match[2] ?? '';
    const name = xmlAttribute(attributes, 'name');
    if (name === undefined) continue;
    const failure = /<(?:failure|error)\b([^>]*)>([\s\S]*?)<\/(?:failure|error)>/u.exec(body);
    if (failure === null) passingTests.push(name);
    else {
      failingTests.push(name);
      failureText += `${xmlAttribute(failure[1] ?? '', 'message') ?? ''}\n${failure[2] ?? ''}\n`;
      failureType ??= xmlAttribute(failure[1] ?? '', 'type');
    }
  }
  return {
    failingTests,
    passingTests,
    failureText,
    ...(failureType === undefined ? {} : {failureType}),
    ...optionalFailureDetails(failureText),
  };
}

function parseJsonReport(report: string): ParsedReport | undefined {
  let value: unknown;
  try {
    value = JSON.parse(report);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !Array.isArray(value.testResults)) return undefined;
  const failingTests: string[] = [];
  const passingTests: string[] = [];
  const failures: string[] = [];
  for (const suite of value.testResults) {
    if (!isRecord(suite)) continue;
    const assertions = Array.isArray(suite.assertionResults)
      ? suite.assertionResults
      : Array.isArray(suite.testResults)
        ? suite.testResults
        : [];
    for (const assertion of assertions) {
      if (!isRecord(assertion)) continue;
      const name = stringField(assertion, ['fullName', 'title', 'name']);
      const status = stringField(assertion, ['status']);
      if (name === undefined || status === undefined) continue;
      if (status === 'passed' || status === 'pass') passingTests.push(name);
      if (status === 'failed' || status === 'fail') {
        failingTests.push(name);
        const messages = assertion.failureMessages;
        if (Array.isArray(messages)) failures.push(...messages.filter((entry): entry is string => typeof entry === 'string'));
        const message = stringField(assertion, ['failureMessage', 'message']);
        if (message !== undefined) failures.push(message);
      }
    }
  }
  const failureText = failures.join('\n');
  return {failingTests, passingTests, failureText, ...optionalFailureDetails(failureText)};
}

function parsePytest(report: string): ParsedReport | undefined {
  if (!/(?:FAILED|ERROR|PASSED) .+::/u.test(report)) return undefined;
  const failingTests = [...report.matchAll(/^(?:FAILED|ERROR) ([^\s]+::[^\s]+)(?:\s+-\s+(.+))?$/gmu)].map(
    (match) => cleanTestName(match[1]),
  );
  const passingTests = [...report.matchAll(/^PASSED ([^\s]+::[^\s]+)$/gmu)].map((match) => cleanTestName(match[1]));
  return {failingTests, passingTests, failureText: report, ...optionalFailureDetails(report)};
}

function classification(
  attempt: RawExecutionAttemptV1,
  outcome: OutcomeKindV1,
  targetTestNames: readonly string[],
  explanation: string,
  confidence: 'high' | 'medium' | 'low',
): ClassifiedAttemptV1 {
  return ClassifiedAttemptSchema.parse({
    rawAttemptIndex: attempt.attempt,
    outcome,
    targetTestNames,
    explanation,
    confidence,
  });
}

function decodeArtifact(contentBase64: string | undefined): string {
  if (contentBase64 === undefined) return '';
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(Buffer.from(contentBase64, 'base64'));
  } catch {
    return '';
  }
}

function classifyInfrastructure(text: string): OutcomeKindV1 | undefined {
  for (const [outcome, pattern] of infrastructurePatterns) {
    if (pattern.test(text)) return outcome;
  }
  return undefined;
}

function normalizeNoise(value: string): string {
  return value
    .replaceAll(ansiPattern, '')
    .replaceAll('\\', '/')
    .replaceAll(/(?:file:\/\/)?\/(?:private\/)?(?:tmp|var\/folders)\/[^\s:)]+/gu, '<tmp>')
    .replaceAll(/(?:file:\/\/)?(?:[A-Za-z]:)?\/(?:[^\s:()]+\/)*[^\s:()]+/gu, '<path>')
    .replaceAll(/:\d+(?::\d+)?\b/gu, ':<line>')
    .replaceAll(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu, '<timestamp>')
    .replaceAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, '<id>');
}

function matchesTarget(name: string, targets: readonly string[]): boolean {
  if (targets.length === 0) return false;
  const normalizedName = cleanTestName(name).toLowerCase();
  return targets.some((target) => {
    const normalizedTarget = cleanTestName(target).toLowerCase();
    return normalizedName.includes(normalizedTarget) || normalizedTarget.includes(normalizedName);
  });
}

function isAssertionFailure(text: string, failureType: string | undefined): boolean {
  return /assert|expect(?:ed|ation)?|strictEqual|deepEqual|comparison/iu.test(
    `${failureType ?? ''}\n${text}`,
  );
}

function optionalFailureDetails(text: string): {failureType?: string; operator?: string} {
  const failureType = /\b(AssertionError|TypeError|RangeError|ReferenceError|Error)\b/u.exec(text)?.[1];
  const operator = /operator:\s*['"]?([A-Za-z][A-Za-z0-9_-]*)/u.exec(text)?.[1];
  return {
    ...(failureType === undefined ? {} : {failureType}),
    ...(operator === undefined ? {} : {operator}),
  };
}

function extractOperator(text: string, assertion: boolean): string {
  return optionalFailureDetails(text).operator ?? (assertion ? 'assertion' : 'throw');
}

function extractMessage(text: string, assertion: boolean): string {
  if (/Expected values to be strictly equal/iu.test(text)) return 'Expected values to be strictly equal';
  const message = /(?:AssertionError|TypeError|RangeError|ReferenceError|Error)(?:\s*\[[^\]]+\])?:\s*([^\n]+)/u.exec(text)?.[1];
  if (message !== undefined) return normalizeNoise(message).trim().slice(0, 512);
  return assertion ? 'assertion failure' : 'behavioral failure';
}

function extractProjectFrame(text: string): string {
  const normalized = text.replaceAll('\\', '/');
  const repositoryTest = /\b((?:test|tests)\/[^:\s)]+):\d+/u.exec(normalized)?.[1];
  if (repositoryTest !== undefined) return repositoryTest;
  return /\b([^/\s:]+\.(?:test|spec)\.[A-Za-z0-9]+):\d+/u.exec(normalized)?.[1] ?? 'unknown-frame';
}

function signatureFor(options: {
  readonly testName: string;
  readonly outcome: OutcomeKindV1;
  readonly operator: string;
  readonly message: string;
  readonly frame: string;
}): `sha256:${string}` {
  const tuple = [
    cleanTestName(options.testName),
    options.outcome,
    options.operator,
    options.message,
    options.frame,
  ].join('\u0000');
  return `sha256:${createHash('sha256').update(tuple, 'utf8').digest('hex')}`;
}

function cleanTestName(value: string | undefined): string {
  return (value ?? '').replace(/^['"]|['"]$/gu, '').trim();
}

function xmlAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`${name}="([^"]*)"`, 'u').exec(attributes);
  return match?.[1]?.replaceAll('&quot;', '"').replaceAll('&amp;', '&');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    if (typeof value[field] === 'string') return value[field];
  }
  return undefined;
}
