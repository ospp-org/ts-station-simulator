import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiCallStep } from '../../../scenarios/steps/ApiCallStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';
import type { Station } from '../../../station/Station.js';

/**
 * `is_recent` — bounding a timestamp the scenario cannot predict.
 *
 * The capability is one line of YAML and three lines of arithmetic; everything
 * that can go wrong with it is in WHICH CLOCK and WHICH DIRECTION, so that is
 * what these pin.
 *
 * The timeline below is heartbeat-cycle.yaml's, to the millisecond, because it
 * is the file the comparator was built for and the one place both directions
 * have to be deterministic:
 *
 *   21:09:18.400  boot   -> last_seen_at (BootNotificationHandler.php:216)
 *   21:09:18.500  serverTime1  (Heartbeat 1 Response)
 *      delay 1000
 *   21:09:19.600  serverTime2  (Heartbeat 2 Response)   <-- the not_before anchor
 *      delay 1000
 *   21:09:20.700  HB3    -> last_seen_at (StationRepository.php:30)
 *   21:09:21      Date header on the read-back
 *
 * `toIso8601String()` floors the value to the second, so the server reports
 * 21:09:20 for a write at 21:09:20.700 and 21:09:18 for one at 21:09:18.400.
 * The +1s slack has to absorb that WITHOUT letting the boot's own write satisfy
 * a bound meant for the heartbeat's.
 */
