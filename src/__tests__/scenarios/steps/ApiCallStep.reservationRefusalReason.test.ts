import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiCallStep } from '../../../scenarios/steps/ApiCallStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';
import type { Station } from '../../../station/Station.js';

/**
 * THE CONTROL FOR `reservations/reserve-rejected-bay-busy.yaml`, AND FOR ITS TWIN.
 *
 * `POST /api/v1/reservations` grew a SECOND producer of 3001 in csms-server `b77f9eeb`, and a
 * second producer of 3014 in the same arc. The scenario that pins those codes did not go red —
 * the server orders the `bays.status` branch first and pins that order with `shouldNotReceive`
 * — it went VACUOUS, which nothing reports. This file is what turns "the scenario now asserts
 * the reason" from a claim into a measurement: the assertion must FAIL when the cause changes,
 * or all it proves is that the server refused something.
 *
 * ── THE BODIES BELOW ARE MEASURED, NOT WRITTEN ──────────────────────────────────────────────
 *
 * Captured 2026-08-30 from csms-server at HEAD `18b26fee`, by constructing each exception
 * exactly as its production site does and rendering it through the SAME registered handler the
 * REST doors use (`bootstrap/app.php:254-274`). Not transcribed from reading the code: the
 * point of the exercise was to find out whether the two responses really are indistinguishable
 * on the fields the old scenario asserted, and they are — `status`, `error.code` and
 * `error.ospp_code` are identical across ARM_A and ARM_B, to the byte.
 *
 * Production sites:
 *   ARM_A  ReserveBayAction:117-133 -> ReservationStateMachine::validateBayForReservation
 *          (OCCUPIED), reading `bays.status` — the STATION's report.
 *   ARM_B  ReservationRepository::createClaimingBay:128-134, reading `sessions` under the
 *          bay-row lock — the SERVER's own table.
 *   ARM_C  the 3014 twin: same state machine, RESERVED arm. Its second producer is
 *          createClaimingBay:101-107 (`live_reservation_row`), which is why
 *          `reserve-rejected-already-reserved.yaml` needed the same repair.
 *
 * `error.message` also differs between A and B, and is deliberately NOT what the scenarios
 * assert. It is prose: unversioned, localisable, and already the thing the bay-edit surface
 * had to pin eight fragments of. `details.reason` is the field the server documents as the
 * stable slug, so it is the field the corpus branches on.
 */
