import { describe, it, expect } from 'vitest';
import {
  _createStationFromScenarioForTesting,
  type ScenarioDefinition,
  type TargetConfig,
} from '../../scenarios/ScenarioRunner.js';
import { OsppAction, MessageType, MessageSource, OSPP_PROTOCOL_VERSION } from '@ospp/protocol';

function scenarioDef(): ScenarioDefinition {
  return {
    name: 'sessionkey-capture-test',
    station: {
      bayCount: 2,
      stationModel: 'WashPro X200',
      stationVendor: 'SimCorp',
      behavior: { accept_rate: 1.0 },
    },
    steps: [],
  } as unknown as ScenarioDefinition;
}

function variables(): Map<string, string> {
  return new Map([
    ['stationId', 'stn_sktest01'],
    ['bayId_1', 'bay_g1'],
    ['bayId_2', 'bay_g2'],
    ['serviceId_1', 'svc_test'],
    ['serialNumber', 'SIM-SK-TEST'],
  ]);
}

const target: TargetConfig = { mqttUrl: 'mqtt://localhost:1883', apiBaseUrl: 'http://localhost:8080' };

function bootAcceptedRaw(sessionKey: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      messageId: 'cmd_boot_resp_sk',
      messageType: MessageType.RESPONSE,
      action: OsppAction.BOOT_NOTIFICATION,
      source: MessageSource.CSMS,
      timestamp: '2026-06-15T00:00:00.000Z',
      protocolVersion: OSPP_PROTOCOL_VERSION,
      payload: {
        status: 'Accepted',
        heartbeatIntervalSec: 60,
        serverTime: '2026-06-15T00:00:00.000Z',
        sessionKey,
      },
    }),
  );
}

describe('ScenarioRunner — scenario-mode boot captures sessionKey (HMAC signing prerequisite)', () => {
  it('populates station.sessionKey after a BootNotification Accepted Response', async () => {
    const station = _createStationFromScenarioForTesting(scenarioDef(), variables(), target);
    expect(station.sessionKey).toBeNull(); // pre-boot

    station.router.route('ospp/v1/stations/stn_sktest01/to-station', bootAcceptedRaw('SCENARIO_SESSION_KEY'));
    await new Promise(resolve => setTimeout(resolve, 10)); // flush async handler

    expect(station.sessionKey).toBe('SCENARIO_SESSION_KEY');
  });

  it('fan-out: the boot Response remains buffered for wait_for after the handler runs', async () => {
    const station = _createStationFromScenarioForTesting(scenarioDef(), variables(), target);
    station.router.route('ospp/v1/stations/stn_sktest01/to-station', bootAcceptedRaw('K'));
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(station.sessionKey).toBe('K'); // handler ran (emit channel)
    const buffered = station.router.drainBuffered(OsppAction.BOOT_NOTIFICATION, MessageType.RESPONSE);
    expect(buffered).toHaveLength(1); // wait_for still finds it (buffer channel) → fan-out, not consume
  });
});
