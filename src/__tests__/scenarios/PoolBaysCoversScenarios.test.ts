import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_POOL_BAYS } from '../../scenarios/bootstrap/PoolBootstrap.js';

/**
 * THE GATE THAT COMPARES THE TWO NUMBERS.
 *
 * `--pool-bays` decides how many bays `--bootstrap-pool` provisions server-side.
 * `{{bayId_N}}` is what scenarios actually reach for. These are the two halves that
 * silently diverged — 4 provisioned, 2 used — and the divergence was discovered by a
 * suite of 109 identical failures on UAT. Nothing compared them anywhere.
 *
 * This does. It recomputes the maximum bay ordinal from the corpus on every run and
 * pins the default to it, in BOTH directions:
 *
 *   - default too LOW  -> a scenario reaches for a bay the pool never provisioned.
 *   - default too HIGH -> the pool provisions bays no scenario asserts on, and
 *     assertions like maintenance-mode-all-bays.yaml read as complete while covering
 *     a subset. That is the state that shipped.
 *
 * Deliberately computed over EVERY scenario file, including `skip_when_pooled` ones.
 * Narrowing to pool-eligible files would be more precise and would also let a new
 * `{{bayId_3}}` land silently in an excluded file and become live the day its skip is
 * lifted. Over-firing costs one conversation; under-firing cost a 109-failure run.
 *
 * `{{captured.bayId_N}}` is a DIFFERENT namespace — fed by a scenario's own
 * `action: provision` step, never by the pool — and is excluded. Reading the pool
 * default off `{{captured.bayId_4}}` is precisely how it came to be 4.
 */

const SCENARIOS_DIR = fileURLToPath(new URL('../../../scenarios', import.meta.url));

/** `{{bayId_N}}` only. Whitespace tolerated; `captured.` deliberately not matched. */
const BARE_BAY_ID = /\{\{\s*bayId_(\d+)\s*\}\}/g;

function yamlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...yamlFiles(full));
    } else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
      out.push(full);
    }
  }

  return out;
}

interface Scan {
  files: number;
  references: number;
  maxOrdinal: number;
  offenders: Array<{ file: string; ordinal: number }>;
}

function scanCorpus(): Scan {
  const files = yamlFiles(SCENARIOS_DIR);
  let references = 0;
  let maxOrdinal = 0;
  const offenders: Array<{ file: string; ordinal: number }> = [];

  for (const file of files) {
    const text = readFileSync(file, 'utf-8');
    for (const m of text.matchAll(BARE_BAY_ID)) {
      references++;
      const ordinal = Number.parseInt(m[1], 10);
      maxOrdinal = Math.max(maxOrdinal, ordinal);
      if (ordinal > DEFAULT_POOL_BAYS) {
        offenders.push({ file: file.slice(SCENARIOS_DIR.length + 1), ordinal });
      }
    }
  }

  return { files: files.length, references, maxOrdinal, offenders };
}

describe('--pool-bays covers exactly the bay ordinals the scenario corpus uses', () => {
  // ---- DENOMINATOR ----------------------------------------------------------
  // A gate that reads zero files passes every assertion below it. These two make a
  // broken glob or a moved directory fail loudly instead of green.
  it('actually reads the scenario corpus', () => {
    const scan = scanCorpus();
    expect(scan.files).toBeGreaterThan(100);
    expect(scan.references).toBeGreaterThan(100);
  });

  // ---- MATCHER CONTROL ------------------------------------------------------
  // The whole gate rests on this regex telling two namespaces apart. Pinned with a
  // conformant sample AND a refusal, so a widened-or-broken matcher is caught here
  // rather than by the number it produces.
  it('matches the pool namespace and refuses the self-provision namespace', () => {
    const bare = (s: string) => [...s.matchAll(new RegExp(BARE_BAY_ID.source, 'g'))].map(m => m[1]);

    expect(bare('{{bayId_7}}')).toEqual(['7']);
    expect(bare('{{ bayId_7 }}')).toEqual(['7']); // whitespace tolerated
    expect(bare('bay_id: "{{bayId_2}}"')).toEqual(['2']); // as it appears in YAML
    expect(bare('{{captured.bayId_7}}')).toEqual([]); // the OTHER namespace
    expect(bare('{{bayNumber_7}}')).toEqual([]);
    expect(bare('{{serviceId_7}}')).toEqual([]);
  });

  // ---- THE ASSERTION --------------------------------------------------------
  it('provisions exactly the highest bay ordinal any scenario references', () => {
    const scan = scanCorpus();

    expect(
      scan.offenders,
      `scenarios reference a bay above --pool-bays (${DEFAULT_POOL_BAYS}); the pool would not ` +
        `provision it, and the station would boot declaring a topology the server did not record:\n` +
        scan.offenders.map(o => `  ${o.file} -> {{bayId_${o.ordinal}}}`).join('\n'),
    ).toEqual([]);

    expect(
      scan.maxOrdinal,
      `DEFAULT_POOL_BAYS is ${DEFAULT_POOL_BAYS} but the corpus tops out at {{bayId_${scan.maxOrdinal}}}. ` +
        'Provisioning more bays than any scenario asserts on makes those assertions partial ' +
        'while they read as complete. Move DEFAULT_POOL_BAYS to match, or say why it should not.',
    ).toBe(DEFAULT_POOL_BAYS);
  });
});
