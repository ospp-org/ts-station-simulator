import { randomUUID } from 'node:crypto';
import type { Step, StepDefinition } from './Step.js';
import type { ScenarioContext } from '../ScenarioContext.js';
import type { Station } from '../../station/Station.js';
import {
  CREATED_RESOURCE_KINDS,
  type CreatedResourceKind,
} from '../bootstrap/ScenarioResources.js';

// ---------------------------------------------------------------------------
// Bounded 429 retry — Retry-After + jitter, cap 3 (opt-out via retry_on_429:false)
// ---------------------------------------------------------------------------

export interface ThrottleRetryOptions {
  /** When `false`, no retry happens — pass-through to caller's expect_status check. */
  enabled?: boolean;
  /** Max retries AFTER the first attempt (default 3 → at most 4 total fetch calls). */
  maxRetries?: number;
  /** Backoff base ms used when no Retry-After header is present (default 500). */
  base?: number;
  /** Multiplicative jitter applied to the backoff curve (±, default 0.2 = ±20%). */
  jitterPct?: number;
  /** Injectable RNG for deterministic tests. */
  rng?: () => number;
  /** Injectable sleep for deterministic tests. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Injectable fetch for tests; defaults to global fetch at call time. */
  fetchFn?: typeof fetch;
  /** Notify on each retry (telemetry/test hook). */
  onRetry?: (info: { attempt: number; delayMs: number; url: string }) => void;
}

/**
 * Translate a 429 `Retry-After` header into a wait duration. RFC 7231 §7.1.3 allows two
 * forms — integer seconds (Laravel's `ThrottleRequests` middleware writes this) or
 * HTTP-date. When the header is absent or unparseable, fall back to exponential backoff
 * (`base × 2^attempt`) with multiplicative jitter so concurrent retriers don't synchronize.
 * `attempt` is 0-indexed: first retry is `attempt = 0`.
 *
 * THE HEADER IS A FLOOR, NOT A SUBSTITUTE — measured 2026-08-14. This used to `return`
 * the parsed header outright, so a well-formed `Retry-After: 0` meant "retry immediately".
 * Laravel's `ThrottleRequests` writes `availableIn($key)`, which reaches 0 in the final
 * second of a window it is still refusing inside, so a 429 carrying `Retry-After: 0` is
 * ordinary rather than exotic. The pooled UAT run showed exactly what that costs:
 *
 *     [ApiCallStep:auth] 429 retry 1/3 … in 27000ms     <- honoured, correct
 *     [ApiCallStep:auth] 429 retry 2/3 … in 0ms         <- both remaining attempts
 *     [ApiCallStep:auth] 429 retry 3/3 … in 0ms         <- burned in microseconds
 *
 * Eight identities failed that way, and the retry that existed to absorb the throttle
 * spent its whole budget inside one tick. Taking the MAX of the two keeps the server
 * authoritative whenever it asks for longer — the 27s above is unchanged — while making a
 * zero (or a past HTTP-date) fall back to our own curve instead of to no wait at all.
 */
export function computeRetryDelayMs(
  retryAfterHeader: string | null,
  attempt: number,
  options?: { base?: number; jitterPct?: number; rng?: () => number; nowMs?: number },
): number {
  const base = options?.base ?? 500;
  const jitterPct = options?.jitterPct ?? 0.2;
  const rng = options?.rng ?? Math.random;
  const nowMs = options?.nowMs ?? Date.now();

  const exp = base * Math.pow(2, attempt);
  const jitter = 1 + (rng() * 2 - 1) * jitterPct;
  const backoffMs = Math.max(0, Math.round(exp * jitter));

  if (retryAfterHeader !== null && retryAfterHeader !== '') {
    const trimmed = retryAfterHeader.trim();
    if (/^\d+$/.test(trimmed)) {
      const asSec = Number.parseInt(trimmed, 10);
      return Math.max(asSec * 1000, backoffMs);
    }
    const asDate = Date.parse(trimmed);
    if (!Number.isNaN(asDate)) {
      return Math.max(asDate - nowMs, backoffMs);
    }
    // Unparseable → fall through to exponential.
  }

  return backoffMs;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Regenerate the `Idempotency-Key` header (if present) on a `RequestInit`, returning a
 * NEW init with a freshly-minted UUID for that header. All other headers preserved.
 *
 * Why this is mandatory for retries: the OSPP server's `IdempotencyMiddleware` caches
 * EVERY response under 500 (including 429s) for 86400s, keyed by the idempotency key.
 * Without regeneration, a retry with the SAME key hits the cache and replays the original
 * 429 — bypassing the rate-limit check entirely, even after the user's bucket has refilled.
 * The retry then fails not because the server is actually rate-limited, but because we're
 * looking at a stale cached response. Regenerating the key makes each retry a fresh
 * server-side request, evaluated against the CURRENT rate-limit window.
 *
 * Idempotency-key semantics nuance: this is the correct trade-off for 429-retries
 * specifically. For network-failure / timeout retries (which fetchWithThrottleRetry
 * does NOT do — those bubble up as rejected fetches), preserving the key would be right
 * so the server replays the original response. 429-retries are different: we WANT a
 * fresh evaluation past the rate-limit gate.
 */
function regenerateIdempotencyKey(init: RequestInit): RequestInit {
  const headers = init.headers;
  if (!headers) return init;

  const TARGET = 'idempotency-key';
  const fresh = randomUUID();

  if (headers instanceof Headers) {
    const cloned = new Headers(headers);
    for (const [k] of cloned.entries()) {
      if (k.toLowerCase() === TARGET) {
        cloned.set(k, fresh);
        return { ...init, headers: cloned };
      }
    }
    return init;
  }
  if (Array.isArray(headers)) {
    let touched = false;
    const cloned: Array<[string, string]> = headers.map(([k, v]) => {
      if (k.toLowerCase() === TARGET) {
        touched = true;
        return [k, fresh];
      }
      return [k, v];
    });
    return touched ? { ...init, headers: cloned } : init;
  }
  // Plain Record<string, string>
  const obj = headers as Record<string, string>;
  let touched = false;
  const cloned: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.toLowerCase() === TARGET) {
      cloned[k] = fresh;
      touched = true;
    } else {
      cloned[k] = v;
    }
  }
  return touched ? { ...init, headers: cloned } : init;
}

