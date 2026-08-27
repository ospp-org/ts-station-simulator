import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ageInDays, formatSkipAgeReport, collectSkipAges } from '../../scenarios/skipAge.js';
import type { SkipAge } from '../../scenarios/skipAge.js';

/**
 * The age report exists because `Skipped: 16` reads as harmless whatever the ages are, and in
 * this corpus the oldest two are 155 days. It REPORTS and does not fail, deliberately: a gate
 * that fails past an age threshold is satisfied by rewriting the reason, which costs the
 * reason the only thing that makes it worth reading.
 */
describe('skip age report', () => {
  const e = (file: string, ageDays?: number, reason = 'r', key = 'skip'): SkipAge =>
    ({ file, key, reason, ageDays, since: '2026-01-01' });

  it('orders OLDEST FIRST — the ordering is the report', () => {
    const lines = formatSkipAgeReport([e('young.yaml', 3), e('ancient.yaml', 155), e('mid.yaml', 40)]);
    expect(lines[1]).toContain('ancient.yaml');
    expect(lines[2]).toContain('mid.yaml');
    expect(lines[3]).toContain('young.yaml');
  });

  // An undated skip is a gap in the INSTRUMENT. Sorting it first would push the oldest real
  // one off the eye-line, which is the one thing the report exists to prevent.
  it('sorts undated skips LAST, not first', () => {
    const lines = formatSkipAgeReport([e('undated.yaml', undefined), e('old.yaml', 100)]);
    expect(lines[1]).toContain('old.yaml');
    expect(lines[2]).toContain('undated.yaml');
    expect(lines[2]).toContain('?');
  });

  it('prints nothing at all when nothing is skipped', () => {
    expect(formatSkipAgeReport([])).toEqual([]);
  });

  it('truncates a long reason rather than wrapping the table', () => {
    const lines = formatSkipAgeReport([e('x.yaml', 1, 'y'.repeat(400))], 40);
    expect(lines[1]).toContain('…');
    expect(lines[1].length).toBeLessThan(140);
  });

  it('ageInDays is undefined-in, undefined-out, and rejects an unparseable date', () => {
    expect(ageInDays(undefined)).toBeUndefined();
    expect(ageInDays('not-a-date')).toBeUndefined();
    expect(ageInDays('2026-01-01', Date.parse('2026-01-11T00:00:00Z'))).toBe(10);
  });

  describe('collectSkipAges', () => {
    const withCorpus = (files: Record<string, string>, fn: (dir: string) => void) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skipage-'));
      try {
        for (const [name, body] of Object.entries(files)) {
          fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
          fs.writeFileSync(path.join(dir, name), body);
        }
        fn(dir);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };

    it('finds both skip forms and carries their reason', () => {
      withCorpus({
        'a.yaml': 'name: a\nskip: true\nskip_reason: "because A"\nsteps: []\n',
        'b/c.yaml': 'name: c\nskip_when_pooled: "because C"\nsteps: []\n',
        'clean.yaml': 'name: clean\nsteps: []\n',
      }, (dir) => {
        const got = collectSkipAges(dir, dir);
        expect(got.map((g) => g.file).sort()).toEqual(['a.yaml', path.join('b', 'c.yaml')]);
        expect(got.find((g) => g.file === 'a.yaml')?.reason).toBe('because A');
        expect(got.find((g) => g.file.endsWith('c.yaml'))?.key).toBe('skip_when_pooled');
      });
    });

    /**
     * The two oldest skips in the real corpus write their reason as a YAML block scalar.
     * Reading only the first line reported them as `>-` — the two files that most needed
     * their reason read were the two whose reason was invisible.
     */
    it('reads a BLOCK SCALAR reason, not just its first line', () => {
      withCorpus({
        'a.yaml': 'name: a\nskip: true\nskip_reason: >-\n  first part\n  second part\nsteps: []\n',
      }, (dir) => {
        expect(collectSkipAges(dir, dir)[0].reason).toBe('first part second part');
      });
    });

    it('reports a skip that gives NO reason, rather than omitting it', () => {
      withCorpus({ 'a.yaml': 'name: a\nskip: true\nsteps: []\n' }, (dir) => {
        const got = collectSkipAges(dir, dir);
        expect(got).toHaveLength(1);
        expect(got[0].reason).toBe('');
      });
    });

    // Anchored to column 0: a key quoted inside a comment or nested in a step is prose,
    // not a declaration, and counting it would inflate the number the report exists to show.
    it('ignores a skip key that is not a top-level declaration', () => {
      withCorpus({
        'a.yaml': 'name: a\nsteps:\n  - action: send\n    note: "skip: true is not a declaration here"\n',
      }, (dir) => {
        expect(collectSkipAges(dir, dir)).toEqual([]);
      });
    });
  });
});
