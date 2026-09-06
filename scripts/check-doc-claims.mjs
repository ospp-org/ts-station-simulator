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

const sdk = require_('@ospp/protocol');
const wireVersion = sdk.OSPP_PROTOCOL_VERSION;
const actions = Object.values(sdk.OsppAction ?? {}).filter((v) => typeof v === 'string');

const broken = [];
if (scenarioFiles.length < 50) broken.push(`derived ${scenarioFiles.length} scenarios — the walk found almost nothing`);
if (categories.length < 3) broken.push(`derived ${categories.length} categories`);
if (checkFiles.length < 3) broken.push(`derived ${checkFiles.length} linter checks`);
if (!/^\d+\.\d+\.\d+$/.test(wireVersion ?? '')) broken.push(`the SDK's OSPP_PROTOCOL_VERSION is ${wireVersion}`);
if (actions.length < 10) broken.push(`derived ${actions.length} OsppAction members`);

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

console.log(`checked ${CLAIMS.length} claims in README.md`);
for (const [label, , expected, from] of CLAIMS) console.log(`  ${label.padEnd(16)} derived = ${expected.padEnd(6)} ${from}`);

if (problems.length > 0) {
  console.error(`\nFALSE CLAIMS — ${problems.length} of ${CLAIMS.length}:\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log('OK — every number README.md states agrees with what this repo contains');
