/**
 * WHICH REST ERROR SHAPE A ROUTE ANSWERS WITH — and why this corpus needs all of them.
 *
 * csms-server answers REST refusals in THREE shapes, and the split is by ROUTE, not by
 * status or by module:
 *
 *   FLAT (the OSPP Error Object, spec/07-errors.md §2.4) — the object IS the body:
 *     { errorCode, errorText, errorDescription, severity, recoverable,
 *       recommendedAction, timestamp, details? }
 *
 *   WRAPPED (the product envelope, most of the application):
 *     { error: { code, ospp_code, message, details? }, meta: { timestamp } }
 *
 *   BARE (the three bay-edit doors, deliberately, so the SPA's prose matching keeps
 *   working — StationManagementController::bayEditRefusal):
 *     { message, details: { reason } }
 *
 * §2.4:207 requires the Error Object to be the top-level body — "MUST NOT be wrapped in
 * an enclosing member (`error`, `data`, or any other name)", and no sibling members. Only
 * the routes the specification actually defines are held to that, and csms-server marks
 * exactly those with the `OsppErrorSurface` middleware. Five of them, listed below.
 *
 * ── WHY THIS MODULE EXISTS RATHER THAN A `sed` ──────────────────────────────────────────
 *
 * Until csms-server `dd090cf0` the marked routes ALSO answered wrapped, because the
 * exception renderers took no Request and so could not tell the two surfaces apart. That
 * commit made both renderers marker-aware, and twelve api_call steps in this corpus went
 * stale in one push — every one of them reading `error.ospp_code` off a route that had
 * stopped carrying an `error` wrapper. They were green against UAT the whole time, because
 * UAT was behind.
 *
 * The migration is the cheap half. The expensive half is that BOTH shapes remain correct,
 * on different routes, so "always use the flat one" is as wrong as the state we came from —
 * `POST /reservations`, every `/admin/*` door and the offline endpoints are all wrapped.
 * A corpus-wide gate keyed on this list is what keeps a copy-paste from moving a step onto
 * the wrong shape in either direction; see MarkedRouteErrorShape.test.ts.
 *
 * ── WHY `src/protocol/` AND NOT `src/scenarios/` ────────────────────────────────────────
 *
 * Two readers need this predicate: the corpus gates under `src/__tests__/scenarios/`, and
 * `src/linter/checks/PreEmptDiscriminatorCheck.ts`. The linter is deliberately standalone —
 * it declares its OWN `ParsedScenario` rather than importing ScenarioRunner's, and until this
 * module its only non-relative imports were `@ospp/protocol`, `yaml`, `node:*` and `chalk`.
 * Putting the shared fact under `scenarios/` would have made the linter depend on the runner
 * to answer a question about a REST envelope, which is neither true nor useful.
 *
 * It is not a scenario concept and not a linter concept. It is a fact about the shapes
 * csms-server puts on the wire, which is what `src/protocol/` is for.
 *
 * KEEP IN SYNC WITH csms-server. The authority is the middleware, not this file:
 *   routes/api/v1/sessions.php:36,38,53,62  ·  routes/api/v1/provisioning.php:26
 *   bootstrap/app.php:286 states the same five in prose.
 */

/** Human-readable name of each `OsppErrorSurface`-marked route, or undefined. */
export function markedErrorRoute(url: string): string | undefined {
  // Order matters: `/sessions/start` and `/sessions/{id}/stop` must be tested before the
  // bare `/sessions/{id}` pattern, which would otherwise swallow `start`.
  const u = url.split('?')[0].replace(/\/+$/, '');
  if (/\/api\/v1\/sessions\/start$/.test(u)) return 'POST /sessions/start';
  if (/\/api\/v1\/sessions\/[^/]+\/stop$/.test(u)) return 'POST /sessions/{id}/stop';
  if (/\/api\/v1\/sessions\/offline-auth$/.test(u)) return 'POST /sessions/offline-auth';
  if (/\/api\/v1\/stations\/provision$/.test(u)) return 'POST /stations/provision';
  if (/\/api\/v1\/sessions\/[^/]+$/.test(u)) return 'GET /sessions/{id}';
  return undefined;
}

/** The `expect_body` paths that name a member of the WRAPPED envelope. */
export function wrappedErrorPaths(expectBody: Record<string, unknown>): string[] {
  return Object.keys(expectBody).filter((p) => p === 'error' || p.startsWith('error.'));
}

/**
 * The `expect_body` paths that name a member of the FLAT Error Object.
 *
 * `details` AND `timestamp` ARE DELIBERATELY ABSENT, and the reason was measured rather than
 * reasoned: the first run of MarkedRouteErrorShape.test.ts flagged two steps in
 * `bay-edit-refused.yaml` reading `details.reason` off an admin route, and they were RIGHT —
 * those doors answer the BARE `{message, details}` envelope, a third shape the migration had
 * not accounted for. `details` therefore appears in two of the three shapes at the same path
 * and discriminates nothing; `timestamp` is a plain data member on read endpoints. Only the
 * six members no other shape carries are listed, so a hit here is proof of the flat object
 * rather than a guess at it.
 */
const FLAT_MEMBERS = [
  'errorCode',
  'errorText',
  'errorDescription',
  'severity',
  'recoverable',
  'recommendedAction',
];
export function flatErrorPaths(expectBody: Record<string, unknown>): string[] {
  return Object.keys(expectBody).filter((p) =>
    FLAT_MEMBERS.some((m) => p === m || p.startsWith(`${m}.`)),
  );
}

/**
 * The OSPP numeric code a step asserts, whichever shape carries it.
 *
 * `errorCode` (flat) and `error.ospp_code` (wrapped) are the same claim written two ways,
 * and every corpus-wide instrument that reads a code — the money gate, the bay-arming gate,
 * the pre-empt linter — must read both or it silently stops seeing half the corpus. That
 * failure mode is not hypothetical: a gate keyed on `ospp_code` alone goes QUIET when a file
 * migrates, rather than red, because "no scenario asserts this" and "this scenario is
 * excused" are both satisfied by finding nothing.
 */
export function assertedErrorCode(expectBody: Record<string, unknown>): number | undefined {
  for (const [path, want] of Object.entries(expectBody)) {
    if (typeof want !== 'number') continue;
    if (path === 'errorCode' || /(^|\.)ospp_code$/.test(path)) return want;
  }
  return undefined;
}

/** True when a step asserts this numeric OSPP code in either shape. */
export function assertsErrorCode(expectBody: unknown, code: number): boolean {
  if (!expectBody || typeof expectBody !== 'object' || Array.isArray(expectBody)) return false;
  return assertedErrorCode(expectBody as Record<string, unknown>) === code;
}
