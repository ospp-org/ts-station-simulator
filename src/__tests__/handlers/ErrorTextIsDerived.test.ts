import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OsppErrorCode, OSPP_ERROR_REGISTRY } from '@ospp/protocol';
import { errorName } from '../../handlers/bayRefusal.js';

/*
 * ERROR TEXT IS THE REGISTRY'S NAME, OR IT IS NOTHING.
 *
 * `errorText` is `^[A-Z][A-Z0-9_]+$` on the schemas that constrain it — a machine-readable
 * name, and the registry is the only place that name exists. A derived site reads it off the
 * SDK — `errorName()` via the enum's reverse mapping, or `OSPP_ERROR_REGISTRY[code].text`
 * via the registry's published field — so it cannot disagree with the registry: the registry
 * IS the value.
 *
 * A TYPED LITERAL CAN. Measured before this gate existed: 9 of the 21 `errorText:`
 * assignments under `src/handlers/` were bare string literals — four in StartServiceHandler,
 * two in UpdateFirmwareHandler, one in ResetHandler, two in SetMaintenanceModeHandler. All
 * nine happened to agree with the code beside them, checked one by one, so nothing was
 * WRONG yet. That is the point: they were nine places where a rename in the SDK, or a
 * corrected code, would leave the text behind with nothing to notice. This repository is
 * the instrument that catches drift in other people's implementations; it cannot carry a
 * silent copy of the registry in its own.
 *
 * ── WHAT THIS GATE CANNOT SEE ───────────────────────────────────────────────────────────
 *
 * It reads SOURCE TEXT, so it is blind to four things, stated plainly rather than implied:
 *
 *  0. A THIRD derived spelling. It accepts `errorName(` and `OSPP_ERROR_REGISTRY[`; anything
 *     else — including a correct new way of reading the same SDK — reds here and has to be
 *     added deliberately. That is the intent: the list of accepted spellings is short on
 *     purpose.
 *  1. A value built at RUN TIME — `errorText: someString`, a concatenation, a lookup table.
 *     It requires the literal call shape, so such a site fails here rather than passing
 *     silently, but it cannot tell a correct runtime value from a wrong one. The wire-level
 *     half of this is `RejectionFramesAreSchemaValid.test.ts`, which now compares the
 *     EMITTED `errorText` against `errorName(emitted errorCode)` on every Rejected frame it
 *     drives — 7 refusal branches across 5 handlers, not all 21 sites.
 *  2. A handler OUTSIDE `src/handlers/`. The directory is the scope, and it is the only
 *     directory that emits refusal frames today (measured: 21 of 21 `errorText:`
 *     assignments in non-test `src/` are under it).
 *  3. `errorName(OsppErrorCode.X)` written beside `errorCode: OsppErrorCode.Y` — the call
 *     shape is right and the code is the wrong one. Adjacency is not parsed here; the
 *     behavioural half above catches it for the branches it reaches.
 *  4. Anything in `dist/`. It reads `src/`.
 */

const HANDLERS_DIR = path.join(fileURLToPath(new URL('../../handlers/', import.meta.url)));

/**
 * An `errorText:` that is an ASSIGNMENT, not a read.
 *
 * The negative lookbehind is load-bearing: `StartServiceHandler.ts` logs
 * `response.status === 'Rejected' ? response.errorText : 'accepted'`, and a pattern without
 * it reads that ternary colon as an assignment and reds a line that assigns nothing.
 */
const ASSIGNMENT_RE = /(?<![.\w])errorText\s*:/;

/**
 * The accepted right-hand sides. TWO spellings, one source.
 *
 * `errorName(c)` reads the enum's reverse mapping; `OSPP_ERROR_REGISTRY[c].text` reads the
 * registry's published field. Measured 2026-09-21 they agree for 120 of 120 codes, so this
 * is not two sources of truth — it is one SDK read two ways.
 *
 * The second spelling exists for exactly one reason, and it is a ceiling:
 * `FirmwareIntegrityCeiling.test.ts:63` pins `UpdateFirmwareHandler`'s imports to EXACTLY
 * `['./Handler.js', '@ospp/protocol']`, on the ground that a new dependency is how I/O
 * arrives in a handler that must REPORT firmware failures rather than discover them.
 * `errorName` lives in `./bayRefusal.js`, so importing it there would red that guard.
 * Widening the ceiling was the other option and was NOT taken: it is a security-shaped
 * gate, and the registry was already reachable on an import the file has. The literals were
 * therefore converted without touching it.
 */
