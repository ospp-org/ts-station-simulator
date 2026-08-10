import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { generateVariables, type ScenarioDefinition, type TargetConfig } from '../../scenarios/ScenarioRunner.js';
import { generateOfflineTxId } from '../../station/StationConfig.js';

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
