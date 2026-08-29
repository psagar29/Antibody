import {describe, expect, it} from 'vitest';

import {RawVerificationEvidenceSchema} from '../../../src/contracts/schemas.js';
import {RunloopVerificationAdapter} from '../../../src/adapters/runloop/adapter.js';
import {FakeRunloopControl, FakeRunloopPersistence} from './fake.js';
import {makeRunloopFixtureRequest, runloopFixturePatch} from './fixtures.js';

describe('Runloop verification adapter', () => {
  it('executes paired causal lanes and current head as raw schema-valid evidence', async () => {
    const control = new FakeRunloopControl();
    const persistence = new FakeRunloopPersistence(control.events);
    const adapter = new RunloopVerificationAdapter(control, persistence, {
      githubToken: 'fixture-not-a-real-token',
      literalSecrets: ['fixture-not-a-real-token'],
    });

    const evidence = await adapter.execute(makeRunloopFixtureRequest());

    expect(RawVerificationEvidenceSchema.parse(evidence)).toEqual(evidence);
    expect(evidence).not.toHaveProperty('verdict');
    expect(evidence.environmentEquivalence).toEqual({
      equivalent: true,
      comparedFields: [
        'resolvedBlueprintId',
        'resolvedSnapshotId',
        'networkPolicyId',
        'resolvedNetworkPolicySha256',
        'architecture',
        'shape',
      ],
      mismatchFields: [],
    });
    expect(control.createParams).toHaveLength(2);
    expect(control.maxActive).toBe(2);
    expect(control.createParams.every((params) => params.snapshot_id === 'snap_fixture')).toBe(true);
    expect(
      control.createParams.every(
        (params) => params.launch_parameters?.network_policy_id === 'npol_fixture',
      ),
    ).toBe(true);
    expect(control.uploads).toHaveLength(3);
    expect(control.uploads.every(({content}) => Buffer.from(content).equals(runloopFixturePatch))).toBe(
      true,
    );
    expect(control.commands.join('\n')).not.toContain(runloopFixturePatch.toString('utf8'));
    expect(evidence.attempts.filter(({lane, phase}) => lane === 'parent' && phase === 'candidate')).toHaveLength(2);
    expect(evidence.attempts.filter(({lane, phase}) => lane === 'fix' && phase === 'candidate')).toHaveLength(2);
    expect(evidence.attempts.filter(({lane, phase}) => lane === 'head' && phase === 'candidate')).toHaveLength(1);
    expect(evidence.attempts.filter(({lane, phase}) => lane === 'head' && phase === 'full-suite')).toHaveLength(1);
    expect(evidence.cleanup).toEqual([
      {devboxId: 'devbox_1', requested: true, completed: true},
      {devboxId: 'devbox_2', requested: true, completed: true},
    ]);
    const firstPersist = control.events.indexOf('persist:evidence');
    const firstShutdown = control.events.findIndex((event) => event.startsWith('shutdown:'));
    expect(firstPersist).toBeGreaterThan(-1);
    expect(firstPersist).toBeLessThan(firstShutdown);
  });

  it('serializes Devboxes when maxParallel is one', async () => {
    const control = new FakeRunloopControl();
    const persistence = new FakeRunloopPersistence(control.events);
    const adapter = new RunloopVerificationAdapter(control, persistence);
    const request = makeRunloopFixtureRequest();

    await adapter.execute({...request, environment: {...request.environment, maxParallel: 1}});

    expect(control.maxActive).toBe(1);
    expect(control.events.indexOf('shutdown:devbox_1')).toBeLessThan(
      control.events.indexOf('create:devbox_2'),
    );
  });
});