/**
 * `fetch` wrapper that retries on HTTP 429 up to a bounded cap, honoring the server's
 * `Retry-After` header when present. Non-429 responses pass straight through unchanged.
 * The retry only changes the SHAPE of timing under contention — it never silently swallows
 * a real failure: after the cap, the last 429 response is returned and the caller's
 * `expect_status` mismatch check still fires.
 *
 * Each retry MINTS A FRESH `Idempotency-Key` (when one is present on the request — i.e.,
 * any POST/PUT/PATCH). The server's `IdempotencyMiddleware` caches all <500 responses for
 * 86400s; reusing the same key on retry replays the cached 429 and bypasses the rate-limit
 * gate. With a fresh key per attempt, each retry is a fresh server-side request evaluated
 * against the current rate-limit window. See {@link regenerateIdempotencyKey}.
 */
export async function fetchWithThrottleRetry(
  url: string,
  init: RequestInit,
  opts: ThrottleRetryOptions = {},
): Promise<Response> {
  const enabled = opts.enabled !== false;
  const maxRetries = opts.maxRetries ?? 3;
  const sleepFn = opts.sleepFn ?? defaultSleep;
  const fetchFn = opts.fetchFn ?? fetch;

  let attempt = 0;
  let currentInit = init;
  // First attempt + up to `maxRetries` retries → at most `maxRetries + 1` fetch calls.
  while (true) {
    const response = await fetchFn(url, currentInit);
    if (!enabled || response.status !== 429 || attempt >= maxRetries) {
      return response;
    }
    const retryAfter = response.headers.get('Retry-After');
    const delayMs = computeRetryDelayMs(retryAfter, attempt, opts);
    // Drain the body so the underlying connection is freed before we sleep.
    await response.text().catch(() => undefined);
    opts.onRetry?.({ attempt, delayMs, url });
    await sleepFn(delayMs);
    // Mint a fresh Idempotency-Key (when present) so the next attempt is a genuine
    // server-side request, not a replay of the cached 429.
    currentInit = regenerateIdempotencyKey(currentInit);
    attempt++;
  }
}

function substituteTemplateValue(
  value: string,
  context: ScenarioContext,
): string {
  return value.replace(/\{\{([^}]+)\}\}/g, (_match, varName: string) => {
    const trimmed = varName.trim();
    if (trimmed.startsWith('captured.')) {
      const captureKey = trimmed.slice('captured.'.length);
      const captured = context.captured.get(captureKey);
      if (captured === undefined) {
        throw new Error(`Captured variable not found: ${captureKey}`);
      }
      return String(captured);
    }
    const variable = context.variables.get(trimmed);
    if (variable === undefined) {
      throw new Error(`Template variable not found: ${trimmed}`);
    }
    return variable;
  });
}

function substituteTemplates(
  value: unknown,
  context: ScenarioContext,
): unknown {
  if (typeof value === 'string') {
    return substituteTemplateValue(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteTemplates(item, context));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = substituteTemplates(val, context);
    }
    return result;
  }
  return value;
}

/**
 * `name[field=value]` — select an array element by one of its fields instead of by index.
 *
 * Exists because several server collections come back UNORDERED. Measured 2026-08-10 on
 * GET /admin/stations/{stn_*}: three consecutive runs returned `data.bays` as
 * [2,3,4,1], [2,3,4,1] and [3,4,1,2] — there is no ORDER BY behind it. An assertion written
 * as `data.bays.0.status` therefore pins whichever bay the database happened to hand back,
 * which is the same class of mistake as asserting on "the most recent" row.
 *
 * Comparison is on String(el[field]) so `[bayNumber=1]` matches the JSON number 1 — a path
 * segment is always text, and requiring YAML authors to know the wire type of every field
 * would be a trap of its own.
 */
const ARRAY_SELECTOR_RE = /^([^[\]]+)\[([^=[\]]+)=([^[\]]*)\]$/;

/**
 * Split a path on `.` but NEVER inside `[...]`.
 *
 * A plain `path.split('.')` tears a selector apart the moment its VALUE contains a dot —
 * `data[firmware_version=2.0.0].status` became `data[firmware_version=2`, `0`, `0]`, `status`
 * and resolved to undefined. It survived review because the first selector written used
 * `[bayNumber=1]`, and a bay number has no dot; a firmware version does. Anything
 * version-shaped, IP-shaped or hostname-shaped would have hit it.
 */
