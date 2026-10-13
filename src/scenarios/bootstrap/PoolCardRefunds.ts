import { randomUUID } from 'node:crypto';

/**
 * THE CARD MONEY OF A POOL, GIVEN BACK BEFORE ITS TEARDOWN DELETES ANYTHING (2026-10-13).
 *
 * WHY THIS EXISTS. The pool teardown is one SQL transaction over SSH (`buildTeardownSql`) that
 * deletes the run's payment_intents with their refunds and ledgers, and it called no API. Two
 * corpus files pay with a card at BT's sandbox - `multiunit-batch-drive` captures 6 lei,
 * `multiunit-jam-drive` 4 lei of which the server itself refunds the jammed unit's 2 - and the
 * teardown deleted those orders from UAT while their money stayed at BT, with nothing on UAT naming
 * it any more: on 2026-10-13, 10 such orders of 2026-09-29 and 2026-10-05 still held 37,57 lei
 * (TODO HS53), refundable only by asking BT directly.
 *
 * WHAT IT DOES, before the teardown deletes anything, for the organization the run minted:
 *  1. Signs in as the pool's owner - the run's ephemeral tenant_owner, who holds payments.view and
 *     payments.refund in that organization - and lists its payments as the console does
 *     (GET /api/v1/admin/payments, X-Organization-Id the organization; csms-server scopes the list
 *     to the organizations where the caller holds payments.view, by the organization frozen into
 *     each payment's metadata).
 *  2. Waits, at most CARD_SETTLE_WAIT_MS and reading every CARD_SETTLE_POLL_MS, for every pending
 *     payment to settle. A pending payment can already be paid at BT: on 2026-10-12 BT's handleCRes
 *     answered an error page after it had deposited, and the server's poller settled the intent
 *     about 2 minutes later (csms-server config/payment.php, the stale-payment poll).
 *  3. Refunds every payment still holding money - succeeded or partially refunded - for what is
 *     left: its amount less every refund of it that did not fail, read from the payment's own
 *     detail (GET /api/v1/admin/payments/{id}), which is how the server sizes the remainder
 *     (PaymentIntent::totalRefundedOrInFlightCents). Through the server's own refund door,
 *     POST /api/v1/admin/payments/{id}/refund, with POOL_TEARDOWN_REFUND_REASON.
 *  4. BT's refund.do answers "system error" for minutes at a time; the server then answers 502,
 *     logs CRITICAL "refund OWED but NO money moved" and keeps the payment unrefunded, and BT took
 *     the refund 1 to 7 tries later at 75 s gaps on 2026-10-12/13. So a payment still holding money
 *     is tried again REFUND_RETRY_GAP_MS later, REFUND_MAX_TRIES tries at most. A refund the server
 *     answers 200 with its status pending (BT's outcome unknown, held for refunds:recover-stranded)
 *     commits what is left, so it is waited for, never asked a second time.
 *  5. A payment is given back when the server answered 200 with the refund succeeded and a read of
 *     the payment shows it refunded, nothing left. When every payment is failed or refunded, the
 *     teardown may delete. When any is still captured or still pending at the end - or the payments
 *     could not be read at all - it throws {@link PoolCardMoneyHeldError} naming each one, and the
 *     teardown deletes nothing.
 *
 * NOT BT. The server is the refund path, and its rows are what the teardown deletes; asking BT
 * directly would refund behind the server's back and leave its rows saying the money is held.
 *
 * Each failed try leaves a failed refund row (the console's unsettled refunds list, CW45) and makes
 * the server log its CRITICAL alert on UAT; that is the server doing what it must, and expected.
 */

/** The reason every teardown refund carries; the console shows it on the payment. */
export const POOL_TEARDOWN_REFUND_REASON = "Pool teardown: the corpus's card payment is given back";