describe('ApiCallStep expect_body is_recent', () => {
  const dummyStation = {} as Station;
  afterEach(() => vi.restoreAllMocks());

  const SERVER_TIME_2 = '2026-08-10T21:09:19.600Z'; // Heartbeat 2 Response
  const LAST_SEEN_FROM_HB3 = '2026-08-10T21:09:20+00:00'; // write at .700, floored
  const LAST_SEEN_FROM_BOOT = '2026-08-10T21:09:18+00:00'; // write at .400, floored
  const READ_AT = 'Mon, 10 Aug 2026 21:09:21 GMT';

  const stationRow = (lastSeenAt: string | null, date: string | null) =>
    new Response(JSON.stringify({ data: { stationId: 'stn_00000001', lastSeenAt } }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...(date === null ? {} : { Date: date }),
      },
    });

  const run = (expectBody: Record<string, unknown>, response: Response) => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);
    return new ApiCallStep().execute(
      {
        action: 'api_call',
        method: 'GET',
        url: 'http://test.local/api/v1/admin/stations/stn_00000001',
        expect_status: 200,
        expect_body: expectBody,
      },
      ctx,
      dummyStation,
    );
  };

  // --- the anchor ---------------------------------------------------------

  it('anchors on the response Date header, NOT on the runner clock', async () => {
    // The whole point. This response is dated years away from whatever `now` is
    // on the machine running the test, and the value sits right beside it. Under
    // a local-clock anchor the age would be years and this would be red; under
    // the response's own clock it is 1 second old.
    await expect(
      run(
        { 'data.lastSeenAt': { is_recent: 60 } },
        stationRow('2019-03-04T05:06:06+00:00', 'Mon, 04 Mar 2019 05:06:07 GMT'),
      ),
    ).resolves.toBeUndefined();
  });

  it('FAILS when the response carries no Date header, rather than falling back to local time', async () => {
    await expect(
      run({ 'data.lastSeenAt': { is_recent: 60 } }, stationRow(LAST_SEEN_FROM_HB3, null)),
    ).rejects.toThrow(/no Date header.*Refusing to fall back to the runner's clock/s);
  });

  // --- the window ---------------------------------------------------------

  it('passes inside the window and fails outside it, reporting the measured age', async () => {
    await expect(
      run({ 'data.lastSeenAt': { is_recent: 60 } }, stationRow(LAST_SEEN_FROM_HB3, READ_AT)),
    ).resolves.toBeUndefined();

    await expect(
      run(
        { 'data.lastSeenAt': { is_recent: 60 } },
        stationRow('2026-08-10T21:00:00+00:00', READ_AT),
      ),
    ).rejects.toThrow(/is not recent.*age=561\.0s.*older than the 60s window/s);
  });

  it('does not go red on the second-flooring alone — a 1s window still passes a floored value', async () => {
    // Written at 21:09:20.900, reported as 21:09:20, read at 21:09:21: a true age
    // of 100ms that looks like 1000ms. A bound that fired here would be red on
    // rounding, on a server that did nothing wrong.
    await expect(
      run({ 'data.lastSeenAt': { is_recent: 1 } }, stationRow(LAST_SEEN_FROM_HB3, READ_AT)),
    ).resolves.toBeUndefined();
  });

  it('FAILS when the value is ahead of the server that dated the response', async () => {
    await expect(
      run(
        { 'data.lastSeenAt': { is_recent: 60 } },
        stationRow('2026-08-10T21:09:31+00:00', READ_AT),
      ),
    ).rejects.toThrow(/AHEAD of the server's own clock by 10\.0s/);
  });

  // --- not_before: the bound that makes the heartbeat files assertable -----

  it('not_before REJECTS the value the boot left behind, and ACCEPTS the heartbeat write', async () => {
    // Both directions on heartbeat-cycle's real timeline. Without not_before the
    // first case passes too — BootNotificationHandler.php:216 sets last_seen_at,
    // so plain recency is satisfied by the boot and the assertion cannot fail.
    await expect(
      run(
        {
          'data.lastSeenAt': {
            is_recent: { within_seconds: 120, not_before: SERVER_TIME_2 },
          },
        },
        stationRow(LAST_SEEN_FROM_BOOT, READ_AT),
      ),
    ).rejects.toThrow(/is BEFORE its not_before anchor.*the write under test did not land/s);

    await expect(
      run(
        {
          'data.lastSeenAt': {
            is_recent: { within_seconds: 120, not_before: SERVER_TIME_2 },
          },
        },
        stationRow(LAST_SEEN_FROM_HB3, READ_AT),
      ),
    ).resolves.toBeUndefined();
  });

  it('reads not_before from a capture, which is how a scenario supplies a server instant', async () => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    ctx.captured.set('serverTime2', SERVER_TIME_2);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      stationRow(LAST_SEEN_FROM_BOOT, READ_AT),
    );
    // The runner substitutes the whole step definition before execute()
    // (ScenarioRunner.ts:1370), so by the time it lands here the token is already
    // the captured string. This asserts the shape that arrives, not the token.
    await expect(
      new ApiCallStep().execute(
        {
          action: 'api_call',
          method: 'GET',
          url: 'http://test.local/api/v1/admin/stations/stn_00000001',
          expect_status: 200,
          expect_body: {
            'data.lastSeenAt': {
              is_recent: { within_seconds: 120, not_before: ctx.captured.get('serverTime2') },
            },
          },
        },
        ctx,
        dummyStation,
      ),
    ).rejects.toThrow(/is BEFORE its not_before anchor/);
  });

  // --- a null timestamp is a finding, not a pass ---------------------------

  it('FAILS when the timestamp is null or the path is absent', async () => {
    await expect(
      run({ 'data.lastSeenAt': { is_recent: 60 } }, stationRow(null, READ_AT)),
    ).rejects.toThrow(/needs an ISO-8601 string.*resolved to null/s);

    await expect(
      run({ 'data.lastBootAt': { is_recent: 60 } }, stationRow(LAST_SEEN_FROM_HB3, READ_AT)),
    ).rejects.toThrow(/needs an ISO-8601 string.*resolved to undefined/s);
  });

  // --- a mistyped bound must not become no bound --------------------------

  it('REFUSES a mistyped or partial comparator instead of widening the bound', async () => {
    await expect(
      run(
        { 'data.lastSeenAt': { is_recent: { within_seconds: 60, not_after: SERVER_TIME_2 } } },
        stationRow(LAST_SEEN_FROM_HB3, READ_AT),
      ),
    ).rejects.toThrow(/unknown "is_recent" key\(s\) \["not_after"\]/);

    await expect(
      run(
        { 'data.lastSeenAt': { is_recent: 60, not_before: SERVER_TIME_2 } },
        stationRow(LAST_SEEN_FROM_HB3, READ_AT),
      ),
    ).rejects.toThrow(/must be the only key in its comparator.*not_before/s);

    await expect(
      run(
        { 'data.lastSeenAt': { is_recent: { not_before: SERVER_TIME_2 } } },
        stationRow(LAST_SEEN_FROM_HB3, READ_AT),
      ),
    ).rejects.toThrow(/within_seconds" must be a positive finite number/);

    await expect(
      run({ 'data.lastSeenAt': { is_recent: 0 } }, stationRow(LAST_SEEN_FROM_HB3, READ_AT)),
    ).rejects.toThrow(/must be a positive finite number/);

    await expect(
      run(
        { 'data.lastSeenAt': { is_recent: { within_seconds: 60, not_before: 'yesterday' } } },
        stationRow(LAST_SEEN_FROM_HB3, READ_AT),
      ),
    ).rejects.toThrow(/is not a parseable timestamp/);
  });

  // --- it must not disturb the equality path ------------------------------

  it('leaves ordinary equality assertions alone, including object values', async () => {
    const body = new Response(
      JSON.stringify({ data: { isOnline: true, bays: [{ bayNumber: 1 }], lastSeenAt: LAST_SEEN_FROM_HB3 } }),
      { status: 200, headers: { 'Content-Type': 'application/json', Date: READ_AT } },
    );
    await expect(
      run(
        {
          'data.isOnline': true,
          'data.bays': [{ bayNumber: 1 }],
          'data.lastSeenAt': { is_recent: 60 },
        },
        body,
      ),
    ).resolves.toBeUndefined();
  });
});