function splitPath(path: string): string[] {
  const parts: string[] = [];
  let buf = '';
  let depth = 0;
  for (const ch of path) {
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    if (ch === '.' && depth === 0) {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  parts.push(buf);
  return parts;
}

function getNestedValue(obj: unknown, path: string): unknown {
  const parts = splitPath(path);
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== 'object') {
      return undefined;
    }

    const selector = ARRAY_SELECTOR_RE.exec(part);
    if (selector) {
      const [, name, field, want] = selector;
      const arr = (current as Record<string, unknown>)[name];
      if (!Array.isArray(arr)) {
        return undefined;
      }
      current = arr.find(
        (el) =>
          el !== null &&
          typeof el === 'object' &&
          String((el as Record<string, unknown>)[field]) === want,
      );
      continue;
    }

    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// ---------------------------------------------------------------------------
// is_recent — the comparator for a timestamp the scenario cannot predict
// ---------------------------------------------------------------------------

/**
 * WHICH CLOCK. This is the whole question, and getting it wrong is not a bug you
 * find later — it is a file that goes red on a correct server whenever the two
 * machines disagree, which they will.
 *
 * The anchor is the response's OWN `Date` header, never `Date.now()`. The runner
 * may be a laptop, a CI box or a container with its own drift; the server is the
 * thing that both WROTE the timestamp and SERVED it. Measured on UAT 2026-08-10:
 * `date: Mon, 10 Aug 2026 21:09:20 GMT` alongside a body `timestamp` of
 * `2026-08-10T21:09:20.783Z` — same second, because nginx and php-fpm share a
 * host. `last_seen_at` and `last_boot_at` are both written with Laravel `now()`
 * (StationRepository.php:30, BootNotificationHandler.php:216-217), so the field
 * and the anchor come off one clock and the comparison has no skew term at all.
 * If the header is missing the assertion FAILS — it does not quietly fall back to
 * local time, because a silent fallback is exactly the wrong answer arriving green.
 *
 * WHY ONE SECOND OF SLACK, EVERYWHERE. Both sides of the comparison are floored
 * to the second: `toIso8601String()` drops sub-second precision on the value, and
 * an HTTP `Date` is IMF-fixdate, which has none. So each observed number
 * UNDER-REPORTS its true instant by up to 1000ms. Every bound gives that second
 * back, in the direction that can only ever make the assertion more forgiving —
 * a bound must never go red on rounding.
 *
 * WHAT `within_seconds` ALONE CANNOT DO. `BootNotificationHandler.php:216` sets
 * `last_seen_at` too, so in any file that boots before it heartbeats, "is it
 * recent?" is already satisfied by the boot — an assertion that cannot fail,
 * which is worse than none. `not_before` is the fix: it pins the value at or
 * after a server instant captured EARLIER in the same scenario (a `serverTime`
 * off a Heartbeat or BootNotification Response — same clock again). The anchor
 * must sit at least one full second after the stale write it has to reject;
 * below that, the flooring slack swallows the gap and a stale row passes. In
 * heartbeat-cycle.yaml the two `delay: 1000` steps guarantee it, which is why
 * that file anchors on `serverTime2` rather than on `serverTime3` — the third
 * Heartbeat's own response is LATER than the write it would be bounding, and a
 * bound you can straddle is a flake with a schedule.
 */
const SECOND_GRANULARITY_SLACK_MS = 1000;

interface RecentBound {
  withinSeconds: number;
  notBefore?: string;
}

/**
 * A comparator, not a literal: `{ is_recent: ... }` in the value position of
 * `expect_body`. Nothing the admin API returns is an object carrying an
 * `is_recent` key, so there is no literal this steals.
 */
function isRecentComparator(want: unknown): want is Record<string, unknown> {
  return (
    want !== null &&
    typeof want === 'object' &&
    !Array.isArray(want) &&
    Object.prototype.hasOwnProperty.call(want, 'is_recent')
  );
}

function parseRecentBound(want: Record<string, unknown>, path: string): RecentBound {
  const siblings = Object.keys(want).filter((k) => k !== 'is_recent');
  if (siblings.length > 0) {
    throw new Error(
      `ApiCallStep: expect_body "${path}" — "is_recent" must be the only key in its ` +
        `comparator, got extra ${JSON.stringify(siblings)}. A sibling key here would be ` +
        `silently ignored, which is how a bound stops bounding.`,
    );
  }

  const spec = want.is_recent;

  if (typeof spec === 'number') {
    if (!Number.isFinite(spec) || spec <= 0) {
      throw new Error(
        `ApiCallStep: expect_body "${path}" — "is_recent" seconds must be a positive ` +
          `finite number, got ${JSON.stringify(spec)}`,
      );
    }
    return { withinSeconds: spec };
  }

  if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) {
    const obj = spec as Record<string, unknown>;
    const unknown = Object.keys(obj).filter(
      (k) => k !== 'within_seconds' && k !== 'not_before',
    );
    if (unknown.length > 0) {
      throw new Error(
        `ApiCallStep: expect_body "${path}" — unknown "is_recent" key(s) ` +
          `${JSON.stringify(unknown)}. Supported: within_seconds, not_before. ` +
          `A typo must not widen the bound silently.`,
      );
    }
    const within = obj.within_seconds;
    if (typeof within !== 'number' || !Number.isFinite(within) || within <= 0) {
      throw new Error(
        `ApiCallStep: expect_body "${path}" — "is_recent.within_seconds" must be a ` +
          `positive finite number, got ${JSON.stringify(within)}`,
      );
    }
    const notBefore = obj.not_before;
    if (notBefore !== undefined && typeof notBefore !== 'string') {
      throw new Error(
        `ApiCallStep: expect_body "${path}" — "is_recent.not_before" must be an ISO-8601 ` +
          `string (normally "{{captured.serverTime}}"), got ${typeof notBefore}`,
      );
    }
    return { withinSeconds: within, notBefore: notBefore as string | undefined };
  }

  throw new Error(
    `ApiCallStep: expect_body "${path}" — "is_recent" must be a number of seconds or an ` +
      `object { within_seconds, not_before }, got ${JSON.stringify(spec)}`,
  );
}

/**
 * Throws with the measured numbers on any violation. Every bound is evaluated
 * CONSERVATIVELY — it fires only when the true instant is violated for EVERY
 * value the flooring could have hidden, so rounding can never produce a red.
 */
function assertIsRecent(
  path: string,
  got: unknown,
  bound: RecentBound,
  dateHeader: string | null,
  responseBody: unknown,
): void {
  const tail = ` (full body: ${JSON.stringify(responseBody)})`;

  if (dateHeader === null || dateHeader.trim() === '') {
    throw new Error(
      `ApiCallStep: expect_body "${path}" uses "is_recent", but the response carried no ` +
        `Date header — there is no server clock to compare against. Refusing to fall back ` +
        `to the runner's clock: a comparison against local time is wrong the moment the ` +
        `two disagree, and it would be wrong GREEN.`,
    );
  }
  const anchorMs = Date.parse(dateHeader);
  if (Number.isNaN(anchorMs)) {
    throw new Error(
      `ApiCallStep: expect_body "${path}" — could not parse the response Date header ` +
        `${JSON.stringify(dateHeader)} as a timestamp.`,
    );
  }

  if (typeof got !== 'string') {
    throw new Error(
      `ApiCallStep: expect_body "${path}" — "is_recent" needs an ISO-8601 string, but the ` +
        `path resolved to ${JSON.stringify(got)}. A null or absent timestamp is a real ` +
        `finding, not a pass.${tail}`,
    );
  }
  const valueMs = Date.parse(got);
  if (Number.isNaN(valueMs)) {
    throw new Error(
      `ApiCallStep: expect_body "${path}" — could not parse ${JSON.stringify(got)} as a ` +
        `timestamp.${tail}`,
    );
  }

  const ageMs = anchorMs - valueMs;
  const seen = `value=${got} anchor(Date header)=${dateHeader} age=${(ageMs / 1000).toFixed(1)}s`;

  // AHEAD OF THE SERVER. The value can only be floored DOWN, and the anchor only
  // floored down, so a value more than one second past the anchor is a genuine
  // disagreement between the layer that wrote the field and the layer that dated
  // the response — or a fabricated future timestamp. Both are findings.
  if (valueMs - anchorMs >= SECOND_GRANULARITY_SLACK_MS) {
    throw new Error(
      `ApiCallStep: expect_body "${path}" is AHEAD of the server's own clock by ` +
        `${((valueMs - anchorMs) / 1000).toFixed(1)}s — ${seen}. The field and the Date ` +
        `header come off the same server, so this is a clock disagreement or a bogus ` +
        `timestamp, not a timing race.${tail}`,
    );
  }

  if (valueMs + SECOND_GRANULARITY_SLACK_MS < anchorMs - bound.withinSeconds * 1000) {
    throw new Error(
      `ApiCallStep: expect_body "${path}" is not recent — ${seen}, which is older than the ` +
        `${bound.withinSeconds}s window. The server did not move this timestamp.${tail}`,
    );
  }

  if (bound.notBefore !== undefined) {
    const notBeforeMs = Date.parse(bound.notBefore);
    if (Number.isNaN(notBeforeMs)) {
      throw new Error(
        `ApiCallStep: expect_body "${path}" — "is_recent.not_before" ` +
          `${JSON.stringify(bound.notBefore)} is not a parseable timestamp. When this came ` +
          `from a capture, the captured value was not a server time.`,
      );
    }
    if (valueMs + SECOND_GRANULARITY_SLACK_MS <= notBeforeMs) {
      throw new Error(
        `ApiCallStep: expect_body "${path}" is BEFORE its not_before anchor — ${seen}, ` +
          `not_before=${bound.notBefore}. The timestamp still holds a value from earlier in ` +
          `this scenario, so the write under test did not land.${tail}`,
      );
    }
  }
}

const tokenCache = new Map<string, string>();
const orgIdCache = new Map<string, string>();

/**
 * Process-wide pacer for `POST /auth/login`.
 *
 * The server's limiter is `RateLimiter::for('auth', … Limit::perMinute(30)->by($request->ip()))`
 * (`AppServiceProvider.php:92-94`) — thirty logins a minute, keyed by IP and NOT by user, as
 * brute-force protection. A pooled run mints one identity per scenario and every one of them
 * logs in from the same machine, so the suite's login rate is a property of how fast the
 * corpus runs, and the cap is shared by all workers no matter how they are spread.
 *
 * WHY THIS EXISTS RATHER THAN A BIGGER RETRY. The retry below is honest defence against a
 * surprise, but it cannot win a race it starts by losing: a blocked login waits inside the
 * scenario's 90s budget (`DEFAULT_SCENARIO_TIMEOUT_MS`), and a backoff long enough to outlast
 * a 60s window does not fit in that budget alongside the scenario's own work. Retrying harder
 * just queues in the worst possible place. Pacing queues BEFORE the bucket is spent, where
 * waiting is free, and in steady state the 429 never happens at all.
 *
 * MEASURED. Until 2026-08-14 the corpus was slow enough to hide this: 28 scenarios spent 15s
 * apiece timing out on a `wait_for` whose cause was the unfunded-wallet 402, and that dead
 * time spaced the logins out. Funding the wallets removed the delay, the same 121 logins
 * bunched up, and 8 of them exhausted the retry. The throttle did not change; the corpus
 * stopped being slow enough to respect it by accident.
 *
 * The default leaves headroom under 30 because the run is not the only client of that IP, and
 * because the window is the server's, measured from when IT saw the request, not from when we
 * sent it. Override with `OSPP_SIM_LOGIN_RATE_PER_MIN` when running against something else.
 */
export class LoginPacer {
  private readonly stamps: number[] = [];
  /** Serializes admission — concurrent workers must not all read a stale window. */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number = 60_000,
    private readonly nowFn: () => number = () => Date.now(),
    private readonly sleepFn: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  /** Blocks until sending one login keeps us inside the window. Returns ms waited. */
  async acquire(): Promise<number> {
    let release!: () => void;
    const previous = this.chain;
    this.chain = new Promise<void>((resolve) => { release = resolve; });
    await previous;

    let waited = 0;
    try {
      for (;;) {
        const now = this.nowFn();
        while (this.stamps.length > 0 && now - this.stamps[0] >= this.windowMs) {
          this.stamps.shift();
        }
        if (this.stamps.length < this.maxPerWindow) {
          this.stamps.push(now);
          return waited;
        }
        // Wait until the oldest stamp leaves the window, plus a tick so the boundary
        // is not raced. `stamps[0]` exists here — the length check above guarantees it.
        const wait = this.windowMs - (now - this.stamps[0]) + 50;
        await this.sleepFn(wait);
        waited += wait;
      }
    } finally {
      release();
    }
  }
}

function loginRateFromEnv(): number {
  const raw = process.env.OSPP_SIM_LOGIN_RATE_PER_MIN;
  if (raw === undefined || raw === '') return 25;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 25;
}

const loginPacer = new LoginPacer(loginRateFromEnv());

async function ensureAuth(context: ScenarioContext): Promise<string | undefined> {
  if (context.authToken) return context.authToken;
  if (!context.apiBaseUrl || !context.apiCredentials) return undefined;

  const cacheKey = `${context.apiBaseUrl}::${context.apiCredentials.email}`;
  const cached = tokenCache.get(cacheKey);
  if (cached) {
    context.authToken = cached;
    return cached;
  }

  const loginUrl = `${context.apiBaseUrl}/api/v1/auth/login`;
  // Pace first, retry second. The pacer keeps the suite inside the server's
  // `perMinute(30)->by(IP)` auth limiter so the 429 does not happen; the retry below stays
  // as defence for the case where it does anyway (a co-tenant on the same IP, a window we
  // mis-estimated). See LoginPacer for why a bigger retry could not substitute for this.
  const pacedMs = await loginPacer.acquire();
  if (pacedMs > 0) {
    console.warn(
      `[ApiCallStep:auth] paced login for ${context.apiCredentials.email} by ${pacedMs}ms ` +
      `to stay under the server's auth limiter (30/min per IP)`,
    );
  }
  // Wrap login in the same 429-aware retry as ApiCallStep itself (commit f2b527b).
  // The server's `auth` limiter is `perMinute(30)->by(IP)` (brute-force protection,
  // not per-user) so per-scenario identity (121 distinct logins from one dev IP)
  // saturates it after the first ~30. The retry honors the server's Retry-After
  // header and lets the IP bucket replenish — single-shared-identity runs (1 login
  // total) never hit this path; per-scenario runs spread their logins across the
  // bucket's 60s refill window. Same retry mechanism, broader scope.
  const res = await fetchWithThrottleRetry(loginUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      email: context.apiCredentials.email,
      password: context.apiCredentials.password,
    }),
  }, {
    onRetry: ({ attempt, delayMs }) =>
      console.warn(`[ApiCallStep:auth] 429 retry ${attempt + 1}/3 for POST ${loginUrl} in ${delayMs}ms`),
  });

  if (!res.ok) {
    throw new Error(`API auth failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as { data?: { access_token?: string } };
  const accessToken = data?.data?.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error(
      `API auth response missing data.access_token: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }
  tokenCache.set(cacheKey, accessToken);
  context.authToken = accessToken;
  return accessToken;
}

