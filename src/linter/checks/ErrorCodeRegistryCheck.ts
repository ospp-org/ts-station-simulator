import { OsppErrorCode } from '@ospp/protocol';
import type { LintIssue, LintCheck, ParsedScenario } from '../types.js';

/**
 * AN ASSERTED ERROR CODE MUST BE A CODE THAT EXISTS.
 *
 * `EnumValuesCheck` derives four enumerations from the SDK — `BootReason`, `BayStatus`,
 * `SessionEndReason`, `MessageType` — and the error-code registry was not among them.
 * Nothing else covered it either: measured on this corpus, FOUR scenarios carrying a
 * fabricated code (`3911` flat, `3914` wrapped, `3918` on an `assert` step, `3907` in a
 * `send` payload) passed all seven checks green. `PayloadSchemaCheck` cannot see it — of
 * the 86 schemas the SDK ships, 21 mention `errorCode` and NONE constrains it with an
 * `enum`: nineteen say only `"type": "integer"` and two
 * (`boot-notification-response`, `status-notification`) add `minimum: 1000, maximum: 9999`.
 * A typo inside that range is a valid integer.
 *
 * So a wrong code reached the server, came back as a mismatch, and read as a server defect
 * rather than as a typo in the file asserting it — the one failure this repository exists
 * to make impossible.
 *
 * ── WHAT IS DERIVED AND WHAT IS NOT ─────────────────────────────────────────────────────
 *
 * The registry is `Object.values(OsppErrorCode)`, read from the SDK at construction, never
 * transcribed — the same shape the four existing enumerations use. 120 members today, and
 * the number is not written down anywhere here.
 *
 * The vendor band IS two literals, and that is the one thing in this file not derived: the
 * SDK documents `9000-9999 Vendor-Specific (reserved, not enumerated here)` in a doc comment
 * (`dist/enums/OsppErrorCode.d.ts:19`) and exports no constant for it, so there is nothing to
 * read. A vendor code is legitimately absent from the registry, and a check that reddened on
 * one would be wrong. `ErrorCodeRegistryCheck.test.ts` pins the assumption underneath the
 * literals — that the registry enumerates nothing in the band — so the day the SDK starts
 * enumerating 9xxx codes, the exemption goes red instead of going quiet.
 *
 * ── WHERE IT LOOKS ──────────────────────────────────────────────────────────────────────
 *
 * Both spellings, because the corpus uses both and a check that reads one silently stops
 * seeing half of it (the reasoning is `src/protocol/errorShape.ts`'s, measured there):
 * `errorCode` on the flat OSPP Error Object, `ospp_code` inside the wrapped envelope.
 *
 * Three containers, which is every place a scenario can name a code — derived from the
 * corpus's own step-key surface, not guessed:
 *   - `payload`     on `send` — the station's own refusal (14 sites + 3 nested)
 *   - `expect_body` on `api_call` and `provision` — what the server must answer (38 sites)
 *   - `field:`/`equals:` on `assert` — the same claim as a step (6 sites)
 * `capture` maps are deliberately NOT walked: `capture: {ospp_code: "error.ospp_code"}` names
 * a JSON path to read, not a code to believe, and it is the one non-numeric site in the 67.
 *
 * `wait_for` has no expectation key at all (it carries only `capture`), so there is nothing
 * to check there and no gap in not checking it.
 */
const REGISTRY: ReadonlySet<number> = new Set(
  Object.values(OsppErrorCode).filter((v): v is number => typeof v === 'number'),
);

/** `9000-9999 Vendor-Specific (reserved, not enumerated here)` — @ospp/protocol dist/enums/OsppErrorCode.d.ts:19 */
const VENDOR_MIN = 9000;
const VENDOR_MAX = 9999;

/** A key that NAMES an OSPP code, in either envelope shape. Matches a dotted `expect_body` path too. */
const CODE_KEY_RE = /(^|\.)(errorCode|ospp_code)$/;

