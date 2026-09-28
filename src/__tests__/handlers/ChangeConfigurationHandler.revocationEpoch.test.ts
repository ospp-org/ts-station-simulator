import { describe, it, expect } from 'vitest';
import { ChangeConfigurationHandler } from '../../handlers/ChangeConfigurationHandler.js';
import {
  OsppAction,
  MessageType,
  MessageSource,
  OSPP_PROTOCOL_VERSION,
  type OsppEnvelope,
} from '@ospp/protocol';
import type { StationContext } from '../../handlers/Handler.js';

function makeMockStation(): { station: StationContext } {
  const station = {
    sessions: new Map(),
    reservations: new Map(),
    currentRevocationEpoch: 0,
    sender: {
      async send(): Promise<void> {
        // no-op
      },
    },
  } as unknown as StationContext;
  return { station };
}

function makeEnvelope(keys: Array<{ key: string; value: string }>): OsppEnvelope {
  return {
    messageId: 'msg-test',
    messageType: MessageType.REQUEST,
    action: OsppAction.CHANGE_CONFIGURATION,
    timestamp: new Date().toISOString(),
    source: MessageSource.SERVER,
    protocolVersion: OSPP_PROTOCOL_VERSION,
    payload: { keys },
  };
}

describe('ChangeConfigurationHandler — RevocationEpoch, by the name the spec gives it (CW95)', () => {
  // The spec names the key RevocationEpoch (spec 08-configuration.md, section 3, row 24, at v0.43.0;
  // @ospp/protocol ConfigKey.REVOCATION_EPOCH), and csms-server pushes it by that name at every boot
  // (IncludeEpochInBootListener) and on every bump (PushEpochToStationsListener). The handler compared
  // `revocationEpoch`, so the push was answered Accepted and never applied (UAT, 2026-09-28:
  // "[ChangeConfiguration] Accepted 1 configuration changes: RevocationEpoch=0").
  const handler = new ChangeConfigurationHandler();

  it('applies RevocationEpoch as the server sends it', async () => {
    const { station } = makeMockStation();
    await handler.handle(makeEnvelope([{ key: 'RevocationEpoch', value: '5' }]), station);
    expect(station.currentRevocationEpoch).toBe(5);
  });

  it('applies RevocationEpoch alongside other keys', async () => {
    const { station } = makeMockStation();
    await handler.handle(
      makeEnvelope([
        { key: 'HeartbeatIntervalSec', value: '60' },
        { key: 'RevocationEpoch', value: '7' },
      ]),
      station,
    );
    expect(station.currentRevocationEpoch).toBe(7);
  });
});

describe('ChangeConfigurationHandler — v0.4.0 revocationEpoch sniff', () => {
  const handler = new ChangeConfigurationHandler();

  it('updates station.currentRevocationEpoch when key matches', async () => {
    const { station } = makeMockStation();
    await handler.handle(makeEnvelope([{ key: 'revocationEpoch', value: '5' }]), station);
    expect(station.currentRevocationEpoch).toBe(5);
  });

  it('ignores non-numeric revocationEpoch values', async () => {
    const { station } = makeMockStation();
    station.currentRevocationEpoch = 3;
    await handler.handle(makeEnvelope([{ key: 'revocationEpoch', value: 'not-a-number' }]), station);
    expect(station.currentRevocationEpoch).toBe(3);
  });

  it('ignores unrelated keys', async () => {
    const { station } = makeMockStation();
    await handler.handle(makeEnvelope([{ key: 'heartbeatInterval', value: '60' }]), station);
    expect(station.currentRevocationEpoch).toBe(0);
  });

  it('processes revocationEpoch alongside other keys', async () => {
    const { station } = makeMockStation();
    await handler.handle(
      makeEnvelope([
        { key: 'heartbeatInterval', value: '60' },
        { key: 'revocationEpoch', value: '7' },
        { key: 'meterValuesInterval', value: '30' },
      ]),
      station,
    );
    expect(station.currentRevocationEpoch).toBe(7);
  });
});
