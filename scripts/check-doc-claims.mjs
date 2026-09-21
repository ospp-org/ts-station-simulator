#!/usr/bin/env node
/**
 * Gate: every number `README.md` states about this simulator, against the artefact.
 *
 * This repository is the only firmware stand-in an integrator has before hardware, and
 * `README.md` is the first thing he reads. Measured 2026-09-06, it was wrong in three
 * places at once:
 *
 *   | claim                                      | said       | was          |
 *   |--------------------------------------------|------------|--------------|
 *   | scenarios                                  | 83         | 148          |
 *   | scenario categories                        | 7          | 11           |
 *   | linter checks                              | 5          | 7            |
 *   | wire protocolVersion                       | 0.2.1      | 0.3.0        |
 *   | MQTT actions covered                       | 26         | 27           |
 *
 * The `0.2.1` is the one that costs a day. It is exactly the value this server refuses
 * with `1007 PROTOCOL_VERSION_MISMATCH`, and a `Rejected` station accepts no commands —
 * so a firmware author who trusts that line builds toward the one value that cannot
 * boot, and has no remote path back. The repository had already repaired the emitter
 * (`src/mqtt/protocolVersion.ts` returns the SDK constant) and left the README saying
 * the old number, which is the whole shape of the defect: the code was fixed and the
 * document that teaches the code was not opened.
 *
 * Every expectation below is DERIVED. Rewriting `83` to `148` produces a file that is
 * right today and rots on the same schedule; what changes here is that the numbers are
 * compared on every run.
 *
 * ── THE PER-SUITE TABLE ────────────────────────────────────────────────────────────────
 *
 * The five sentence claims above passed while the table under them was wrong in SIX of its
 * seven rows, because a correct TOTAL says nothing about how it is split. Measured
 * 2026-09-21: `core` said 16 against 25, `sessions` 13 against 29, `device-management` 20
 * against 40, `security` 18 against 26, `reservations` 6 against 8, `chaos` 7 against 8 —
 * only `fleet` agreed. The rows summed to 83 while the sentence above them correctly said
 * 158, and FIVE categories (`e2e`, `multiunit-e2e`, `probes`, `provisioning`, `tls-floor`,
 * 19 files) had no row at all. A reader counting suites got a different answer from a
 * reader reading the sentence, and nothing was red.
 *
 * So the table is now compared ROW BY ROW: the suite names must be exactly the directories
 * under `scenarios/`, and each count must be that directory's. The alternative was to
 * GENERATE the table, which was rejected — a generated table still needs a gate to prove it
 * was regenerated before the commit, so gating is the smaller change and there is one
 * mechanism instead of two.
 *
 * WHAT IT STILL CANNOT SEE: the Coverage column. It is prose, it derives from nothing, and
 * a row can describe the wrong things while its name and count are right. That is stated in
 * README.md beside the table rather than left for a reader to discover.
 *
 * Exit 1 = a claim disagrees. Exit 2 = a derivation produced nothing believable, which
 * is not a pass.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);

// ── derivations ────────────────────────────────────────────────────────────
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const scenarioRoot = join(ROOT, 'scenarios');
const scenarioFiles = walk(scenarioRoot).filter((f) => f.endsWith('.yaml'));
const categories = readdirSync(scenarioRoot).filter((n) => statSync(join(scenarioRoot, n)).isDirectory());
const checkFiles = readdirSync(join(ROOT, 'src', 'linter', 'checks')).filter((f) => f.endsWith('Check.ts'));

/** Every category and what is actually in it — `Map<name, count>`, in the table's order. */
const perCategory = new Map(
  [...categories].sort().map((name) => [name, walk(join(scenarioRoot, name)).filter((f) => f.endsWith('.yaml')).length]),
);

const sdk = require_('@ospp/protocol');
const wireVersion = sdk.OSPP_PROTOCOL_VERSION;
const actions = Object.values(sdk.OsppAction ?? {}).filter((v) => typeof v === 'string');

const broken = [];
if (scenarioFiles.length < 50) broken.push(`derived ${scenarioFiles.length} scenarios — the walk found almost nothing`);
if (categories.length < 3) broken.push(`derived ${categories.length} categories`);
if (checkFiles.length < 3) broken.push(`derived ${checkFiles.length} linter checks`);
if (!/^\d+\.\d+\.\d+$/.test(wireVersion ?? '')) broken.push(`the SDK's OSPP_PROTOCOL_VERSION is ${wireVersion}`);
if (actions.length < 10) broken.push(`derived ${actions.length} OsppAction members`);
// The rows must account for every scenario — a per-category walk that lost files would
// otherwise produce a set of small, self-consistent, wrong numbers.
const perCategoryTotal = [...perCategory.values()].reduce((a, b) => a + b, 0);
if (perCategoryTotal !== scenarioFiles.length) {
  broken.push(`the per-category walk found ${perCategoryTotal} scenarios, the flat walk ${scenarioFiles.length}`);
}