function isKnown(code: number): boolean {
  if (REGISTRY.has(code)) return true;
  return code >= VENDOR_MIN && code <= VENDOR_MAX;
}

/**
 * The defined codes nearest to a rejected one, so a mistyped digit reads as a mistyped digit.
 *
 * Ranked by DIGIT DIFFERENCE, not by numeric distance, and the difference is not cosmetic:
 * `3911` is numerically closest to `4000` (89 away) and that is useless, while `3011` — the
 * code actually meant — is 900 away but differs in ONE character. The failure this message
 * replaces said only that the server answered something else; naming the one-character
 * neighbour is what turns it back into a typo.
 *
 * Numeric distance stays as the tie-break, so equally-close candidates come out in a stable
 * order rather than in registry-declaration order.
 */
function digitDistance(a: number, b: number): number {
  const x = String(a).padStart(4, '0');
  const y = String(b).padStart(4, '0');
  let d = Math.abs(x.length - y.length);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) d++;
  }
  return d;
}

function nearest(code: number, howMany = 3): string {
  return [...REGISTRY]
    .sort(
      (a, b) =>
        digitDistance(a, code) - digitDistance(b, code) ||
        Math.abs(a - code) - Math.abs(b - code) ||
        a - b,
    )
    .slice(0, howMany)
    .map((c) => `${c} ${OsppErrorCode[c]}`)
    .join(', ');
}

/** Every (path, numeric value) under a container, walking nested objects and dotted keys alike. */
function collect(
  value: unknown,
  base: string,
  out: Array<{ path: string; code: number }>,
): Array<{ path: string; code: number }> {
  if (Array.isArray(value)) {
    value.forEach((item, i) => collect(item, `${base}[${i}]`, out));
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const path = base ? `${base}.${k}` : k;
      // Only NUMBERS are claims about a code. A `{{template}}` resolves at run time and a
      // JSON path is a directive; neither is assertable here.
      if (CODE_KEY_RE.test(k) && typeof v === 'number') out.push({ path, code: v });
      collect(v, path, out);
    }
  }
  return out;
}

export class ErrorCodeRegistryCheck implements LintCheck {
  name = 'error-code-registry';

  check(scenario: ParsedScenario): LintIssue[] {
    const issues: LintIssue[] = [];

    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      const action = step.action as string;

      // Same opt-out `PayloadSchemaCheck` grants, for the same reason: a step marked
      // `expect_invalid` deliberately publishes something wrong to probe the server, and
      // fighting the linter over it is not the job. Measured: 0 of the 5 `expect_invalid`
      // steps in this corpus names a code, so the opt-out is inert today.
      const optedOut = action === 'send' && step.expect_invalid === true;

      const found: Array<{ path: string; code: number }> = [];
      if (!optedOut) {
        collect(step.payload, 'payload', found);
        collect(step.expect_body, 'expect_body', found);
      }

      // The `assert` form says the same thing across two keys rather than one.
      if (
        action === 'assert' &&
        typeof step.field === 'string' &&
        CODE_KEY_RE.test(step.field) &&
        typeof step.equals === 'number'
      ) {
        found.push({ path: `field ${step.field} / equals`, code: step.equals });
      }

      for (const { path, code } of found) {
        if (isKnown(code)) continue;
        issues.push({
          file: scenario.filePath,
          step: i,
          stepAction: action,
          message:
            `Unknown OSPP error code ${code} at ${path} -- not one of the ${REGISTRY.size} ` +
            `members of the SDK's OsppErrorCode, and not in the ${VENDOR_MIN}-${VENDOR_MAX} ` +
            `vendor band. Nearest defined: ${nearest(code)}. A code that does not exist ` +
            `cannot be answered, so this scenario would fail at run time as a mismatch ` +
            `rather than as the typo it is.`,
        });
      }
    }

    return issues;
  }
}
