import { describe, it, expect } from 'vitest';
import {
  EffectedBy,
  BayStatus,
  BayStateMachine,
  isReportableBayStatus,
  MessageType,
  OsppAction,
  type OsppEnvelope,
  type StatusNotificationPayload,
} from '@ospp/protocol';
import { BootNotificationHandler } from '../../handlers/BootNotificationHandler.js';
import type { Handler, StationContext } from '../../handlers/Handler.js';

/*
 * The post-boot StatusNotification must carry a status a station may report.
 *
 * `BootNotificationHandler`'s autoReact branch reads `station.getBayState()`
 * straight into the payload it publishes. Whatever a bay's state machine holds
 * at that moment goes on the wire verbatim — so if the machine can hold a
 * non-reportable state, the handler will publish one.
 *
 * The existing autoReact test stubs `getBayState()` to a hardcoded
 * `BayStatus.AVAILABLE`, which asserts the answer the code is supposed to
 * produce and therefore cannot fail. This one sources the state from a REAL
 * `BayStateMachine`, so it tracks whatever the SDK's actual default is.
 *
 * RED before the bay-init change: the machine defaults to `UNKNOWN` and the
 * handler publishes `status: "Unknown"` — non-conforming per spec v0.10.0, and
 * schema-invalid against the narrowed `bay-status.schema.json`.
 */

const BAYS = [
  { bayId: 'bay_rs_a', bayNumber: 1, programs: [{ programNumber: 1, label: 'P1', available: true }], services: [{ serviceId: 'svc_x', serviceName: 'X', available: true }] },
  { bayId: 'bay_rs_b', bayNumber: 2, programs: [{ programNumber: 1, label: 'P1', available: true }], services: [{ serviceId: 'svc_y', serviceName: 'Y', available: true }] },
];

function makeContext(
  captured: Array<{ action: OsppAction; payload: unknown }>,
  // Mirrors `Station`'s constructor: a real BayStateMachine per bay, seeded the way
  // the real one seeds it. Passing nothing gives the SDK's own FSM default, which is
  // `Unknown` — used below to prove the guard fires.
  initial?: BayStatus,
) {
  const machines = new Map(
    BAYS.map(b => [
      b.bayId,
      // EffectedBy.STATION is required now: "a station machine that silently
      // accepted the Server rows would model the server's job". Omitting the
      // initial state still gives the SDK default, Unknown, which is what proves
      // the guard fires.
      initial === undefined
        ? new BayStateMachine(EffectedBy.STATION)
        : new BayStateMachine(EffectedBy.STATION, initial),
    ]),
  );

  return {
    config: { stationId: 'stn_reportable01', bays: BAYS, behavior: { autoRetryBoot: false } },
    sender: {
      async send(action: OsppAction, _messageType: MessageType, payload: unknown): Promise<void> {
        captured.push({ action, payload });
      },
    },
    sessionKey: null as string | null,
    getBayState: (bayId: string): BayStatus => machines.get(bayId)!.state,
    setBayState: (bayId: string, status: BayStatus): void => {
      machines.get(bayId)!.transition(status);
    },
    startHeartbeat(): void {},
    stopHeartbeat(): void {},
    async retryBoot(): Promise<void> {},
    destroyConnection(): void {},
  } as unknown as StationContext;
}

function acceptedBoot(): OsppEnvelope {
  return {
    messageId: 'msg_boot_reportable',
    messageType: MessageType.RESPONSE,
    action: OsppAction.BOOT_NOTIFICATION,
    timestamp: '2026-07-31T00:00:00.000Z',
    source: 'Server',
    protocolVersion: '0.2.1',
    payload: {
      status: 'Accepted',
      heartbeatIntervalSec: 30,
      serverTime: '2026-07-31T00:00:00.000Z',
    },
  } as unknown as OsppEnvelope;
}

describe('post-boot StatusNotification', () => {
  it('never publishes a bay status the station may not report', async () => {
    const captured: Array<{ action: OsppAction; payload: unknown }> = [];
    const handler = new BootNotificationHandler() as unknown as Handler;

    await handler.handle(acceptedBoot(), makeContext(captured, BayStatus.AVAILABLE));

    const statuses = captured
      .filter(c => c.action === OsppAction.STATUS_NOTIFICATION)
      .map(c => (c.payload as StatusNotificationPayload).status);

    expect(statuses).toHaveLength(BAYS.length);
    for (const status of statuses) {
      expect(
        isReportableBayStatus(status),
        `published status "${status}" is not a reportable bay state`,
      ).toBe(true);
    }
  });

  it('omits previousStatus — absence is what marks the boot report', async () => {
    const captured: Array<{ action: OsppAction; payload: unknown }> = [];
    const handler = new BootNotificationHandler() as unknown as Handler;

    await handler.handle(acceptedBoot(), makeContext(captured, BayStatus.AVAILABLE));

    const payloads = captured
      .filter(c => c.action === OsppAction.STATUS_NOTIFICATION)
      .map(c => c.payload as StatusNotificationPayload);

    expect(payloads).toHaveLength(BAYS.length);
    for (const payload of payloads) {
      expect(payload.previousStatus).toBeUndefined();
    }
  });

  /*
   * The guard, proven to fire.
   *
   * `Station` now seeds its bays AVAILABLE, so this state is unreachable through
   * the real constructor — which is exactly why it is worth pinning. If a future
   * change reintroduces an unresolved bay, the station must fail locally and
   * loudly rather than publish a message the server will reject and drop whole,
   * leaving the bay stuck at unknown server-side where it refuses payment.
   *
   * Seeded with the SDK's own FSM default rather than a literal, so this tracks
   * whatever `BayStateMachine` considers "not yet resolved".
   */
  it('refuses to publish rather than emit an unresolved bay', async () => {
    const captured: Array<{ action: OsppAction; payload: unknown }> = [];
    const handler = new BootNotificationHandler() as unknown as Handler;

    await expect(handler.handle(acceptedBoot(), makeContext(captured))).rejects.toThrow(
      /must not report/,
    );

    const published = captured.filter(c => c.action === OsppAction.STATUS_NOTIFICATION);
    expect(published, 'nothing non-conforming reached the wire').toHaveLength(0);
  });
});
