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
        { bayId: 'bay_a', bayNumber: 1, programs: [{ programNumber: 1, label: 'P1', available: true }], services: [{ serviceId: 'svc_x', serviceName: 'X', available: true }] },
        { bayId: 'bay_b', bayNumber: 2, programs: [{ programNumber: 1, label: 'P1', available: true }], services: [{ serviceId: 'svc_y', serviceName: 'Y', available: true }] },
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

/**
 * THE FLAG SPLIT IN TWO ON 2026-09-07, AND THIS FILE IS WHERE THE OLD MEANING DIED.
 *
 * `autoReact=false` used to mean two things at once: "do not emit StatusNotifications for
 * bayIds the scenario has not provisioned yet" (correct, unchanged) and "do not beat"
 * (a non-conformance — 140 of 148 scenario files booted and then went application-silent).
 * The heartbeat half moved to its own parameter, which DEFAULTS ON in both modes.
 *
 * The assertion below that used to read `heartbeatStarted === false` for scenario mode now
 * reads `true`, and that inversion is the change, not a regression. The silent case still
 * exists and is still tested — it is now the explicitly-declared one. See
 * `scenarios/heartbeatIsDefault.test.ts` for the wire-level proof in both directions.
 */
describe('BootNotificationHandler — autoReact / autoHeartbeat gates', () => {
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

  it('autoReact=false (scenario mode): NO StatusNotifications — but it still BEATS', async () => {
    const { station, captured, flags } = makeMockStation();
    await new BootNotificationHandler(false).handle(acceptedBootResponse('K2'), station);

    expect(station.sessionKey).toBe('K2');
    expect(captured).toHaveLength(0); // the half that did not change
    expect(flags.heartbeatStarted).toBe(true); // the half that did
  });

  it('autoHeartbeat=false: the declared-silence case, and the ONLY way to get silence now', async () => {
    const { station, captured, flags } = makeMockStation();
    await new BootNotificationHandler(false, false).handle(acceptedBootResponse('K3'), station);

    expect(station.sessionKey).toBe('K3');
    expect(flags.heartbeatStarted).toBe(false);
    expect(captured).toHaveLength(0);
  });

  it('the two flags are independent — connect mode can be silent, scenario mode can beat', () => {
    // Guards the split itself. If a later change re-ties them, one of these four combinations
    // stops being reachable and the corpus loses either its silence declaration or its
    // per-bay boot report.
    const combos: Array<[boolean, boolean]> = [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ];
    const seen = new Set<string>();
    for (const [autoReact, autoHeartbeat] of combos) {
      const { station, captured, flags } = makeMockStation();
      // Synchronous enough for the flags; the sends are awaited inside but the mock resolves
      // immediately, and the assertion is on the SHAPE of the combination, not on ordering.
      void new BootNotificationHandler(autoReact, autoHeartbeat).handle(
        acceptedBootResponse('K'),
        station,
      );
      seen.add(`${flags.heartbeatStarted}/${captured.length > 0}`);
    }
    expect(seen.size, 'the two flags no longer produce four distinct outcomes').toBe(4);
  });
});
