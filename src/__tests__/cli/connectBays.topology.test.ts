import { describe, it, expect } from 'vitest';
import { deriveBays } from '../../cli/connectBays.js';
import { parseTopologySpec } from '../../station/topologySpec.js';

const stationId = 'stn_1a2b3c4d';
const stationHex = '1a2b3c4d';

describe('deriveBays with an explicit topology', () => {
  it('the topology decides the bay numbers AND the per-bay programs', () => {
    const { bays, warnings } = deriveBays(
      stationId, 2, new Map(), null, parseTopologySpec('1:1,2;3:7'),
    );
    expect(bays.map(b => b.bayNumber)).toEqual([1, 3]);
    expect(bays[0].programs.map(p => p.programNumber)).toEqual([1, 2]);
    expect(bays[1].programs.map(p => p.programNumber)).toEqual([7]);
    expect(warnings).toEqual([]);
  });

  it('the topology overrides bayCount entirely — the count is only the fallback shape', () => {
    const { bays } = deriveBays(stationId, 9, new Map(), null, parseTopologySpec('4:1'));
    expect(bays.map(b => b.bayNumber)).toEqual([4]);
  });

  it('programs carry the label the spec derived, and available:true', () => {
    const { bays } = deriveBays(stationId, 1, new Map(), null, parseTopologySpec('1:3'));
    expect(bays[0].programs).toEqual([{ programNumber: 3, label: 'Program 3', available: true }]);
  });

  it('with no provisioned pairs the bayId is derived from the bay NUMBER', () => {
    const { bays } = deriveBays(stationId, 1, new Map(), null, parseTopologySpec('3:1'));
    expect(bays[0].bayId).toBe(`bay_${stationHex}03`);
  });
});

describe('deriveBays: a topology that disagrees with the provisioned set', () => {
  const provisioned = [
    { bayId: 'bay_aaaaaaaa01', bayNumber: 1 },
    { bayId: 'bay_aaaaaaaa02', bayNumber: 2 },
  ];

  it('keeps the SERVER-ISSUED bayId for a bay number the server knows', () => {
    // This is the whole mechanism behind the two divergence arms: the station has to
    // address a bay the server can find (by its issued bayId) while REPORTING a
    // program set the server does not have on record for it. Inventing the bayId
    // instead would make the server refuse the frame for a different reason and the
    // arm would never be reached.
    const { bays } = deriveBays(
      stationId, 2, new Map(), provisioned, parseTopologySpec('1:1,7'),
    );
    expect(bays).toHaveLength(1);
    expect(bays[0].bayId).toBe('bay_aaaaaaaa01');
    expect(bays[0].bayNumber).toBe(1);
    expect(bays[0].programs.map(p => p.programNumber)).toEqual([1, 7]);
  });

  it('reporting FEWER programs than the server holds is the `omitted` arm', () => {
    const { bays } = deriveBays(
      stationId, 2, new Map(), provisioned, parseTopologySpec('1:1;2:1'),
    );
    expect(bays.map(b => b.programs.map(p => p.programNumber))).toEqual([[1], [1]]);
  });

  it('WARNS when the topology names a bay the server never issued', () => {
    // Not an error: a station reporting a bay the server has no record of is a real
    // adversarial case. But the bayId is then invented, so the server will not resolve
    // it — which is a DIFFERENT branch from the program-set arms, and a run that
    // confuses the two has measured nothing. So it is said out loud.
    const { bays, warnings } = deriveBays(
      stationId, 2, new Map(), provisioned, parseTopologySpec('1:1;9:1'),
    );
    expect(bays.map(b => b.bayNumber)).toEqual([1, 9]);
    expect(bays[1].bayId).toBe(`bay_${stationHex}09`);
    expect(warnings.join(' ')).toMatch(/bay 9/);
    expect(warnings.join(' ')).toMatch(/never issued|not among the provisioned/i);
  });

  it('an explicit --var bayId_<N> still wins over the provisioned pair', () => {
    const { bays } = deriveBays(
      stationId, 2, new Map([['bayId_1', 'bay_ffffffff01']]), provisioned, parseTopologySpec('1:1'),
    );
    expect(bays[0].bayId).toBe('bay_ffffffff01');
  });

  it('--var naming a bay the topology does not declare warns, as before', () => {
    const { warnings } = deriveBays(
      stationId, 2, new Map([['bayId_5', 'bay_ffffffff05']]), provisioned, parseTopologySpec('1:1'),
    );
    expect(warnings.join(' ')).toMatch(/names no bay on this station/);
    expect(warnings.join(' ')).toMatch(/declared bays: 1/);
  });
});

describe('deriveBays without a topology is byte-identical to before', () => {
  it('two bays, one program each labelled Basic Wash', () => {
    const { bays, warnings } = deriveBays(stationId, 2, new Map());
    expect(warnings).toEqual([]);
    expect(bays).toHaveLength(2);
    for (const bay of bays) {
      expect(bay.programs).toEqual([{ programNumber: 1, label: 'Basic Wash', available: true }]);
      expect(bay.services).toEqual([
        { serviceId: 'svc_wash_basic', serviceName: 'Basic Wash', available: true },
      ]);
    }
  });

  it('provisioned pairs still decide numbers and ids when no topology is given', () => {
    const { bays } = deriveBays(stationId, 2, new Map(), [
      { bayId: 'bay_bbbbbbbb01', bayNumber: 1 },
      { bayId: 'bay_bbbbbbbb03', bayNumber: 3 },
    ]);
    expect(bays.map(b => [b.bayNumber, b.bayId])).toEqual([
      [1, 'bay_bbbbbbbb01'],
      [3, 'bay_bbbbbbbb03'],
    ]);
  });
});
