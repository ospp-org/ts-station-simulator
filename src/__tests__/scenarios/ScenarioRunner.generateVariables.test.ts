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

describe('generateVariables — Sprint B --var userVars overrides', () => {
  it('overrides auto-generated bayId_1 when supplied via userVars', () => {
    const userVars = new Map([['bayId_1', 'bay_realbay001']]);
    const vars = generateVariables(scenario(), TARGET, null, userVars);

    expect(vars.get('bayId_1')).toBe('bay_realbay001');
    // Untouched bayId_2 still comes from generateBayId() (random hex)
    expect(vars.get('bayId_2')).toMatch(/^bay_[a-f0-9]{8}$/);
  });

  it('overrides multiple bayId_N values simultaneously', () => {
    const userVars = new Map([
      ['bayId_1', 'bay_aa'],
      ['bayId_2', 'bay_bb'],
    ]);
    const vars = generateVariables(scenario(undefined, 2), TARGET, null, userVars);

    expect(vars.get('bayId_1')).toBe('bay_aa');
    expect(vars.get('bayId_2')).toBe('bay_bb');
  });

  it('overrides stationId via userVars (winning over auto-generated)', () => {
    const userVars = new Map([['stationId', 'stn_overridden']]);
    const vars = generateVariables(scenario(), TARGET, null, userVars);

    expect(vars.get('stationId')).toBe('stn_overridden');
  });

  it('userVars wins over the pool-allocated stationId (last-write semantics)', () => {
    const userVars = new Map([['stationId', 'stn_user']]);
    const vars = generateVariables(scenario(), TARGET, 'stn_pool', userVars);

    expect(vars.get('stationId')).toBe('stn_user');
  });

  it('can define brand-new placeholder names not in the auto-generated set', () => {
    const userVars = new Map([['customMarker', 'tag42']]);
    const vars = generateVariables(scenario(), TARGET, null, userVars);

    expect(vars.get('customMarker')).toBe('tag42');
  });

  it('omitting userVars leaves auto-generation untouched (backwards-compat)', () => {
    const without = generateVariables(scenario('stn_fixed'), TARGET);
    const withEmpty = generateVariables(scenario('stn_fixed'), TARGET, null, new Map());

    expect(without.get('stationId')).toBe('stn_fixed');
    expect(withEmpty.get('stationId')).toBe('stn_fixed');
    // serviceIds are deterministic; bayIds + serialNumber are random per-call so
    // we don't compare them directly.
    expect(withEmpty.get('serviceId_1')).toBe(without.get('serviceId_1'));
  });
});
