import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiCallStep } from '../../../scenarios/steps/ApiCallStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';
import type { Station } from '../../../station/Station.js';

/**
 * `poll` — the assertion a settlement cannot answer on the first read.
 *
 * A web payment intent does not become `succeeded` when the purchase POST returns. It
 * becomes succeeded when the card is paid and the processor's return URL reaches
 * `PaymentLandingController::callback`, which calls `settleIntent` IN THE REQUEST
 * (csms-server routes/web.php:19). Between those two moments the same read answers
 * `pending`, truthfully. A step that reads once is not asserting that the payment failed
 * to settle; it is asserting that it had not settled YET, which is a different sentence
 * and is the one `multiunit-jam-drive` has been failing on.
 *
 * MEASURED, and this is why polling is the right shape rather than a longer sleep: the
 * async half of settlement (`payment:poll-webpay`) does not look at an order until
 * `payment.intent.webpay_poll_threshold_minutes` — 2 — have passed, so the window is
 * minutes wide and its end is an EVENT, not a duration.
 *
 * GET ONLY, and the guard is load-bearing rather than tidy: re-issuing the purchase POST
 * would buy a second batch every interval.
 */
describe('ApiCallStep poll — re-reads until the assertions hold, or names what it last saw', () => {
  const dummyStation = {} as Station;

  const payments = (status: string) =>
    new Response(JSON.stringify({ data: [{ id: 'pi_1', status }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  const step = (extra: Record<string, unknown> = {}) => ({
    action: 'api_call',
    method: 'GET',
    url: 'http://test.local/api/v1/admin/payments',
    expect_status: 200,
    expect_body: { 'data[id=pi_1].status': 'succeeded' },
    poll: { timeout_ms: 2000, interval_ms: 5 },
    ...extra,
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes on the attempt where the body finally matches, and stops asking', async () => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(payments('pending'))
      .mockResolvedValueOnce(payments('pending'))
      .mockResolvedValueOnce(payments('succeeded'))
      .mockImplementation(() => Promise.resolve(payments('succeeded')));

    await expect(new ApiCallStep().execute(step(), ctx, dummyStation)).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('on timeout fails with the LAST mismatch, not with a bare "timed out"', async () => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(payments('pending')));

    await expect(
      new ApiCallStep().execute(step({ poll: { timeout_ms: 40, interval_ms: 5 } }), ctx, dummyStation),
    ).rejects.toThrow(/expected body "data\[id=pi_1\]\.status" to equal "succeeded", but got "pending"/);
  });

  it('the timeout message also says it polled, and for how long', async () => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(payments('pending')));

    await expect(
      new ApiCallStep().execute(step({ poll: { timeout_ms: 40, interval_ms: 5 } }), ctx, dummyStation),
    ).rejects.toThrow(/polled for 40ms/);
  });

  it('REFUSES a poll on a non-GET — re-issuing the purchase would buy a second batch', async () => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(payments('pending')));

    await expect(
      new ApiCallStep().execute(step({ method: 'POST' }), ctx, dummyStation),
    ).rejects.toThrow(/"poll" is only supported on GET/);
    expect(fetchSpy, 'refused before any request went out').not.toHaveBeenCalled();
  });

  it('REFUSES a poll with background: true — nothing awaits the response it would re-read', async () => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    await expect(
      new ApiCallStep().execute(step({ background: true }), ctx, dummyStation),
    ).rejects.toThrow(/"poll" is not supported with "background: true"/);
  });

  it('REFUSES a poll alongside creates — a repeated create is a repeated row', async () => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    await expect(
      new ApiCallStep().execute(step({ creates: { kind: 'station', id: 'data.id' } }), ctx, dummyStation),
    ).rejects.toThrow(/"poll" cannot be combined with "creates"/);
  });

  it('REFUSES a malformed poll rather than silently reading once', async () => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    for (const bad of [{ interval_ms: 5 }, { timeout_ms: 0, interval_ms: 5 }, { timeout_ms: 100, interval_ms: 0 }]) {
      await expect(
        new ApiCallStep().execute(step({ poll: bad }), ctx, dummyStation),
      ).rejects.toThrow(/"poll(\.|")/);
    }
  });

  it('CONTROL — without poll the step reads exactly once and fails on the first mismatch', async () => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(payments('pending')));
    const { poll: _dropped, ...noPoll } = step();

    await expect(new ApiCallStep().execute(noPoll, ctx, dummyStation)).rejects.toThrow(
      /but got "pending"/,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * A `{{token}}` substitution is textual, so a budget supplied with `--var` reaches the step
 * as a string. That is the only way a per-run settlement window can be expressed — a card
 * leg is attended and its length is the operator's, not the file's — so a numeric string is
 * accepted and anything else still throws.
 */
describe('ApiCallStep poll — a substituted budget arrives as a string', () => {
  const dummyStation = {} as Station;
  const payments = (status: string) =>
    new Response(JSON.stringify({ data: [{ id: 'pi_1', status }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const step = (poll: unknown) => ({
    action: 'api_call',
    method: 'GET',
    url: 'http://test.local/api/v1/admin/payments',
    expect_status: 200,
    expect_body: { 'data[id=pi_1].status': 'succeeded' },
    poll,
  });

  it('accepts "40" / "5" exactly as 40 / 5', async () => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(payments('pending')));
    await expect(
      new ApiCallStep().execute(step({ timeout_ms: '40', interval_ms: '5' }), ctx, dummyStation),
    ).rejects.toThrow(/polled for 40ms/);
  });

  it('REFUSES a non-integer string rather than coercing it', async () => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(payments('pending')));
    for (const bad of ['', '600000.5', '6e5', 'soon', '-1']) {
      await expect(
        new ApiCallStep().execute(step({ timeout_ms: bad, interval_ms: 5 }), ctx, dummyStation),
      ).rejects.toThrow(/"poll\.timeout_ms" must be a positive whole number/);
    }
    expect(fetchSpy, 'refused before any request went out').not.toHaveBeenCalled();
  });
});
