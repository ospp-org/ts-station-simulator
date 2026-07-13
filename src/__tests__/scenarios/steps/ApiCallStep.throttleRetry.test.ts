import { describe, it, expect, vi } from 'vitest';
import {
  computeRetryDelayMs,
  fetchWithThrottleRetry,
} from '../../../scenarios/steps/ApiCallStep.js';

describe('computeRetryDelayMs', () => {
  it('honors Retry-After in seconds (Laravel ThrottleRequests format)', () => {
    expect(computeRetryDelayMs('5', 0)).toBe(5000);
    expect(computeRetryDelayMs('0', 0)).toBe(0);
    expect(computeRetryDelayMs('60', 2)).toBe(60_000);
  });

  it('honors Retry-After as an HTTP-date in the future (delta from nowMs)', () => {
    const now = Date.parse('2026-05-31T12:00:00Z');
    const future = 'Sun, 31 May 2026 12:00:30 GMT';
    expect(computeRetryDelayMs(future, 0, { nowMs: now })).toBe(30_000);
  });

  it('clamps a past HTTP-date to 0 (never sleep negative)', () => {
    const now = Date.parse('2026-05-31T12:00:00Z');
    const past = 'Sun, 31 May 2026 11:59:30 GMT';
    expect(computeRetryDelayMs(past, 0, { nowMs: now })).toBe(0);
  });

  it('falls through to exponential backoff when header is unparseable', () => {
    const delay = computeRetryDelayMs('not-a-thing', 0, { rng: () => 0.5, jitterPct: 0 });
    expect(delay).toBe(500); // base × 2^0 × 1.0
  });

  it('exponential backoff: base × 2^attempt with no jitter (rng=0.5 + jitterPct=0)', () => {
    const noJitter = { rng: () => 0.5, jitterPct: 0, base: 500 };
    expect(computeRetryDelayMs(null, 0, noJitter)).toBe(500);
    expect(computeRetryDelayMs(null, 1, noJitter)).toBe(1000);
    expect(computeRetryDelayMs(null, 2, noJitter)).toBe(2000);
  });

  it('jitter bounds: result stays inside [exp × (1 − jitterPct), exp × (1 + jitterPct)]', () => {
    // rng = 0 → jitter = 1 − jitterPct (lower bound)
    expect(computeRetryDelayMs(null, 1, { rng: () => 0, jitterPct: 0.2 })).toBe(800);
    // rng = 1 → jitter = 1 + jitterPct (upper bound)
    expect(computeRetryDelayMs(null, 1, { rng: () => 1, jitterPct: 0.2 })).toBe(1200);
  });

  it('treats empty Retry-After as missing (falls through to exponential)', () => {
    expect(computeRetryDelayMs('', 0, { rng: () => 0.5, jitterPct: 0 })).toBe(500);
  });
});

