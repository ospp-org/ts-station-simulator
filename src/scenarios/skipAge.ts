import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * How long each skipped scenario has been skipped, and why.
 *
 * WHY THIS EXISTS, and why it only REPORTS. A skip is a claim — "this file cannot run
 * because X" — and it is the only claim in the corpus that nothing ever checks. Every other
 * assertion is evaluated on every run. The cost is not the missing coverage, it is the DRIFT:
 * a file nobody runs keeps compiling and keeps linting while the system moves under it, and
 * when the blocker is finally cleared it fails for reasons that have nothing to do with what
 * it was waiting on. That is not hypothetical here — `multiunit-jam-drive.yaml` declared a
 * one-bay topology against a two-bay pool for the whole time it was skipped, because the
 * server's topology gate was armed AFTER the skip went on.
 *
 * WHY IT DOES NOT FAIL, and this is the whole design decision. A gate that fails past an age
 * threshold is satisfied by REWRITING THE REASON, which costs the reason the only thing that
 * makes it worth reading. This repo has already recorded that failure mode for skip prose. So
 * the cheap half is built and the expensive halves are left as arguments the numbers can now
 * settle: a dated re-attestation ceiling (fails on a stale DATE, which prose cannot fix), and
 * periodically RUNNING the skipped files to check they fail for the reason they declare.
 *
 * `Skipped: 16` in a summary reads as harmless whatever the ages are. A table cannot.
 */
export interface SkipAge {
  file: string;
  key: string;
  reason: string;
  /** ISO date the skip key first appeared, or undefined when git could not say. */
  since?: string;
  ageDays?: number;
}

/**
 * The commit that FIRST introduced this skip key in this file, via `git log -S … --reverse`.
 *
 * `-S` counts occurrences rather than matching a diff line, so it finds the commit where the
 * key appeared regardless of how the surrounding prose has been rewritten since — which is
 * the point: a reason edited ten times still dates from when the file stopped running.
 *
 * Returns undefined rather than throwing on any git failure. This is a reporting aid; a
 * corpus exported from a tarball, a shallow clone, or a machine without git must still be
 * able to run scenarios.
 */
export function skipIntroducedAt(file: string, key: string, cwd = process.cwd()): string | undefined {
  try {
    const res = spawnSync(
      'git',
      ['log', '-S', `${key}:`, '--format=%cI', '--reverse', '--', path.relative(cwd, file)],
      { cwd, encoding: 'utf-8', timeout: 5000 },
    );
    if (res.status !== 0 || typeof res.stdout !== 'string') return undefined;
    const first = res.stdout.split('\n').find((l) => l.trim() !== '');
    return first?.slice(0, 10);
  } catch {
    return undefined;
  }
}

/** Whole days between an ISO date and now, floored. Undefined in, undefined out. */
export function ageInDays(since: string | undefined, nowMs: number = Date.now()): number | undefined {
  if (since === undefined) return undefined;
  const then = Date.parse(`${since}T00:00:00Z`);
  if (Number.isNaN(then)) return undefined;
  return Math.floor((nowMs - then) / 86_400_000);
}

/**
 * Render the table, OLDEST FIRST — the ordering is the report. A list in corpus order buries
 * a 155-day skip between two that landed last week.
 *
 * Returns an empty array (no lines at all) when nothing is skipped, so a clean corpus prints
 * nothing rather than an empty heading.
 */
export function formatSkipAgeReport(entries: ReadonlyArray<SkipAge>, maxReason = 96): string[] {
  if (entries.length === 0) return [];

  const sorted = [...entries].sort((a, b) => {
    // Unknown ages sort LAST, not first: an undated skip is a gap in the instrument, and
    // putting it at the top would push the oldest real one off the eye-line.
    if (a.ageDays === undefined && b.ageDays === undefined) return a.file.localeCompare(b.file);
    if (a.ageDays === undefined) return 1;
    if (b.ageDays === undefined) return -1;
    return b.ageDays - a.ageDays;
  });

  const width = Math.max(...sorted.map((e) => e.file.length));
  const lines = [
    `Skipped scenarios — age and reason, oldest first (${sorted.length}):`,
  ];
  for (const e of sorted) {
    const age = e.ageDays === undefined ? '   ?' : `${String(e.ageDays).padStart(4)}d`;
    const reason = e.reason.length > maxReason ? `${e.reason.slice(0, maxReason - 1)}…` : e.reason;
    lines.push(`  ${age}  ${e.file.padEnd(width)}  ${e.key}  ${reason}`);
  }
  return lines;
}

