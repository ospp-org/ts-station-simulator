import { describe, it, expect } from 'vitest';
import {
  OsppAction,
  MessageType,
  MessageSource,
  BayStatus,
  OsppErrorCode,
  type OsppEnvelope,
} from '@ospp/protocol';
import type { StationContext } from '../../handlers/Handler.js';
import { UpdateServiceCatalogHandler } from '../../handlers/UpdateServiceCatalogHandler.js';
import { ReserveBayHandler } from '../../handlers/ReserveBayHandler.js';
import { CancelReservationHandler } from '../../handlers/CancelReservationHandler.js';
import { SetMaintenanceModeHandler } from '../../handlers/SetMaintenanceModeHandler.js';
import { StopServiceHandler } from '../../handlers/StopServiceHandler.js';
import { GetDiagnosticsHandler } from '../../handlers/GetDiagnosticsHandler.js';

/*
 * REFUSALS A CONFORMING STATION MAKES AND THIS ONE DID NOT.
 *
 * Groups A, B, C, D.3, F and I.3 of docs/CONFORMANCE-GAPS.md — 11 of the 41.
 *
 * Every assertion lands on the FRAME SENT, never on a log line: the thing a server can
 * observe is the response envelope, and a refusal that exists only in stdout is not a
 * refusal. Two shapes here are worse than absent and are asserted as such: group A
 * currently THROWS, so the server sees no frame at all, and group C currently answers
 * `Accepted` where the spec requires `3013`/`3012` — a wrong statement on the wire.
 *
 * The control that matters is at the bottom: a station that does it right must still be
 * accepted. Without those, a handler that refused everything would pass this file.
 */

interface Sent {
  action: OsppAction;
  messageType: MessageType;
  payload: Record<string, unknown>;
}

interface MockOpts {
  bayStates?: Record<string, BayStatus>;
  sessions?: Map<string, unknown>;
  reservations?: Map<string, unknown>;
  catalogVersion?: string;
}

function mockStation(opts: MockOpts = {}): { station: StationContext; sent: Sent[] } {
  const sent: Sent[] = [];
  const bayStates = opts.bayStates ?? { bay_a: BayStatus.AVAILABLE, bay_b: BayStatus.AVAILABLE };

  const station = {
    config: {
      stationId: 'stn_conformance',
      bays: [
        {
          bayId: 'bay_a',
          bayNumber: 1,
          programs: [
            { programNumber: 1, label: 'Rinse', available: true },
            { programNumber: 2, label: 'Foam', available: true },
          ],
          services: [],
        },
        {
          bayId: 'bay_b',
          bayNumber: 2,
          programs: [{ programNumber: 1, label: 'Rinse', available: true }],
          services: [],
        },
      ],
      behavior: { autoRetryBoot: false },
    },
    currentCatalogVersion: opts.catalogVersion ?? 'v1',
    sender: {
      async send(
        action: OsppAction,
        messageType: MessageType,
        payload: Record<string, unknown>,
      ): Promise<void> {
        sent.push({ action, messageType, payload });
      },
    },
    // The real Station throws for an unknown bay; the mock reproduces that so group A is
    // measured against the actual failure shape rather than a friendlier stand-in.
    getBayState(bayId: string): BayStatus {
      const s = bayStates[bayId];
      if (s === undefined) {
        throw new Error(`Bay not found: ${bayId}`);
      }
      return s;
    },
    setBayState(bayId: string, s: BayStatus): void {
      bayStates[bayId] = s;
    },
    sessions: opts.sessions ?? new Map(),
    reservations: opts.reservations ?? new Map(),
    terminalReservations: new Map(),
  } as unknown as StationContext;

  return { station, sent };
}

function envelope(action: OsppAction, payload: unknown): OsppEnvelope {
  return {
    messageId: 'msg_conformance_0001',
    messageType: MessageType.REQUEST,
    action,
    source: MessageSource.SERVER,
    timestamp: new Date().toISOString(),
    payload,
  } as unknown as OsppEnvelope;
}

/** The one frame the server can see. Absence is itself a failure mode here. */
function onlyResponse(sent: Sent[]): Record<string, unknown> {
  const responses = sent.filter(s => s.messageType === MessageType.RESPONSE);
  expect(responses, 'the station sent NO response frame at all').toHaveLength(1);
  return responses[0]!.payload;
}

