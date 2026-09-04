import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  markedErrorRoute,
  wrappedErrorPaths,
  flatErrorPaths,
} from '../../protocol/errorShape.js';

/**
 * A REFUSAL ASSERTION MUST NAME THE SHAPE ITS OWN ROUTE ANSWERS WITH.
 *
 * csms-server answers REST errors in two shapes and picks by ROUTE — the five
 * `OsppErrorSurface`-marked endpoints get the flat OSPP Error Object (spec §2.4: the object
 * IS the body), everything else gets the wrapped product envelope. `src/protocol/errorShape.ts`
 * holds the list and the argument.
 *
 * WHY A GATE AND NOT JUST THE MIGRATION. Twelve steps in this corpus read `error.ospp_code`
 * off a marked route until csms-server `dd090cf0` made the renderers marker-aware, and every
 * one of them was GREEN the whole time — against a UAT that was behind. The migration fixes
 * those twelve. It does not stop the thirteenth, and the thirteenth is likelier than the
 * first twelve were: the corpus now contains both shapes, side by side, in files that look
 * alike, so a copy-paste has a wrong answer available to it that reads as normal.
 *
 * BOTH DIRECTIONS ARE CHECKED, and the second is the load-bearing one. Flat-on-wrapped is
 * the failure a migration introduces; wrapped-on-flat is the one it leaves behind. Neither
 * is detectable from a green run against a server that has not moved yet.
 *
 * IT EARNED ITS KEEP ON THE FIRST RUN, in the direction that was not the point: it flagged
 * two steps in `bay-edit-refused.yaml` reading `details.reason`, and they were correct — the
 * bay-edit doors answer a THIRD envelope, `{message, details}`, which the migration had not
 * accounted for. `details` and `timestamp` are shared across shapes and discriminate nothing;
 * only the six members unique to the Error Object count as flat. See errorShape.ts.
 *
 * WHAT THIS DOES NOT CLAIM. It says nothing about whether the code asserted is the right
 * code, nor whether the step should assert a body at all — only that a step which HAS
 * decided to read an error member reads it off the shape its route emits.
 */

const SCENARIOS_DIR = path.resolve(__dirname, '../../../scenarios');

interface ErrorStep {
  file: string;
  step: number;
  url: string;
  route: string | undefined;
  wrapped: string[];
  flat: string[];
}

function collect(): ErrorStep[] {
  const out: ErrorStep[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.yaml')) continue;

      let doc: { steps?: unknown } | null;
      try {
        doc = parseYaml(fs.readFileSync(full, 'utf-8')) as { steps?: unknown } | null;
      } catch {
        continue; // Malformed YAML is the scenario linter's finding, not this gate's.
      }
      const steps = (doc?.steps ?? []) as Array<Record<string, unknown>>;
      steps.forEach((step, index) => {
        if (step.action !== 'api_call') return;
        const body = step.expect_body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) return;
        const map = body as Record<string, unknown>;
        const wrapped = wrappedErrorPaths(map);
        const flat = flatErrorPaths(map);
        if (wrapped.length === 0 && flat.length === 0) return;
        const url = String(step.url ?? '');
        out.push({
          file: path.relative(SCENARIOS_DIR, full),
          step: index,
          url,
          route: markedErrorRoute(url),
          wrapped,
          flat,
        });
      });
    }
  };
  walk(SCENARIOS_DIR);
  return out;
}

const errorSteps = collect();

describe('REST error shape — the assertion matches the route that answers it', () => {
  it('the walk found error assertions on BOTH surfaces (guards a vacuous gate)', () => {
    // Two positive controls, because one is not enough here: a gate that finds only marked
    // steps would never exercise its wrapped arm and vice versa, and either half could rot
    // to nothing while the file kept reporting green.
    const onMarked = errorSteps.filter((s) => s.route !== undefined);
    const onOther = errorSteps.filter((s) => s.route === undefined);
    expect(onMarked.length, 'no error assertion on any marked route').toBeGreaterThan(0);
    expect(onOther.length, 'no error assertion off the marked routes').toBeGreaterThan(0);
  });

  it('a marked route is asserted with the FLAT Error Object, never `error.*`', () => {
    const offenders = errorSteps
      .filter((s) => s.route !== undefined && s.wrapped.length > 0)
      .map((s) => `${s.file} step ${s.step} (${s.route}) reads ${s.wrapped.join(', ')}`);
    expect(
      offenders,
      'These steps read the WRAPPED envelope off a route that answers the flat OSPP Error ' +
        'Object. spec/07-errors.md §2.4 forbids the `error` wrapper there, and csms-server ' +
        'dd090cf0 made both exception renderers honour it — so `error.ospp_code` resolves to ' +
        'nothing and the assertion fails on a body that is correct. Map it: ' +
        'error.ospp_code -> errorCode, error.code -> errorText, error.message -> ' +
        'errorDescription, error.details.X -> details.X.',
    ).toEqual([]);
  });

  it('an unmarked route is asserted with the WRAPPED envelope, never the flat members', () => {
    const offenders = errorSteps
      .filter((s) => s.route === undefined && s.flat.length > 0)
      .map((s) => `${s.file} step ${s.step} (${s.url}) reads ${s.flat.join(', ')}`);
    expect(
      offenders,
      'These steps read the FLAT Error Object off a route that is not in the ' +
        '`OsppErrorSurface` group, and so still answers `{error: {...}, meta: {...}}`. The ' +
        'flat members resolve to nothing there. Map it back: errorCode -> error.ospp_code, ' +
        'errorText -> error.code, errorDescription -> error.message. If the route really has ' +
        'been marked on the server, add it to markedErrorRoute() in ' +
        'src/protocol/errorShape.ts rather than exempting the file.',
    ).toEqual([]);
  });

  it('no step mixes the two shapes in one expect_body', () => {
    // A body cannot be both. A step holding one of each is asserting against a response that
    // cannot exist, and half of it is guaranteed dead — which is the quiet way an assertion
    // stops discriminating without ever going red.
    const mixed = errorSteps
      .filter((s) => s.wrapped.length > 0 && s.flat.length > 0)
      .map((s) => `${s.file} step ${s.step}: ${s.wrapped.join(',')} + ${s.flat.join(',')}`);
    expect(mixed, 'expect_body names members of both error shapes').toEqual([]);
  });
});
