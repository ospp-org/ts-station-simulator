/**
 * Minimal payloads that actually satisfy their message schema.
 *
 * Before the inbound schema gate existed, routing and correlation tests built
 * envelopes with `payload: {}` — a shape that has never been on the wire for any
 * of these messages. That was invisible while the router cast inbound JSON to
 * `OsppEnvelope` and asked nothing of it, and it is exactly the reason the suite
 * could not see a server shipping `payload: []`: its own idea of an inbound
 * message did not have to resemble one.
 *
 * These are deliberately MINIMAL — required members only, no optional decoration
 * — so a test that needs a specific field sets it explicitly and the reader can
 * tell which fields the test is actually about.
 *
 * conformantPayloads.test.ts validates every entry here against the SDK schema
 * it claims to satisfy. A fixture helper that quietly stopped producing
 * conformant fixtures would re-open the hole this closes, one indirection
 * further away.
 */
import { OsppAction, MessageType } from '@ospp/protocol';

const SESSION_KEY_B64 = Buffer.from(new Uint8Array(32).fill(9)).toString('base64');

export const CONFORMANT_PAYLOADS: ReadonlyArray<{
  action: OsppAction;
  messageType: MessageType;
  payload: Record<string, unknown>;
}> = [
  {
    action: OsppAction.BOOT_NOTIFICATION,
    messageType: MessageType.REQUEST,
    payload: {
      stationId: 'stn_00000001',
      firmwareVersion: '1.0.0',
      stationModel: 'SimModel',
      stationVendor: 'SimVendor',
      serialNumber: 'SN-12345678',
      bays: [{ bayNumber: 1, programNumbers: [1] }],
      uptimeSeconds: 42,
      pendingOfflineTransactions: 0,
      timezone: 'Europe/Bucharest',
      bootReason: 'PowerOn',
      capabilities: {
        bleSupported: false,
        offlineModeSupported: true,
        meterValuesSupported: true,
      },
      networkInfo: { connectionType: 'Ethernet' },
    },
  },
  {
    action: OsppAction.BOOT_NOTIFICATION,
    messageType: MessageType.RESPONSE,
    payload: {
      status: 'Accepted',
      serverTime: '2026-08-26T12:00:00.000Z',
      heartbeatIntervalSec: 30,
      sessionKey: SESSION_KEY_B64,
    },
  },
  {
    action: OsppAction.HEARTBEAT,
    messageType: MessageType.REQUEST,
    payload: {},
  },
  {
    action: OsppAction.HEARTBEAT,
    messageType: MessageType.RESPONSE,
    payload: { serverTime: '2026-08-26T12:00:00.000Z' },
  },
  {
    action: OsppAction.RESET,
    messageType: MessageType.REQUEST,
    payload: { force: false },
  },
  {
    action: OsppAction.START_SERVICE,
    messageType: MessageType.REQUEST,
    payload: {
      sessionId: 'sess_00000001',
      bayId: 'bay_00000001',
      serviceId: 'svc_wash_basic',
      durationSeconds: 300,
      sessionSource: 'MobileApp',
      programNumber: 1,
    },
  },
  {
    action: OsppAction.GET_CONFIGURATION,
    messageType: MessageType.REQUEST,
    payload: {},
  },
  {
    action: OsppAction.GET_DIAGNOSTICS,
    messageType: MessageType.REQUEST,
    payload: { uploadUrl: 'https://example.invalid/diagnostics' },
  },
];

const INDEX = new Map(
  CONFORMANT_PAYLOADS.map((e) => [`${e.action}|${e.messageType}`, e.payload]),
);

/**
 * A conformant payload for this pair, THROWING when none is registered.
 *
 * Not `?? {}`: falling back to an empty object would hand back the very
 * non-conformant fixture this helper exists to retire, and the test would go
 * green while proving nothing about the message it names.
 */
export function conformantPayloadFor(
  action: OsppAction,
  messageType: MessageType,
): Record<string, unknown> {
  const found = INDEX.get(`${action}|${messageType}`);
  if (found === undefined) {
    throw new Error(
      `No conformant fixture for ${action} ${messageType}. Add one to ` +
        `CONFORMANT_PAYLOADS (conformantPayloads.test.ts will validate it against the schema).`,
    );
  }
  return structuredClone(found);
}