const DERIVED_RE = /(?<![.\w])errorText\s*:\s*(errorName\(|OSPP_ERROR_REGISTRY\[)/;

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
}

interface Site {
  file: string;
  line: number;
  text: string;
}

function scan(): Site[] {
  const sites: Site[] = [];
  for (const name of fs.readdirSync(HANDLERS_DIR).filter((f) => f.endsWith('.ts')).sort()) {
    const lines = fs.readFileSync(path.join(HANDLERS_DIR, name), 'utf-8').split('\n');
    lines.forEach((text, i) => {
      if (isCommentLine(text)) return;
      if (ASSIGNMENT_RE.test(text)) sites.push({ file: name, line: i + 1, text: text.trim() });
    });
  }
  return sites;
}

describe('errorText in the handlers is derived from the registry, never typed', () => {
  const sites = scan();

  it('ANTI-VACUITY — the scan finds the assignments it is meant to police', () => {
    // A gate that found nothing would pass every assertion below. 21 sites were measured by
    // hand across 10 handler files; the floor is deliberately below that so adding a
    // refusal does not red this, while deleting the scan's ability to see does.
    expect(sites.length).toBeGreaterThanOrEqual(21);
    expect(new Set(sites.map((s) => s.file)).size).toBeGreaterThanOrEqual(9);
  });

  it('POSITIVE CONTROL — the predicate rejects a hand-typed literal', () => {
    // Without this, "every site is derived" is satisfied by a predicate that accepts
    // everything. These are the nine literals as they were written, verbatim.
    const wasTyped = [
      "        errorText: 'BAY_NOT_FOUND',",
      "        errorText: 'INVALID_SERVICE',",
      "        errorText: 'PROGRAM_NOT_DECLARED',",
      "        errorText: 'DURATION_INVALID',",
      "        errorText: 'VERSION_ALREADY_INSTALLED',",
      "        errorText: 'ACTIVE_SESSIONS_PRESENT',",
      "            errorText: 'BAY_BUSY',",
      "        errorText: 'VERSION_ALREADY_INSTALLED', // not the registry lookup",
      '        errorText: `ACTIVE_SESSIONS_PRESENT`,',
      '        errorText: someRuntimeString,',
    ];
    for (const line of wasTyped) {
      expect(ASSIGNMENT_RE.test(line), `not seen as an assignment: ${line}`).toBe(true);
      expect(DERIVED_RE.test(line), `wrongly accepted as derived: ${line}`).toBe(false);
    }
  });

  it('CONTROL — the predicate does not read a property ACCESS as an assignment', () => {
    // The ternary in StartServiceHandler's log line. A gate that flagged it would be
    // un-satisfiable and would get switched off.
    const read = "      response.status === 'Rejected' ? response.errorText : 'accepted',";
    expect(ASSIGNMENT_RE.test(read)).toBe(false);
  });

  it('every errorText assignment under src/handlers/ reads the SDK', () => {
    const typed = sites.filter((s) => !DERIVED_RE.test(s.text));
    expect(
      typed.map((s) => `${s.file}:${s.line}  ${s.text}`),
      'errorText must be errorName(<the code this frame carries>) — or, where an import ' +
        'ceiling forbids that, OSPP_ERROR_REGISTRY[<the same code>].text — so the text ' +
        'cannot drift from the registry. A literal is a second copy of a name the SDK ' +
        'already owns.',
    ).toEqual([]);
  });

  it('the two derived spellings are the SAME source — 120 of 120 codes agree', () => {
    // What makes accepting both honest rather than lax. If the SDK ever let the enum name
    // and the registry's `text` diverge, the second spelling would stop being a synonym and
    // this reds before anything ships on the difference.
    const codes = Object.values(OsppErrorCode).filter((v): v is number => typeof v === 'number');
    const disagreeing = codes.filter((c) => OsppErrorCode[c] !== OSPP_ERROR_REGISTRY[c].text);
    expect(disagreeing).toEqual([]);
    expect(codes.length).toBeGreaterThan(100);
  });

  it('errorName() IS the registry — it does not restate it', () => {
    // The derivation itself, so "derived" means something. `errorName` reads the enum's
    // reverse mapping; if it ever became a transcribed table, this reds.
    expect(errorName(OsppErrorCode.BAY_MAINTENANCE)).toBe('BAY_MAINTENANCE');
    expect(errorName(OsppErrorCode.ACTIVE_SESSIONS_PRESENT)).toBe('ACTIVE_SESSIONS_PRESENT');
    expect(() => errorName(3911 as OsppErrorCode)).toThrow(/no name for OsppErrorCode 3911/);
  });
});
