/**
 * The clock that gets DIFFERENCED — as distinct from the clock that gets STAMPED.
 *
 * `spec/profiles/core/heartbeat.md:44` rule 5, present since the first tag
 * (`v0.1.0-draft.1`, commit `5e49f2e`):
 *
 *   "Clock adjustments MUST NOT affect the duration of active sessions. The
 *    station MUST track session elapsed time using a monotonic timer, not the
 *    wall clock."
 *
 * Restated on both carriers of the one field it exists for —
 * `spec/profiles/transaction/stop-service.md:47` rule 5 and
 * `spec/profiles/transaction/session-ended.md:61` rule 2. This simulator read the
 * wall clock at both, which is what this module exists to stop.
 *
 * `heartbeat.md:51` rule 6 states the division of labour, and it is the whole of
 * the rule this module encodes:
 *
 *   "The wall clock's job in a session is to stamp values that get ORDERED — the
 *    envelope `timestamp`, `startedAt`, `endedAt`; the monotonic timer's job is
 *    to produce the one that gets DIFFERENCED."
 *
 * So the two are NOT interchangeable and neither substitutes for the other:
 *   - `new Date().toISOString()` stays wherever a wire timestamp is built, and
 *     must never appear inside a subtraction;
 *   - `monotonicNowMs()` is only ever subtracted from another reading of itself,
 *     and must never reach the wire.
 *
 * Why the rule is a MUST and not advice, in `heartbeat.md:51` rule 6's own terms:
 * `actualDurationSeconds` is `integer, minimum 0` with **no `maximum`** on
 * `stop-service-response.schema.json` and `session-ended-event.schema.json`, and
 * no receiver obligation cross-checks it against the session's own `startedAt`
 * and `endedAt`. The receiver takes it verbatim. A station that derives it from
 * the wall clock therefore ships every correction that lands mid-session straight
 * into the invoice, in whichever direction the correction went, with nothing
 * downstream to catch it.
 *
 * `performance.now()` and not `Date.now()`: in Node it is `uv_hrtime()` —
 * `clock_gettime(CLOCK_MONOTONIC)` on Linux — so an NTP step, a cellular NITZ
 * correction or an operator setting the clock moves `Date.now()` and does not
 * move this. It is read through the global at every call rather than captured
 * once, which is also what lets a test drive it with
 * `vi.spyOn(performance, 'now')` while `vi.useFakeTimers({ toFake: ['Date'] })`
 * steps the wall clock underneath it.
 *
 * The value is milliseconds since an ARBITRARY per-process origin. It is
 * meaningless on its own: it MUST NOT be serialised, logged as a time, persisted,
 * or compared against anything that came off the wire — only against another
 * reading of this same function in this same process. Two readings taken in
 * different processes are not comparable, which is why a duration spanning a
 * restart cannot be measured this way at all (`heartbeat.md:48` says as much for
 * the receiver that has to settle one).
 */
export function monotonicNowMs(): number {
  return performance.now();
}
