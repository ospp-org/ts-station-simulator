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

  it('surfaces receiptKeyPath + chainPath when the receipt-signing key exists on disk', async () => {
    // A `run --station <id>` against a bootstrap/provision-persisted station must
    // wire the receipt-signing key so SendStep can sign offline TransactionEvent
    // receipts — without it, auth-form/pass-form reconcile fails with
    // "no receiptKeyPath registered".
    const stationId = 'stn_receipt01';
    await fs.writeFile(
      path.join(tmpDir, `${stationId}-bays.json`),
      JSON.stringify({ stationId, bayIds: ['bay_r'] }),
    );
    await fs.writeFile(
      path.join(tmpDir, `${stationId}-receipt-key.pem`),
      '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----',
    );

    const result = await _hydrateProvisioningForTesting(stationId, {
      mqttUrl: 'mqtt://x',
      tls: { key: path.join(tmpDir, '{{stationId}}-key.pem') },
    });

    expect(result?.receiptKeyPath).toBe(path.join(tmpDir, `${stationId}-receipt-key.pem`));
    expect(result?.chainPath).toBe(path.join(tmpDir, `${stationId}-chain.pem`));
  });

  it('omits receiptKeyPath when no receipt-signing key is on disk (pass-form-only station)', async () => {
    const stationId = 'stn_noreceipt';
    await fs.writeFile(
      path.join(tmpDir, `${stationId}-bays.json`),
      JSON.stringify({ stationId, bayIds: ['bay_n'] }),
    );

    const result = await _hydrateProvisioningForTesting(stationId, {
      mqttUrl: 'mqtt://x',
      tls: { key: path.join(tmpDir, '{{stationId}}-key.pem') },
    });

    expect(result?.receiptKeyPath).toBeUndefined();
  });
});