if (broken.length > 0) {
  console.error('INSTRUMENT BROKEN — a derivation produced nothing believable:');
  for (const b of broken) console.error(`  ! ${b}`);
  process.exit(2);
}

// ── the claims ─────────────────────────────────────────────────────────────
const CLAIMS = [
  ['scenarios', /(\d+) YAML-driven test scenarios/, String(scenarioFiles.length), 'scenarios/**/*.yaml'],
  ['categories', /YAML-driven test scenarios across (\d+) categories/, String(categories.length), 'directories under scenarios/'],
  ['linter checks', /\*\*Linter\*\* — (\d+) checks/, String(checkFiles.length), 'src/linter/checks/*Check.ts'],
  ['wire version', /\*\*wire version ([0-9.]+)\*\*/, wireVersion, "@ospp/protocol's OSPP_PROTOCOL_VERSION"],
  ['actions', /All (\d+) MQTT actions covered/, String(actions.length), "@ospp/protocol's OsppAction"],
];

// Control before belief: the comparator must catch a wrong value and a missing sentence.
const probe = 'it has 7 widgets here';
const hit = probe.match(/(\d+) widgets/);
if (!hit || hit[1] !== '7' || 'nothing here'.match(/(\d+) widgets/) !== null) {
  console.error('ERROR: positive control FAILED — the comparator does not discriminate.');
  process.exit(2);
}

const doc = readFileSync(join(ROOT, 'README.md'), 'utf8');
let tableRowsChecked = 0;
const problems = [];
for (const [label, pattern, expected, from] of CLAIMS) {
  const matches = doc.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g')) ?? [];
  if (matches.length !== 1) {
    problems.push(`${label}: expected exactly one match for ${pattern} — found ${matches.length}. The sentence was reworded or removed, and this gate can no longer see it.`);
    continue;
  }
  const actual = doc.match(pattern)[1];
  if (actual !== expected) {
    problems.push(`${label}: README says "${actual}", derived value is "${expected}" (from ${from})`);
  }
}

// ── the per-suite table, row by row, in EVERY document that carries one ────
//
// README.md was gated first and `scenarios/SCENARIOS.md` carried the SAME table, wrong in
// the same six of seven rows, and additionally inconsistent with ITSELF: measured
// 2026-09-21, `Core` read 16 in the summary table, 20 in the `## Core (N scenarios)`
// heading and 18 rows under that heading — three numbers for one category, and 25 is the
// real one. So the gate is extended here rather than copied: one derivation
// (`perCategory`), one comparator, a list of documents.
//
// THE TWO DOCUMENTS WRITE THE TABLE DIFFERENTLY, which is why this needed more than a
// second filename. README.md writes `| `core` | 25 |` — backticked, lower-case, the
// directory name verbatim. SCENARIOS.md writes `| Core | 25 |` and `| Device Management |
// 40 |` — title-case, unbackticked, space-separated. The original ROW_RE required the
// backticks and `[a-z0-9-]+`, so pointed at SCENARIOS.md it matched ZERO rows and would
// have reported every category missing. Names are therefore normalised — lower-cased,
// spaces to hyphens — and compared against the directory names.
//
// AND SCENARIOS.md IS SECTION-SCOPED, because a looser row pattern collides. That file
// carries four other two-column tables whose second cell is a bare integer (`| Carry a
// server-state assertion | 82 |` at :105, `| Migrated from PHP simulator | 33 |` at :300,
// and two spec-delta rows at :450). Reading the whole file would turn each into "a row for
// a suite that is not a directory". Only the block under `## Summary` is read.
const DOC_TABLES = [
  {
    file: 'README.md',
    section: null,
    // Backticked, lower-case: the shape README.md writes.
    row: /^\|\s*`([a-z0-9-]+)`\s*\|\s*(\d+)\s*\|/gm,
    probe: { line: '| `demo-suite` | 42 | Anything at all |', name: 'demo-suite', count: '42' },
  },
  {
    file: 'scenarios/SCENARIOS.md',
    section: '## Summary',
    // Unbackticked, title-case, possibly spaced: the shape SCENARIOS.md writes.
    row: /^\|\s*([A-Za-z][A-Za-z0-9 -]*?)\s*\|\s*(\d+)\s*\|/gm,
    probe: { line: '| Demo Suite | 42 | Anything at all |', name: 'demo-suite', count: '42' },
  },
];

/** `Device Management` and `device-management` are the same suite. Directory spelling wins. */
const normalizeSuite = (name) => name.trim().toLowerCase().replace(/\s+/g, '-');