function methodRequiresIdempotencyKey(method: string): boolean {
  const m = method.toUpperCase();
  return m === 'POST' || m === 'PUT' || m === 'PATCH';
}

/**
 * Resolve the org UUID to inject as `X-Organization-Id`.
 *
 *   1. context.orgId (set from CLI --org-id flag) wins if present.
 *   2. Otherwise lazy-discover via GET /api/v1/organizations.
 *      Cache per (baseUrl, email). If the admin owns exactly one org,
 *      that's the auto-selected value. Zero or multi-org admins are
 *      errors — surface a clear message asking for explicit --org-id.
 *
 * Returns undefined when no resolution is possible (no auth, no baseUrl)
 * so the caller can simply skip injection.
 */
async function ensureOrgId(
  context: ScenarioContext,
  token: string,
): Promise<string | undefined> {
  if (context.orgId) return context.orgId;
  if (!context.apiBaseUrl || !context.apiCredentials) return undefined;

  const cacheKey = `${context.apiBaseUrl}::${context.apiCredentials.email}`;
  const cached = orgIdCache.get(cacheKey);
  if (cached) {
    context.orgId = cached;
    return cached;
  }

  const url = `${context.apiBaseUrl}/api/v1/organizations`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    throw new Error(
      `ApiCallStep: org auto-discovery failed (${res.status}): ${await res.text()}`,
    );
  }

  const body = await res.json() as { data?: Array<{ id?: string }> };
  const list = body?.data;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(
      `ApiCallStep: admin user has no organization memberships; cannot inject X-Organization-Id. ` +
      `Set --org-id <uuid> on the simulator CLI or assign the user to an organization.`,
    );
  }
  if (list.length > 1) {
    const ids = list.map((o) => o.id).filter((id): id is string => typeof id === 'string');
    throw new Error(
      `ApiCallStep: admin user is member of ${list.length} organizations; cannot auto-pick. ` +
      `Pass --org-id <uuid> to disambiguate. Candidates: ${ids.join(', ')}`,
    );
  }

  const orgId = list[0]?.id;
  if (typeof orgId !== 'string' || orgId.length === 0) {
    throw new Error(
      `ApiCallStep: /api/v1/organizations returned an entry without a string \`id\` field`,
    );
  }

  orgIdCache.set(cacheKey, orgId);
  context.orgId = orgId;
  return orgId;
}

