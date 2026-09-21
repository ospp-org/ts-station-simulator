import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { DEFAULT_POOL_BAYS } from '../../scenarios/bootstrap/PoolBootstrap.js';

/**
 * TWO FIXTURE PROPERTIES A POOLED FILE MUST DECLARE FOR ITSELF, both found by running the
 * corpus rather than by reading it — three files failed on 2026-09-21 and each had never
 * executed before, so nothing had ever measured them.
 *
 * (A) THE TOPOLOGY IT BOOTS MUST BE THE ONE THE POOL PROVISIONED. `BootTopologyComparator`
 *     compares the declared bay set against `provisionedTopology($station)` and answers
 *     `3018 TOPOLOGY_MISMATCH` + Pending when they disagree, which holds the station out of
 *     service for the rest of the file. A file declaring one bay against a pool station
 *     provisioned with DEFAULT_POOL_BAYS is therefore dead at its first step.
 *
 * (B) THE PROGRAM AVAILABILITY IT RELIES ON MUST BE ONE IT REPORTED. `bay_programs.available`
 *     is a LATCH, and every part of that is read off a writer:
 *       - the column defaults to `true` and `CertificateManager:493` omits it at provisioning;
 *       - `StatusNotificationHandler:656` is the ONLY writer that ever sets it;
 *       - `BootNotificationHandler::resetBaysToUnknown` updates `version`/`updated_at` (and
 *         `status` on a cold boot) and does NOT touch `available`;
 *       - `ServiceProgramResolver::isReportedUnavailable` refuses on `bp.available = false`.
 *     So a file that never reports inherits whatever the PREVIOUS lessee of that pool bay
 *     left there. Measured: `AuthorizeOfflineSessionAction:164` refused two scenarios on a
 *     bay a parallel worker had marked unavailable, and the server was right both times.
 *
 * Both predicates are derived from the files, never from a list of names — a hand-kept list
 * drifts the first time someone adds a scenario, and drift here means the gate either blocks
 * a correct file or waves through the one it exists to catch.
 */

const SCENARIOS_DIR = fileURLToPath(new URL('../../../scenarios', import.meta.url));

type Doc = {
  skip?: boolean;
  owns_station?: string;
  station?: { stationId?: string; bayCount?: number };
  steps?: unknown[];
};

function yamlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...yamlFiles(full));
    else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) out.push(full);
  }

  return out;
}

/** A file the pool allocator can hand a station to: not skipped, not hardcoded, not self-owned. */
export function takesPoolStation(doc: Doc | null): boolean {
  if (!doc) return false;
  if (doc.skip === true) return false;
  if (typeof doc.owns_station === 'string' && doc.owns_station !== '') return false;
  const declared = doc.station?.stationId;

  return !(typeof declared === 'string' && declared !== '' && !declared.includes('{{'));
}

/**
 * Boots whose declared bay set is NOT the pool's — excluding the one case where a mismatch is
 * the subject. A boot followed by an assertion of `errorCode 3018` is testing the comparator,
 * not tripping over it, and the only way to test it is to declare a set that disagrees.
 * Keyed on the ASSERTION, so a file that stops expecting 3018 stops being excused in the
 * same edit.
 */
export function topologyOffendersIn(doc: Doc | null, poolBays: number): string[] {
  const steps = Array.isArray(doc?.steps) ? doc!.steps : [];
  const out: string[] = [];

  steps.forEach((raw, index) => {
    const step = raw as Record<string, any> | null;
    if (step?.action !== 'send' || step?.message !== 'BootNotification') return;
    const bays = step.payload?.bays;
    if (!Array.isArray(bays)) return;
    if (bays.length === poolBays) return;

    const assertsMismatch = steps
      .slice(index + 1)
      .some((s) => {
        const a = s as Record<string, any> | null;
        return a?.action === 'assert' && String(a.field ?? '').endsWith('errorCode') && a.equals === 3018;
      });
    if (assertsMismatch) return;

    out.push(`step ${index}: declares ${bays.length} bay(s), pool provisions ${poolBays}`);
  });

  const bayCount = Number(doc?.station?.bayCount ?? 0);
  const boots = steps.some((s) => (s as any)?.action === 'send' && (s as any)?.message === 'BootNotification');
  if (boots && bayCount !== poolBays) {
    out.push(`station.bayCount is ${bayCount}, pool provisions ${poolBays}`);
  }

  return out;
}

