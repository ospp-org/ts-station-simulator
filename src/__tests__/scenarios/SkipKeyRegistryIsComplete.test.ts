import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { collectSkipAges } from '../../scenarios/skipAge.js';

/**
 * EVERY WAY A FILE CAN STOP RUNNING MUST BE A WAY THE AGE REPORT CAN SEE.
 *
 * The two halves of this drift apart in one direction only, and the direction is the reason
 * the drift is invisible: a file that stops running stops producing the signal that would say
 * it stopped. Nothing goes red. The count in the summary goes DOWN, which reads like progress.
 *
 * MEASURED 2026-09-05, and it is a class rather than an oversight. `ScenarioRunner.runScenario`
 * has FOUR scenario-declared exclusions; `SKIP_KEYS` carried TWO.
 *
 *   - `requires_pool` — six files. `service-catalog-update.yaml` adopted it as a straight
 *     REPLACEMENT for `skip: true` + `skip_kind: inconclusive`; the file went on not running
 *     and its age reset to nothing. Audit A9-40 then read it as an uncovered MQTT action —
 *     a false row in an audit list, caused by a key missing from this registry.
 *   - `requires_files` — six files, and `certs/` is gitignored in full (0 tracked), so on a
 *     clean clone all six skip. Five were visible under a second key by luck.
 *     `tls-floor/s5-rejects-revoked-cert.yaml` declares only this one and was invisible
 *     outright: 163 days of corpus history in which nothing could have said how long it had
 *     been dark.
 *
 * The report went 14 rows -> 20 -> 26 as the two were added. None of those twelve was new;
 * they had all been skipped the whole time.
 *
 * `multiunit-jam-drive.yaml:41` had even written the requirement down — "an entry in
 * `SKIP_KEYS` (skipAge.ts:100), or the skip becomes invisible to the age report" — as step 4
 * of a change nobody made. A rule stated in a comment on one file is not a rule.
 *
 * NOT IN SCOPE, and deliberately: `findMissingTargetCert(target)` also skips, and it is the
 * one exclusion no scenario key can express — the runner's own comment says these paths "are
 * not declarable per scenario". It is a property of the TARGET, so a per-file age has nothing
 * to measure. Named here so its absence is a decision rather than the next gap.
 */

const RUNNER = path.resolve(__dirname, '../../scenarios/ScenarioRunner.ts');
const SKIP_AGE = path.resolve(__dirname, '../../scenarios/skipAge.ts');

/** The declaration keys `runScenario` reads on the way to a `skippedResult`. */
function exclusionKeysInRunner(): string[] {
  const src = fs.readFileSync(RUNNER, 'utf-8');
  const start = src.indexOf('async runScenario(');
  expect(start, 'runScenario is gone or renamed — this gate reads it by name').toBeGreaterThan(-1);
  // Bound the scan at the target-level check, which is explicitly outside the registry.
  const end = src.indexOf('findMissingTargetCert(target)', start);
  expect(end, 'the findMissingTargetCert boundary is gone').toBeGreaterThan(start);
  const region = src.slice(start, end);

  // Companions carry prose or a kind for a key already counted; they are not exclusions
  // of their own, and requiring them here would demand rows for things that skip nothing.
  const COMPANIONS = new Set(['skip_reason', 'skip_kind', 'requires_files_hint', 'name']);
  return [...new Set([...region.matchAll(/scenario\.(\w+)/g)].map((m) => m[1]))]
    .filter((k) => !COMPANIONS.has(k))
    .sort();
}

/** The keys the age report actually looks for. */
function registeredKeys(): string[] {
  const src = fs.readFileSync(SKIP_AGE, 'utf-8');
  const m = /const SKIP_KEYS = \[([^\]]+)\]/.exec(src);
  expect(m, 'SKIP_KEYS is gone or reshaped').not.toBeNull();
  const declared = [...(m?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]);
  // `skip_reason` is how a bare `skip: true` is spelled in the corpus; the report files both
  // under the key `skip`, and the runner reads `scenario.skip`.
  return [...new Set(declared.map((k) => (k === 'skip_reason' ? 'skip' : k)))].sort();
}

describe('skip-key registry — the report can see every way a file stops running', () => {
  it('every scenario-declared exclusion in the runner is registered with the age report', () => {
    const inRunner = exclusionKeysInRunner();
    const registered = registeredKeys();
    expect(inRunner.length, 'found no exclusions at all — the scan region is wrong').toBeGreaterThan(2);
    const unregistered = inRunner.filter((k) => !registered.includes(k));
    expect(
      unregistered,
      'These keys take a file out of a run and the skip-age report cannot see them. A file ' +
        'excluded by one of them goes dark with no age and no reason, and the summary count ' +
        'goes DOWN — which reads as progress. Add them to SKIP_KEYS in skipAge.ts, and if the ' +
        'key carries a list rather than prose, point the reason at its `_hint` sibling.',
    ).toEqual([]);
  });

  it('the registry claims no key the runner does not act on', () => {
    // The reverse. A registered key nothing enforces produces rows for files that DO run,
    // which spends the report's only asset — that a row in it means something is dark.
    const inRunner = exclusionKeysInRunner();
    const phantom = registeredKeys().filter((k) => !inRunner.includes(k));
    expect(phantom, 'SKIP_KEYS names a key runScenario never reads').toEqual([]);
  });

  it('the report is non-empty and every row carries a reason', () => {
    // A row with an empty reason is the worst case the module set out to prevent, and
    // `requires_files` would have produced six of them: its value is a LIST, and its prose
    // lives in `requires_files_hint`.
    const dir = path.resolve(__dirname, '../../../scenarios');
    const cwd = path.resolve(__dirname, '../../..');
    const rows = collectSkipAges(dir, cwd);
    expect(rows.length).toBeGreaterThan(20);
    const reasonless = rows.filter((r) => r.reason.trim() === '').map((r) => `${r.file} (${r.key})`);
    expect(reasonless, 'skip rows with no reason at all').toEqual([]);
  });
});
