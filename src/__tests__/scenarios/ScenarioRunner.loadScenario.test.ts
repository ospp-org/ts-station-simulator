import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScenarioRunner } from '../../scenarios/ScenarioRunner.js';

describe('ScenarioRunner.loadScenario — mandatory station.stationModel/stationVendor', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'scenario-load-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('throws when station.stationModel is missing', async () => {
    const file = join(tmp, 'missing-model.yaml');
    writeFileSync(file, `
name: "Missing model"
station:
  stationId: "stn_test"
  bayCount: 1
  stationVendor: "SimCorp"
steps: []
`);
    const runner = new ScenarioRunner();
    await expect(runner.loadScenario(file)).rejects.toThrow(
      /missing required field station\.stationModel/,
    );
  });

  it('throws when station.stationVendor is missing', async () => {
    const file = join(tmp, 'missing-vendor.yaml');
    writeFileSync(file, `
name: "Missing vendor"
station:
  stationId: "stn_test"
  bayCount: 1
  stationModel: "WashPro X200"
steps: []
`);
    const runner = new ScenarioRunner();
    await expect(runner.loadScenario(file)).rejects.toThrow(
      /missing required field station\.stationVendor/,
    );
  });

  it('loads successfully when both fields are present', async () => {
    const file = join(tmp, 'ok.yaml');
    writeFileSync(file, `
name: "OK"
station:
  stationId: "stn_test"
  bayCount: 1
  stationModel: "WashPro X200"
  stationVendor: "SimCorp"
steps: []
`);
    const runner = new ScenarioRunner();
    const def = await runner.loadScenario(file);
    expect(def.station.stationModel).toBe('WashPro X200');
    expect(def.station.stationVendor).toBe('SimCorp');
  });
});