/** The lines from `heading` up to the next `## `, or the whole text when no section is asked for. */
function sectionOf(text, heading) {
  if (heading === null) return text;
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

for (const doc of DOC_TABLES) {
  const text = readFileSync(join(ROOT, doc.file), 'utf8');

  // Control before belief, per document: the row pattern must read a row and refuse a
  // header. Without this an empty `rows` map reports every category as missing and the
  // failure is blamed on the document rather than on this regex.
  const probeHit = [...doc.probe.line.matchAll(doc.row)];
  if (probeHit.length !== 1 ||
      normalizeSuite(probeHit[0][1]) !== doc.probe.name ||
      probeHit[0][2] !== doc.probe.count ||
      [...'| Suite | Scenarios | Coverage |'.matchAll(doc.row)].length !== 0) {
    console.error(`ERROR: positive control FAILED — the row pattern for ${doc.file} does not discriminate.`);
    process.exit(2);
  }

  const scope = sectionOf(text, doc.section);
  if (scope === null) {
    problems.push(`${doc.file}: no "${doc.section}" heading — this gate can no longer find the per-suite table`);
    continue;
  }

  const rows = new Map();
  const duplicated = [];
  for (const m of scope.matchAll(doc.row)) {
    const name = normalizeSuite(m[1]);
    if (rows.has(name)) duplicated.push(name);
    rows.set(name, m[2]);
  }

  for (const d of new Set(duplicated)) {
    problems.push(`${doc.file} per-suite table: two rows name \`${d}\``);
  }
  for (const [name, count] of perCategory) {
    const stated = rows.get(name);
    if (stated === undefined) {
      problems.push(`${doc.file} per-suite table: no row for \`${name}\` — the corpus has ${count} scenario(s) there, and the table accounts for none of them`);
    } else if (stated !== String(count)) {
      problems.push(`${doc.file} per-suite table: \`${name}\` says "${stated}", scenarios/${name} holds ${count}`);
    }
  }
  for (const name of rows.keys()) {
    if (!perCategory.has(name)) {
      problems.push(`${doc.file} per-suite table: a row for \`${name}\`, which is not a directory under scenarios/`);
    }
  }
  tableRowsChecked += perCategory.size;
}

// ── SCENARIOS.md's SECTION HEADINGS, which are a third statement of the same number ───────
//
// `## Core (20 scenarios)` is a count like any other, and it disagreed with both the summary
// table above it and the rows below it. Gating the table alone would have left two of the
// three numbers unwatched, so the headings are read from the same derivation.
//
// NOT gated: the per-section file tables under each heading. Those list individual scenario
// files, and SCENARIOS.md already records, in its own comment under `## Core`, that they
// drift from the directory (a row with no file, files with no row). Comparing listed
// filenames against the tree is a different instrument and a different job; it is named here
// rather than half-built.
const HEADING_RE = /^## ([A-Z][A-Za-z ]*?) \((\d+) scenarios?\)\s*$/gm;
const scenariosDoc = readFileSync(join(ROOT, 'scenarios', 'SCENARIOS.md'), 'utf8');

const headingProbe = [...'## Demo Suite (42 scenarios)'.matchAll(HEADING_RE)];
if (headingProbe.length !== 1 || normalizeSuite(headingProbe[0][1]) !== 'demo-suite' || headingProbe[0][2] !== '42' ||
    [...'## Summary'.matchAll(HEADING_RE)].length !== 0) {
  console.error('ERROR: positive control FAILED — the heading pattern does not discriminate.');
  process.exit(2);
}

let headingsChecked = 0;
for (const m of scenariosDoc.matchAll(HEADING_RE)) {
  const name = normalizeSuite(m[1]);
  headingsChecked++;
  const actual = perCategory.get(name);
  if (actual === undefined) {
    problems.push(`scenarios/SCENARIOS.md heading: "## ${m[1]} (${m[2]} scenarios)" names no directory under scenarios/`);
  } else if (m[2] !== String(actual)) {
    problems.push(`scenarios/SCENARIOS.md heading: "## ${m[1]}" says ${m[2]} scenarios, scenarios/${name} holds ${actual}`);
  }
}
if (headingsChecked === 0) {
  console.error('ERROR: positive control FAILED — no "## <Suite> (N scenarios)" heading was found in scenarios/SCENARIOS.md.');
  process.exit(2);
}

console.log(`checked ${CLAIMS.length} claims, ${tableRowsChecked} table rows across ${DOC_TABLES.length} document(s), and ${headingsChecked} section heading(s)`);
for (const [label, , expected, from] of CLAIMS) console.log(`  ${label.padEnd(16)} derived = ${expected.padEnd(6)} ${from}`);

console.log(`  ${'per-suite rows'.padEnd(16)} derived = ${String(perCategory.size).padEnd(6)} ${[...perCategory].map(([k, v]) => `${k}:${v}`).join(' ')}`);

if (problems.length > 0) {
  console.error(`\nFALSE CLAIMS — ${problems.length} of ${CLAIMS.length + tableRowsChecked + headingsChecked} checked:\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log('OK — every number README.md states, every per-suite row in README.md and scenarios/SCENARIOS.md, and every SCENARIOS.md section heading, agrees with what this repo contains');