/**
 * Calls that EXPECT SUCCESS on a named bay without having reported that bay's programs
 * available first. A refusal-expecting call is excluded: it is not relying on availability,
 * it is asserting a refusal. A BootNotification disarms everything reported before it,
 * because the server resets the bay STATUS on one and a file that re-boots must re-report.
 */
export function unreportedAvailabilityIn(doc: Doc | null): string[] {
  const steps = Array.isArray(doc?.steps) ? doc!.steps : [];
  const out: string[] = [];
  let armed = new Set<string>();

  steps.forEach((raw, index) => {
    const step = raw as Record<string, any> | null;
    if (!step) return;

    if (step.action === 'send' && step.message === 'BootNotification') {
      armed = new Set<string>();

      return;
    }
    if (step.action === 'send' && step.message === 'StatusNotification' && step.payload?.bayId !== undefined) {
      const programs = Array.isArray(step.payload.programs) ? step.payload.programs : [];
      if (programs.some((p: any) => p?.available === true)) armed.add(String(step.payload.bayId));

      return;
    }

    if (step.action !== 'api_call') return;
    const url = String(step.url ?? '').replace('{{target_url}}', '');
    if (!/\/api\/v1\/sessions\/(start|offline-auth)$/.test(url)) return;
    const expected = Number(step.expect_status ?? 0);
    if (expected < 200 || expected > 299) return;
    const bay = step.body?.bay_id ?? step.body?.bayId;
    if (bay === undefined) return;
    if (!armed.has(String(bay))) out.push(`step ${index}: ${url} expects ${expected} on ${bay}, never reported available`);
  });

  return out;
}

interface Scan {
  files: number;
  poolEligible: number;
  boots: number;
  successCalls: number;
  topology: string[];
  availability: string[];
}

function scanCorpus(): Scan {
  const files = yamlFiles(SCENARIOS_DIR);
  const scan: Scan = { files: files.length, poolEligible: 0, boots: 0, successCalls: 0, topology: [], availability: [] };

  for (const file of files) {
    const doc = YAML.parse(readFileSync(file, 'utf-8')) as Doc | null;
    const label = file.slice(SCENARIOS_DIR.length + 1);
    const steps = Array.isArray(doc?.steps) ? doc!.steps : [];
    scan.boots += steps.filter((s) => (s as any)?.action === 'send' && (s as any)?.message === 'BootNotification').length;
    scan.successCalls += steps.filter((s) => {
      const step = s as Record<string, any> | null;
      if (step?.action !== 'api_call') return false;
      const url = String(step.url ?? '').replace('{{target_url}}', '');
      const expected = Number(step.expect_status ?? 0);

      return /\/api\/v1\/sessions\/(start|offline-auth)$/.test(url) && expected >= 200 && expected <= 299;
    }).length;

    if (!takesPoolStation(doc)) continue;
    scan.poolEligible++;
    scan.topology.push(...topologyOffendersIn(doc, DEFAULT_POOL_BAYS).map((m) => `${label} — ${m}`));
    scan.availability.push(...unreportedAvailabilityIn(doc).map((m) => `${label} — ${m}`));
  }

  return scan;
}

