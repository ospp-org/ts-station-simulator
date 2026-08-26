import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Station } from '../../station/Station.js';
import type { StationConfig } from '../../station/StationConfig.js';
import {
  INBOUND_SCHEMA_ENV,
  inboundSchemaStats,
  resetInboundSchemaStats,
} from '../../mqtt/inboundSchema.js';
import { OsppAction, MessageType, MessageSource, OSPP_PROTOCOL_VERSION } from '@ospp/protocol';

// ---------------------------------------------------------------------------
// THE GATE HAS A CALLER — asserted on the wiring, not on the class.
//
// MessageRouter's schema check is exercised thoroughly by tests that construct
// the router directly. Those would all pass with Station never enabling it, in
// exactly the way every MAC test passed while Station.ts built its router as
// `new MessageRouter()` and the key it stored could never be seen (see
// Station.routerWiring.test.ts — same file, same class, same shape of mistake).
//
// The failure mode here is worse than that one, because it is SILENT: the gate
// logs only on a violation, so a Station that never validated anything and a
// wire carrying nothing malformed produce identical output — no lines at all.
// A measurement run reporting "0 non-conformant" would then be reporting the
// wiring, not the server. Hence both halves below: that the mode reaches the
// router, and that a payload routed through the STATION's own inbound bridge is
// actually judged.
// ---------------------------------------------------------------------------

function makeConfig(): StationConfig {
  return {
    stationId: 'stn_schematest',
    firmwareVersion: '1.0.0',
    stationModel: 'M',
    stationVendor: 'V',
    timezone: 'UTC',
    bays: [
      {
        bayId: 'bay_schematest',
        bayNumber: 1,
        programs: [{ programNumber: 1, label: 'P1', available: true }],
        services: [{ serviceId: 'svc_x', serviceName: 'X', available: true }],
      },
    ],
    behavior: {
      acceptRate: 1,
      responseDelayMs: [0, 0],
      heartbeatIntervalSec: 30,
      meterValuesIntervalSec: 10,
    },
  } as unknown as StationConfig;
}

function bootResponse(payload: unknown): Buffer {
  // BootNotification RESPONSE is MAC-exempt (it carries the session key), so
  // this reaches the schema gate without needing a key the station has not got.
  return Buffer.from(
    JSON.stringify({
      messageId: 'msg-wiring',
      messageType: MessageType.RESPONSE,
      action: OsppAction.BOOT_NOTIFICATION,
      timestamp: new Date().toISOString(),
      source: MessageSource.SERVER,
      protocolVersion: OSPP_PROTOCOL_VERSION,
      payload,
    }),
  );
}

const original = process.env[INBOUND_SCHEMA_ENV];

beforeEach(() => {
  resetInboundSchemaStats();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (original === undefined) delete process.env[INBOUND_SCHEMA_ENV];
  else process.env[INBOUND_SCHEMA_ENV] = original;
});

describe('Station — the inbound schema gate is wired to the wire', () => {
  it('a payload routed through the station is CHECKED — the denominator moves', () => {
    delete process.env[INBOUND_SCHEMA_ENV];
    const station = new Station(makeConfig(), {} as never);

    expect(inboundSchemaStats().checked).toBe(0);
    station.router.route('to-station', bootResponse({
      status: 'Accepted',
      serverTime: '2026-08-26T12:00:00.000Z',
      heartbeatIntervalSec: 30,
      sessionKey: Buffer.from(new Uint8Array(32).fill(3)).toString('base64'),
    }));

    // The point of the assertion: not "nothing was refused", but "something was
    // judged". A gate with no caller leaves this at 0.
    expect(inboundSchemaStats().checked).toBe(1);
    expect(inboundSchemaStats().violations).toBe(0);
  });

  it('and a non-conformant one is REFUSED by the station, not merely counted', () => {
    delete process.env[INBOUND_SCHEMA_ENV];
    const station = new Station(makeConfig(), {} as never);
    const seen: string[] = [];
    station.router.onAction(OsppAction.BOOT_NOTIFICATION, (e) => seen.push(e.messageId));

    station.router.route('to-station', bootResponse({ status: 'Accepted' }));

    expect(seen).toEqual([]);
    expect(inboundSchemaStats().violations).toBe(1);
    expect(station.router.schemaViolations).toHaveLength(1);
  });

  it('the mode reaches the router from the environment — warn delivers and records', () => {
    process.env[INBOUND_SCHEMA_ENV] = 'warn';
    const station = new Station(makeConfig(), {} as never);
    const seen: string[] = [];
    station.router.onAction(OsppAction.BOOT_NOTIFICATION, (e) => seen.push(e.messageId));

    station.router.route('to-station', bootResponse({ status: 'Accepted' }));

    // Delivered anyway — this is the measuring mode — but still recorded, which
    // is what makes a warn-mode run a measurement rather than a no-op.
    expect(seen).toEqual(['msg-wiring']);
    expect(station.router.schemaViolations).toHaveLength(1);
  });

  it('`off` reaches the router too, and then nothing is checked at all', () => {
    process.env[INBOUND_SCHEMA_ENV] = 'off';
    const station = new Station(makeConfig(), {} as never);

    station.router.route('to-station', bootResponse({ status: 'Accepted' }));

    expect(inboundSchemaStats().checked).toBe(0);
    expect(station.router.schemaViolations).toHaveLength(0);
  });
});
