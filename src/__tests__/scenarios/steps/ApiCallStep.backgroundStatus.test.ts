import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiCallStep } from '../../../scenarios/steps/ApiCallStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';
import type { ScenarioContext } from '../../../scenarios/ScenarioContext.js';
import type { Station } from '../../../station/Station.js';

/**
 * `expect_status` on a `background: true` api_call used to be unable to fail.
 *
 * The step returns the moment the fetch is fired — that is the point of
 * background mode, since POST /api/v1/sessions/start blocks on the station's own
 * MQTT Response and the scenario has to keep sending while it is in flight. The
 * verdict therefore arrived after the step was already green, and the only trace
 * was a `console.warn` nothing consumed. 37 steps across 33 files declared an
 * expected code under those conditions; on the 2026-08-26 UAT run one of them
 * got a 422 where it declared 201 and the scenario still reported green.
 *
 * The five sibling keys (`creates`, `capture`, `expect_body`,
 * `expect_body_absent`, `expect_body_text`) are refused outright in background
 * mode for this same reason. `expect_status` is not refused — 36 of the 37 pass
 * honestly, and deleting the assertion would lose them — so it is recorded and
 * settled instead.
 */
describe('ApiCallStep — background expect_status is a real assertion', () => {
  const dummyStation = {} as Station;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const fire = async (expected: number, actual: number): Promise<ScenarioContext> => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'NOPE' } }), {
        status: actual,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await new ApiCallStep().execute(
      {
        action: 'api_call',
        method: 'POST',
        url: 'http://test.local/api/v1/sessions/start',
        body: { bay_id: 'bay_x' },
        background: true,
        expect_status: expected,
      },
      ctx,
      dummyStation,
    );
    return ctx;
  };

  it('the step still returns BEFORE the response — background is still background', async () => {
    const ctx = await fire(201, 201);
    // The assertion is queued, not yet judged: that is the concurrency the
    // scenarios need, and it is what the runner settles at the end.
    expect(ctx.backgroundCalls).toHaveLength(1);
  });

  it('records nothing when the status matches', async () => {
    const ctx = await fire(201, 201);
    await Promise.allSettled(ctx.backgroundCalls);
    expect(ctx.backgroundFailures).toEqual([]);
  });

  /**
   * The measured case, pinned. On 2026-08-26,
   * sessions/start-service-refused-program-not-declared.yaml declared 201 and
   * the endpoint answered 422 PROGRAM_NOT_DECLARED. The scenario passed.
   */
  it('records the mismatch that used to pass green — 201 declared, 422 answered', async () => {
    const ctx = await fire(201, 422);
    await Promise.allSettled(ctx.backgroundCalls);
    expect(ctx.backgroundFailures).toHaveLength(1);
    expect(ctx.backgroundFailures[0]).toContain('expected 201, got 422');
  });

  it('records a transport failure too, not only a status mismatch', async () => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await new ApiCallStep().execute(
      {
        action: 'api_call',
        method: 'POST',
        url: 'http://test.local/api/v1/sessions/start',
        body: {},
        background: true,
        expect_status: 201,
      },
      ctx,
      dummyStation,
    );
    await Promise.allSettled(ctx.backgroundCalls);
    expect(ctx.backgroundFailures[0]).toContain('ECONNREFUSED');
  });

  it('a background step with no expect_status declares no assertion and records none', async () => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 500 }));
    await new ApiCallStep().execute(
      {
        action: 'api_call',
        method: 'POST',
        url: 'http://test.local/api/v1/sessions/start',
        body: {},
        background: true,
      },
      ctx,
      dummyStation,
    );
    await Promise.allSettled(ctx.backgroundCalls);
    expect(ctx.backgroundFailures).toEqual([]);
  });
});
