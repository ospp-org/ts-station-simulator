import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProvisionStep } from '../../../scenarios/steps/ProvisionStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';

// F-05: FLAT normative provisioning body — no `data` envelope, mirroring the
// live ProvisioningController + provisioning-response.schema.json.
const PROVISION_RESPONSE = {
  clientCert: '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----',
  stationCaChain: '-----BEGIN CERTIFICATE-----\nCHAIN\n-----END CERTIFICATE-----',
  brokerRootCa: '-----BEGIN CERTIFICATE-----\nBROKER\n-----END CERTIFICATE-----',
  // v0.11.0 wire shape: explicit {bayId, bayNumber} pairs, not a positional array.
  bays: [
    { bayId: 'bay_1111111111111111', bayNumber: 1 },
    { bayId: 'bay_2222222222222222', bayNumber: 2 },
  ],
  mqttConfig: { brokerUri: 'mqtts://broker.example:8883' },
};

describe('ProvisionStep — populates context.provisioning + writes bays.json', () => {
  let tmpDir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provision-test-'));
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify(PROVISION_RESPONSE), {
        // OSPP §2 provisioning returns 200 OK (update, not create) — mirrors the
        // live ProvisioningController. Was 201, which masked the status mismatch.
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function ctx(stationId = 'stn_test_abc') {
    const c = createContext();
    c.apiBaseUrl = 'http://localhost:8080';
    c.captured.set('provisioning_token', 'tok_shared');
    c.variables.set('stationId', stationId);
    return c;
  }

  it('populates context.provisioning with stationId, bayIds, certPath, keyPath', async () => {
    const step = new ProvisionStep();
    const context = ctx('stn_provtest');
    await step.execute(
      {
        action: 'provision',
        serial_number: 'SN-TEST-1',
        bay_count: 2,
        artifacts_dir: tmpDir,
      },
      context,
      {} as never,
    );

    expect(context.provisioning).toBeDefined();
    expect(context.provisioning?.stationId).toBe('stn_provtest');
    expect(context.provisioning?.bayIds).toEqual(['bay_1111111111111111', 'bay_2222222222222222']);
    expect(context.provisioning?.certPath).toContain('stn_provtest.pem');
    expect(context.provisioning?.keyPath).toContain('stn_provtest-key.pem');
  });

  it('writes bays.json to <artifactsDir>/<stationId>/bays.json', async () => {
    const step = new ProvisionStep();
    const context = ctx('stn_baystest');
    await step.execute(
      {
        action: 'provision',
        serial_number: 'SN-TEST-2',
        bay_count: 2,
        artifacts_dir: tmpDir,
      },
      context,
      {} as never,
    );

    const baysJsonPath = path.join(tmpDir, 'stn_baystest', 'bays.json');
    const parsed = JSON.parse(await fs.readFile(baysJsonPath, 'utf-8'));
    expect(parsed).toEqual({
      stationId: 'stn_baystest',
      // The v0.11.0 pairs, verbatim...
      bays: [
        { bayId: 'bay_1111111111111111', bayNumber: 1 },
        { bayId: 'bay_2222222222222222', bayNumber: 2 },
      ],
      // ...plus the 0-indexed template array, sorted by bayNumber. Both are
      // written because they answer different questions: `bays` is the wire
      // mapping, `bayIds[0]` is "the scenario's first bay".
      bayIds: ['bay_1111111111111111', 'bay_2222222222222222'],
    });
  });

  it('also leaves the legacy captured.bayId_N keys in place (backward compat)', async () => {
    const step = new ProvisionStep();
    const context = ctx();
    await step.execute(
      {
        action: 'provision',
        serial_number: 'SN-TEST-3',
        bay_count: 2,
        artifacts_dir: tmpDir,
      },
      context,
      {} as never,
    );
    expect(context.captured.get('bayId_1')).toBe('bay_1111111111111111');
    expect(context.captured.get('bayId_2')).toBe('bay_2222222222222222');
  });
});
