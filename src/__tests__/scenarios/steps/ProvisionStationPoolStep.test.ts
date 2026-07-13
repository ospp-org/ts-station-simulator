import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProvisionStationPoolStep } from '../../../scenarios/steps/ProvisionStationPoolStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';

// F-05: FLAT normative provisioning body — no `data` envelope, mirroring the
// live ProvisioningController + provisioning-response.schema.json.
const PROVISION_RESPONSE = {
  clientCert: '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----',
  stationCaChain: '-----BEGIN CERTIFICATE-----\nCHAIN\n-----END CERTIFICATE-----',
  brokerRootCa: '-----BEGIN CERTIFICATE-----\nBROKER\n-----END CERTIFICATE-----',
  bayIds: ['bay_real_001', 'bay_real_002'],
  mqttConfig: { brokerUri: 'mqtts://broker.example:8883' },
};

describe('ProvisionStationPoolStep', () => {
  let tmpDir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pool-test-'));
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify(PROVISION_RESPONSE), {
        // OSPP §2 provisioning returns 200 OK (update, not create). Was 201.
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function ctx() {
    const c = createContext();
    c.apiBaseUrl = 'http://localhost:8080';
    c.captured.set('provisioning_token', 'tok_shared');
    return c;
  }

  it('provisions N stations and registers them in the pool', async () => {
    const step = new ProvisionStationPoolStep();
    const context = ctx();
    await step.execute(
      {
        action: 'provision_station_pool',
        count: 3,
        bay_count: 2,
        artifacts_dir: tmpDir,
      },
      context,
      // station arg unused by this step
      {} as never,
    );

    expect(context.pool.size()).toBe(3);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    for (const entry of context.pool.list()) {
      expect(entry.stationId).toMatch(/^stn_pool_[a-f0-9]{8}$/);
      expect(entry.bayIds).toEqual(['bay_real_001', 'bay_real_002']);
      expect(entry.clientIdSuffix).toMatch(/^[0-9a-f-]{36}$/);
      expect(entry.certPath).toBeDefined();
      expect(entry.keyPath).toBeDefined();
    }
  });

  it('persists cert + key + chain + broker-ca + bays.json per station', async () => {
    const step = new ProvisionStationPoolStep();
    const context = ctx();
    await step.execute(
      { action: 'provision_station_pool', count: 2, bay_count: 2, artifacts_dir: tmpDir },
      context,
      {} as never,
    );

    for (const entry of context.pool.list()) {
      const dir = path.join(tmpDir, 'pool', entry.stationId);
      expect(await fs.stat(dir).then((s) => s.isDirectory())).toBe(true);
      expect(await fs.readFile(path.join(dir, `${entry.stationId}.pem`), 'utf8')).toMatch(/FAKE/);
      expect(await fs.readFile(path.join(dir, `${entry.stationId}-key.pem`), 'utf8')).toMatch(
        /BEGIN PRIVATE KEY/,
      );
      expect(await fs.readFile(path.join(dir, `${entry.stationId}-broker-ca.pem`), 'utf8')).toMatch(
        /BROKER/,
      );
      const baysJson = JSON.parse(await fs.readFile(path.join(dir, 'bays.json'), 'utf8'));
      expect(baysJson.stationId).toBe(entry.stationId);
      expect(baysJson.bayIds).toEqual(['bay_real_001', 'bay_real_002']);
    }
  });

  it('writes an index.json under pool/ summarising all entries', async () => {
    const step = new ProvisionStationPoolStep();
    const context = ctx();
    await step.execute(
      { action: 'provision_station_pool', count: 2, bay_count: 1, artifacts_dir: tmpDir },
      context,
      {} as never,
    );

    const index = JSON.parse(await fs.readFile(path.join(tmpDir, 'pool', 'index.json'), 'utf8'));
    expect(index.stations).toHaveLength(2);
    expect(index.stations[0].stationId).toMatch(/^stn_pool_/);
    expect(index.stations[0].bayIds).toEqual(['bay_real_001', 'bay_real_002']);
  });

  it('uses a custom prefix when supplied', async () => {
    const step = new ProvisionStationPoolStep();
    const context = ctx();
    await step.execute(
      {
        action: 'provision_station_pool',
        count: 2,
        bay_count: 1,
        artifacts_dir: tmpDir,
        prefix: 'stn_fleet_',
      },
      context,
      {} as never,
    );
    for (const entry of context.pool.list()) {
      expect(entry.stationId).toMatch(/^stn_fleet_[a-f0-9]{8}$/);
    }
  });

  it('throws when count is missing or invalid', async () => {
    const step = new ProvisionStationPoolStep();
    await expect(
      step.execute({ action: 'provision_station_pool', bay_count: 1 }, ctx(), {} as never),
    ).rejects.toThrow(/"count" field is required/);
  });

  it('throws when bay_count is missing or invalid', async () => {
    const step = new ProvisionStationPoolStep();
    await expect(
      step.execute({ action: 'provision_station_pool', count: 1 }, ctx(), {} as never),
    ).rejects.toThrow(/"bay_count" field is required/);
  });

  it('throws when the provisioning token is not captured', async () => {
    const step = new ProvisionStationPoolStep();
    const context = createContext();
    context.apiBaseUrl = 'http://localhost:8080';
    await expect(
      step.execute(
        { action: 'provision_station_pool', count: 1, bay_count: 1, artifacts_dir: tmpDir },
        context,
        {} as never,
      ),
    ).rejects.toThrow(/token_var "provisioning_token" not in captured context/);
  });

  it('supports per-station token_vars when array is provided', async () => {
    const step = new ProvisionStationPoolStep();
    const context = ctx();
    context.captured.set('tok_a', 'TA');
    context.captured.set('tok_b', 'TB');
    await step.execute(
      {
        action: 'provision_station_pool',
        count: 2,
        bay_count: 1,
        artifacts_dir: tmpDir,
        token_vars: ['tok_a', 'tok_b'],
      },
      context,
      {} as never,
    );

    expect(context.pool.size()).toBe(2);
    const calls = fetchSpy.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));
    expect(calls[0].provisioningToken).toBe('TA');
    expect(calls[1].provisioningToken).toBe('TB');
  });

  it('rejects when token_vars length does not match count', async () => {
    const step = new ProvisionStationPoolStep();
    const context = ctx();
    context.captured.set('tok_a', 'TA');
    await expect(
      step.execute(
        {
          action: 'provision_station_pool',
          count: 2,
          bay_count: 1,
          artifacts_dir: tmpDir,
          token_vars: ['tok_a'],
        },
        context,
        {} as never,
      ),
    ).rejects.toThrow(/token_vars length 1 does not match count 2/);
  });

  it('surfaces a non-200 provisioning response with the body excerpt', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('{"error":"INVALID_TOKEN"}', { status: 401 }),
    );
    const step = new ProvisionStationPoolStep();
    await expect(
      step.execute(
        { action: 'provision_station_pool', count: 1, bay_count: 1, artifacts_dir: tmpDir },
        ctx(),
        {} as never,
      ),
    ).rejects.toThrow(/returned 401/);
  });
});
