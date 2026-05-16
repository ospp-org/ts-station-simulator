import { describe, it, expect } from 'vitest';
import { generateVariables, type ScenarioDefinition, type TargetConfig } from '../../scenarios/ScenarioRunner.js';

const TARGET: TargetConfig = {
  mqttUrl: 'mqtt://localhost:1883',
  apiBaseUrl: 'http://localhost:8080',
};

function scenario(stationId?: string, bayCount = 2): ScenarioDefinition {
  return {
    name: 'test',
    station: {
      stationId,
      bayCount,
      stationModel: 'WashPro X200',
      stationVendor: 'SimCorp',
    },
    steps: [],
  };
}

describe('generateVariables — Drift 8.1 stationHex suffix removal', () => {
  it('generates default service IDs without stationHex suffix (csms-server enforces UNIQUE per-tenant now)', () => {
    const vars = generateVariables(scenario('stn_a1b2c3d4'), TARGET);

    expect(vars.get('serviceId_1')).toBe('svc_wash_basic');
    expect(vars.get('serviceId_2')).toBe('svc_wash_premium');
    expect(vars.get('serviceId_3')).toBe('svc_dry');
    expect(vars.get('serviceId_4')).toBe('svc_vacuum');
  });

  it('does not embed the station hex tail in any service id', () => {
    const stationId = 'stn_deadbeef';
    const vars = generateVariables(scenario(stationId), TARGET);

    const hex = stationId.replace(/^stn_/, '');
    for (let i = 1; i <= 4; i++) {
      const svc = vars.get(`serviceId_${i}`);
      expect(svc).toBeDefined();
      expect(svc).not.toContain(hex);
    }
  });
});