describe('F — catalog: a binding the station never declared (update-service-catalog.md r8)', () => {
  it('RED: rejects the WHOLE catalog with 5024 and keeps the previous one', async () => {
    const { station, sent } = mockStation({ catalogVersion: 'v7' });

    await new UpdateServiceCatalogHandler().handle(
      envelope(OsppAction.UPDATE_SERVICE_CATALOG, {
        catalogVersion: 'v8',
        services: [
          // bay 1 declares {1,2} — this one is fine.
          { serviceId: 'svc_ok', serviceName: 'OK', pricingType: 'PerMinute', available: true,
            bindings: [{ bayNumber: 1, programNumber: 2 }] },
          // bay 2 declares {1} only. Program 9 was never declared.
          { serviceId: 'svc_bad', serviceName: 'Bad', pricingType: 'PerMinute', available: true,
            bindings: [{ bayNumber: 2, programNumber: 9 }] },
        ],
      }),
      station,
    );

    const res = onlyResponse(sent);
    expect(res.status).toBe('Rejected');
    expect(res.errorCode).toBe(OsppErrorCode.UNSUPPORTED_SERVICE);
    // "MUST leave the previous catalog in force" — observable on the station, not in a log.
    expect((station as unknown as { currentCatalogVersion: string }).currentCatalogVersion).toBe('v7');
  });

  it('CONTROL: a catalog whose bindings are all declared is still Accepted and adopted', async () => {
    const { station, sent } = mockStation({ catalogVersion: 'v7' });

    await new UpdateServiceCatalogHandler().handle(
      envelope(OsppAction.UPDATE_SERVICE_CATALOG, {
        catalogVersion: 'v8',
        services: [
          { serviceId: 'svc_ok', serviceName: 'OK', pricingType: 'PerMinute', available: true,
            bindings: [{ bayNumber: 1, programNumber: 2 }, { bayNumber: 2, programNumber: 1 }] },
        ],
      }),
      station,
    );

    const res = onlyResponse(sent);
    expect(res.status).toBe('Accepted');
    expect(res.previousCatalogVersion).toBe('v7');
    expect((station as unknown as { currentCatalogVersion: string }).currentCatalogVersion).toBe('v8');
  });
});

describe('A — an unknown bayId is refused with 3005, not thrown away', () => {
  it('RED: ReserveBay answers 3005 instead of sending nothing', async () => {
    const { station, sent } = mockStation();
    await new ReserveBayHandler().handle(
      envelope(OsppAction.RESERVE_BAY, {
        bayId: 'bay_nope', reservationId: 'rsv_1', userId: 'sub_1', expirationTime: new Date(Date.now() + 60_000).toISOString(),
      }),
      station,
    );
    const res = onlyResponse(sent);
    expect(res.status).toBe('Rejected');
    expect(res.errorCode).toBe(OsppErrorCode.BAY_NOT_FOUND);
  });

  it('RED: CancelReservation answers 3005 instead of sending nothing', async () => {
    const { station, sent } = mockStation();
    await new CancelReservationHandler().handle(
      envelope(OsppAction.CANCEL_RESERVATION, { bayId: 'bay_nope', reservationId: 'rsv_1' }),
      station,
    );
    const res = onlyResponse(sent);
    expect(res.status).toBe('Rejected');
    expect(res.errorCode).toBe(OsppErrorCode.BAY_NOT_FOUND);
  });

  it('RED: SetMaintenanceMode answers 3005 instead of sending nothing', async () => {
    const { station, sent } = mockStation();
    await new SetMaintenanceModeHandler().handle(
      envelope(OsppAction.SET_MAINTENANCE_MODE, { bayId: 'bay_nope', enabled: true }),
      station,
    );
    const res = onlyResponse(sent);
    expect(res.status).toBe('Rejected');
    expect(res.errorCode).toBe(OsppErrorCode.BAY_NOT_FOUND);
  });
});

describe('B — SetMaintenanceMode bay-state arms (set-maintenance-mode.md §6 table)', () => {
  it('RED: a RESERVED bay cannot be put into maintenance — 3014', async () => {
    const { station, sent } = mockStation({ bayStates: { bay_a: BayStatus.RESERVED } });
    await new SetMaintenanceModeHandler().handle(
      envelope(OsppAction.SET_MAINTENANCE_MODE, { bayId: 'bay_a', enabled: true }),
      station,
    );
    const res = onlyResponse(sent);
    expect(res.status).toBe('Rejected');
    expect(res.errorCode).toBe(OsppErrorCode.BAY_RESERVED);
  });

  it('RED: an UNKNOWN bay is refused in either direction — 3002', async () => {
    const { station, sent } = mockStation({ bayStates: { bay_a: BayStatus.UNKNOWN } });
    await new SetMaintenanceModeHandler().handle(
      envelope(OsppAction.SET_MAINTENANCE_MODE, { bayId: 'bay_a', enabled: false }),
      station,
    );
    const res = onlyResponse(sent);
    expect(res.status).toBe('Rejected');
    expect(res.errorCode).toBe(OsppErrorCode.BAY_NOT_READY);
  });

  it('CONTROL: an AVAILABLE bay still enters maintenance', async () => {
    const { station, sent } = mockStation({ bayStates: { bay_a: BayStatus.AVAILABLE } });
    await new SetMaintenanceModeHandler().handle(
      envelope(OsppAction.SET_MAINTENANCE_MODE, { bayId: 'bay_a', enabled: true }),
      station,
    );
    expect(onlyResponse(sent).status).toBe('Accepted');
  });
});

