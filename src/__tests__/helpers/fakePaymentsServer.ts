import { vi } from 'vitest';

/**
 * A stand-in for the part of csms-server a pool teardown talks to: the owner's sign-in and the
 * payments admin API the console uses (csms-server master 123ed36d, routes/api/v1/dashboard.php
 * :195-205, DashboardPaymentController). Stateful, so a refund it answers 200 is a refund the next
 * read shows, and the clock it settles by is `Date.now()`, so a test that fakes time drives it.
 *
 * What it reproduces, each from the controller or the action behind it:
 *  - GET /api/v1/admin/payments: the rows of `index` (:82-120), `refundedCents` and `netCents` by
 *    PaymentRevenueQuery (succeeded refunds only, a `refunded` payment counts as refunded in full),
 *    paginated by `per_page` and `page` with `meta.last_page`.
 *  - GET /api/v1/admin/payments/{id}: the row of `show` (:310-370), with every refund and its status.
 *  - POST /api/v1/admin/payments/{id}/refund: `refund` (:372-466) over ProcessRefundAction's admin
 *    branch - 422 when the payment is not refundable, NOTHING_LEFT_TO_REFUND when nothing is left,
 *    REFUND_EXCEEDS_REMAINDER above the remainder, where the remainder is the amount less every
 *    succeeded or pending refund (totalRefundedOrInFlightCents); then what BT answers: a refund
 *    (200, the payment refunded or partially refunded), BT's "system error" (a failed refund row and
 *    502 "The payment remains unrefunded"), or an outcome BT does not show yet (a pending refund row,
 *    200 with status pending, settled later as refunds:recover-stranded would).
 *  - The settlement poller: a pending payment settles to what the test says once its time has come.
 *
 * Every request must carry the owner's bearer token and the organization's X-Organization-Id;
 * one that does not is answered 401 or 403, which is how a test sees the teardown ask as the owner.
 */

export type FakePaymentStatus = 'pending' | 'processing' | 'succeeded' | 'partially_refunded' | 'refunded' | 'failed';

export interface FakeRefund {
  id: string;
  amountCents: number;
  status: 'pending' | 'succeeded' | 'failed';
  /** A pending refund the recovery sweep settles once this instant has passed. */
  settlesAt?: number;
}

/** What BT does with one refund.do: give the money back, answer its "system error", or not say yet. */
export type BtRefundAnswer = 'refunds' | 'system-error' | 'not-yet';

export interface FakePayment {
  id: string;
  status: FakePaymentStatus;
  processor?: string;
  amountCents: number;
  processorTransactionId: string | null;
  referenceType?: string;
  referenceId: string;
  parkedAt?: string | null;
  refunds?: FakeRefund[];
  /** A pending payment the settlement poller settles this long after the server started. */
  settles?: { afterMs: number; to: 'succeeded' | 'failed' };
  /** BT's answer to each refund.do, in order; the last one repeats. Default: it refunds. */
  btAnswers?: BtRefundAnswer[];
  /** For 'not-yet': how long until the recovery sweep finds the refund landed. */
  notYetSettlesAfterMs?: number;
}

export interface RecordedCall {
  /** `Date.now()` when the request arrived. */
  at: number;
  method: string;
  /** Path and query, without the origin. */
  path: string;
  headers: Record<string, string>;
  body: unknown;
  status: number;
}

export interface FakePaymentsServerOptions {
  api: string;
  orgId: string;
  ownerEmail: string;
  ownerPassword: string;
  payments: FakePayment[];
}

type Json = Record<string, unknown>;

