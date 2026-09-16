import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { BayConfig } from '../station/StationConfig.js';
import type { BaySpec } from '../station/topologySpec.js';

export interface DeriveBaysResult {
  bays: BayConfig[];
  warnings: string[];
}

/** One `bayId` ↔ `bayNumber` pair exactly as the provisioning response gave it. */
export interface ProvisionedBay {
  bayId: string;
  bayNumber: number;
}

const BAY_KEY_RE = /^bayId_(\d+)$/;

/**
 * Read the `bayId` ↔ `bayNumber` pairs this station was actually issued.
 *
 * These arrive ONCE, in the provisioning response, and the guide makes keeping them a
 * storage obligation: `docs/guide/03-provizionare.md` — the pairs are assigned by the
 * server, never derived, and a bay number is not an index (a model with bays `{1,3}`
 * yields `bayNumber` 3 at index 1). `provision` already persists them next to the key
 * as `<stationId>-bays.json`; this is the reader that closes the loop.
 *
 * Why this exists: `connect` used to invent `bay_<stationHex><NN>` and ignore the file
 * it had just written. The server then addresses a REAL bay — `TriggerMessage` with a
 * `bayId`, which `docs/guide/05-puls-si-stare.md` documents as the server asking a
 * bay's state back — and the station has never heard of it. That is measuring the
 * instrument, not the server.
 *
 * Returns `null` when there is no file (never provisioned through this CLI), so the
 * caller can fall back without treating absence as an error.
 */
export async function loadProvisionedBays(
  stationId: string,
  keyPath: string | undefined,
): Promise<ProvisionedBay[] | null> {
  if (!keyPath) return null;
  const file = path.join(path.dirname(keyPath), `${stationId}-bays.json`);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { bays?: unknown };
    if (!Array.isArray(parsed.bays)) return null;
    const pairs = parsed.bays
      .filter((b): b is ProvisionedBay =>
        typeof (b as ProvisionedBay)?.bayId === 'string' &&
        Number.isInteger((b as ProvisionedBay)?.bayNumber))
      .sort((a, b) => a.bayNumber - b.bayNumber);
    return pairs.length > 0 ? pairs : null;
  } catch {
    return null;
  }
}

/**
 * Build the station's bay list.
 *
 * WHICH BAY NUMBERS, highest precedence first:
 *   1. `topology` — an EXPLICIT declaration. It decides the bay numbers and the
 *      per-bay PROGRAMS, and it is the only input that can make what the station
 *      reports differ from what the server has on record for it. See topologySpec.ts
 *      for why that difference is the point.
 *   2. `provisioned` — the pairs the SERVER issued. Both the id and the bay NUMBER
 *      come from here, so a non-contiguous topology (`{1,3}`) survives instead of
 *      being flattened to `1..n`.
 *   3. `bayCount` — dense `1..N`, correct only for a station that was never
 *      provisioned through this CLI.
 *
 * WHICH BAY ID, highest precedence first:
 *   1. `--var bayId_<N>=…` — an explicit operator override, for a station whose pairs
 *      live somewhere this CLI cannot read.
 *   2. the `provisioned` pair for that bay NUMBER, whatever decided the numbers. A
 *      station that reports a different program set still has to address a bay the
 *      server can resolve, so the issued id is kept even when the topology overrides
 *      everything else.
 *   3. `bay_<stationHex><NN>` — a derived placeholder.
 */
export function deriveBays(
  stationId: string,
  bayCount: number,
  userVars: Map<string, string>,
  provisioned?: ProvisionedBay[] | null,
  topology?: readonly BaySpec[] | null,
): DeriveBaysResult {
  const stationHex = stationId.replace(/^stn_/, '');
  const bays: BayConfig[] = [];
  const warnings: string[] = [];

  const issuedIdFor = new Map<number, string>(
    (provisioned ?? []).map(p => [p.bayNumber, p.bayId]),
  );

  // An explicit topology decides the numbers; otherwise the server's pairs do;
  // otherwise a dense count.
  const slots: Array<{ bayNumber: number; programs: BayConfig['programs'] }> =
    topology && topology.length > 0
      ? topology.map(b => ({
          bayNumber: b.bayNumber,
          // `available: true`: this shape declares that the program EXISTS. A faulted
          // program is reported present-but-unavailable, which is a per-run state a
          // scenario sets, not a property of the declaration.
          programs: b.programs.map(p => ({
            programNumber: p.programNumber,
            label: p.label,
            available: true,
          })),
        }))
      : (provisioned && provisioned.length > 0
          ? provisioned.map(p => ({ bayNumber: p.bayNumber, programs: defaultPrograms() }))
          : Array.from({ length: bayCount }, (_, i) => ({ bayNumber: i + 1, programs: defaultPrograms() })));

  for (const slot of slots) {
    const i = slot.bayNumber;
    const issued = issuedIdFor.get(i);
    if (topology && issuedIdFor.size > 0 && issued === undefined) {
      // Said out loud rather than refused. A station reporting a bay the server has
      // no record of is a legitimate adversarial case — but the id below is then
      // INVENTED, so the server cannot resolve it, and the branch that answers is
      // the unresolvable-bay one rather than either program-set arm. A run that
      // confuses the two has measured nothing.
      warnings.push(
        `topology declares bay ${i}, which is not among the provisioned pairs ` +
          `(${[...issuedIdFor.keys()].sort((a, b) => a - b).join(', ')}) — the server never issued ` +
          'an id for it, so the derived placeholder below will not resolve server-side',
      );
    }
    const defaultBayId = issued ?? `bay_${stationHex}${String(i).padStart(2, '0')}`;
    const overrideBayId = userVars.get(`bayId_${i}`);
    bays.push({
      bayId: overrideBayId ?? defaultBayId,
      bayNumber: i,
      programs: slot.programs,
      services: [{ serviceId: 'svc_wash_basic', serviceName: 'Basic Wash', available: true }],
    });
  }

  for (const key of userVars.keys()) {
    const m = key.match(BAY_KEY_RE);
    if (!m) {
      warnings.push(`--var ${key}=... not recognized by connect mode (only bayId_<N> is honored; ignored)`);
      continue;
    }
    const index = Number.parseInt(m[1], 10);
    // The valid set is the bay NUMBERS this station actually has — which is not
    // `1..bayCount` when the topology is non-contiguous. A model with bays `{1,3}`
    // has no bay 2, and bay 3 is legal; validating against a count would reject the
    // real bay and accept a bay that does not exist.
    const known = new Set(bays.map(b => b.bayNumber));
    if (!known.has(index)) {
      const declared = [...known].sort((a, b) => a - b).join(', ');
      warnings.push(
        `--var ${key}=... names no bay on this station (declared bays: ${declared}; ignored)`,
      );
    }
  }

  return { bays, warnings };
}

/**
 * The one-program default a bare bay count has always meant.
 *
 * Programs are firmware constants the station owns; services are what the server
 * pushed. Both are declared here because the simulator plays both halves, but only
 * programs go on the wire in a StatusNotification.
 */
function defaultPrograms(): BayConfig['programs'] {
  return [{ programNumber: 1, label: 'Basic Wash', available: true }];
}
