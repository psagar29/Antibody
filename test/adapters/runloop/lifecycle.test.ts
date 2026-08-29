import {createHash} from 'node:crypto';

import {describe, expect, it} from 'vitest';

import {AntibodyError} from '../../../src/contracts/errors.js';
import {RawVerificationEvidenceSchema} from '../../../src/contracts/schemas.js';
import {RunloopVerificationAdapter} from '../../../src/adapters/runloop/adapter.js';
import {
  FakeRunloopControl,
  FakeRunloopPersistence,
  type FakeRunloopFault,
} from './fake.js';
import {makeRunloopFixtureRequest} from './fixtures.js';

class AdvancingClock {
  #milliseconds = 1_788_019_200_000;

  nowMs(): number {
    return this.#milliseconds;
  }

  sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(new Error('aborted'));
    this.#milliseconds += milliseconds;
    return Promise.resolve();
  }
}

function makeHarness(
  fault?: FakeRunloopFault,
  faultCommand?: string,
): {
  control: FakeRunloopControl;
  persistence: FakeRunloopPersistence;
  adapter: RunloopVerificationAdapter;
} {
  const control = new FakeRunloopControl({
    ...(fault === undefined ? {} : {fault}),
    ...(faultCommand === undefined ? {} : {faultCommand}),
  });
  const persistence = new FakeRunloopPersistence(control.events);
  return {
    control,
    persistence,
    adapter: new RunloopVerificationAdapter(control, persistence),
  };
}