describe('reservation refusals: two producers, one code, and the field that separates them', () => {
  // Station is only used by SendStep — ApiCallStep ignores it.
  const dummyStation = {} as Station;

  const ARM_A_OCCUPIED = {
    error: {
      code: 'BAY_BUSY',
      ospp_code: 3001,
      message: 'BAY_BUSY',
      details: { reason: 'bay_reported_occupied', bayStatus: 'occupied' },
    },
    meta: { timestamp: '2026-08-30T05:36:10.258094Z' },
  };

  const ARM_B_LIVE_SESSION = {
    error: {
      code: 'BAY_BUSY',
      ospp_code: 3001,
      message: 'Bay already has a live session',
      details: { reason: 'live_session_row' },
    },
    meta: { timestamp: '2026-08-30T05:36:10.259548Z' },
  };

  const ARM_C_RESERVED = {
    error: {
      code: 'BAY_RESERVED',
      ospp_code: 3014,
      message: 'BAY_RESERVED',
      details: { reason: 'bay_already_reserved', bayStatus: 'reserved' },
    },
    meta: { timestamp: '2026-08-30T05:36:10.259781Z' },
  };

  const reserve = async (
    served: Record<string, unknown>,
    expectBody: Record<string, unknown>,
  ): Promise<void> => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(served), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    return new ApiCallStep().execute(
      {
        action: 'api_call',
        method: 'POST',
        url: 'http://test.local/api/v1/reservations',
        body: { bay_id: 'bay_x', duration_minutes: 5, session_source: 'MobileApp' },
        expect_status: 409,
        expect_body: expectBody,
      },
      ctx,
      dummyStation,
    );
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- THE DEFECT, REPRODUCED FIRST -----------------------------------------------------
  // Before asserting that the repair works, assert that there was something to repair. This
  // is the assertion `reserve-rejected-bay-busy.yaml` carried until 2026-08-30, run against
  // BOTH causes: it passes on both, so the scenario could not have detected that its own
  // `Occupied` report stopped landing. A green run across that change would have meant zero
  // coverage, and nothing anywhere would have said so.
  it('the OLD assertion (code alone) passes on the STATION report', async () => {
    await expect(reserve(ARM_A_OCCUPIED, { 'error.ospp_code': 3001 })).resolves.toBeUndefined();
  });

  it('and the OLD assertion passes on the SESSIONS ROW too — this is the vacuity', async () => {
    await expect(reserve(ARM_B_LIVE_SESSION, { 'error.ospp_code': 3001 })).resolves.toBeUndefined();
  });

  it('because the two responses are identical on every field it asserted', () => {
    expect(ARM_B_LIVE_SESSION.error.ospp_code).toBe(ARM_A_OCCUPIED.error.ospp_code);
    expect(ARM_B_LIVE_SESSION.error.code).toBe(ARM_A_OCCUPIED.error.code);
    // Both are HTTP 409 — pinned by the two passing cases above, which serve exactly that.
    expect(ARM_B_LIVE_SESSION.error.details.reason).not.toBe(ARM_A_OCCUPIED.error.details.reason);
  });

  // ---- THE REPAIR, IN BOTH DIRECTIONS ---------------------------------------------------
  // A one-sided test passes on the arm that was already right. Both directions are run
  // because the failure this guards against is symmetric: arm A reading arm B's body means
  // the status report never landed, and arm B reading arm A's means something moved
  // `bays.status` with no station saying so. Either is a real defect and neither is the other.
  it('arm A PASSES on the station report', async () => {
    await expect(
      reserve(ARM_A_OCCUPIED, {
        'error.ospp_code': 3001,
        'error.details.reason': 'bay_reported_occupied',
      }),
    ).resolves.toBeUndefined();
  });

  it("arm A FAILS on the sessions row — CHANGE THE CAUSE AND THE SCENARIO REDS", async () => {
    await expect(
      reserve(ARM_B_LIVE_SESSION, {
        'error.ospp_code': 3001,
        'error.details.reason': 'bay_reported_occupied',
      }),
    ).rejects.toThrow(
      /expected body "error\.details\.reason" to equal "bay_reported_occupied", but got "live_session_row"/,
    );
  });

  it('arm B PASSES on the sessions row', async () => {
    await expect(
      reserve(ARM_B_LIVE_SESSION, {
        'error.ospp_code': 3001,
        'error.details.reason': 'live_session_row',
      }),
    ).resolves.toBeUndefined();
  });

  it('arm B FAILS on the station report — the same control, inverted', async () => {
    await expect(
      reserve(ARM_A_OCCUPIED, {
        'error.ospp_code': 3001,
        'error.details.reason': 'live_session_row',
      }),
    ).rejects.toThrow(
      /expected body "error\.details\.reason" to equal "live_session_row", but got "bay_reported_occupied"/,
    );
  });

  // ---- AND THE 3014 TWIN ----------------------------------------------------------------
  // `reserve-rejected-already-reserved.yaml` had the identical shape: 3014 is produced by the
  // RESERVED arm of the state machine AND by createClaimingBay's `findActiveOnBay` guard (plus
  // the 23505 backstop behind `idx_reservations_one_live_per_bay`), so pinning the code alone
  // stopped proving that the `Reserved` StatusNotification landed.
  it('the 3014 assertion FAILS when the reservations table is what refused', async () => {
    const liveReservationRow = {
      ...ARM_C_RESERVED,
      error: {
        code: 'BAY_RESERVED',
        ospp_code: 3014,
        message: 'Bay already has a live reservation',
        details: { reason: 'live_reservation_row' },
      },
    };
    await expect(
      reserve(liveReservationRow, {
        'error.ospp_code': 3014,
        'error.details.reason': 'bay_already_reserved',
      }),
    ).rejects.toThrow(
      /expected body "error\.details\.reason" to equal "bay_already_reserved", but got "live_reservation_row"/,
    );
  });

  it('and PASSES when the station report is', async () => {
    await expect(
      reserve(ARM_C_RESERVED, {
        'error.ospp_code': 3014,
        'error.details.reason': 'bay_already_reserved',
      }),
    ).resolves.toBeUndefined();
  });
});
