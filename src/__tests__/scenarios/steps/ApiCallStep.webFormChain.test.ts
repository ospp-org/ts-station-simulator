import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiCallStep } from '../../../scenarios/steps/ApiCallStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';
import type { ScenarioContext } from '../../../scenarios/ScenarioContext.js';
import type { Station } from '../../../station/Station.js';

/**
 * The four runner capabilities the webpay landing flow needs, and the controls that
 * keep each of them from being a mechanism that cannot fail.
 *
 * WHAT WAS MISSING, and it was not one thing. `POST /w/{slug}/process` is the only
 * step that can start a multi-unit batch, and reaching it means walking a Laravel
 * `web` route rather than a bearer-token JSON API:
 *
 *   GET  /w/{slug}          -> HTML, sets a session cookie, carries a CSRF token
 *   POST /w/{slug}/process  -> needs BOTH back, answers 302 either way
 *
 * Against that, `ApiCallStep` had: `capture` reading `response.json()` (no HTML),
 * no cookie between calls (two requests were two sessions), and `fetch`'s default
 * redirect-following (a 302 to the processor would have been CHASED, turning a
 * scenario step into a real request to a payment host). `capture_text`, `cookies`,
 * `capture_header` and `follow_redirects: false` are those four, and each one is
 * tested here in both directions — it does the thing, and the corpus's existing
 * 145 files are provably unaffected because it is off by default.
 */
