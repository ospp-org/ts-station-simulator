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