/** How long the teardown waits for a pending payment to settle before it keeps the pool. */
export const CARD_SETTLE_WAIT_MS = 10 * 60_000;
/** How often it reads the payments while one is pending. */
export const CARD_SETTLE_POLL_MS = 15_000;
/** The gap between two refund tries of one payment. */
export const REFUND_RETRY_GAP_MS = 90_000;
/** The tries one payment is given before the teardown keeps the pool. */
export const REFUND_MAX_TRIES = 10;

/** The same knob, and the same default, as PoolBootstrap's own API calls. */
const API_TIMEOUT_MS = Number.parseInt(process.env.UAT_API_TIMEOUT_MS ?? '30000', 10);

/** 100 rows a page is the list's maximum (PaymentListRequest); 100 pages is far past any run. */
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

/** Who the teardown asks, and about which organization. Built by teardownPool from the handle. */
export interface PoolCardMoneyTarget {
  /** The organization the run minted; absent when it minted none. */
  organizationId?: string;
  apiBaseUrl?: string;
  ownerEmail?: string;
  ownerPassword?: string;
}

/** A payment the teardown could not leave with nothing captured, as it reports it. */
export interface HeldCardPayment {
  paymentId: string;
  /** BT's orderId for the order (the payment's processorTransactionId), null when it has none. */
  btOrderId: string | null;
  status: string;
  amountCents: number;
  /**
   * For a captured payment, what is left: the amount less every refund that did not fail. For a
   * pending one, the amount - it may have been captured at BT already.
   */
  remainderCents: number;
  /** Set when the server's poller gave up on a pending payment: nothing will settle it by itself. */
  parkedAt: string | null;
  /** Refund requests this teardown sent for it. */
  tries: number;
  /** The server's last answer to this teardown about it, when there was one. */
  lastAnswer: string | null;
}

/**
 * The teardown kept the pool because card money of its organization is still captured, still
 * pending, or could not be read. Nothing was deleted - no row and no local file. The CLI exits
 * EXIT_POOL_CARD_MONEY_HELD on it and keeps the handle.
 */
export class PoolCardMoneyHeldError extends Error {
  constructor(
    readonly organizationId: string | undefined,
    readonly held: HeldCardPayment[],
    why: string,
  ) {
    super(
      `nothing was deleted: ${why}` +
      held.map((p) => `\n  - ${describeHeld(p)}`).join(''),
    );
    this.name = 'PoolCardMoneyHeldError';
  }
}

function describeHeld(p: HeldCardPayment): string {
  const pending = p.status === 'pending' || p.status === 'processing';
  return (
    `payment ${p.paymentId}, BT order ${p.btOrderId ?? '(none)'}: ${p.status}` +
    (p.parkedAt ? ` (parked ${p.parkedAt}: the server's poller will not settle it by itself)` : '') +
    (pending
      ? `, ${p.amountCents} cents that BT may already hold`
      : p.remainderCents === 0
        ? `, ${p.amountCents} cents charged and nothing left to ask: what is left is committed to a refund ` +
          'still in flight at the server'
        : `, ${p.remainderCents} of ${p.amountCents} cents still captured`) +
    `, ${p.tries} refund tr${p.tries === 1 ? 'y' : 'ies'}` +
    (p.lastAnswer ? `, last answer: ${p.lastAnswer}` : '')
  );
}

// ---------------------------------------------------------------------------
// What a payment is, as the admin API serves it
// ---------------------------------------------------------------------------

interface PaymentRow {
  id: string;
  status: string;
  processor: string;
  amountCents: number;
  processorTransactionId: string | null;
  parkedAt: string | null;
  /** Only on the detail (GET /api/v1/admin/payments/{id}). */
  refunds?: Array<{ amountCents: number; status: string }>;
}

