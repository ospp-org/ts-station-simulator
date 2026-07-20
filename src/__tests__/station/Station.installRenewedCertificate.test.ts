import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Station } from '../../station/Station.js';
import type { StationConfig } from '../../station/StationConfig.js';
import type { StationId } from '@ospp/protocol';

function minimalConfig(stationId: string): StationConfig {
  return {
    stationId: stationId as StationId,
    firmwareVersion: '1.0.0',
    stationModel: 'M',
    stationVendor: 'V',
    serialNumber: 'SN-TEST',
    bayCount: 0,
    timezone: 'UTC',
    bays: [],
    behavior: {
      acceptRate: 1,
      responseDelayMs: [0, 0],
      heartbeatIntervalSec: 60,
      meterValuesIntervalSec: 30,
      autoRetryBoot: false,
    },
  };
}

describe('Station.installRenewedCertificate — swap the client cert on disk', () => {
  it('overwrites the station TLS cert + key files with the renewed material', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'renew-install-'));
    const keyPath = path.join(dir, 'stn.key.pem');
    const certPath = path.join(dir, 'stn.cert.pem');
    await writeFile(keyPath, 'OLD-PROVISIONING-KEY');
    await writeFile(certPath, 'OLD-PROVISIONING-CERT');

    const station = new Station(minimalConfig('stn_install01'), {
      mqttUrl: 'mqtts://broker.example:8883',
      stationId: 'stn_install01',
      tls: { key: keyPath, cert: certPath },
    });

    await station.installRenewedCertificate({
      certificatePem: '-----BEGIN CERTIFICATE-----\nRENEWED-LEAF\n-----END CERTIFICATE-----',
      privateKeyPem: '-----BEGIN PRIVATE KEY-----\nRENEWED-KEY\n-----END PRIVATE KEY-----',
      caChainPem: '-----BEGIN CERTIFICATE-----\nISSUING-CA\n-----END CERTIFICATE-----',
    });

    const certOut = await readFile(certPath, 'utf8');
    const keyOut = await readFile(keyPath, 'utf8');

    // The connection reads these exact paths at connect() time, so overwriting
    // them IS the client-cert swap — the next handshake presents the renewed leaf.
    expect(certOut).toContain('RENEWED-LEAF');
    expect(certOut).not.toContain('OLD-PROVISIONING-CERT');
    // Full chain (leaf + issuing CA) when a chain is supplied.
    expect(certOut).toContain('ISSUING-CA');
    expect(keyOut).toContain('RENEWED-KEY');
    expect(keyOut).not.toContain('OLD-PROVISIONING-KEY');
  });

  it('throws if the station has no TLS cert/key path to swap', async () => {
    const station = new Station(minimalConfig('stn_install02'), {
      mqttUrl: 'mqtts://broker.example:8883',
      stationId: 'stn_install02',
      // no tls
    });

    await expect(
      station.installRenewedCertificate({
        certificatePem: 'LEAF',
        privateKeyPem: 'KEY',
      }),
    ).rejects.toThrow();
  });
});