describe('ApiCallStep — the Laravel web-form chain', () => {
  const dummyStation = {} as Station;
  afterEach(() => vi.restoreAllMocks());

  /** A `@csrf` hidden input as Blade actually renders it, inside a real-shaped form. */
  const LANDING_HTML = [
    '<!DOCTYPE html><html><body>',
    '<form method="POST" action="https://pay.test.local/w/abc123XYZ0/process">',
    '<input type="hidden" name="_token" value="Xk91QpLmNb44ZrTt0sVuWy77AaBbCcDd8899EeFf">',
    '<select name="service_id"><option value="svc_dispenser">Token Dispenser</option></select>',
    '<input type="number" name="duration_seconds" value="300">',
    '</form></body></html>',
  ].join('');

  const CSRF = 'Xk91QpLmNb44ZrTt0sVuWy77AaBbCcDd8899EeFf';
  const TOKEN_PATTERN = 'name="_token"\\s+value="([^"]+)"';

  const html = (body: string, init: ResponseInit = {}) =>
    new Response(body, {
      status: 200,
      ...init,
      headers: { 'Content-Type': 'text/html; charset=UTF-8', ...(init.headers ?? {}) },
    });

  const run = (
    def: Record<string, unknown>,
    response: Response,
    ctx: ScenarioContext = createContext(),
    url = 'https://pay.test.local/w/abc123XYZ0',
  ) => {
    ctx.apiBaseUrl = 'https://pay.test.local';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);
    return new ApiCallStep().execute({ action: 'api_call', method: 'GET', url, ...def }, ctx, dummyStation);
  };

  // -------------------------------------------------------------------------
  // capture_text — the token itself
  // -------------------------------------------------------------------------
  describe('capture_text', () => {
    it('lifts the CSRF token out of the rendered form', async () => {
      const ctx = createContext();
      await run({ capture_text: { csrf: TOKEN_PATTERN } }, html(LANDING_HTML), ctx);
      expect(ctx.captured.get('csrf')).toBe(CSRF);
    });

    it('accepts the /…/ delimited form as the same pattern', async () => {
      const ctx = createContext();
      await run({ capture_text: { csrf: `/${TOKEN_PATTERN}/` } }, html(LANDING_HTML), ctx);
      expect(ctx.captured.get('csrf')).toBe(CSRF);
    });

    it('captures more than one value from ONE read', async () => {
      const ctx = createContext();
      await run(
        {
          capture_text: {
            csrf: TOKEN_PATTERN,
            service: 'name="service_id"><option value="([^"]+)"',
          },
        },
        html(LANDING_HTML),
        ctx,
      );
      expect(ctx.captured.get('csrf')).toBe(CSRF);
      expect(ctx.captured.get('service')).toBe('svc_dispenser');
    });

    it('shares the single body read with expect_body_text, and the assertion GUARDS the capture', async () => {
      const ctx = createContext();
      // `response.text()` is not replayable, so a second read would throw rather
      // than return '' — that this resolves is the proof the read is shared.
      await run(
        {
          expect_body_text: ['<form method="POST"', 'name="service_id"'],
          capture_text: { csrf: TOKEN_PATTERN },
        },
        html(LANDING_HTML),
        ctx,
      );
      expect(ctx.captured.get('csrf')).toBe(CSRF);
    });

    it('a FAILING expect_body_text stops the capture — the page was not the page', async () => {
      const ctx = createContext();
      await expect(
        run(
          { expect_body_text: 'name="unit_count"', capture_text: { csrf: TOKEN_PATTERN } },
          html(LANDING_HTML),
          ctx,
        ),
      ).rejects.toThrow(/expected body text to contain/);
      expect(ctx.captured.has('csrf')).toBe(false);
    });

    // ---- the three refusals, which are the mechanism ----

    it('FAILS when the pattern does not match, naming the pattern and the body', async () => {
      const ctx = createContext();
      // The realistic shape of this failure: a `payment.error` page, which is HTML,
      // is 200 after a followed redirect, and has no token anywhere in it.
      await expect(
        run({ capture_text: { csrf: TOKEN_PATTERN } }, html('<html><body>Payment unavailable</body></html>'), ctx),
      ).rejects.toThrow(/capture_text\.csrf.*did not match.*Payment unavailable/s);
      expect(ctx.captured.has('csrf')).toBe(false);
    });

    it('FAILS when the pattern has no capture group, instead of capturing undefined', async () => {
      await expect(
        run({ capture_text: { csrf: 'name="_token"' } }, html(LANDING_HTML)),
      ).rejects.toThrow(/has no capture group/);
    });

    it('FAILS when group 1 matched but is EMPTY — an empty token reads as a wrong one', async () => {
      const empty = LANDING_HTML.replace(`value="${CSRF}"`, 'value=""');
      await expect(
        run({ capture_text: { csrf: 'name="_token"\\s+value="([^"]*)"' } }, html(empty)),
      ).rejects.toThrow(/capture group 1 is empty/);
    });

    it('FAILS on a pattern that is not a valid regular expression', async () => {
      await expect(
        run({ capture_text: { csrf: 'value="([^"' } }, html(LANDING_HTML)),
      ).rejects.toThrow(/is not a valid regular expression/);
    });

    it('FAILS when the map is not a map', async () => {
      await expect(run({ capture_text: 'value="([^"]+)"' }, html(LANDING_HTML)))
        .rejects.toThrow(/must be a map of varName -> regex pattern/);
    });

    // ---- THE CANARY. Without this, capture_text is a weaker `capture`. ----
    it('is REFUSED on a JSON response — a regex over JSON matches anywhere, not at a path', async () => {
      await expect(
        run(
          { capture_text: { id: '"id":"([^"]+)"' } },
          new Response('{"data":{"id":"stn_1","bays":[{"id":"bay_9"}]}}', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      ).rejects.toThrow(/"capture_text" refused for a JSON response/);
    });

    it('is REFUSED alongside the five keys that need the body parsed as JSON', async () => {
      await expect(
        run({ capture_text: { csrf: TOKEN_PATTERN }, capture: { x: 'data.x' } }, html(LANDING_HTML)),
      ).rejects.toThrow(/"capture_text" cannot be combined with expect_body/);
    });

    // The refusal NAMES which of the two text forms the step actually declared, so a
    // reader is not sent looking for an `expect_body_text` the file does not contain.
    it('names both forms in the refusal when the step declared both', async () => {
      await expect(
        run(
          { capture_text: { csrf: TOKEN_PATTERN }, expect_body_text: '<form', capture: { x: 'data.x' } },
          html(LANDING_HTML),
        ),
      ).rejects.toThrow(/"expect_body_text\/capture_text" cannot be combined with expect_body/);
    });

    it('is REFUSED in background mode, where no response is ever awaited', async () => {
      await expect(
        run({ background: true, capture_text: { csrf: TOKEN_PATTERN } }, html(LANDING_HTML)),
      ).rejects.toThrow(/"capture_text" is not supported with "background: true"/);
    });
  });

  // -------------------------------------------------------------------------
  // capture_header — where a 302 actually went
  // -------------------------------------------------------------------------
  describe('capture_header', () => {
    const redirect = (location: string) =>
      new Response(null, { status: 302, headers: { Location: location } });

    it('captures Location off a 302 that was not followed', async () => {
      const ctx = createContext();
      await run(
        { method: 'POST', follow_redirects: false, expect_status: 302, capture_header: { payUrl: 'location' } },
        redirect('https://ecclients-sandbox.btrl.ro/payment/merchants/x/payment_en.html?mdOrder=abc'),
        ctx,
      );
      expect(ctx.captured.get('payUrl')).toBe(
        'https://ecclients-sandbox.btrl.ro/payment/merchants/x/payment_en.html?mdOrder=abc',
      );
    });

    // The whole reason the step asserts on Location rather than on the status: BOTH
    // outcomes of POST /w/{slug}/process are 302, and only the target tells them apart.
    it('captures the REFUSAL target too, so a missing precondition is named at the step', async () => {
      const ctx = createContext();
      await run(
        { method: 'POST', follow_redirects: false, expect_status: 302, capture_header: { payUrl: 'location' } },
        redirect('https://pay.test.local/pay/error?reason=payment_unavailable'),
        ctx,
      );
      expect(ctx.captured.get('payUrl')).toContain('reason=payment_unavailable');
    });

    it('FAILS when the header is absent, and lists the headers that were present', async () => {
      const ctx = createContext();
      await expect(
        run({ capture_header: { payUrl: 'location' } }, html(LANDING_HTML), ctx),
      ).rejects.toThrow(/carries no "location" header.*content-type/s);
      expect(ctx.captured.has('payUrl')).toBe(false);
    });

    it('does not consume the body — it composes with expect_body_text', async () => {
      const ctx = createContext();
      await run(
        { capture_header: { ct: 'content-type' }, expect_body_text: '<form method="POST"' },
        html(LANDING_HTML),
        ctx,
      );
      expect(ctx.captured.get('ct')).toBe('text/html; charset=UTF-8');
    });

    it('is REFUSED in background mode', async () => {
      await expect(
        run({ background: true, capture_header: { payUrl: 'location' } }, html(LANDING_HTML)),
      ).rejects.toThrow(/"capture_header" is not supported with "background: true"/);
    });
  });

  // -------------------------------------------------------------------------
  // cookies + follow_redirects — the request shape
  // -------------------------------------------------------------------------
  describe('cookies', () => {
    const withCookies = (...setCookies: string[]) =>
      new Response(LANDING_HTML, {
        status: 200,
        headers: [
          ['Content-Type', 'text/html; charset=UTF-8'],
          ...setCookies.map((c): [string, string] => ['Set-Cookie', c]),
        ],
      });

    const twoStep = async (secondStep: Record<string, unknown>) => {
      const ctx = createContext();
      ctx.apiBaseUrl = 'https://pay.test.local';
      const spy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(withCookies('laravel_session=SESSIONVALUE; Path=/; HttpOnly'))
        .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'https://x.test/' } }));

      const step = new ApiCallStep();
      await step.execute(
        { action: 'api_call', method: 'GET', url: 'https://pay.test.local/w/abc', cookies: true },
        ctx,
        dummyStation,
      );
      await step.execute(
        {
          action: 'api_call',
          method: 'POST',
          url: 'https://pay.test.local/w/abc/process',
          follow_redirects: false,
          expect_status: 302,
          ...secondStep,
        },
        ctx,
        dummyStation,
      );
      const second = spy.mock.calls[1][1] as RequestInit;
      return (second.headers as Record<string, string>).Cookie;
    };

    it('carries the session from the page that minted the token to the request that uses it', async () => {
      expect(await twoStep({ cookies: true })).toBe('laravel_session=SESSIONVALUE');
    });

    // THE CONTROL THAT MATTERS. Without it the test above proves only that the code
    // ran, not that the jar is what carried the session — and it is the same control
    // that proves the other 145 files did not silently change shape: no `cookies: true`,
    // no Cookie header, byte-identical requests to before this existed.
    it('sends NO Cookie header when the step did not ask for the jar', async () => {
      expect(await twoStep({})).toBeUndefined();
    });

    it('is scoped per ORIGIN — a cookie from one host is never offered to another', async () => {
      const ctx = createContext();
      ctx.apiBaseUrl = 'https://pay.test.local';
      const spy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(withCookies('laravel_session=SESSIONVALUE; Path=/'))
        .mockResolvedValueOnce(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));

      const step = new ApiCallStep();
      await step.execute(
        { action: 'api_call', method: 'GET', url: 'https://pay.test.local/w/abc', cookies: true },
        ctx, dummyStation,
      );
      await step.execute(
        { action: 'api_call', method: 'GET', url: 'https://other.test.local/api/v1/x', cookies: true },
        ctx, dummyStation,
      );
      expect((spy.mock.calls[1][1] as RequestInit).headers).not.toHaveProperty('Cookie');
      expect(ctx.cookies.namesFor('https://pay.test.local/')).toEqual(['laravel_session']);
      expect(ctx.cookies.namesFor('https://other.test.local/')).toEqual([]);
    });

    it('keeps every Set-Cookie on a response, not just the last', async () => {
      const ctx = createContext();
      ctx.apiBaseUrl = 'https://pay.test.local';
      // `headers.get('set-cookie')` joins with ", " and an Expires attribute contains
      // that separator — which is why the jar reads getSetCookie() instead of splitting.
      await run(
        { cookies: true },
        withCookies(
          'XSRF-TOKEN=abc; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT',
          'laravel_session=def; Path=/; HttpOnly',
        ),
        ctx,
      );
      expect(ctx.cookies.namesFor('https://pay.test.local/').sort()).toEqual(['XSRF-TOKEN', 'laravel_session']);
      expect(ctx.cookies.header('https://pay.test.local/')).toContain('XSRF-TOKEN=abc');
    });

    it('honours Max-Age=0 as a deletion — Laravel forget() must not leave a dead session behind', async () => {
      const ctx = createContext();
      ctx.apiBaseUrl = 'https://pay.test.local';
      const step = new ApiCallStep();
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(withCookies('laravel_session=SESSIONVALUE; Path=/'))
        .mockResolvedValueOnce(withCookies('laravel_session=deleted; Path=/; Max-Age=0'));

      await step.execute({ action: 'api_call', url: 'https://pay.test.local/a', cookies: true }, ctx, dummyStation);
      expect(ctx.cookies.namesFor('https://pay.test.local/')).toEqual(['laravel_session']);
      await step.execute({ action: 'api_call', url: 'https://pay.test.local/b', cookies: true }, ctx, dummyStation);
      expect(ctx.cookies.namesFor('https://pay.test.local/')).toEqual([]);
    });

    it('absorbs the session even when the status is not the expected one', async () => {
      const ctx = createContext();
      ctx.apiBaseUrl = 'https://pay.test.local';
      await expect(
        run({ cookies: true, expect_status: 200 },
          new Response('nope', {
            status: 419,
            headers: [
              ['Content-Type', 'text/html'],
              ['Set-Cookie', 'laravel_session=FRESH; Path=/'],
            ],
          }), ctx),
      ).rejects.toThrow(/expected status 200, got 419/);
      expect(ctx.cookies.namesFor('https://pay.test.local/')).toEqual(['laravel_session']);
    });
  });

  describe('follow_redirects', () => {
    const probeRedirectMode = async (def: Record<string, unknown>) => {
      const ctx = createContext();
      ctx.apiBaseUrl = 'https://pay.test.local';
      const spy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      await new ApiCallStep().execute(
        { action: 'api_call', method: 'GET', url: 'https://pay.test.local/x', ...def },
        ctx, dummyStation,
      );
      return (spy.mock.calls[0][1] as RequestInit).redirect;
    };

    it('asks fetch for a MANUAL redirect when set to false', async () => {
      expect(await probeRedirectMode({ follow_redirects: false })).toBe('manual');
    });

    // The default is what the other 145 files get, and it must not have moved.
    it('follows by default, and follows when set explicitly to true', async () => {
      expect(await probeRedirectMode({})).toBe('follow');
      expect(await probeRedirectMode({ follow_redirects: true })).toBe('follow');
    });
  });
});