describe('fetchWithThrottleRetry', () => {
  function res(status: number, retryAfter?: string): Response {
    const headers = new Headers();
    if (retryAfter !== undefined) headers.set('Retry-After', retryAfter);
    return new Response('body', { status, headers });
  }

  it('non-429 → no retry, no sleep, response returned immediately', async () => {
    const fetchFn = vi.fn(async () => res(200));
    const sleepFn = vi.fn(async () => undefined);
    const onRetry = vi.fn();
    const response = await fetchWithThrottleRetry(
      'http://x',
      { method: 'GET' },
      { fetchFn, sleepFn, onRetry },
    );
    expect(response.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('429 → 200 in one retry; onRetry fires once with the computed delay', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(429, '2'))
      .mockResolvedValueOnce(res(201));
    const sleepFn = vi.fn(async () => undefined);
    const onRetry = vi.fn();
    const response = await fetchWithThrottleRetry(
      'http://x',
      { method: 'POST' },
      { fetchFn, sleepFn, onRetry },
    );
    expect(response.status).toBe(201);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).toHaveBeenCalledWith(2000); // 2 seconds from Retry-After
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toEqual({ attempt: 0, delayMs: 2000, url: 'http://x' });
  });

  it('429 always → cap exhausts, last 429 returned (no silent swallow)', async () => {
    const fetchFn = vi.fn(async () => res(429, '1'));
    const sleepFn = vi.fn(async () => undefined);
    const onRetry = vi.fn();
    const response = await fetchWithThrottleRetry(
      'http://x',
      { method: 'POST' },
      { fetchFn, sleepFn, onRetry, maxRetries: 3 },
    );
    expect(response.status).toBe(429);
    // 1 initial + 3 retries = 4 fetches; 3 sleeps; 3 onRetry calls
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(sleepFn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(3);
  });

  it('enabled=false → no retry even on 429 (opt-out)', async () => {
    const fetchFn = vi.fn(async () => res(429));
    const sleepFn = vi.fn(async () => undefined);
    const response = await fetchWithThrottleRetry(
      'http://x',
      { method: 'POST' },
      { fetchFn, sleepFn, enabled: false },
    );
    expect(response.status).toBe(429);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('falls back to exponential when no Retry-After (deterministic via injected rng)', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(200));
    const sleepFn = vi.fn(async () => undefined);
    await fetchWithThrottleRetry(
      'http://x',
      { method: 'POST' },
      { fetchFn, sleepFn, rng: () => 0.5, jitterPct: 0, base: 500 },
    );
    // attempt 0 → 500ms, attempt 1 → 1000ms (no jitter)
    expect(sleepFn).toHaveBeenNthCalledWith(1, 500);
    expect(sleepFn).toHaveBeenNthCalledWith(2, 1000);
  });

  it('maxRetries=0 → no retry on 429 (degenerate cap)', async () => {
    const fetchFn = vi.fn(async () => res(429));
    const sleepFn = vi.fn(async () => undefined);
    const response = await fetchWithThrottleRetry(
      'http://x',
      { method: 'GET' },
      { fetchFn, sleepFn, maxRetries: 0 },
    );
    expect(response.status).toBe(429);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('drains the 429 body before sleeping so the connection is freed', async () => {
    let bodyConsumed = false;
    const make429 = (): Response => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('throttled'));
          controller.close();
        },
      });
      const r = new Response(body, { status: 429 });
      // Track if .text() was consumed via the readable stream side effect.
      const origText = r.text.bind(r);
      r.text = async () => {
        bodyConsumed = true;
        return origText();
      };
      return r;
    };
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(make429())
      .mockResolvedValueOnce(res(200));
    const sleepFn = vi.fn(async () => undefined);
    await fetchWithThrottleRetry(
      'http://x',
      { method: 'POST' },
      { fetchFn, sleepFn, rng: () => 0.5, jitterPct: 0 },
    );
    expect(bodyConsumed).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Idempotency-Key regeneration on retry
  // ---------------------------------------------------------------------------
  // The OSPP server's IdempotencyMiddleware caches every response with status < 500
  // (including 429s) for 86400s, keyed by Idempotency-Key. Without regeneration,
  // a 429-retry with the same key would replay the cached 429 and bypass the
  // (now-refilled) rate-limit gate entirely. These tests assert each retry mints
  // a fresh key so the server sees a genuine new request, evaluated against the
  // CURRENT rate-limit window — not a cache hit on a stale 429.
  // ---------------------------------------------------------------------------

  it('regenerates Idempotency-Key on each retry (plain object headers)', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(429, '0'))
      .mockResolvedValueOnce(res(429, '0'))
      .mockResolvedValueOnce(res(201));
    const sleepFn = vi.fn(async () => undefined);
    const initialKey = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    await fetchWithThrottleRetry(
      'http://x',
      { method: 'POST', headers: { 'Idempotency-Key': initialKey, Authorization: 'Bearer t' } },
      { fetchFn, sleepFn },
    );
    expect(fetchFn).toHaveBeenCalledTimes(3);
    // Each call has its OWN init.headers object with a (regenerated) idempotency key.
    const calls = fetchFn.mock.calls;
    const keyOf = (i: number): string => {
      const init = calls[i][1] as RequestInit;
      const h = init.headers as Record<string, string>;
      return h['Idempotency-Key'];
    };
    expect(keyOf(0)).toBe(initialKey);
    expect(keyOf(1)).not.toBe(initialKey);
    expect(keyOf(2)).not.toBe(initialKey);
    expect(keyOf(1)).not.toBe(keyOf(2));
    // Authorization (and other headers) are preserved verbatim across retries.
    const authOf = (i: number): string => {
      const h = (calls[i][1] as RequestInit).headers as Record<string, string>;
      return h.Authorization;
    };
    expect(authOf(0)).toBe('Bearer t');
    expect(authOf(1)).toBe('Bearer t');
    expect(authOf(2)).toBe('Bearer t');
  });

  it('regenerates Idempotency-Key in Headers instance (case-insensitive match)', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(429, '0'))
      .mockResolvedValueOnce(res(201));
    const sleepFn = vi.fn(async () => undefined);
    const initHeaders = new Headers();
    initHeaders.set('idempotency-key', 'orig-key-1');
    initHeaders.set('content-type', 'application/json');
    await fetchWithThrottleRetry('http://x', { method: 'POST', headers: initHeaders }, { fetchFn, sleepFn });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const retryInit = fetchFn.mock.calls[1][1] as RequestInit;
    const retryHeaders = retryInit.headers as Headers;
    expect(retryHeaders).toBeInstanceOf(Headers);
    expect(retryHeaders.get('idempotency-key')).not.toBe('orig-key-1');
    expect(retryHeaders.get('idempotency-key')!.length).toBeGreaterThan(20);
    expect(retryHeaders.get('content-type')).toBe('application/json');
  });

  it('regenerates Idempotency-Key in array-of-pairs headers', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(429, '0'))
      .mockResolvedValueOnce(res(201));
    const sleepFn = vi.fn(async () => undefined);
    const initHeaders: Array<[string, string]> = [
      ['Idempotency-Key', 'orig-key-arr'],
      ['Accept', 'application/json'],
    ];
    await fetchWithThrottleRetry('http://x', { method: 'POST', headers: initHeaders }, { fetchFn, sleepFn });
    const retryInit = fetchFn.mock.calls[1][1] as RequestInit;
    const retryHeaders = retryInit.headers as Array<[string, string]>;
    expect(Array.isArray(retryHeaders)).toBe(true);
    const idempPair = retryHeaders.find(([k]) => k.toLowerCase() === 'idempotency-key');
    expect(idempPair).toBeDefined();
    expect(idempPair![1]).not.toBe('orig-key-arr');
    expect(retryHeaders.find(([k]) => k === 'Accept')![1]).toBe('application/json');
  });

  it('no Idempotency-Key header → request unchanged on retry (no-op for non-mutating calls)', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(429, '0'))
      .mockResolvedValueOnce(res(200));
    const sleepFn = vi.fn(async () => undefined);
    const original = { method: 'GET', headers: { Accept: 'application/json' } };
    await fetchWithThrottleRetry('http://x', original, { fetchFn, sleepFn });
    // Both calls should see the same headers shape; no key was ever set.
    const h1 = (fetchFn.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    const h2 = (fetchFn.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(h1).toEqual(h2);
    expect('Idempotency-Key' in h1).toBe(false);
  });

  it('each retry-key is a valid UUID (defense against weak randomness)', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(429, '0'))
      .mockResolvedValueOnce(res(429, '0'))
      .mockResolvedValueOnce(res(429, '0'))
      .mockResolvedValueOnce(res(429, '0'))
      .mockResolvedValueOnce(res(201));
    const sleepFn = vi.fn(async () => undefined);
    await fetchWithThrottleRetry(
      'http://x',
      { method: 'POST', headers: { 'Idempotency-Key': 'initial-key' } },
      { fetchFn, sleepFn, maxRetries: 4 },
    );
    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const seen = new Set<string>();
    for (let i = 1; i < fetchFn.mock.calls.length; i++) {
      const h = (fetchFn.mock.calls[i][1] as RequestInit).headers as Record<string, string>;
      const k = h['Idempotency-Key'];
      expect(k, `call ${i} key shape`).toMatch(uuidV4);
      seen.add(k);
    }
    // Every retry generated a distinct key.
    expect(seen.size).toBe(fetchFn.mock.calls.length - 1);
  });
});