/**
 * Check whether the URL targets an endpoint that the server gates on
 * X-Organization-Id (currently anything under /api/v1/admin/).
 */
function requiresOrgHeader(url: string): boolean {
  return /\/api\/v1\/admin\//.test(url);
}

export class ApiCallStep implements Step {
  async execute(
    definition: StepDefinition,
    context: ScenarioContext,
    _station: Station,
  ): Promise<void> {
    const method = (definition.method as string) ?? 'GET';
    const rawUrl = definition.url as string;
    if (!rawUrl) {
      throw new Error('ApiCallStep requires a "url" field');
    }

    const url = substituteTemplateValue(rawUrl, context);
    const headers = definition.headers
      ? (substituteTemplates(definition.headers, context) as Record<string, string>)
      : undefined;
    const body = definition.body
      ? JSON.stringify(substituteTemplates(definition.body, context))
      : undefined;

    // Auto-authenticate if credentials are available
    const token = await ensureAuth(context);

    // Auto-inject X-Organization-Id for admin endpoints when not explicitly
    // supplied via scenario `headers:`. Skip for non-admin URLs (auth/login,
    // /organizations itself, etc.) so the auto-discovery call doesn't loop.
    const explicitOrgHeader =
      headers !== undefined && Object.keys(headers).some((k) => k.toLowerCase() === 'x-organization-id');
    // `omit_org_header: true` suppresses the auto-injected X-Organization-Id so a PLATFORM-scoped
    // api_call (e.g. install-certificate / trigger-cert-renewal, gated by
    // permission:platform.certificates.manage) resolves at the NULL/platform team instead of an
    // org team — where a platform_admin's NULL-scoped permission would be filtered out (403).
    // Confirmed empirically on UAT: org-less platform admin is authorized; org-scoped is 403.
    const omitOrgHeader = definition.omit_org_header === true;
    let autoOrgId: string | undefined;
    if (token && requiresOrgHeader(url) && !explicitOrgHeader && !omitOrgHeader) {
      autoOrgId = await ensureOrgId(context, token);
    }

    const fetchHeaders: Record<string, string> = {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(autoOrgId ? { 'X-Organization-Id': autoOrgId } : {}),
      ...(methodRequiresIdempotencyKey(method) ? { 'Idempotency-Key': randomUUID() } : {}),
      ...headers,
    };

    const isBackground = definition.background === true;
    // 429 retry is on by default — only disabled with explicit `retry_on_429: false`.
    // Honors the server's Retry-After header; falls back to bounded exponential backoff +
    // jitter so concurrent retriers don't synchronize. After the cap, the last 429 reaches
    // the expect_status mismatch check exactly as before — no silent swallowing.
    const retryEnabled = definition.retry_on_429 !== false;
    const retryOpts: ThrottleRetryOptions = {
      enabled: retryEnabled,
      onRetry: ({ attempt, delayMs }) => {
        console.log(
          `[ApiCallStep${isBackground ? ':background' : ''}] 429 retry ${attempt + 1}/3 for ${method} ${url} in ${delayMs}ms`,
        );
      },
    };

    if (isBackground) {
      // Background mode: fire the request without awaiting. Required for
      // synchronous REST endpoints (e.g., POST /api/v1/sessions/start) that
      // block on the station's MQTT Response — the scenario's subsequent
      // wait_for + send Response steps must run while the fetch is in flight.
      // Errors and status mismatches log but do not fail the step; capture
      // is not supported in background mode.
      // Same reason as `capture`, and the consequence is heavier: a backgrounded
      // create whose id is never recorded is a row nothing can delete. Refuse the
      // combination rather than let a scenario believe it declared ownership.
      if (definition.creates !== undefined) {
        throw new Error(
          'ApiCallStep: "creates" is not supported with "background: true" — the response is ' +
            'not awaited, so the id teardown would delete by is never read. A row created ' +
            'this way could not be cleaned up.',
        );
      }
      if (definition.capture !== undefined) {
        throw new Error(
          'ApiCallStep: "capture" is not supported with "background: true" (response not awaited)',
        );
      }
      // Same reason, and worth failing loudly on: in background mode a status
      // mismatch is only a console.warn (below), so a scenario that believes
      // "the 4xx is the final assertion" has no assertion at all. expect_body
      // cannot be honoured here either — refuse it rather than silently ignore.
      if (definition.expect_body !== undefined) {
        throw new Error(
          'ApiCallStep: "expect_body" is not supported with "background: true" ' +
            '(response not awaited — use a foreground call to assert on the body)',
        );
      }
      // Same reasoning for the two siblings: both are assertions, and an
      // assertion nobody awaits is not one.
      if (definition.expect_body_absent !== undefined) {
        throw new Error(
          'ApiCallStep: "expect_body_absent" is not supported with "background: true" ' +
            '(response not awaited — use a foreground call to assert on the body)',
        );
      }
      if (definition.expect_body_text !== undefined) {
        throw new Error(
          'ApiCallStep: "expect_body_text" is not supported with "background: true" ' +
            '(response not awaited — use a foreground call to assert on the body)',
        );
      }
      // HOW A BACKGROUND FAILURE PRESENTS ITSELF — read this before attributing one.
      //
      // This warn is the ONLY trace a refused background request leaves. The step
      // itself is already green (it returned the moment the fetch was fired), so the
      // run reports the failure at whatever step notices the CONSEQUENCE — normally a
      // `wait_for` that times out several steps later, because the request that would
      // have made the server publish never succeeded. The reported error names the
      // message that never arrived; it does not name the refusal that explains why.
      //
      // Measured 2026-08-13, core/boot-disabled-station-boots-and-stays-gated: the run
      // failed as `Timeout waiting for StartService Request after 15000ms` at step 16,
      // and the cause was this line at step 15 — `409 BAY_NOT_READY/3002` on the
      // backgrounded POST /sessions/start. Three steps and one subsystem apart.
      //
      // So: when a `wait_for` times out in a scenario that has a background call
      // upstream, grep the run log for `[ApiCallStep:background]` BEFORE reading
      // anything into the timeout. This is a property of the instrument — background
      // mode trades assertion for concurrency, deliberately — not of any scenario.
      fetchWithThrottleRetry(url, { method, headers: fetchHeaders, body }, retryOpts)
        .then(async (response) => {
          if (definition.expect_status !== undefined) {
            const expectedStatus = definition.expect_status as number;
            if (response.status !== expectedStatus) {
              const responseBody = await response.text();
              console.warn(
                `[ApiCallStep:background] ${method} ${url}: expected ${expectedStatus}, got ${response.status} — ${responseBody.slice(0, 200)}`,
              );
            }
          }
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[ApiCallStep:background] ${method} ${url} failed: ${message}`);
        });
      return;
    }

    const response = await fetchWithThrottleRetry(
      url,
      { method, headers: fetchHeaders, body },
      retryOpts,
    );

    if (definition.expect_status !== undefined) {
      const expectedStatus = definition.expect_status as number;
      if (response.status !== expectedStatus) {
        const responseBody = await response.text();
        throw new Error(
          `ApiCallStep: expected status ${expectedStatus}, got ${response.status} — ${responseBody}`,
        );
      }
    }

    // ------------------------------------------------------------------
    // expect_body_text — the NON-JSON assertion form.
    //
    // Exists because response.json() is unconditional below, which made every
    // non-JSON surface unreachable: /metrics is Prometheus exposition text
    // (`text/plain; version=0.0.4`) and is the ONLY place the MAC-verification
    // branch is observable at all — the middleware drops the message silently,
    // so there is nothing on the wire and nothing in a table.
    //
    // THE GUARD THAT MATTERS: this must not become a weaker expect_body. A
    // substring match against a JSON body passes when the value appears ANYWHERE
    // — a bay id in a `services[]` entry satisfies a match meant for `bay.id`,
    // and `"status":"failed"` is satisfied by a `fail_reason` that merely
    // contains the word. So a JSON content-type is REFUSED here and the caller
    // is sent to expect_body, which resolves a path. The refusal is on the
    // response's own Content-Type, not on a guess from the URL, so it cannot be
    // dodged by pointing at a JSON endpoint that happens to be undeclared.
    // ------------------------------------------------------------------
    if (definition.expect_body_text !== undefined) {
      if (definition.expect_body !== undefined || definition.capture !== undefined ||
          definition.expect_body_absent !== undefined ||
          definition.creates !== undefined ||
          typeof definition.set_auth_token === 'string') {
        throw new Error(
          'ApiCallStep: "expect_body_text" cannot be combined with expect_body, ' +
            'expect_body_absent, capture, creates or set_auth_token — the body is consumed ' +
            'once, and those five require it parsed as JSON',
        );
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (/\bjson\b/i.test(contentType)) {
        throw new Error(
          `ApiCallStep: "expect_body_text" refused for a JSON response ` +
            `(content-type: ${contentType}). A substring match on JSON passes when the ` +
            `value appears anywhere in the body rather than at a path — use "expect_body", ` +
            `which resolves a path, or "expect_body_absent" to assert a field is missing.`,
        );
      }

      const text = await response.text();
      const patterns = Array.isArray(definition.expect_body_text)
        ? (definition.expect_body_text as unknown[])
        : [definition.expect_body_text];

      for (const raw of patterns) {
        if (typeof raw !== 'string') {
          throw new Error(
            `ApiCallStep: "expect_body_text" entries must be strings, got ${typeof raw}`,
          );
        }
        // `/…/` delimits a regex; anything else is a literal substring. Keeping
        // the literal form the default matters — a Prometheus line carries `{`,
        // `}` and `.`, which are all regex metacharacters, so treating every
        // pattern as a regex would silently change what most callers meant.
        const isRegex = raw.length > 1 && raw.startsWith('/') && raw.endsWith('/');
        const hit = isRegex
          ? new RegExp(raw.slice(1, -1)).test(text)
          : text.includes(raw);

        if (!hit) {
          throw new Error(
            `ApiCallStep: expected body text to ${isRegex ? 'match' : 'contain'} ` +
              `${JSON.stringify(raw)} (content-type: ${contentType}, ${text.length} bytes). ` +
              `First 400 bytes: ${text.slice(0, 400)}`,
          );
        }
      }
      return;
    }

    const needsBody =
      (definition.capture && typeof definition.capture === 'object') ||
      (definition.creates && typeof definition.creates === 'object') ||
      (definition.expect_body && typeof definition.expect_body === 'object') ||
      Array.isArray(definition.expect_body_absent) ||
      typeof definition.set_auth_token === 'string';

    if (needsBody) {
      const responseBody: unknown = await response.json();

      // ----------------------------------------------------------------
      // expect_body_absent — asserts a path is NOT THERE.
      //
      // Absence is genuinely different from null and the corpus needs both.
      // ReservationResource emits cancelled_at/expired_at UNCONDITIONALLY, so
      // those keys are present carrying JSON null and `expect_body: {x: null}`
      // is the right tool. SessionResource wraps fail_reason/fail_error_code in
      // $this->when(status === FAILED), so on a completed session the keys do
      // not exist — and `null` would FAIL there, because getNestedValue returns
      // `undefined` and `undefined === null` is false.
      //
      // Conflating the two is the bug this guards: asserting null where the
      // field is absent produces a red file against a CORRECT server, and
      // asserting absence where the field is null lets a real regression pass.
      // ----------------------------------------------------------------
      if (Array.isArray(definition.expect_body_absent)) {
        for (const path of definition.expect_body_absent) {
          if (typeof path !== 'string') {
            throw new Error(
              `ApiCallStep: "expect_body_absent" entries must be strings, got ${typeof path}`,
            );
          }
          const got = getNestedValue(responseBody, path);
          if (got !== undefined) {
            throw new Error(
              `ApiCallStep: expected body "${path}" to be ABSENT, but it resolved to ` +
                `${JSON.stringify(got)}. Note a JSON null is PRESENT-but-null, not absent — ` +
                `assert that with "expect_body: {${path}: null}" instead. ` +
                `(full body: ${JSON.stringify(responseBody)})`,
            );
          }
        }
      }

      // `expect_status` alone cannot tell one refusal from another: a bay that
      // is Unavailable answers 3011 BAY_MAINTENANCE and a bay the server has
      // never heard a status for answers 3002 BAY_NOT_READY, and BOTH are 409.
      // A scenario asserting only the HTTP code passes on either, so it cannot
      // detect that its own precondition never landed. `expect_body` pins the
      // discriminating field. Dotted paths, strict equality per key.
      if (definition.expect_body && typeof definition.expect_body === 'object') {
        for (const [path, want] of Object.entries(
          definition.expect_body as Record<string, unknown>,
        )) {
          const got = getNestedValue(responseBody, path);

          // `is_recent` is the one value form that is a COMPARATOR rather than a
          // literal — for timestamps the scenario cannot predict but can bound.
          // Intercepted before the equality path below, which would otherwise
          // deep-compare the comparator object itself and always fail.
          if (isRecentComparator(want)) {
            assertIsRecent(
              path,
              got,
              parseRecentBound(want, path),
              response.headers.get('date'),
              responseBody,
            );
            continue;
          }

          const same =
            got === want ||
            (typeof got === 'object' && got !== null &&
              JSON.stringify(got) === JSON.stringify(want));
          if (!same) {
            throw new Error(
              `ApiCallStep: expected body "${path}" to equal ` +
                `${JSON.stringify(want)}, but got ${JSON.stringify(got)} ` +
                `(full body: ${JSON.stringify(responseBody)})`,
            );
          }
        }
      }

      if (typeof definition.set_auth_token === 'string') {
        const tokenPath = definition.set_auth_token;
        const value = getNestedValue(responseBody, tokenPath);
        if (typeof value !== 'string' || value.length === 0) {
          throw new Error(
            `ApiCallStep: set_auth_token path "${tokenPath}" did not resolve to a non-empty string`,
          );
        }
        context.authToken = value;
      }

      if (definition.capture && typeof definition.capture === 'object') {
        for (const [varName, path] of Object.entries(
          definition.capture as Record<string, string>,
        )) {
          const value = getNestedValue(responseBody, path);
          context.captured.set(varName, value);
        }
      }

      // ----------------------------------------------------------------
      // creates — the step SAYS what row it just brought into existence, so the
      // scenario's teardown deletes an id the server itself answered with rather
      // than one a naming convention suggested. See ScenarioResourceLedger.
      //
      //   creates:
      //     organization: "data.organization.id"
      //
      // Only a path into THIS response is accepted. A literal (or a `{{stationId}}`
      // that substitution already resolved) would let a scenario claim ownership of a
      // row it did not create — and the delete for an organization cascades. Reached
      // only after expect_status and expect_body have passed, so a call that did not
      // create what it meant to records nothing.
      // ----------------------------------------------------------------
      if (definition.creates && typeof definition.creates === 'object') {
        for (const [kind, path] of Object.entries(
          definition.creates as Record<string, string>,
        )) {
          if (!(CREATED_RESOURCE_KINDS as readonly string[]).includes(kind)) {
            throw new Error(
              `ApiCallStep: "creates" key "${kind}" is not a resource teardown can delete. ` +
                `Known kinds: ${CREATED_RESOURCE_KINDS.join(', ')}.`,
            );
          }
          if (typeof path !== 'string' || path.length === 0) {
            throw new Error(
              `ApiCallStep: "creates.${kind}" must be a dotted path into this response body, ` +
                `got ${JSON.stringify(path)}.`,
            );
          }
          const value = getNestedValue(responseBody, path);
          if (typeof value !== 'string' || value.length === 0) {
            throw new Error(
              `ApiCallStep: "creates.${kind}" path "${path}" did not resolve to a non-empty ` +
                `string in the response — teardown would have nothing to delete by, and the ` +
                `row would be left behind silently. (full body: ${JSON.stringify(responseBody)})`,
            );
          }
          context.created.record(
            kind as CreatedResourceKind,
            value,
            `${method} ${new URL(url).pathname} → ${path}`,
          );
        }
      }
    }
  }
}

/** Test-only surface for the path resolver; see ApiCallStep.arraySelector.test.ts. */
export const _getNestedValueForTesting = getNestedValue;
