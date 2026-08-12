import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { generateVariables, type ScenarioDefinition, type TargetConfig } from '../../scenarios/ScenarioRunner.js';
import { generateOfflineTxId, generateSecurityEventId } from '../../station/StationConfig.js';

/**
 * Regression guard for the poisoned-fixture class.
 *
 * security/offline-transaction-reconcile.yaml hardcoded `otx_a0000000001`. The server's
 * Reconciler dedups on offlineTxId permanently, so a literal is reconcilable exactly once
 * per database: a row written on 2026-08-07 was still making the scenario answer
 * `Duplicate` instead of `Accepted` on 2026-08-10, and no teardown fixed it (the sweep is
 * user-scoped; the poisoning run was outside its scope).
 */

const TARGET: TargetConfig = {
  mqttUrl: 'mqtt://localhost:1883',
  apiBaseUrl: 'http://localhost:8080',
};

function scenario(): ScenarioDefinition {
  return {
    name: 'test',
    station: { bayCount: 2, stationModel: 'WashPro X200', stationVendor: 'SimCorp' },
    steps: [],
  };
}

// common/offline-tx-id.schema.json
const OFFLINE_TX_ID = /^otx_[a-f0-9]{8,}$/;

describe('generateOfflineTxId — schema shape and uniqueness', () => {
  it('matches the wire schema pattern and minLength', () => {
    const id = generateOfflineTxId();
    expect(id).toMatch(OFFLINE_TX_ID);
    expect(id.length).toBeGreaterThanOrEqual(12);
    expect(id.length).toBeLessThanOrEqual(64);
  });

  it('is distinct across calls — the whole point', () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateOfflineTxId()));
    expect(ids.size).toBe(200);
  });
});

describe('generateVariables — runOfflineTxId', () => {
  it('exposes runOfflineTxId, schema-shaped', () => {
    expect(generateVariables(scenario(), TARGET).get('runOfflineTxId')).toMatch(OFFLINE_TX_ID);
  });

  it('differs between runs, so a reconciled id never collides with a previous run', () => {
    const a = generateVariables(scenario(), TARGET).get('runOfflineTxId');
    const b = generateVariables(scenario(), TARGET).get('runOfflineTxId');
    expect(a).not.toBe(b);
  });

  it('resolves to ONE value per run, so an idempotency re-send is still a re-send', () => {
    const vars = generateVariables(scenario(), TARGET);
    expect(vars.get('runOfflineTxId')).toBe(vars.get('runOfflineTxId'));
  });

  it('does NOT generate `offlineTxId` — the offline-auth-reconcile files require that as an explicit --var, and a generated default would turn their honest substitution failure into a confusing downstream one', () => {
    expect(generateVariables(scenario(), TARGET).has('offlineTxId')).toBe(false);
  });

  it('lets --var override it', () => {
    const vars = generateVariables(scenario(), TARGET, null, new Map([['runOfflineTxId', 'otx_deadbeefcafe']]));
    expect(vars.get('runOfflineTxId')).toBe('otx_deadbeefcafe');
  });
});

describe('the scenario that was poisoned', () => {
  const file = path.resolve('scenarios/security/offline-transaction-reconcile.yaml');

  it('no longer hardcodes an offlineTxId in any payload', () => {
    const payloadIds = fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(l => /^\s*offlineTxId:/.test(l));

    expect(payloadIds.length).toBeGreaterThan(0);
    for (const line of payloadIds) {
      expect(line).toContain('{{runOfflineTxId}}');
      expect(line).not.toMatch(/otx_[a-f0-9]{8,}/);
    }
  });

  it('still sends the SAME id twice — removing the literal must not remove the idempotency proof', () => {
    const payloadIds = fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(l => /^\s*offlineTxId:/.test(l));

    expect(payloadIds.length).toBe(2);
    expect(payloadIds[0].trim()).toBe(payloadIds[1].trim());
  });
});