describe('C — reservation lifecycle: the two answers that are INVERTED today', () => {
  it('RED: an EXPIRED reservation is 3013, not Accepted', async () => {
    const reservations = new Map();
    const { station, sent } = mockStation({
      bayStates: { bay_a: BayStatus.AVAILABLE },
      reservations,
    });
    // The expiry timer has already fired and released the bay — the record must survive it.
    station.terminalReservations.set('rsv_expired', { bayId: 'bay_a', outcome: 'expired' });

    await new CancelReservationHandler().handle(
      envelope(OsppAction.CANCEL_RESERVATION, { bayId: 'bay_a', reservationId: 'rsv_expired' }),
      station,
    );
    const res = onlyResponse(sent);
    expect(res.status).toBe('Rejected');
    expect(res.errorCode).toBe(OsppErrorCode.RESERVATION_EXPIRED);
  });

  it('RED: a CONSUMED reservation is 3012, not Accepted', async () => {
    const { station, sent } = mockStation({ bayStates: { bay_a: BayStatus.OCCUPIED } });
    station.terminalReservations.set('rsv_used', { bayId: 'bay_a', outcome: 'consumed' });

    await new CancelReservationHandler().handle(
      envelope(OsppAction.CANCEL_RESERVATION, { bayId: 'bay_a', reservationId: 'rsv_used' }),
      station,
    );
    const res = onlyResponse(sent);
    expect(res.status).toBe('Rejected');
    expect(res.errorCode).toBe(OsppErrorCode.RESERVATION_NOT_FOUND);
  });

  it('RED: an id that never existed is 3012, not Accepted', async () => {
    const { station, sent } = mockStation({ bayStates: { bay_a: BayStatus.AVAILABLE } });
    await new CancelReservationHandler().handle(
      envelope(OsppAction.CANCEL_RESERVATION, { bayId: 'bay_a', reservationId: 'rsv_never' }),
      station,
    );
    const res = onlyResponse(sent);
    expect(res.status).toBe('Rejected');
    expect(res.errorCode).toBe(OsppErrorCode.RESERVATION_NOT_FOUND);
  });

  it('CONTROL: a live reservation is still cancelled and the bay released', async () => {
    const reservations = new Map([
      ['bay_a', { reservationId: 'rsv_live', expirationTime: new Date(Date.now() + 60_000).toISOString(), timer: undefined }],
    ]);
    const { station, sent } = mockStation({ bayStates: { bay_a: BayStatus.RESERVED }, reservations });

    await new CancelReservationHandler().handle(
      envelope(OsppAction.CANCEL_RESERVATION, { bayId: 'bay_a', reservationId: 'rsv_live' }),
      station,
    );
    expect(onlyResponse(sent).status).toBe('Accepted');
    expect(station.getBayState('bay_a')).toBe(BayStatus.AVAILABLE);
  });

  it('CONTROL: cancelling an ALREADY-CANCELLED id is idempotent Accepted (r2)', async () => {
    const { station, sent } = mockStation({ bayStates: { bay_a: BayStatus.AVAILABLE } });
    station.terminalReservations.set('rsv_gone', { bayId: 'bay_a', outcome: 'cancelled' });

    await new CancelReservationHandler().handle(
      envelope(OsppAction.CANCEL_RESERVATION, { bayId: 'bay_a', reservationId: 'rsv_gone' }),
      station,
    );
    expect(onlyResponse(sent).status).toBe('Accepted');
  });
});

describe('D.3 — StopService: the sessionId must name a session on THAT bay', () => {
  it('RED: a valid sessionId on the wrong bay is 3007, not Accepted', async () => {
    const sessions = new Map([['sess_1', { bayId: 'bay_a', serviceId: 'svc', startedAt: Date.now() }]]);
    const { station, sent } = mockStation({ sessions });

    await new StopServiceHandler().handle(
      envelope(OsppAction.STOP_SERVICE, { bayId: 'bay_b', sessionId: 'sess_1' }),
      station,
    );
    const res = onlyResponse(sent);
    expect(res.status).toBe('Rejected');
    expect(res.errorCode).toBe(OsppErrorCode.SESSION_MISMATCH);
  });
});

describe('I.3 — GetDiagnostics: an inverted time window is 5020', () => {
  it('RED: startTime after endTime is Rejected', async () => {
    const { station, sent } = mockStation();
    await new GetDiagnosticsHandler().handle(
      envelope(OsppAction.GET_DIAGNOSTICS, {
        uploadUrl: 'https://example.invalid/up',
        startTime: '2026-09-11T10:00:00.000Z',
        endTime: '2026-09-11T09:00:00.000Z',
      }),
      station,
    );
    const res = onlyResponse(sent);
    expect(res.status).toBe('Rejected');
    expect(res.errorCode).toBe(OsppErrorCode.INVALID_TIME_WINDOW);
  });

  it('CONTROL: a well-ordered window is still Accepted', async () => {
    const { station, sent } = mockStation();
    await new GetDiagnosticsHandler().handle(
      envelope(OsppAction.GET_DIAGNOSTICS, {
        uploadUrl: 'https://example.invalid/up',
        startTime: '2026-09-11T09:00:00.000Z',
        endTime: '2026-09-11T10:00:00.000Z',
      }),
      station,
    );
    const res = sent.filter(s => s.messageType === MessageType.RESPONSE)[0]!.payload;
    expect(res.status).toBe('Accepted');
  });
});