function pluck(obj: unknown, dottedPath: string): unknown {
  let cur: unknown = obj;
  for (const part of dottedPath.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function asPaymentRow(x: unknown): PaymentRow | undefined {
  if (x === null || typeof x !== 'object') return undefined;
  const r = x as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.status !== 'string' || !Number.isInteger(r.amountCents)) return undefined;
  const row: PaymentRow = {
    id: r.id,
    status: r.status,
    processor: typeof r.processor === 'string' ? r.processor : '',
    amountCents: r.amountCents as number,
    processorTransactionId: typeof r.processorTransactionId === 'string' ? r.processorTransactionId : null,
    parkedAt: typeof r.parkedAt === 'string' ? r.parkedAt : null,
  };
  if (Array.isArray(r.refunds)) {
    const refunds: Array<{ amountCents: number; status: string }> = [];
    for (const f of r.refunds as unknown[]) {
      const amount = pluck(f, 'amountCents');
      const status = pluck(f, 'status');
      if (!Number.isInteger(amount) || typeof status !== 'string') return undefined;
      refunds.push({ amountCents: amount as number, status });
    }
    row.refunds = refunds;
  }
  return row;
}

/**
 * The bookkeeping intent ProcessRefundAction books a wallet session's refund against (processor
 * `wallet`, amount 0) is not card money; csms-server's own revenue definition leaves it out too
 * (PaymentRevenueQuery). Every other processor's payment is money a card moved.
 */
const isCard = (p: PaymentRow): boolean => p.processor !== 'wallet';
const isCaptured = (p: PaymentRow): boolean =>
  isCard(p) && (p.status === 'succeeded' || p.status === 'partially_refunded');
const isPending = (p: PaymentRow): boolean =>
  isCard(p) && (p.status === 'pending' || p.status === 'processing');

/** What is left to refund: the amount less every refund that did not fail. 0 unless captured. */
function remainderOf(detail: PaymentRow): number {
  if (!isCaptured(detail)) return 0;
  const committed = (detail.refunds ?? [])
    .filter((r) => r.status !== 'failed')
    .reduce((sum, r) => sum + r.amountCents, 0);
  return Math.max(0, detail.amountCents - committed);
}

// ---------------------------------------------------------------------------
// The pool owner's session
// ---------------------------------------------------------------------------

/** The server refused the owner's credentials: reading again will not help. */
class OwnerSignInRefused extends Error {}

interface Answer {
  status: number;
  body: unknown;
}

function short(body: unknown): string {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? null);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

async function send(method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<Answer> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`${method} ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  let text = '';
  try {
    text = await res.text();
  } catch {
    // A body that broke off: the status is still the answer.
  }
  let parsed: unknown = text;
  try {
    parsed = text === '' ? undefined : JSON.parse(text);
  } catch {
    // Not JSON (an edge's HTML error page): keep the text for the report.
  }
  return { status: res.status, body: parsed };
}

class PoolOwnerSession {
  private token: string | undefined;

  constructor(
    private readonly base: string,
    private readonly email: string,
    private readonly password: string,
    private readonly organizationId: string,
  ) {}

  private async signIn(): Promise<void> {
    const res = await send(
      'POST',
      `${this.base}/api/v1/auth/login`,
      { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      { email: this.email, password: this.password },
    );
    const token = pluck(res.body, 'data.access_token');
    if (res.status === 200 && typeof token === 'string' && token !== '') {
      this.token = token;
      return;
    }
    const refusal = `signing in as the pool owner ${this.email} answered HTTP ${res.status}`;
    // A 4xx is the server's answer about these credentials; anything else is the way to it.
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      throw new OwnerSignInRefused(refusal);
    }
    throw new Error(refusal);
  }

  /** One request as the owner, in the organization; a 401 signs in again once. */
  async request(method: string, path: string, body?: unknown): Promise<Answer> {
    for (let attempt = 1; ; attempt++) {
      if (this.token === undefined) await this.signIn();
      const headers: Record<string, string> = {
        Accept: 'application/json',
        Authorization: `Bearer ${this.token}`,
        'X-Organization-Id': this.organizationId,
      };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (method !== 'GET') headers['Idempotency-Key'] = randomUUID();
      const res = await send(method, `${this.base}${path}`, headers, body);
      if (res.status === 401 && attempt === 1) {
        this.token = undefined;
        continue;
      }
      return res;
    }
  }

  async listPayments(): Promise<PaymentRow[]> {
    const rows: PaymentRow[] = [];
    for (let page = 1, lastPage = 1; page <= lastPage; page++) {
      const res = await this.request('GET', `/api/v1/admin/payments?per_page=${PAGE_SIZE}&page=${page}`);
      if (res.status !== 200) {
        throw new Error(`GET /api/v1/admin/payments page ${page} answered HTTP ${res.status}: ${short(res.body)}`);
      }
      const data = pluck(res.body, 'data');
      if (!Array.isArray(data)) throw new Error(`GET /api/v1/admin/payments page ${page} carries no data list`);
      for (const x of data) {
        const row = asPaymentRow(x);
        if (row === undefined) throw new Error(`GET /api/v1/admin/payments page ${page} has a row it cannot read: ${short(x)}`);
        rows.push(row);
      }
      const last = Number(pluck(res.body, 'meta.last_page'));
      if (!Number.isInteger(last) || last < 1) throw new Error('GET /api/v1/admin/payments carries no meta.last_page');
      if (last > MAX_PAGES) throw new Error(`GET /api/v1/admin/payments has ${last} pages, more than the ${MAX_PAGES} read`);
      lastPage = last;
    }
    return rows;
  }

  async payment(id: string): Promise<PaymentRow> {
    const res = await this.request('GET', `/api/v1/admin/payments/${id}`);
    const row = res.status === 200 ? asPaymentRow(pluck(res.body, 'data')) : undefined;
    if (row === undefined || row.refunds === undefined) {
      throw new Error(`GET /api/v1/admin/payments/${id} answered HTTP ${res.status}: ${short(res.body)}`);
    }
    return row;
  }

  refund(id: string, amountCents: number): Promise<Answer> {
    return this.request('POST', `/api/v1/admin/payments/${id}/refund`, {
      amount_cents: amountCents,
      reason: POOL_TEARDOWN_REFUND_REASON,
    });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function describeAnswer(res: Answer): string {
  const status = pluck(res.body, 'refund.status');
  const code = pluck(res.body, 'code');
  const error = pluck(res.body, 'error') ?? pluck(res.body, 'message');
  return (
    `HTTP ${res.status}` +
    (typeof status === 'string' ? `, refund ${status}` : '') +
    (typeof code === 'string' ? ` ${code}` : '') +
    (typeof error === 'string' ? ` "${error}"` : '')
  );
}

interface Tracker {
  row: PaymentRow;
  tries: number;
  remainderCents: number | undefined;
  lastAnswer: string | null;
  refunded: boolean;
}

/**
 * Give back every captured card payment of the organization the run minted, through the server,
 * before the teardown deletes anything. Resolves when no payment of the organization is captured
 * or pending; throws {@link PoolCardMoneyHeldError} otherwise. See the module docblock.
 */
export async function refundPoolCardPayments(target: PoolCardMoneyTarget): Promise<void> {
  const org = target.organizationId;
  if (!org) {
    // A run that minted no organization made no bay a card could pay at: the bootstrap mints the
    // organization before it creates anything inside it.
    console.log('[teardown] card money: the run minted no organization, so it holds no card payment of its own');
    return;
  }
  const missing = [
    !target.apiBaseUrl && 'apiBaseUrl',
    !target.ownerEmail && 'ephemeralOwnerEmail',
    !target.ownerPassword && "the owner's password (identityCredentials)",
  ].filter((m): m is string => typeof m === 'string');
  if (missing.length > 0) {
    throw new PoolCardMoneyHeldError(
      org,
      [],
      `the card payments of organization ${org} cannot be read: the handle carries no ${missing.join(', ')}` +
      (missing.includes('apiBaseUrl')
        ? ' (a handle written before 2026-10-13 has none: add "apiBaseUrl", e.g. "https://api-uat.onestoppay.ro", to it)'
        : ''),
    );
  }
  const owner = new PoolOwnerSession(
    (target.apiBaseUrl as string).replace(/\/+$/, ''),
    target.ownerEmail as string,
    target.ownerPassword as string,
    org,
  );

  try {
    return await giveBack(owner, org, target.ownerEmail as string);
  } catch (err) {
    if (err instanceof OwnerSignInRefused) {
      throw new PoolCardMoneyHeldError(
        org,
        [],
        `the card payments of organization ${org} cannot be read: ${err.message} - if this pool was torn down ` +
        'already, its owner is gone with it and this handle can be deleted',
      );
    }
    throw err;
  }
}

async function giveBack(owner: PoolOwnerSession, org: string, ownerEmail: string): Promise<void> {
  const trackers = new Map<string, Tracker>();
  const track = (row: PaymentRow): Tracker => {
    const t = trackers.get(row.id) ?? { row, tries: 0, remainderCents: undefined, lastAnswer: null, refunded: false };
    t.row = row;
    trackers.set(row.id, t);
    return t;
  };
  let lastReadError: string | undefined;
  const read = async (): Promise<PaymentRow[] | undefined> => {
    try {
      const rows = await owner.listPayments();
      lastReadError = undefined;
      return rows;
    } catch (err) {
      if (err instanceof OwnerSignInRefused) throw err;
      lastReadError = errorText(err);
      console.warn(`[teardown] card money: the payments of organization ${org} could not be read (${lastReadError})`);
      return undefined;
    }
  };

  console.log(`[teardown] card money: reading the payments of organization ${org} as its owner ${ownerEmail}`);

  // 1. A pending payment first: it may be paid at BT already, and only the server's poller knows.
  const settleBy = Date.now() + CARD_SETTLE_WAIT_MS;
  let rows = await read();
  let said = '';
  let saidAt = 0;
  while (rows === undefined || rows.some(isPending)) {
    if (Date.now() + CARD_SETTLE_POLL_MS > settleBy) break;
    if (rows !== undefined) {
      const pending = rows.filter(isPending).map((p) => `${p.id} (${p.status}${p.parkedAt ? ', parked' : ''})`).join(', ');
      // Said when the set changes, and once a minute while it does not.
      if (pending !== said || Date.now() - saidAt >= 60_000) {
        const left = Math.ceil((settleBy - Date.now()) / 1000);
        console.log(`[teardown] card money: waiting for pending payment(s) to settle, ${left} s left: ${pending}`);
        said = pending;
        saidAt = Date.now();
      }
    }
    await sleep(CARD_SETTLE_POLL_MS);
    rows = await read();
  }

  // 2. Each payment still holding money, for what is left, until none does or the tries run out.
  //    Not when the payments could not be read once in the whole wait: the API has had its 10
  //    minutes, and the read below decides.
  let lastRoundEndedAt: number | undefined;
  for (let round = 1; rows !== undefined && round <= REFUND_MAX_TRIES; round++) {
    const listed = round === 1 ? rows : await read();
    if (listed === undefined) {
      await sleep(REFUND_RETRY_GAP_MS);
      continue;
    }
    const owed = listed.filter(isCaptured);
    if (owed.length === 0) break;
    if (lastRoundEndedAt !== undefined) {
      await sleep(Math.max(0, lastRoundEndedAt + REFUND_RETRY_GAP_MS - Date.now()));
    }
    for (const row of owed) await visit(owner, track(row), round);
    lastRoundEndedAt = Date.now();
  }

  // 3. What the server says now, read fresh: the teardown may delete only if nothing is held.
  const final = await read();
  if (final === undefined) {
    throw new PoolCardMoneyHeldError(
      org,
      [],
      `the card payments of organization ${org} could not be read (${lastReadError ?? 'no answer'}), so ` +
      'whether one still holds money is not known',
    );
  }
  const heldRows = final.filter((p) => isCaptured(p) || isPending(p));
  if (heldRows.length > 0) {
    const held: HeldCardPayment[] = [];
    for (const row of heldRows) {
      const t = trackers.get(row.id);
      let remainderCents = isPending(row) ? row.amountCents : (t?.remainderCents ?? row.amountCents);
      if (isCaptured(row)) {
        try {
          remainderCents = remainderOf(await owner.payment(row.id));
        } catch {
          // Keep the last remainder this teardown read; the report says what it knew.
        }
      }
      held.push({
        paymentId: row.id,
        btOrderId: row.processorTransactionId,
        status: row.status,
        amountCents: row.amountCents,
        remainderCents,
        parkedAt: row.parkedAt,
        tries: t?.tries ?? 0,
        lastAnswer: t?.lastAnswer ?? null,
      });
    }
    throw new PoolCardMoneyHeldError(
      org,
      held,
      `${held.length} card payment(s) of organization ${org} still hold money or are still pending. Run ` +
      'teardown-pool --handle again later: it waits for a pending payment and tries each refund again ' +
      '(or refund one through the server yourself, POST /api/v1/admin/payments/{id}/refund)',
    );
  }
  const refunded = [...trackers.values()].filter((t) => t.refunded).length;
  console.log(
    `[teardown] card money: ${final.length} payment(s) of organization ${org}, none captured or pending` +
    (refunded > 0 ? ` - ${refunded} refunded by this teardown` : ''),
  );
}

/** One round's look at one payment still holding money: one refund request at most. */
async function visit(owner: PoolOwnerSession, t: Tracker, round: number): Promise<void> {
  const id = t.row.id;
  let detail: PaymentRow;
  try {
    detail = await owner.payment(id);
  } catch (err) {
    if (err instanceof OwnerSignInRefused) throw err;
    t.lastAnswer = errorText(err);
    console.warn(`[teardown] card money: payment ${id} could not be read (${t.lastAnswer})`);
    return;
  }
  if (!isCaptured(detail)) {
    // Given back since the list was read: by a refund this teardown asked for that has landed, or
    // by someone else.
    if (t.tries > 0) t.refunded = true;
    console.log(`[teardown] card money: payment ${id} is ${detail.status}, nothing left`);
    return;
  }
  const remainder = remainderOf(detail);
  t.remainderCents = remainder;
  if (remainder === 0) {
    // Every cent is committed to a refund the server holds in flight: asking again would be a
    // second refund of the same money, which the server refuses anyway (NOTHING_LEFT_TO_REFUND).
    t.lastAnswer = 'a refund of what is left is still in flight at the server';
    console.log(`[teardown] card money: payment ${id} (${detail.status}): ${t.lastAnswer}; reading it again`);
    return;
  }

  t.tries++;
  let res: Answer;
  try {
    res = await owner.refund(id, remainder);
  } catch (err) {
    if (err instanceof OwnerSignInRefused) throw err;
    t.lastAnswer = errorText(err);
    console.warn(`[teardown] card money: refund ${t.tries}/${REFUND_MAX_TRIES} of payment ${id} failed (${t.lastAnswer})`);
    return;
  }
  t.lastAnswer = describeAnswer(res);
  console.log(
    `[teardown] card money: refund ${t.tries}/${REFUND_MAX_TRIES} (round ${round}) of payment ${id}, ` +
    `BT order ${detail.processorTransactionId ?? '(none)'}, ${remainder} cents: ${t.lastAnswer}`,
  );
  if (res.status !== 200 || pluck(res.body, 'refund.status') !== 'succeeded') return;

  try {
    const after = await owner.payment(id);
    t.remainderCents = remainderOf(after);
    if (!isCaptured(after)) {
      t.refunded = true;
      console.log(`[teardown] card money: payment ${id} is ${after.status}, nothing left`);
    } else {
      t.lastAnswer += `; the payment still reads ${after.status} with ${t.remainderCents} cents left`;
    }
  } catch (err) {
    if (err instanceof OwnerSignInRefused) throw err;
    t.lastAnswer += `; the payment could not be read after it (${errorText(err)})`;
  }
}
