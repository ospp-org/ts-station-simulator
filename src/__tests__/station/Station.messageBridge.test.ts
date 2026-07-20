import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
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

/**
 * Regression guard for the cert-renewal re-handshake (ADR-0002 T1).
 *
 * The inbound-message → router bridge MUST be wired exactly once, at
 * construction — NOT per connect(). A certificate renewal re-handshakes by
 * disconnect()+connect(); if connect() re-registered the bridge, every reconnect
 * would stack another 'message' listener, routing each inbound message N times.
 * Observed on UAT before this fix: doubled heartbeats, and a scanner-fired
 * TriggerCertificateRenewal handled twice — two keypairs racing the single
 * pending-renewal-key slot, so the install paired a cert with the wrong key
 * (ERR_OSSL_X509_KEY_VALUES_MISMATCH) and the station process crashed.
 */
describe('Station inbound-message bridge — single registration (no re-handshake leak)', () => {
  it('wires the connection→router bridge exactly once at construction', () => {
    const station = new Station(minimalConfig('stn_bridge01'), {
      mqttUrl: 'mqtts://broker.example:8883',
      stationId: 'stn_bridge01',
    });
    const connection = (station as unknown as { connection: EventEmitter }).connection;
    expect(connection.listenerCount('message')).toBe(1);
  });

  it('routes each inbound message exactly once', () => {
    const station = new Station(minimalConfig('stn_bridge02'), {
      mqttUrl: 'mqtts://broker.example:8883',
      stationId: 'stn_bridge02',
    });
    const connection = (station as unknown as { connection: EventEmitter }).connection;
    const router = (station as unknown as { router: { route: (t: string, p: Buffer) => void } })
      .router;

    let routed = 0;
    router.route = (): void => {
      routed += 1;
    };

    connection.emit('message', 'ospp/stn_bridge02/from-server', Buffer.from('{}'));
    expect(routed).toBe(1);
  });
});