/**
 * The declaration keys that take a file out of a run, and the value that is each one's reason.
 *
 * `requires_pool` JOINED ON 2026-09-05, and its absence was the exact failure this module was
 * built to prevent. It is the INVERSE skip — it removes a file from every unattended run that
 * is not pooled — and `service-catalog-update.yaml` adopted it as a straight REPLACEMENT for
 * `skip: true` + `skip_kind: inconclusive`. The file went on not running, its age reset to
 * nothing, and it left this report entirely. Six files are in that state.
 * `multiunit-jam-drive.yaml:41` had even written the requirement down — "an entry in
 * `SKIP_KEYS` (skipAge.ts:100), or the skip becomes invisible to the age report" — as step 4
 * of a change nobody made. Audit A9-40 then read one of those six as an uncovered action.
 *
 * ONE ROW PER DECLARED KEY, not per file. The loop used to stop at the first match, so a file
 * declaring two restrictions reported one and hid the other — the same invisibility one level
 * down. No file declares two today (measured: 0 of 148); this makes that a fact the report
 * would show rather than one it depends on.
 */
const SKIP_KEYS = ['skip_reason', 'skip_when_pooled', 'requires_pool'] as const;

/**
 * Walk the corpus and collect every file that declares a skip, with its reason and age.
 *
 * READS THE CORPUS, NOT THE RUN. Deliberate: the question this answers is "what in the corpus
 * has stopped being exercised, and for how long", which does not depend on which subset a
 * particular invocation selected. A `--scenario one-file.yaml` run should still print the
 * whole picture, because the picture is the point.
 *
 * The reason is taken from `skip_reason:`, `skip_when_pooled:` or `requires_pool:` — the three
 * keys that carry prose. A bare `skip: true` with no `skip_reason` is reported with an empty
 * reason rather than omitted, because a skip that does not say why is the worst case, not an
 * absent one.
 */
export function collectSkipAges(dir: string, cwd = process.cwd()): SkipAge[] {
  const out: SkipAge[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!e.name.endsWith('.yaml') && !e.name.endsWith('.yml')) continue;

      let text: string;
      try {
        text = fs.readFileSync(full, 'utf-8');
      } catch {
        continue;
      }

      // Top-level keys only — anchored to column 0 so a `skip_reason:` nested inside a step
      // or quoted in a comment block cannot be mistaken for a declaration.
      const unconditional = /^skip:\s*true\s*$/m.test(text);
      const declared: Array<{ key: string; reason: string }> = [];
      for (const k of SKIP_KEYS) {
        const m = new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(text);
        if (m) declared.push({ key: k === 'skip_reason' ? 'skip' : k, reason: readScalar(text, m) });
      }
      if (declared.length === 0 && unconditional) declared.push({ key: 'skip', reason: '' });
      if (declared.length === 0) continue;

      for (const { key, reason } of declared) {
        const since = skipIntroducedAt(full, key, cwd);
        out.push({
          file: path.relative(dir, full),
          key,
          reason,
          since,
          ageDays: ageInDays(since),
        });
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * The value of a top-level key, whether it is inline or a YAML BLOCK SCALAR.
 *
 * Not cosmetic. Two of the corpus's oldest skips write their reason as `skip_reason: >-`
 * followed by indented prose, and reading only the first line reported them as `>-` — the
 * two files that most needed their reason read were the two whose reason was invisible.
 * Anything more than this (anchors, flow mappings) is out of scope: a reason is prose, and a
 * reason that needs a YAML parser to read is already the wrong shape.
 */
function readScalar(text: string, m: RegExpExecArray): string {
  const inline = m[1].trim();
  if (!/^[|>][-+]?\d*$/.test(inline)) {
    return inline.replace(/^["']|["']$/g, '');
  }
  const rest = text.slice(m.index + m[0].length).split('\n').slice(1);
  const body: string[] = [];
  for (const line of rest) {
    if (line.trim() === '') { body.push(''); continue; }
    if (!/^\s/.test(line)) break;   // dedent to column 0 ends the block
    body.push(line.trim());
  }
  return body.join(' ').trim();
}
