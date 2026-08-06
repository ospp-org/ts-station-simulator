import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TopologyStore } from '../../station/TopologyStore.js';
import type { BayConfig } from '../../station/StationConfig.js';

// ---------------------------------------------------------------------------
// spec v0.11.0 boot-notification-request.schema.json:50 —
//
//   "The declaration MUST be STABLE between boots while the hardware is
//    unchanged; how firmware achieves that — NVS, a compiled-in table, a
//    hardware scan — is its own business, and the contract is the stability, not
//    the mechanism."
//
// The simulator persisted nothing but certificates, and built its bays from the
// config file on every run. So "stable across boots" held only because the config
// file happened not to change — the station was not the source of its own
// declaration, the scenario was. A proof of boot re-declaration resting on that
// proves the config file, not the station.
//
// This store is the station's own memory of what it declared. First boot writes
// it; every later boot reads it and re-declares the same thing EVEN IF the config
// now says otherwise — because a station whose hardware has not changed must not
// change its declaration, and a station whose hardware HAS changed needs
// re-provisioning rather than a quiet self-correction (§05-state-machines.md:126,
// "A station MUST NOT alter its declaration to match what the server expected").
// ---------------------------------------------------------------------------

const BAYS: BayConfig[] = [
  {
    bayId: 'bay_a',
    bayNumber: 1,
    programs: [
      { programNumber: 1, label: 'Basic', available: true },
      { programNumber: 3, label: 'Wax', available: true },
    ],
    services: [],
  },
  {
    bayId: 'bay_b',
    bayNumber: 4,
    programs: [{ programNumber: 2, label: 'Rinse', available: true }],
    services: [],
  },
];

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ospp-topology-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('TopologyStore — the station remembers what it declared', () => {
  it('first boot writes the declaration and returns it unchanged', async () => {
    const store = new TopologyStore(dir, 'stn_aaaa1111');

    expect(await store.declare(BAYS)).toEqual([
      { bayNumber: 1, programNumbers: [1, 3] },
      { bayNumber: 4, programNumbers: [2] },
    ]);
  });

  it('a later boot re-declares from what it WROTE, not from config', async () => {
    // The property that matters. If the config changes under a station whose
    // hardware did not, the station must keep declaring what it declared —
    // otherwise a topology mismatch can never be detected, because the station
    // silently agrees with whatever it is told to be.
    const store = new TopologyStore(dir, 'stn_aaaa1111');
    await store.declare(BAYS);

    const differentConfig: BayConfig[] = [
      { bayId: 'bay_a', bayNumber: 9, programs: [{ programNumber: 7, label: 'X', available: true }], services: [] },
    ];

    expect(await new TopologyStore(dir, 'stn_aaaa1111').declare(differentConfig)).toEqual([
      { bayNumber: 1, programNumbers: [1, 3] },
      { bayNumber: 4, programNumbers: [2] },
    ]);
  });

  it('survives a restart — a brand-new process reads it off disk', async () => {
    await new TopologyStore(dir, 'stn_aaaa1111').declare(BAYS);

    const afterRestart = await new TopologyStore(dir, 'stn_aaaa1111').declare([]);

    expect(afterRestart).toEqual([
      { bayNumber: 1, programNumbers: [1, 3] },
      { bayNumber: 4, programNumbers: [2] },
    ]);
  });

  it('keeps stations apart — one station cannot read another declaration', async () => {
    await new TopologyStore(dir, 'stn_aaaa1111').declare(BAYS);

    const other = await new TopologyStore(dir, 'stn_bbbb2222').declare([
      { bayId: 'bay_z', bayNumber: 2, programs: [{ programNumber: 5, label: 'Z', available: true }], services: [] },
    ]);

    expect(other).toEqual([{ bayNumber: 2, programNumbers: [5] }]);
  });

  it('declares ordinals only — no labels reach the wire shape', async () => {
    // bay-topology.schema.json omits labels structurally: they are descriptive,
    // are never compared, and "a corrected typo in a firmware constant MUST NOT
    // put a station into Pending".
    const declared = await new TopologyStore(dir, 'stn_aaaa1111').declare(BAYS);

    for (const bay of declared) {
      expect(Object.keys(bay).sort()).toEqual(['bayNumber', 'programNumbers']);
    }
  });

  it('a corrected label does not change the declaration', async () => {
    const store = new TopologyStore(dir, 'stn_aaaa1111');
    const first = await store.declare(BAYS);

    const relabelled = BAYS.map(b => ({ ...b, programs: b.programs.map(p => ({ ...p, label: `${p.label} FIXED` })) }));

    expect(await new TopologyStore(dir, 'stn_aaaa1111').declare(relabelled)).toEqual(first);
  });

  it('forget() is the re-provisioning path — the only way the declaration changes', async () => {
    // Re-provisioning is what changes a topology (boot-notification.md:144). It
    // is deliberately explicit: nothing in the boot path may reach it, or the
    // station would be self-correcting again.
    const store = new TopologyStore(dir, 'stn_aaaa1111');
    await store.declare(BAYS);
    await store.forget();

    const newHardware: BayConfig[] = [
      { bayId: 'bay_a', bayNumber: 2, programs: [{ programNumber: 8, label: 'New', available: true }], services: [] },
    ];

    expect(await store.declare(newHardware)).toEqual([{ bayNumber: 2, programNumbers: [8] }]);
  });

  it('a corrupt file is refused, not silently re-declared from config', async () => {
    // Silently falling back to config on a bad read would reintroduce exactly the
    // defect this store exists to remove, and would do it invisibly.
    await writeFile(join(dir, 'stn_aaaa1111-topology.json'), '{ not json');

    await expect(new TopologyStore(dir, 'stn_aaaa1111').declare(BAYS)).rejects.toThrow(/topology/i);
  });

  it('writes ordinals sorted, so the file does not churn on re-declaration', async () => {
    const unsorted: BayConfig[] = [
      { bayId: 'b', bayNumber: 2, programs: [{ programNumber: 9, label: 'i', available: true }, { programNumber: 2, label: 'ii', available: true }], services: [] },
      { bayId: 'a', bayNumber: 1, programs: [{ programNumber: 3, label: 'iii', available: true }], services: [] },
    ];

    await new TopologyStore(dir, 'stn_aaaa1111').declare(unsorted);
    const raw = JSON.parse(await readFile(join(dir, 'stn_aaaa1111-topology.json'), 'utf-8')) as {
      bays: Array<{ bayNumber: number; programNumbers: number[] }>;
    };

    expect(raw.bays).toEqual([
      { bayNumber: 1, programNumbers: [3] },
      { bayNumber: 2, programNumbers: [2, 9] },
    ]);
  });
});
