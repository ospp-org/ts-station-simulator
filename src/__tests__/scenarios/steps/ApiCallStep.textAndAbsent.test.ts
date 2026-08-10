import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiCallStep } from '../../../scenarios/steps/ApiCallStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';
import type { Station } from '../../../station/Station.js';

/**
 * Two runner capabilities the corpus was blocked on, and the guards that keep
 * each from becoming a worse version of `expect_body`.
 *
 * `expect_body_text` exists because response.json() was unconditional, which put
 * every non-JSON surface out of reach — including /metrics, the ONLY place the
 * MAC-verification branch is observable (the middleware drops the message
 * silently, so there is nothing on the wire and nothing in a table).
 *
 * `expect_body_absent` exists because absence and null are different, and the
 * corpus needs both against the SAME server: ReservationResource emits its
 * timestamps unconditionally (present, null) while SessionResource wraps its
 * failure fields in when() (absent entirely). Conflating them produces a red
 * file against a correct server in one direction, and a silent pass in the other.
 */
describe('ApiCallStep expect_body_text', () => {
  const dummyStation = {} as Station;
  afterEach(() => vi.restoreAllMocks());

  const metrics = (body: string) =>
    new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' },
    });

  const run = (def: Record<string, unknown>, response: Response) => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);
    return new ApiCallStep().execute(
      { action: 'api_call', method: 'GET', url: 'http://test.local/metrics', ...def },
      ctx,
      dummyStation,
    );
  };

  const MAC_LINE =
    'csms_mqtt_mac_verification_failures_total{action="Heartbeat",reason="MAC_MISSING"} 1\n';

  it('passes when the literal substring is present', async () => {
    await expect(
      run({ expect_body_text: 'reason="MAC_MISSING"' }, metrics(MAC_LINE)),
    ).resolves.toBeUndefined();
  });

  it('FAILS when the substring is absent, and reports the content-type and a body excerpt', async () => {
    await expect(
      run({ expect_body_text: 'reason="MAC_MISSING"' }, metrics('csms_other_metric 0\n')),
    ).rejects.toThrow(/expected body text to contain .*MAC_MISSING.*text\/plain/s);
  });

  it('treats a /…/ pattern as a regex and a bare string as a literal', async () => {
    // Load-bearing: a Prometheus line is full of regex metacharacters ({ } . "),
    // so defaulting to regex would silently change what most callers meant.
    await expect(
      run({ expect_body_text: '/mac_verification_failures_total\\{.*MAC_MISSING.*\\} [1-9]/' }, metrics(MAC_LINE)),
    ).resolves.toBeUndefined();

    // The same text as a LITERAL must not match — proving the two forms differ.
    await expect(
      run({ expect_body_text: 'mac_verification_failures_total{.*MAC_MISSING.*} [1-9]' }, metrics(MAC_LINE)),
    ).rejects.toThrow(/expected body text to contain/);
  });

  it('accepts a list and requires EVERY entry', async () => {
    await expect(
      run({ expect_body_text: ['MAC_MISSING', 'csms_mqtt_mac_verification'] }, metrics(MAC_LINE)),
    ).resolves.toBeUndefined();

    await expect(
      run({ expect_body_text: ['MAC_MISSING', 'NOT_IN_BODY'] }, metrics(MAC_LINE)),
    ).rejects.toThrow(/NOT_IN_BODY/);
  });

  // THE GUARD. Without it this is a weaker expect_body: a substring match on
  // JSON passes when the value appears ANYWHERE rather than at a path.
  it('REFUSES a JSON response, and says to use expect_body instead', async () => {
    const json = new Response(JSON.stringify({ error: { ospp_code: 3011 } }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
    await expect(run({ expect_body_text: '3011' }, json)).rejects.toThrow(
      /refused for a JSON response.*use "expect_body"/s,
    );
  });

  it('refuses to be combined with the JSON-parsing forms — the body is consumed once', async () => {
    for (const other of [
      { expect_body: { a: 1 } },
      { expect_body_absent: ['a'] },
      { capture: { x: 'a' } },
      { set_auth_token: 'a' },
    ]) {
      await expect(
        run({ expect_body_text: 'x', ...other }, metrics('x')),
      ).rejects.toThrow(/cannot be combined with/);
    }
  });

  it('refuses background mode — an assertion nobody awaits is not one', async () => {
    await expect(
      run({ expect_body_text: 'x', background: true }, metrics('x')),
    ).rejects.toThrow(/not supported with "background: true"/);
  });
});

describe('ApiCallStep expect_body_absent (absence is not null)', () => {
  const dummyStation = {} as Station;
  afterEach(() => vi.restoreAllMocks());

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  const run = (def: Record<string, unknown>, body: unknown) => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(body));
    return new ApiCallStep().execute(
      { action: 'api_call', method: 'GET', url: 'http://test.local/api/v1/sessions/s', ...def },
      ctx,
      dummyStation,
    );
  };

  // A COMPLETED session: SessionResource wraps fail_reason/fail_error_code in
  // $this->when(status === FAILED), so on this body the keys do not exist.
  const completed = { data: { status: 'completed', credits_charged: 500 } };

  // A CANCELLED reservation: ReservationResource emits both timestamps
  // unconditionally, so expired_at is PRESENT carrying null.
  const cancelled = { data: { status: 'cancelled', cancelled_at: '2026-08-10T00:00:00Z', expired_at: null } };

  it('passes when the path is genuinely absent', async () => {
    await expect(
      run({ expect_body_absent: ['data.fail_error_code', 'data.fail_reason'] }, completed),
    ).resolves.toBeUndefined();
  });

  it('FAILS when the path is present', async () => {
    await expect(
      run({ expect_body_absent: ['data.status'] }, completed),
    ).rejects.toThrow(/to be ABSENT, but it resolved to "completed"/);
  });

  // ---- THE CONFLATION TESTS. These are the reason this feature is separate ----

  it('does NOT treat a present-but-null field as absent', async () => {
    // expired_at is null on a cancelled reservation. It is PRESENT. Asserting
    // absence must fail, and the message must point at the right tool.
    await expect(
      run({ expect_body_absent: ['data.expired_at'] }, cancelled),
    ).rejects.toThrow(/PRESENT-but-null, not absent.*expect_body/s);
  });

  it('and expect_body: null does NOT accept a genuinely absent field', async () => {
    // The mirror image, and the failure this whole distinction exists to stop:
    // asserting null where the field is absent goes red against a CORRECT
    // server, because getNestedValue returns undefined and undefined !== null.
    await expect(
      run({ expect_body: { 'data.fail_error_code': null } }, completed),
    ).rejects.toThrow(/expected body "data\.fail_error_code" to equal null/);

    // ...while it correctly accepts a field that really is null.
    await expect(
      run({ expect_body: { 'data.expired_at': null } }, cancelled),
    ).resolves.toBeUndefined();
  });

  it('works alongside expect_body on the same response', async () => {
    await expect(
      run(
        {
          expect_body: { 'data.status': 'completed' },
          expect_body_absent: ['data.fail_error_code'],
        },
        completed,
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses background mode', async () => {
    await expect(
      run({ expect_body_absent: ['data.x'], background: true }, completed),
    ).rejects.toThrow(/not supported with "background: true"/);
  });
});