describe('a pooled scenario declares the fixtures it depends on', () => {
  // ---- DENOMINATORS ---------------------------------------------------------
  it('reads the corpus and finds the things it is about', () => {
    const scan = scanCorpus();
    expect(scan.files).toBeGreaterThan(150);
    expect(scan.poolEligible).toBeGreaterThan(100);
    expect(scan.boots).toBeGreaterThan(100);
    expect(scan.successCalls).toBeGreaterThan(40);
  });

  // ---- MATCHER CONTROLS -----------------------------------------------------
  it('(A) flags a one-bay declaration against a two-bay pool, and passes the same file at two', () => {
    const boot = (n: number) => ({
      action: 'send',
      message: 'BootNotification',
      payload: { bays: Array.from({ length: n }, (_u, i) => ({ bayNumber: i + 1, programNumbers: [1] })) },
    });
    expect(topologyOffendersIn({ station: { bayCount: 1 }, steps: [boot(1)] }, 2)).toHaveLength(2);
    expect(topologyOffendersIn({ station: { bayCount: 2 }, steps: [boot(2)] }, 2)).toEqual([]);

    // The deliberate mismatch is excused ONLY by its own assertion, and loses the excuse
    // the moment the assertion changes.
    const asserts3018 = { action: 'assert', field: 'payload.errorCode', equals: 3018 };
    const assertsPending = { action: 'assert', field: 'payload.status', equals: 'Pending' };
    expect(topologyOffendersIn({ station: { bayCount: 2 }, steps: [boot(3), asserts3018, boot(2)] }, 2)).toEqual([]);
    expect(topologyOffendersIn({ station: { bayCount: 2 }, steps: [boot(3), assertsPending, boot(2)] }, 2)).toHaveLength(1);
  });

  it('(B) flags a success-expecting call on an unreported bay, and passes it once reported', () => {
    const boot = { action: 'send', message: 'BootNotification' };
    const report = {
      action: 'send',
      message: 'StatusNotification',
      payload: { bayId: '{{bayId_1}}', bayNumber: 1, status: 'Available', programs: [{ programNumber: 1, available: true }] },
    };
    const grant = {
      action: 'api_call',
      method: 'POST',
      url: '{{target_url}}/api/v1/sessions/offline-auth',
      body: { bay_id: '{{bayId_1}}' },
      expect_status: 201,
    };

    expect(unreportedAvailabilityIn({ steps: [boot, grant] })).toHaveLength(1);
    expect(unreportedAvailabilityIn({ steps: [boot, report, grant] })).toEqual([]);

    // A report that carries NO available:true program does not arm — silence is not a report.
    const silentReport = { ...report, payload: { ...report.payload, programs: [] } };
    expect(unreportedAvailabilityIn({ steps: [boot, silentReport, grant] })).toHaveLength(1);

    // A re-boot disarms, exactly as the server resets the bay.
    expect(unreportedAvailabilityIn({ steps: [boot, report, boot, grant] })).toHaveLength(1);

    // A REFUSAL-expecting call is not relying on availability and is not flagged.
    expect(unreportedAvailabilityIn({ steps: [boot, { ...grant, expect_status: 409 }] })).toEqual([]);
  });

  // ---- THE ASSERTIONS -------------------------------------------------------
  it('(A) every pooled boot declares the topology the pool provisions', () => {
    const scan = scanCorpus();
    expect(
      scan.topology,
      'these files boot a topology the pool did not provision — BootTopologyComparator answers ' +
        '3018 TOPOLOGY_MISMATCH and holds the station Pending for the rest of the run:\n' +
        scan.topology.map((m) => `  ${m}`).join('\n'),
    ).toEqual([]);
  });

  it('(B) every pooled call that needs a bay available has reported it available', () => {
    const scan = scanCorpus();
    expect(
      scan.availability,
      '`bay_programs.available` is a latch that only a StatusNotification writes and a boot ' +
        'does not reset, so these calls inherit whatever the previous lessee of the shared ' +
        'pool bay left there:\n' +
        scan.availability.map((m) => `  ${m}`).join('\n'),
    ).toEqual([]);
  });
});
