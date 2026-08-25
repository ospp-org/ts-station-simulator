import { describe, it, expect } from 'vitest';
import {
  _createStationFromScenarioForTesting,
  type ScenarioDefinition,
  type TargetConfig,
} from '../../scenarios/ScenarioRunner.js';
import type { ProvisioningArtifact } from '../../scenarios/ScenarioContext.js';

/**
 * THE BOOT DECLARATION MUST DERIVE FROM THE PROVISIONED TOPOLOGY.
 *
 * The defect this pins: `--bootstrap-pool` provisioned `--pool-bays` bays server-side
 * while `createStationFromScenario` built the station's bays from the scenario's own
 * `station.bayCount`. Two independent sources for one physical fact. They disagreed —
 * 4 provisioned, 2 declared — and nothing in the simulator compared them.
 *
 * Nothing on the server compared them either, until csms-server `d11b0896` gave the
 * boot topology gate a per-station arm. Then the first UAT run failed 109 of 130
 * scenarios, every one of them on the same assertion: BootNotification answered
 * `Pending` (3018 TOPOLOGY_MISMATCH) instead of `Accepted`.
 *
 * Aligning the two numbers would have left two numbers. These tests pin the SHAPE
 * instead: when a provisioning artifact is present, it decides the bay count, and the
 * scenario's `station.bayCount` does not get a vote. Revert the derivation and the
 * first test goes red — on `npm test`, without reaching UAT.
 */

function scenarioDef(bayCount: number): ScenarioDefinition {
  return {
    name: 'provisioned-topology-test',
    station: {
      bayCount,
      stationModel: 'WashPro X200',
      stationVendor: 'SimCorp',
      behavior: { accept_rate: 1.0 },
    },
    steps: [],
  } as unknown as ScenarioDefinition;
}

function variables(bayIds: string[]): Map<string, string> {
  const v = new Map<string, string>([
    ['stationId', 'stn_topotest'],
    ['serviceId_1', 'svc_test'],
    ['serialNumber', 'SIM-TOPO-TEST'],
  ]);
  // Hydration writes bayId_N into `variables` for every PROVISIONED bay; this mirrors
  // ScenarioRunner.ts's hydration block exactly.
  bayIds.forEach((id, i) => v.set(`bayId_${i + 1}`, id));

  return v;
}

function artifact(bayIds: string[]): ProvisioningArtifact {
  return {
    stationId: 'stn_topotest',
    bayIds,
    bays: bayIds.map((bayId, i) => ({ bayId, bayNumber: i + 1 })),
  } as ProvisioningArtifact;
}

const target: TargetConfig = {
  mqttUrl: 'mqtt://localhost:1883',
  apiBaseUrl: 'http://localhost:8080',
};

describe('createStationFromScenario — the declared topology derives from the provisioned one', () => {
  it('takes the bay count from the provisioning artifact, NOT from station.bayCount', () => {
    // The exact divergence that failed 109 scenarios: pool provisioned 4, scenario said 2.
    const bayIds = ['bay_p1', 'bay_p2', 'bay_p3', 'bay_p4'];
    const station = _createStationFromScenarioForTesting(
      scenarioDef(2),
      variables(bayIds),
      target,
      artifact(bayIds),
    );

    expect(station.config.bays).toHaveLength(4);
    expect(station.config.bayCount).toBe(4);
    expect(station.config.bays.map(b => b.bayNumber)).toEqual([1, 2, 3, 4]);
    expect(station.config.bays.map(b => b.bayId)).toEqual(bayIds);
  });

  it('derives DOWNWARD too — a scenario asking for more than was provisioned gets what exists', () => {
    // The opposite direction matters as much: a station must never declare a bay it was
    // not provisioned with, or the mismatch is the same defect with the sign flipped.
    const bayIds = ['bay_q1', 'bay_q2'];
    const station = _createStationFromScenarioForTesting(
      scenarioDef(4),
      variables(bayIds),
      target,
      artifact(bayIds),
    );

    expect(station.config.bays).toHaveLength(2);
    expect(station.config.bays.map(b => b.bayNumber)).toEqual([1, 2]);
  });

  it('falls back to station.bayCount when there is no provisioning artifact', () => {
    // Self-provisioning scenarios (`action: provision`) have no artifact at station-build
    // time — their provision step has not run yet. They keep their own declared count,
    // which is the same number their own step will provision with. This is why the three
    // e2e journeys passed the run that failed everything else.
    const station = _createStationFromScenarioForTesting(
      scenarioDef(4),
      variables(['bay_r1', 'bay_r2', 'bay_r3', 'bay_r4']),
      target,
      undefined,
    );

    expect(station.config.bays).toHaveLength(4);
  });

  it('falls back when the artifact carries no bays, rather than declaring zero', () => {
    const station = _createStationFromScenarioForTesting(
      scenarioDef(2),
      variables(['bay_s1', 'bay_s2']),
      target,
      artifact([]),
    );

    expect(station.config.bays).toHaveLength(2);
  });

  it('still honours a CLI --var bayId_N override, which is applied AFTER hydration', () => {
    // The count comes from the artifact; the IDs come from `variables`. That split is
    // deliberate — reading IDs straight off the artifact would silently discard
    // `--var bayId_1=...`, whose last-write semantics the runner applies after hydration.
    const bayIds = ['bay_t1', 'bay_t2'];
    const vars = variables(bayIds);
    vars.set('bayId_1', 'bay_OVERRIDDEN');

    const station = _createStationFromScenarioForTesting(
      scenarioDef(2),
      vars,
      target,
      artifact(bayIds),
    );

    expect(station.config.bays).toHaveLength(2);
    expect(station.config.bays[0].bayId).toBe('bay_OVERRIDDEN');
    expect(station.config.bays[1].bayId).toBe('bay_t2');
  });
});
