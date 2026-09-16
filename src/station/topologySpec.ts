/**
 * The topology a station DECLARES, and the topology it REPORTS, as a value an
 * operator can type.
 *
 * WHY THIS EXISTS. Both halves used to come from one hardcoded literal.
 * `deriveBays()` built every bay with `programs: [{ programNumber: 1 }]`, and
 * `provision` called it with no overrides, so:
 *
 *   - what the station DECLARED at provisioning (which the server stores as
 *     `bay_programs`, CertificateManager.php:447-458), and
 *   - what the station REPORTS in a StatusNotification (BootNotificationHandler's
 *     post-boot report, built from the same `bay.programs`)
 *
 * were the SAME array. The server compares them —
 * `StatusNotificationHandler.php:657-658`:
 *
 *     $undeclared = array_values(array_diff($reported, $declared));
 *     $omitted    = array_values(array_diff($declared, $reported));
 *
 * — so with one source for both sides, `array_diff` was empty in both directions
 * and NEITHER arm could ever fire from this simulator. Two server branches, and a
 * `program_set_mismatch` journal entry behind them, were unreachable by
 * construction. Making the two sides independently declarable is what reaches
 * them.
 *
 * Note the arm names, because they are easy to invert: `undeclared` is a program
 * the STATION reported that the server has no record of; `omitted` is one the
 * SERVER has on record that the station left out.
 *
 * THE SYNTAX. `<bayNumber>:<programNumber>[,<programNumber>...][;<bay>...]`
 *
 *     1:1              one bay, one program — the historical default for N=1
 *     1:1,2;2:1        bay 1 runs programs {1,2}; bay 2 runs {1}
 *     1:1;3:1          bays {1,3} — bay 2 was never fitted
 *     1:7,9            a bay whose programs are {7,9}; neither set need be dense
 *
 * LABELS ARE NOT IN THE SYNTAX, and that is deliberate rather than a shortcut.
 * `label` is printable ASCII (`^[\x20-\x7E]+$`), which includes `,`, `;` and `:`
 * — so any inline label syntax is ambiguous against the separators. The schema
 * says labels are DESCRIPTIVE, that they are "NOT compared at boot", and that
 * "drift in this field on a retry MUST be ignored", so a derived `Program <n>`
 * carries everything the protocol reads from it. A scenario that needs a specific
 * label declares `bays:` on its provision step, which takes full objects.
 */

/** One program as the provisioning request carries it. */
export interface ProgramSpec {
  programNumber: number;
  label: string;
}

/** One bay as the provisioning request carries it. */
export interface BaySpec {
  bayNumber: number;
  programs: ProgramSpec[];
}

/** provisioning-request.schema.json: `bays` maxItems 64, `bayNumber` 1..64. */
const BAY_MIN = 1;
const BAY_MAX = 64;
/** provisioning-request.schema.json: `programs` maxItems 32, `programNumber` 1..32. */
const PROGRAM_MIN = 1;
const PROGRAM_MAX = 32;

/**
 * The label a bare `bay_count` has always produced.
 *
 * Kept as a literal so the dense path stays byte-identical to what every existing
 * caller sent: changing a label that nothing compares would still change the
 * bytes on the wire and the `bay_programs.label` column, for no gain.
 */
const DENSE_LABEL = 'Basic Wash';