describe('Runloop lifecycle and failure cleanup', () => {
  it.each([
    ['clone', "'git' 'checkout'", 1],
    ['apply', "'git' 'apply' '--check'", 1],
    ['head', "'3333333333333333333333333333333333333333'", 2],
  ])('persists partial evidence and shuts down confirmed boxes after %s failure', async (
    _stage,
    command,
    expectedBoxes,
  ) => {
    const {adapter, control, persistence} = makeHarness('execute', command);

    await expect(adapter.execute(makeRunloopFixtureRequest())).rejects.toBeInstanceOf(AntibodyError);

    expect(control.shutdowns).toHaveLength(expectedBoxes);
    expect(new Set(control.shutdowns).size).toBe(expectedBoxes);
    expect(persistence.evidence.length).toBeGreaterThanOrEqual(2);
    const finalEvidence = persistence.evidence.at(-1);
    expect(finalEvidence).toBeDefined();
    if (finalEvidence !== undefined) {
      expect(RawVerificationEvidenceSchema.parse(finalEvidence)).toEqual(finalEvidence);
      expect(finalEvidence.cleanup.every(({requested}) => requested)).toBe(true);
    }
  });

  it.each([
    ['setup', "'npm' 'install'", 'setup'],
    ['baseline', "'npm' 'test'", 'baseline'],
    ['candidate', "'node' '--test'", 'candidate'],
  ])('records a raw platform error and still cleans up when %s execution fails', async (
    _stage,
    command,
    expectedPhase,
  ) => {
    const {adapter, control} = makeHarness('execute', command);

    const evidence = await adapter.execute(makeRunloopFixtureRequest());

    expect(
      evidence.attempts.some(
        ({phase, termination}) => phase === expectedPhase && termination === 'platform-error',
      ),
    ).toBe(true);
    expect(control.shutdowns).toEqual(['devbox_1', 'devbox_2']);
  });

  it('does not provision when source resolution fails', async () => {
    const {adapter, control} = makeHarness('resolve');

    await expect(adapter.execute(makeRunloopFixtureRequest())).rejects.toBeInstanceOf(AntibodyError);
    expect(control.createParams).toHaveLength(0);
    expect(control.shutdowns).toHaveLength(0);
  });

  it('does not invent a cleanup target when create fails before returning an id', async () => {
    const {adapter, control} = makeHarness('create');

    await expect(adapter.execute(makeRunloopFixtureRequest())).rejects.toBeInstanceOf(AntibodyError);
    expect(control.shutdowns).toHaveLength(0);
  });

  it('retains and cleans up a Devbox id when provisioning polling fails', async () => {
    const {adapter, control, persistence} = makeHarness('provision');

    await expect(adapter.execute(makeRunloopFixtureRequest())).rejects.toBeInstanceOf(AntibodyError);

    expect(control.shutdowns).toEqual(['devbox_1']);
    expect(persistence.evidence.at(-1)?.cleanup).toEqual([
      {devboxId: 'devbox_1', requested: true, completed: true},
    ]);
  });

  it('cleans up after artifact persistence failure', async () => {
    const {adapter, control, persistence} = makeHarness();
    persistence.failArtifacts = true;

    await expect(adapter.execute(makeRunloopFixtureRequest())).rejects.toBeInstanceOf(AntibodyError);
    expect(control.shutdowns).toEqual(['devbox_1']);
  });

  it('records cleanup failure without replacing otherwise raw evidence', async () => {
    const {adapter, control} = makeHarness('shutdown');

    const evidence = await adapter.execute(makeRunloopFixtureRequest());

    expect(evidence.cleanup).toEqual([
      {devboxId: 'devbox_1', requested: true, completed: false, errorCode: 'Error'},
      {devboxId: 'devbox_2', requested: true, completed: false, errorCode: 'Error'},
    ]);
    expect(control.shutdowns).toEqual(['devbox_1', 'devbox_2']);
  });

  it('kills an execution at the controller deadline and then shuts down its Devbox', async () => {
    const control = new FakeRunloopControl({runningExecutions: true});
    const persistence = new FakeRunloopPersistence(control.events);
    const adapter = new RunloopVerificationAdapter(control, persistence, {
      pollIntervalMs: 500,
      controllerGraceMs: 0,
      clock: new AdvancingClock(),
    });

    await expect(adapter.execute(makeRunloopFixtureRequest())).rejects.toBeInstanceOf(AntibodyError);

    expect(control.killed).toEqual(['exec_1']);
    expect(control.shutdowns).toEqual(['devbox_1']);
    expect(persistence.evidence.at(-1)?.attempts[0]?.termination).toBe('timed-out');
  });

  it('kills on AbortSignal and still shuts down the Devbox', async () => {
    const abortController = new AbortController();
    const control = new FakeRunloopControl({
      runningExecutions: true,
      abortController,
      abortOnCommand: "'git' 'checkout'",
    });
    const persistence = new FakeRunloopPersistence(control.events);
    const adapter = new RunloopVerificationAdapter(control, persistence);

    await expect(
      adapter.execute(makeRunloopFixtureRequest(), {signal: abortController.signal}),
    ).rejects.toBeInstanceOf(AntibodyError);

    expect(control.killed).toEqual(['exec_1']);
    expect(control.shutdowns).toEqual(['devbox_1']);
    expect(persistence.evidence.at(-1)?.attempts[0]?.termination).toBe('signaled');
  });

  it('marks SDK truncation explicitly and preserves artifact hashes after redaction', async () => {
    const secret = 'fixture-secret-value';
    const token = ['github', 'pat', 'AAAAAAAAAAAAAAAAAAAAAAAA'].join('_');
    const control = new FakeRunloopControl({
      truncatedCommand: "'node' '--test'",
      outputText: `hello ${secret} ${token}`,
    });
    const persistence = new FakeRunloopPersistence(control.events);
    const adapter = new RunloopVerificationAdapter(control, persistence, {
      literalSecrets: [secret],
    });

    const evidence = await adapter.execute(makeRunloopFixtureRequest());
    const truncated = evidence.attempts.find(
      ({phase, termination}) => phase === 'candidate' && termination === 'platform-error',
    );

    expect(truncated?.stdout.name).toContain('.truncated.');
    const stored = truncated === undefined ? undefined : persistence.artifacts.get(truncated.stdout.name);
    expect(stored).toBeDefined();
    if (stored !== undefined && truncated !== undefined) {
      const text = Buffer.from(stored).toString('utf8');
      expect(text).not.toContain(secret);
      expect(text).not.toContain('github_pat_');
      expect(truncated.stdout.sha256).toBe(
        `sha256:${createHash('sha256').update(stored).digest('hex')}`,
      );
      expect(truncated.stdout.sizeBytes).toBe(stored.byteLength);
    }
  });

  it('omits unavailable optional report and provider fields instead of fabricating values', async () => {
    const control = new FakeRunloopControl({fault: 'report'});
    const persistence = new FakeRunloopPersistence(control.events);
    const adapter = new RunloopVerificationAdapter(control, persistence);
    const request = makeRunloopFixtureRequest();
    const withoutOptionalEnvironment = {
      ...request,
      environment: {source: request.environment.source, maxParallel: request.environment.maxParallel},
    };

    const evidence = await adapter.execute(withoutOptionalEnvironment);

    expect(evidence.attempts.every((attempt) => attempt.report === undefined)).toBe(true);
    expect(evidence.attempts.every((attempt) => attempt.provider.architecture === undefined)).toBe(
      true,
    );
    expect(evidence.attempts.every((attempt) => attempt.provider.shape === undefined)).toBe(true);
    expect(evidence).not.toHaveProperty('runloopCostUsd');
  });

  it('keeps candidate repetition order and avoids duplicate cleanup', async () => {
    const {adapter, control} = makeHarness();

    const evidence = await adapter.execute(makeRunloopFixtureRequest());

    expect(
      evidence.attempts
        .filter(({phase}) => phase === 'candidate')
        .map(({lane, attempt}) => `${lane}:${String(attempt)}`),
    ).toEqual(['parent:0', 'parent:1', 'fix:0', 'fix:1', 'head:0']);
    expect(control.shutdowns).toEqual(['devbox_1', 'devbox_2']);
  });

  it('keeps internal verification independent from the contract inline-artifact limit', async () => {
    const control = new FakeRunloopControl();
    const persistence = new FakeRunloopPersistence(control.events);
    const adapter = new RunloopVerificationAdapter(control, persistence, {
      inlineArtifactBytes: 1,
    });

    const evidence = await adapter.execute(makeRunloopFixtureRequest());

    expect(evidence.cleanup.every(({completed}) => completed)).toBe(true);
    expect(evidence.attempts.every(({stdout}) => stdout.contentBase64 === undefined)).toBe(true);
  });
});
