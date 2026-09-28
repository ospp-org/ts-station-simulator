import { describe, it, expect, vi } from 'vitest';
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

// These pinned `revocationEpoch`, lower-case r - a spelling no spec version gives the key and csms-server
// never sends - as the key that applies. Rewritten for CW95 on the spec's name; the camelCase spelling is
// kept as the one case that must NOT apply, since `revocationEpoch` is the OfflinePass field
// (offline-pass.schema.json), not a configuration key.
describe('ChangeConfigurationHandler — what is and is not the RevocationEpoch key', () => {
  const handler = new ChangeConfigurationHandler();

  it('ignores non-numeric RevocationEpoch values', async () => {
    const { station } = makeMockStation();
    station.currentRevocationEpoch = 3;
    await handler.handle(makeEnvelope([{ key: 'RevocationEpoch', value: 'not-a-number' }]), station);
    expect(station.currentRevocationEpoch).toBe(3);
  });

  it('ignores unrelated keys', async () => {
    const { station } = makeMockStation();
    await handler.handle(makeEnvelope([{ key: 'heartbeatInterval', value: '60' }]), station);
    expect(station.currentRevocationEpoch).toBe(0);
  });

  it('does not apply the camelCase revocationEpoch, which is not the configuration key', async () => {
    const { station } = makeMockStation();
    await handler.handle(makeEnvelope([{ key: 'revocationEpoch', value: '9' }]), station);
    expect(station.currentRevocationEpoch).toBe(0);
  });

  it('says what it applied, the epoch it held before beside the new one', async () => {
    const { station } = makeMockStation();
    station.currentRevocationEpoch = 2;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handler.handle(makeEnvelope([{ key: 'RevocationEpoch', value: '4' }]), station);
    expect(log).toHaveBeenCalledWith('[ChangeConfiguration] %s applied: %d (was %d)', 'RevocationEpoch', 4, 2);
    log.mockRestore();
  });
});
