import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _hydrateProvisioningForTesting } from '../../scenarios/ScenarioRunner.js';

describe('hydrateProvisioningFromDisk', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydrate-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined when no bays.json exists', async () => {
    const result = await _hydrateProvisioningForTesting('stn_missing', {
      mqttUrl: 'mqtt://x',
      tls: { key: path.join(tmpDir, '{{stationId}}-key.pem') },
    });
    expect(result).toBeUndefined();
  });

  it('hydrates from CLI provision layout (<dirname>/<stationId>-bays.json)', async () => {
    const stationId = 'stn_aabbccdd';
    const baysJsonPath = path.join(tmpDir, `${stationId}-bays.json`);
    await fs.writeFile(
      baysJsonPath,
      JSON.stringify({ stationId, bayIds: ['bay_real_a', 'bay_real_b'] }),
    );

    const result = await _hydrateProvisioningForTesting(stationId, {
      mqttUrl: 'mqtt://x',
      tls: { key: path.join(tmpDir, '{{stationId}}-key.pem') },
    });

    expect(result).toBeDefined();
    expect(result?.stationId).toBe(stationId);
    expect(result?.bayIds).toEqual(['bay_real_a', 'bay_real_b']);
    expect(result?.keyPath).toBe(path.join(tmpDir, `${stationId}-key.pem`));
    expect(result?.certPath).toBe(path.join(tmpDir, `${stationId}.pem`));
  });

  it('returns undefined when bays.json is malformed', async () => {
    const stationId = 'stn_bad';
    const baysJsonPath = path.join(tmpDir, `${stationId}-bays.json`);
    await fs.writeFile(baysJsonPath, 'not-valid-json');

    const result = await _hydrateProvisioningForTesting(stationId, {
      mqttUrl: 'mqtt://x',
      tls: { key: path.join(tmpDir, '{{stationId}}-key.pem') },
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined when bays.json has empty bayIds array', async () => {
    const stationId = 'stn_empty';
    const baysJsonPath = path.join(tmpDir, `${stationId}-bays.json`);
    await fs.writeFile(baysJsonPath, JSON.stringify({ stationId, bayIds: [] }));

    const result = await _hydrateProvisioningForTesting(stationId, {
      mqttUrl: 'mqtt://x',
      tls: { key: path.join(tmpDir, '{{stationId}}-key.pem') },
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined when target has no tls config and no scenario artifact', async () => {
    const result = await _hydrateProvisioningForTesting('stn_no_tls', {
      mqttUrl: 'mqtt://x',
    });
    expect(result).toBeUndefined();
  });

  it('honours tls.keyPattern when tls.key is absent', async () => {
    const stationId = 'stn_pattern';
    const baysJsonPath = path.join(tmpDir, `${stationId}-bays.json`);
    await fs.writeFile(
      baysJsonPath,
      JSON.stringify({ stationId, bayIds: ['bay_p'] }),
    );

    const result = await _hydrateProvisioningForTesting(stationId, {
      mqttUrl: 'mqtt://x',
      tls: { keyPattern: path.join(tmpDir, '{{stationId}}-key.pem') },
    });
    expect(result?.bayIds).toEqual(['bay_p']);
  });
});