describe('indexed runOfflineTxId_N — for a scenario reconciling several in one run', () => {
  it('exposes 1..8, all schema-shaped and all distinct from each other and from runOfflineTxId', () => {
    const vars = generateVariables(scenario(), TARGET);
    const ids = Array.from({ length: 8 }, (_, i) => vars.get(`runOfflineTxId_${i + 1}`));

    for (const id of ids) expect(id).toMatch(OFFLINE_TX_ID);
    expect(new Set([...ids, vars.get('runOfflineTxId')]).size).toBe(9);
  });

  it('the fraud scenario uses five of them and hardcodes none', () => {
    const lines = fs.readFileSync(
      path.resolve('scenarios/security/offline-fraud-rapid-transactions.yaml'), 'utf8')
      .split('\n').filter(l => /^\s*offlineTxId:/.test(l));

    expect(lines).toHaveLength(5);
    lines.forEach((l, i) => expect(l).toContain(`{{runOfflineTxId_${i + 1}}}`));
    // The literals that poisoned it: otx_aa00000001..5, reconciled 2026-08-07.
    for (const l of lines) expect(l).not.toMatch(/otx_[a-f0-9]{8,}/);
  });

  it('and it now asserts every TransactionEvent response, not just the boot', () => {
    const src = fs.readFileSync(
      path.resolve('scenarios/security/offline-fraud-rapid-transactions.yaml'), 'utf8');
    const sends = (src.match(/^\s*message: TransactionEvent$/gm) ?? []).length;
    const statusAsserts = (src.match(/field: "payload\.status"/g) ?? []).length;

    // 5 sends + 5 response waits = 10 mentions; 5 tx asserts + 1 boot assert = 6.
    expect(sends).toBe(10);
    expect(statusAsserts).toBe(6);
  });
});

// common/security-event.schema.json
const SECURITY_EVENT_ID = /^sec_[a-f0-9]{8,}$/;

describe('runSecurityEventId — the same poisoned-fixture class, in security_events', () => {
  it('is schema-shaped and distinct per call', () => {
    expect(generateSecurityEventId()).toMatch(SECURITY_EVENT_ID);
    expect(new Set(Array.from({ length: 200 }, generateSecurityEventId)).size).toBe(200);
  });

  it('generateVariables exposes it', () => {
    expect(generateVariables(scenario(), TARGET).get('runSecurityEventId'))
      .toMatch(SECURITY_EVENT_ID);
  });

  it('differs between runs — the server dedups event_id GLOBALLY, so a literal is insertable once ever', () => {
    const a = generateVariables(scenario(), TARGET).get('runSecurityEventId');
    const b = generateVariables(scenario(), TARGET).get('runSecurityEventId');
    expect(a).not.toBe(b);
  });
});

describe('the eleven security-event scenarios', () => {
  const files = fs.readdirSync(path.resolve('scenarios/security'))
    .filter(f => f.startsWith('security-event-') && f.endsWith('.yaml'))
    .map(f => path.resolve('scenarios/security', f));

  it('there are eleven of them', () => {
    expect(files).toHaveLength(11);
  });

  it('none hardcodes an eventId — all eleven were deduped from 2026-06-15 until 2026-08-10', () => {
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      expect(src).toMatch(/eventId: "\{\{runSecurityEventId\}\}"/);
      expect(src).not.toMatch(/eventId: "sec_[a-f0-9]+"/);
    }
  });

  // The assertion lines only. Every one of these files now quotes both retired forms in its
  // header, deliberately, so a whole-file `toContain` would read the explanation as the code.
  const assertionLines = (f: string) =>
    fs.readFileSync(f, 'utf8')
      .split('\n')
      .filter(ln => !ln.trimStart().startsWith('#'))
      .join('\n');

  it('each reads its event back and asserts the id it sent — not a count, not the most recent', () => {
    for (const f of files) {
      const code = assertionLines(f);
      expect(code).toContain('/api/v1/admin/security/events?station_id={{captured.stationUuid}}');
      expect(code).toContain('data[eventId={{runSecurityEventId}}].type:');
      expect(code).toContain('data[eventId={{runSecurityEventId}}].stationId: "{{stationId}}"');
    }
  });

  // The regression this pins. `data.length: 1` claims the station has had exactly one
  // security event ever — false for every scenario after the first to land on a pooled
  // station, because StationPoolAllocator does not reset state on release. `data.0` claims
  // the row it wants is the newest, which held only by the endpoint's default sort. Both are
  // position/count arguments about rows this scenario does not own; identity is the eventId.
  it('none addresses the row by COUNT or by POSITION', () => {
    for (const f of files) {
      const code = assertionLines(f);
      expect(code).not.toMatch(/data\.length/);
      expect(code).not.toMatch(/data\.\d+\./);
    }
  });

  it('asserts severity in the LOWERCASE the column stores, not the wire enum case', () => {
    for (const f of files) {
      const m = assertionLines(f).match(/\]\.severity: "([^"]+)"/);
      expect(m).not.toBeNull();
      expect(m![1]).toBe(m![1].toLowerCase());
    }
  });
});
