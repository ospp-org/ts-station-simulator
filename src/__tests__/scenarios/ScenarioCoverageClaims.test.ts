import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { OsppAction } from '@ospp/protocol';

/**
 * SCENARIOS.md MAKES FOUR CLAIMS ABOUT SETS. THIS READS THE SETS.
 *
 * Audit A9-40 is one document's claims outliving the corpus they describe, and every one of
 * them rotted the same way: a number written once, from a measurement, and never re-derived.
 *
 *   - "Total scenarios: 113 across 10 categories"  — 148 across 11 on disk, 35 files adrift.
 *     The header had ALREADY been corrected once (116 -> 113) with a note explaining that a
 *     count is a claim with an expiry date. The note survived; the number rotted again.
 *   - "All 26 MQTT actions are covered"            — `OsppAction` has 27 members, and the
 *     table under that sentence had 27 rows. Nobody counted either.
 *   - "UpdateServiceCatalog has a single `requires_pool` scenario" — five files name it.
 *   - "the AuthorizeOfflinePass refusal branch is `skip: true`" — a second, unskipped file
 *     covers three refusals on that action.
 *
 * The last two are the interesting ones: both closed by being OUTGROWN rather than fixed.
 * Nobody was ever going to walk back to this document after writing a file that happened to
 * cover an action, which is exactly why the claim has to be derived instead of stated.
 *
 * WHAT IS PINNED HERE, and deliberately not more: the action column against the SDK enum,
 * the coverage against the corpus, and the two counts in the header. The per-category tables
 * further down SCENARIOS.md are stale by design and say so; pinning them would force the
 * sweep this document has twice deferred, and forcing it from a test is how a note gets
 * satisfied by deleting the note.
 */

const SCENARIOS_DIR = path.resolve(__dirname, '../../../scenarios');
const DOC = path.join(SCENARIOS_DIR, 'SCENARIOS.md');

function scenarioFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.yaml')) out.push(full);
    }
  };
  walk(SCENARIOS_DIR);
  return out;
}

const doc = fs.readFileSync(DOC, 'utf-8');
const files = scenarioFiles();
const categories = fs
  .readdirSync(SCENARIOS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

/** The Action column of the "Spec Coverage" table. */
function tableActions(): string[] {
  const start = doc.indexOf('MQTT actions are covered');
  const end = doc.indexOf('### Uncovered Spec Areas');
  expect(start, 'the Spec Coverage sentence is gone from SCENARIOS.md').toBeGreaterThan(-1);
  expect(end, 'the Uncovered Spec Areas heading is gone from SCENARIOS.md').toBeGreaterThan(start);
  return doc
    .slice(start, end)
    .split('\n')
    .filter((l) => /^\| [A-Z]/.test(l))
    .map((l) => l.split('|')[1].trim())
    .filter((a) => a !== 'Action');
}

/** Every `message:` an api_call-free `send` / `wait_for` step names, across the corpus. */
function actionsNamedByCorpus(): Set<string> {
  const seen = new Set<string>();
  for (const f of files) {
    let doc2: { steps?: unknown } | null;
    try {
      doc2 = parseYaml(fs.readFileSync(f, 'utf-8')) as { steps?: unknown } | null;
    } catch {
      continue;
    }
    for (const step of (doc2?.steps ?? []) as Array<Record<string, unknown>>) {
      if (typeof step.message === 'string') seen.add(step.message);
    }
  }
  return seen;
}

const enumActions = Object.values(OsppAction) as string[];

describe('SCENARIOS.md — the claims about sets are derived, not stated', () => {
  it('the corpus walk found files (guards every count below going vacuous)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(categories.length).toBeGreaterThan(5);
  });

  it('the header count matches the corpus on disk', () => {
    const m = /\*\*Total scenarios: (\d+)\*\* across (\d+) categories/.exec(doc);
    expect(m, 'the "Total scenarios" line is gone or reworded').not.toBeNull();
    const claimed = { files: Number(m?.[1]), categories: Number(m?.[2]) };
    expect(
      claimed,
      'SCENARIOS.md states a total that is no longer on disk. This is the third time — ' +
        '116 -> 113 -> now. Re-derive it, do not adjust it by the diff.',
    ).toEqual({ files: files.length, categories: categories.length });
  });

  it('the "All N MQTT actions" sentence matches OsppAction', () => {
    const m = /All \*\*(\d+)\*\* MQTT actions are covered/.exec(doc);
    expect(m, 'the Spec Coverage sentence is gone or reworded').not.toBeNull();
    expect(
      Number(m?.[1]),
      `SCENARIOS.md claims ${m?.[1]} MQTT actions; OsppAction carries ${enumActions.length}. ` +
        'The denominator is the enum in the pinned SDK — when the pin moves, this is one of ' +
        'the things it moves.',
    ).toBe(enumActions.length);
  });

  it('the Spec Coverage table lists every OsppAction member exactly once, and nothing else', () => {
    const listed = tableActions();
    const missing = enumActions.filter((a) => !listed.includes(a));
    const extra = listed.filter((a) => !enumActions.includes(a));
    const duplicated = listed.filter((a, i) => listed.indexOf(a) !== i);
    expect({ missing, extra, duplicated }).toEqual({ missing: [], extra: [], duplicated: [] });
  });

  it('every action the table claims coverage for is actually named by a scenario', () => {
    // The claim is "covered by at least one scenario", so this is the claim itself rather
    // than a proxy for it. It says nothing about the scenario being runnable — that is the
    // skip-age report's subject, and conflating the two is what let A9-40's two examples
    // read as gaps long after they had stopped being any.
    const named = actionsNamedByCorpus();
    const uncovered = enumActions.filter((a) => !named.has(a));
    expect(
      uncovered,
      'These actions appear in the Spec Coverage table but no scenario sends or waits for ' +
        'them. Either write one or take the row out — a table that claims coverage it does ' +
        'not have is worse than a shorter table.',
    ).toEqual([]);
  });

  it('no scenario names a message the SDK enum does not know', () => {
    // The reverse direction, and the one a pin bump breaks first: a scenario written against
    // a message the pinned SDK has since renamed goes red at the broker, not here, and reads
    // as a server fault.
    const unknown = [...actionsNamedByCorpus()].filter((a) => !enumActions.includes(a));
    expect(unknown, 'scenario `message:` values absent from OsppAction').toEqual([]);
  });
});