export function parseTopologySpec(spec: string): BaySpec[] {
  const trimmed = spec.trim();
  if (trimmed.length === 0) {
    throw new Error(
      'topology spec is empty: declare at least one bay, as <bayNumber>:<programNumber>[,...] ' +
        '(for example "1:1;2:1,2"). provisioning-request.schema.json puts minItems 1 on bays.',
    );
  }

  const bays: BaySpec[] = [];
  const seenBayNumbers = new Set<number>();

  for (const chunk of trimmed.split(';')) {
    const bayText = chunk.trim();
    // A trailing `;` is a typing artefact, not a bay. An EMPTY chunk between two
    // separators is the same thing.
    if (bayText.length === 0) continue;

    const colon = bayText.indexOf(':');
    if (colon === -1) {
      throw new Error(
        `topology spec: "${bayText}" has no ":" — each bay is written bayNumber:programNumber[,...]`,
      );
    }

    const bayNumber = parseOrdinal(bayText.slice(0, colon), 'bayNumber', BAY_MIN, BAY_MAX);
    if (seenBayNumbers.has(bayNumber)) {
      throw new Error(
        `topology spec: duplicate bayNumber ${bayNumber}. Each bay is declared once — ` +
          'the schema requires bayNumber unique within the request, because two entries for ' +
          'one bay make the bayId mapping the server answers with ambiguous.',
      );
    }
    seenBayNumbers.add(bayNumber);

    const programsText = bayText.slice(colon + 1).trim();
    if (programsText.length === 0) {
      throw new Error(
        `topology spec: bay ${bayNumber} declares at least one program, none given. ` +
          'A faulted program is declared present-but-unavailable, never omitted — absence ' +
          'means the hardware itself changed and requires re-provisioning.',
      );
    }

    const programs: ProgramSpec[] = [];
    const seenProgramNumbers = new Set<number>();
    for (const programText of programsText.split(',')) {
      const programNumber = parseOrdinal(programText, 'programNumber', PROGRAM_MIN, PROGRAM_MAX);
      if (seenProgramNumbers.has(programNumber)) {
        throw new Error(
          `topology spec: duplicate programNumber ${programNumber} in bay ${bayNumber}. ` +
            'The schema requires it unique within its bay.',
        );
      }
      seenProgramNumbers.add(programNumber);
      programs.push({ programNumber, label: `Program ${programNumber}` });
    }

    programs.sort((a, b) => a.programNumber - b.programNumber);
    bays.push({ bayNumber, programs });
  }

  if (bays.length === 0) {
    throw new Error(
      `topology spec "${spec}" declares at least one bay, none found. ` +
        'Write it as <bayNumber>:<programNumber>[,...][;<bay>...], for example "1:1;2:1,2".',
    );
  }

  // SORTED on the way out, so two spellings of one topology are one value. That is
  // what makes a declared set and a reported set comparable without the caller
  // having to normalise first — and an unsorted comparison is how {1,3} got read
  // as {1,2} in the shape this file's predecessor produced.
  bays.sort((a, b) => a.bayNumber - b.bayNumber);
  return bays;
}

/**
 * What a bare bay count has always stood for: dense 1..N, one program each.
 *
 * Separate from the parser rather than expressed as a spec string, because this is
 * the path every existing caller takes and it must not change shape. The count
 * bound is the same 1..64 the schema puts on `bays`.
 */
export function denseTopology(bayCount: number): BaySpec[] {
  if (!Number.isInteger(bayCount) || bayCount < BAY_MIN || bayCount > BAY_MAX) {
    throw new Error(
      `bay count must be an integer in ${BAY_MIN}..${BAY_MAX} (provisioning-request.schema.json ` +
        `puts minItems 1 and maxItems ${BAY_MAX} on bays), got ${JSON.stringify(bayCount)}`,
    );
  }
  return Array.from({ length: bayCount }, (_, i) => ({
    bayNumber: i + 1,
    programs: [{ programNumber: 1, label: DENSE_LABEL }],
  }));
}

/** The spec string for a topology. Round trips through parseTopologySpec. */
export function formatTopologySpec(bays: readonly BaySpec[]): string {
  return [...bays]
    .sort((a, b) => a.bayNumber - b.bayNumber)
    .map(b => `${b.bayNumber}:${[...b.programs]
      .sort((x, y) => x.programNumber - y.programNumber)
      .map(p => p.programNumber)
      .join(',')}`)
    .join(';');
}

function parseOrdinal(text: string, what: string, min: number, max: number): number {
  const raw = text.trim();
  // `Number()` and not `parseInt()`: parseInt('1.5') is 1 and parseInt('1x') is 1,
  // so both would be accepted silently. A topology read off a typo is worse than a
  // refusal, because the run then measures a station nobody meant to describe.
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `topology spec: ${what} "${raw}" is not an integer. ` +
        `The schema types it as an integer in ${min}..${max}.`,
    );
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new Error(`topology spec: ${what} ${value} is outside ${min}..${max}, which the schema requires.`);
  }
  return value;
}