export function fakePaymentsServer(options: FakePaymentsServerOptions) {
  const startedAt = Date.now();
  const payments = new Map<string, FakePayment & { refunds: FakeRefund[]; btTries: number }>(
    options.payments.map((p) => [p.id, { ...p, refunds: [...(p.refunds ?? [])], btTries: 0 }]),
  );
  const calls: RecordedCall[] = [];
  const tokens = new Set<string>();
  let refundSeq = 0;

  const succeededCents = (p: { refunds: FakeRefund[] }): number =>
    p.refunds.filter((r) => r.status === 'succeeded').reduce((s, r) => s + r.amountCents, 0);
  const committedCents = (p: { refunds: FakeRefund[] }): number =>
    p.refunds.filter((r) => r.status !== 'failed').reduce((s, r) => s + r.amountCents, 0);
  const restate = (p: FakePayment & { refunds: FakeRefund[] }): void => {
    if (p.status !== 'succeeded' && p.status !== 'partially_refunded') return;
    const refunded = succeededCents(p);
    if (refunded >= p.amountCents) p.status = 'refunded';
    else if (refunded > 0) p.status = 'partially_refunded';
  };

  /** What the poller and the recovery sweep would have done by now. */
  const settleDue = (): void => {
    const now = Date.now();
    for (const p of payments.values()) {
      if ((p.status === 'pending' || p.status === 'processing') && p.settles && now - startedAt >= p.settles.afterMs) {
        p.status = p.settles.to;
      }
      for (const r of p.refunds) {
        if (r.status === 'pending' && r.settlesAt !== undefined && now >= r.settlesAt) {
          r.status = 'succeeded';
          restate(p);
        }
      }
    }
  };

  const row = (p: FakePayment & { refunds: FakeRefund[] }): Json => {
    const captured = ['succeeded', 'partially_refunded', 'refunded'].includes(p.status);
    const refunded = !captured ? 0 : p.status === 'refunded' ? p.amountCents : Math.min(succeededCents(p), p.amountCents);
    return {
      id: p.id,
      userId: null,
      userName: null,
      status: p.status,
      processor: p.processor ?? 'bt_ipay',
      processorOrderNumber: p.processorTransactionId ? `OSP${p.id.replace(/-/g, '').slice(0, 20)}` : null,
      processorTransactionId: p.processorTransactionId,
      amountCents: p.amountCents,
      creditsAmount: p.amountCents,
      currency: 'RON',
      referenceType: p.referenceType ?? 'session_payment',
      referenceId: p.referenceId,
      parkedAt: p.parkedAt ?? null,
      createdAt: new Date(startedAt).toISOString(),
      updatedAt: new Date(Date.now()).toISOString(),
      sessions: [],
      stationId: null,
      stationName: null,
      refundedCents: refunded,
      netCents: (captured ? p.amountCents : 0) - refunded,
    };
  };

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const answer = (method: string, url: URL, headers: Record<string, string>, body: unknown): Response => {
    settleDue();
    if (method === 'POST' && url.pathname === '/api/v1/auth/login') {
      const b = (body ?? {}) as Json;
      if (b.email !== options.ownerEmail || b.password !== options.ownerPassword) {
        return json(401, { message: 'Invalid credentials' });
      }
      const token = `owner-token-${tokens.size + 1}`;
      tokens.add(token);
      return json(200, { data: { access_token: token, token_type: 'bearer', expires_in: 3600 } });
    }
    const bearer = (headers['authorization'] ?? '').replace(/^Bearer /, '');
    if (!tokens.has(bearer)) return json(401, { message: 'Unauthenticated.' });
    if (headers['x-organization-id'] !== options.orgId) {
      return json(403, { message: 'This action is unauthorized.' });
    }

    if (method === 'GET' && url.pathname === '/api/v1/admin/payments') {
      const perPage = Number(url.searchParams.get('per_page') ?? '25');
      const page = Number(url.searchParams.get('page') ?? '1');
      if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) {
        return json(422, { message: 'The per page field must not be greater than 100.' });
      }
      const all = [...payments.values()];
      const lastPage = Math.max(1, Math.ceil(all.length / perPage));
      return json(200, {
        data: all.slice((page - 1) * perPage, page * perPage).map(row),
        meta: { current_page: page, last_page: lastPage, per_page: perPage, total: all.length },
      });
    }

    const detail = /^\/api\/v1\/admin\/payments\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (method === 'GET' && detail) {
      const p = payments.get(detail[1]);
      if (!p) return json(404, { message: 'Not found.' });
      return json(200, {
        data: {
          ...row(p),
          refunds: p.refunds.map((r) => ({
            id: r.id, amountCents: r.amountCents, creditsAmount: 0, currency: 'RON',
            reason: 'earlier refund', status: r.status, createdAt: new Date(startedAt).toISOString(),
          })),
        },
      });
    }

    const refund = /^\/api\/v1\/admin\/payments\/([0-9a-f-]{36})\/refund$/.exec(url.pathname);
    if (method === 'POST' && refund) {
      const p = payments.get(refund[1]);
      if (!p) return json(404, { message: 'Not found.' });
      const b = (body ?? {}) as Json;
      if (!Number.isInteger(b.amount_cents) || (b.amount_cents as number) < 1
        || typeof b.reason !== 'string' || b.reason.length < 3) {
        return json(422, { message: 'The given data was invalid.', errors: {} });
      }
      if (p.status !== 'succeeded' && p.status !== 'partially_refunded') {
        return json(422, { success: false, error: 'Payment is not eligible for refund in its current state.' });
      }
      const remaining = Math.max(0, p.amountCents - committedCents(p));
      if (remaining === 0) {
        return json(422, {
          success: false,
          error: 'Nothing is left to refund on this payment: it is refunded in full, or a refund of the rest is still in progress.',
          code: 'NOTHING_LEFT_TO_REFUND',
        });
      }
      const asked = b.amount_cents as number;
      if (asked > remaining) {
        return json(422, {
          success: false, code: 'REFUND_EXCEEDS_REMAINDER', requestedCents: asked, remainingCents: remaining, currency: 'RON',
          error: `The refund asked is more than is left to refund on this payment: ${remaining} cents are left.`,
        });
      }
      const answers = p.btAnswers ?? ['refunds'];
      const bt = answers[Math.min(p.btTries, answers.length - 1)];
      p.btTries++;
      const id = `0000refund-${String(++refundSeq).padStart(4, '0')}`;
      if (bt === 'system-error') {
        p.refunds.push({ id, amountCents: asked, status: 'failed' });
        return json(502, {
          success: false,
          error: 'Refund could not be completed: the processor declined it and no wallet fallback was available. The payment remains unrefunded.',
          refund: { id, status: 'failed' },
        });
      }
      if (bt === 'not-yet') {
        p.refunds.push({ id, amountCents: asked, status: 'pending', settlesAt: Date.now() + (p.notYetSettlesAfterMs ?? 0) });
        return json(200, { success: true, refund: { id, amountCents: asked, currency: 'RON', reason: b.reason, status: 'pending' } });
      }
      p.refunds.push({ id, amountCents: asked, status: 'succeeded' });
      restate(p);
      return json(200, {
        success: true,
        refund: { id, amountCents: asked, creditsAmount: 0, currency: 'RON', reason: b.reason, calculation: 'Full refund (no session associated)', status: 'succeeded' },
      });
    }

    return json(404, { message: 'Not found.' });
  };

  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    const at = Date.now();
    if (url.origin !== new URL(options.api).origin) {
      throw new TypeError(`fetch failed: ${url.origin} is not the API under test`);
    }
    const res = answer(method, url, headers, body);
    calls.push({ at, method, path: url.pathname + url.search, headers, body, status: res.status });
    return res;
  });

  return {
    fetch,
    calls,
    payment: (id: string) => payments.get(id),
    refundCalls: (id?: string) => calls.filter((c) => c.method === 'POST' && /\/refund$/.test(c.path)
      && (id === undefined || c.path === `/api/v1/admin/payments/${id}/refund`)),
  };
}

/**
 * Await a promise whose work sleeps on (faked) `setTimeout`, moving the fake clock until it settles.
 * Each step yields to the real event loop, so fetch mocks, file I/O and microtasks run between steps.
 */
export async function settleUnderFakeTime<T>(
  promise: Promise<T>,
  options: { stepMs?: number; maxFakeMs?: number } = {},
): Promise<{ value?: T; error?: unknown; settled: boolean; fakeElapsedMs: number }> {
  const stepMs = options.stepMs ?? 5_000;
  const maxFakeMs = options.maxFakeMs ?? 3 * 60 * 60_000;
  const start = Date.now();
  let outcome: { value?: T; error?: unknown } | undefined;
  promise.then((value) => { outcome = { value }; }, (error: unknown) => { outcome = { error }; });
  while (outcome === undefined && Date.now() - start < maxFakeMs) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  return { ...(outcome ?? {}), settled: outcome !== undefined, fakeElapsedMs: Date.now() - start };
}
