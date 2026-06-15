import { describe, it, expect } from 'vitest';
import { BootNotificationHandler } from '../../handlers/BootNotificationHandler.js';
import {
  OsppAction,
  MessageType,
  MessageSource,
  BayStatus,
  OSPP_PROTOCOL_VERSION,
  type OsppEnvelope,
} from '@ospp/protocol';
import type { StationContext } from '../../handlers/Handler.js';

interface CapturedSend {
  action: OsppAction;
  messageType: MessageType;
  payload: unknown;
}

function makeMockStation(): {
  station: StationContext;
  captured: CapturedSend[];
  flags: { heartbeatStarted: boolean };
} {
  const captured: CapturedSend[] = [];
  const flags = { heartbeatStarted: false };

  const station = {
    config: {
      bays: [
        { bayId: 'bay_a', bayNumber: 1, services: [{ serviceId: 'svc_x', serviceName: 'X', available: true }] },
        { bayId: 'bay_b', bayNumber: 2, services: [{ serviceId: 'svc_y', serviceName: 'Y', available: true }] },
      ],
      behavior: { autoRetryBoot: false },
    },
    sender: {
      async send(action: OsppAction, messageType: MessageType, payload: unknown): Promise<void> {
        captured.push({ action, messageType, payload });
      },
    },
    sessionKey: null as string | null,
    getBayState(_bayId: string): BayStatus {
      return BayStatus.AVAILABLE;
    },
    startHeartbeat(_intervalSec: number): void {
      flags.heartbeatStarted = true;
    },
    stopHeartbeat(): void {},
    setBayState(): void {},
    async retryBoot(): Promise<void> {},
    destroyConnection(): void {},
    sessions: new Map(),
    reservations: new Map(),
    currentRevocationEpoch: 0,
  } as unknown as StationContext;

  return { station, captured, flags };
}

function acceptedBootResponse(sessionKey: string): OsppEnvelope {
  return {
    messageId: 'cmd_test_boot_resp',
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
  } as unknown as OsppEnvelope;
}

describe('BootNotificationHandler — autoReact gate', () => {
  it('captures sessionKey in BOTH modes (essential boot state)', async () => {
    for (const autoReact of [true, false]) {
      const { station } = makeMockStation();
      await new BootNotificationHandler(autoReact).handle(acceptedBootResponse('KEY_' + autoReact), station);
      expect(station.sessionKey).toBe('KEY_' + autoReact);
    }
  });

  it('autoReact=true (default, connect mode): starts heartbeat + emits a StatusNotification per bay', async () => {
    const { station, captured, flags } = makeMockStation();
    await new BootNotificationHandler().handle(acceptedBootResponse('K1'), station);

    expect(flags.heartbeatStarted).toBe(true);
    expect(captured).toHaveLength(2); // one per bay
    expect(captured.every(c => c.action === OsppAction.STATUS_NOTIFICATION)).toBe(true);
  });

  it('autoReact=false (scenario mode): NO heartbeat, NO StatusNotifications — only sessionKey', async () => {
    const { station, captured, flags } = makeMockStation();
    await new BootNotificationHandler(false).handle(acceptedBootResponse('K2'), station);

    expect(station.sessionKey).toBe('K2');
    expect(flags.heartbeatStarted).toBe(false);
    expect(captured).toHaveLength(0);
  });
});
