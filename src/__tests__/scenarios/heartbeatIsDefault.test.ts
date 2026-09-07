import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  _createStationFromScenarioForTesting,
  type ScenarioDefinition,
  type TargetConfig,
} from '../../scenarios/ScenarioRunner.js';
import { BootNotificationHandler } from '../../handlers/BootNotificationHandler.js';
import {
  OsppAction,
  MessageType,
  MessageSource,
  BayStatus,
  OSPP_PROTOCOL_VERSION,
  type OsppEnvelope,
} from '@ospp/protocol';
import type { StationContext } from '../../handlers/Handler.js';

/**
 * A REAL STATION PULSES, SO A SIMULATED ONE DOES TOO — UNLESS ITS FILE SAYS OTHERWISE.
 *
 * Until this landed, scenario mode registered `BootNotificationHandler(autoReact=false)` and
 * that flag carried TWO unrelated decisions on one boolean: "do not emit StatusNotifications
 * for the pre-provision bayIds" (right, and still true) and "do not beat" (a
 * NON-CONFORMANCE). Measured on disk the day of the change: **8 of 148 files** called
 * `start_heartbeat`, so **140** ran against the server as a station that booted and then went
 * application-silent for its whole life. No real firmware does that, and the csms
 * `station:check-heartbeats` sweep marks such a station offline at `3.5 x
 * heartbeatIntervalSec` — 105s against the deployed 30. The suite was not exercising the path
 * the integrator will have.
 *
 * So the default inverted: **the station beats, and a file that needs silence declares it.**
 *
 * WHAT THE TWO DIRECTIONS ARE, AND WHY BOTH ARE HERE. Flipping a default without proving both
 * is how you change behaviour you cannot see:
 *
 *   - a station that beats must FAIL if the pulse is missing  -> `pulses on the wire`, which
 *     asserts published REQUESTs, not the existence of a timer object. A test that only
 *     checked `heartbeatTimer !== null` passes against a timer whose callback throws.
 *   - a file that declares silence must FAIL if a pulse arrives -> `suppress_heartbeat
 *     silences it`, whose positive control is the first test: the SAME harness, the same
 *     clock advance, the only difference the declaration.
 *
 * THE WINDOW IS PART OF THE PROPERTY, not a detail. Beating at some interval proves nothing
 * if the interval is wider than the sweep it exists to satisfy, so `stays inside the sweep
 * window` does the arithmetic against `3.5 x interval` rather than trusting the number.
 */

const SCENARIOS_DIR = path.resolve(__dirname, '../../../scenarios');

const target: TargetConfig = {
  mqttUrl: 'mqtt://localhost:1883',
  apiBaseUrl: 'http://localhost:8080',
};

function variables(): Map<string, string> {
  return new Map([
    ['stationId', 'stn_hbtest01'],
    ['bayId_1', 'bay_h1'],
    ['bayId_2', 'bay_h2'],
    ['serviceId_1', 'svc_test'],
    ['serialNumber', 'SIM-HB-TEST'],
  ]);
}

function scenarioDef(extra: Partial<ScenarioDefinition> = {}): ScenarioDefinition {
  return {
    name: 'heartbeat-default-test',
    station: {
      bayCount: 2,
      stationModel: 'WashPro X200',
      stationVendor: 'SimCorp',
      behavior: { accept_rate: 1.0 },
    },
    steps: [],
    ...extra,
  } as unknown as ScenarioDefinition;
}

/** A boot Response exactly as the server sends it, with the interval it declares. */
function bootRaw(status: string, heartbeatIntervalSec: number): Buffer {
  return Buffer.from(
    JSON.stringify({
      messageId: 'cmd_boot_resp_hb',
      messageType: MessageType.RESPONSE,
      action: OsppAction.BOOT_NOTIFICATION,
      source: MessageSource.CSMS,
      timestamp: '2026-06-15T00:00:00.000Z',
      protocolVersion: OSPP_PROTOCOL_VERSION,
      payload: {
        status,
        heartbeatIntervalSec,
        serverTime: '2026-06-15T00:00:00.000Z',
        ...(status === 'Accepted' ? { sessionKey: 'HB_TEST_KEY' } : {}),
      },
    }),
  );
}

const TOPIC = 'ospp/v1/stations/stn_hbtest01/to-station';

/**
 * Build a scenario station, spy its outbound sender, boot it, and let `ms` of clock elapse.
 * Returns every Heartbeat REQUEST that actually reached the sender.
 *
 * Fake timers, because the property is about a 30s cadence and no test may take 30s to say so.
 * `advanceTimersByTimeAsync` rather than the sync form: the router dispatches the boot
 * Response through an async handler, so the arming itself is a microtask.
 */
async function pulsesWithin(
  def: ScenarioDefinition,
  ms: number,
  opts: { intervalSec?: number; status?: string; sendRejects?: boolean } = {},
): Promise<{ heartbeats: number[]; errors: Error[] }> {
  const intervalSec = opts.intervalSec ?? 30;
  const status = opts.status ?? 'Accepted';

  vi.useFakeTimers();
  try {
    const station = _createStationFromScenarioForTesting(def, variables(), target);
    const heartbeats: number[] = [];
    const errors: Error[] = [];
    station.on('error', (err: Error) => errors.push(err));

    vi.spyOn(station.sender, 'send').mockImplementation(async (action: OsppAction) => {
      if (action === OsppAction.HEARTBEAT) heartbeats.push(Date.now());
      if (opts.sendRejects) throw new Error('MQTT client is not connected');
    });

    station.router.route(TOPIC, bootRaw(status, intervalSec));
    await vi.advanceTimersByTimeAsync(ms);

    station.stopHeartbeat();
    return { heartbeats, errors };
  } finally {
    vi.useRealTimers();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('heartbeat is the scenario default — the wire direction', () => {
  it('pulses on the wire: a scenario file that declares nothing beats after an accepted boot', async () => {
    // 5 intervals of clock. The assertion is on PUBLISHED REQUESTs: a timer that exists and
    // never fires, or fires into a rejected promise, fails here and would not fail a
    // `heartbeatTimer !== null` check.
    const { heartbeats } = await pulsesWithin(scenarioDef(), 5 * 30_000, { intervalSec: 30 });
    expect(heartbeats.length).toBe(5);
  });

  it('stays inside the sweep window: `3.5 x interval` never elapses without a pulse', async () => {
    // The server marks a station offline after 3.5 x its heartbeat interval of OSPP silence
    // (02-transport.md §4.2). Beating is only the property if the gap is under that.
    const intervalSec = 30;
    const windowMs = 3.5 * intervalSec * 1000; // 105_000
    const { heartbeats } = await pulsesWithin(scenarioDef(), 4 * windowMs, { intervalSec });

    expect(heartbeats.length).toBeGreaterThan(0);
    const gaps = heartbeats.slice(1).map((t, i) => t - heartbeats[i]);
    const worst = Math.max(heartbeats[0] - (heartbeats[0] - intervalSec * 1000), ...gaps);
    expect(worst).toBeLessThan(windowMs);
  });

  it('the interval is the SERVER\'s, read off the boot Response — not a constant here', async () => {
    // A server that declares 10 gets pulses every 10; declaring a local default would beat at
    // 30 against a station configured to beat at 10 and be swept at 35.
    const { heartbeats } = await pulsesWithin(scenarioDef(), 60_000, { intervalSec: 10 });
    expect(heartbeats.length).toBe(6);
  });

  it('a boot that is not Accepted arms nothing — a refused station has no session to keep alive', async () => {
    for (const status of ['Rejected', 'Pending']) {
      const { heartbeats } = await pulsesWithin(scenarioDef(), 5 * 30_000, { status });
      expect(heartbeats, `boot status ${status}`).toEqual([]);
    }
  });
});

describe('heartbeat is the scenario default — the declared-silence direction', () => {
  it('`suppress_heartbeat` silences it, and the pulsing test above is its positive control', async () => {
    const def = scenarioDef({
      suppress_heartbeat: 'test: the subject is application silence',
    } as Partial<ScenarioDefinition>);
    const { heartbeats } = await pulsesWithin(def, 5 * 30_000, { intervalSec: 30 });
    expect(heartbeats).toEqual([]);
  });

  it('the declaration is the ONLY difference — same clock, same station, same boot', async () => {
    // Stated as one assertion so a future change that breaks the pairing (e.g. silencing
    // everything) fails here rather than passing both halves for the wrong reason.
    const loud = await pulsesWithin(scenarioDef(), 3 * 30_000);
    const quiet = await pulsesWithin(
      scenarioDef({ suppress_heartbeat: 'test' } as Partial<ScenarioDefinition>),
      3 * 30_000,
    );
    expect([loud.heartbeats.length, quiet.heartbeats.length]).toEqual([3, 0]);
  });
});

describe('heartbeat is the scenario default — what it must not break', () => {
  it('a pulse that cannot be published is reported, not fatal', async () => {
    // `startHeartbeat` reports a failed send with `emit('error')`. EventEmitter THROWS on an
    // unlistened 'error', and the emit happens inside a `.catch()` — so with no listener the
    // throw becomes an unhandled rejection and, under Node's default, kills the whole run.
    // That was latent while 8 files beat; it is live the moment 140 do, and 9 of them sever or
    // destroy the connection mid-scenario (`fault:`), which nulls the client and makes every
    // subsequent publish reject.
    const station = _createStationFromScenarioForTesting(scenarioDef(), variables(), target);
    expect(
      station.listenerCount('error'),
      'the scenario station has no error listener — a failed background heartbeat would ' +
        'become an unhandled rejection and terminate the run',
    ).toBeGreaterThan(0);
  });

  it('a rejecting sender produces errors, and the station is still alive afterwards', async () => {
    const { heartbeats, errors } = await pulsesWithin(scenarioDef(), 3 * 30_000, {
      sendRejects: true,
    });
    expect(heartbeats.length).toBe(3); // it kept trying, like firmware on a dead link
    expect(errors.length).toBe(3); // and every failure was surfaced
  });

  it('connect mode is unchanged: autoReact still beats AND still reports every bay', async () => {
    const captured: OsppAction[] = [];
    let started: number | null = null;
    const station = {
      config: {
        bays: [
          { bayId: 'bay_a', bayNumber: 1, programs: [{ programNumber: 1, available: true }] },
          { bayId: 'bay_b', bayNumber: 2, programs: [{ programNumber: 1, available: true }] },
        ],
        behavior: { autoRetryBoot: false },
      },
      sender: {
        async send(action: OsppAction): Promise<void> {
          captured.push(action);
        },
      },
      sessionKey: null as string | null,
      getBayState: (): BayStatus => BayStatus.AVAILABLE,
      startHeartbeat: (s: number): void => {
        started = s;
      },
      stopHeartbeat: (): void => {},
      setBayState: (): void => {},
      retryBoot: async (): Promise<void> => {},
      destroyConnection: (): void => {},
      sessions: new Map(),
      reservations: new Map(),
      currentRevocationEpoch: 0,
    } as unknown as StationContext;

    const envelope = JSON.parse(bootRaw('Accepted', 45).toString()) as OsppEnvelope;
    await new BootNotificationHandler().handle(envelope, station);

    expect(started).toBe(45);
    expect(captured.filter((a) => a === OsppAction.STATUS_NOTIFICATION)).toHaveLength(2);
  });
});

/**
 * THE CORPUS SIDE. A default is a claim about a SET, so the set is read rather than described.
 *
 * This is the gate that stops the change from being undone by omission in either direction: a
 * new file that needs silence and does not say so beats and fails for a reason nobody will
 * attribute to this commit; a file that carries the key and no longer needs it keeps a
 * non-conformance alive under a declaration that reads like a decision.
 */
describe('heartbeat is the scenario default — the corpus', () => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.yaml')) files.push(full);
    }
  };
  walk(SCENARIOS_DIR);

  const declaring = files
    .filter((f) => {
      const s = parseYaml(fs.readFileSync(f, 'utf-8')) as Record<string, unknown> | null;
      return typeof s?.suppress_heartbeat === 'string';
    })
    .map((f) => path.relative(SCENARIOS_DIR, f))
    .sort();

  it('the denominator is read from disk, not written down', () => {
    expect(files.length).toBe(148);
  });

  it('exactly the files whose SUBJECT is application silence declare it', () => {
    // ONE file, and the enumeration that produced it is in the commit message. The other
    // candidates were measured and do not need the key:
    //   - the 3 `expect_silence: Heartbeat/Response` files correlate their wait to their OWN
    //     scripted Request's messageId, so a background pulse's Response cannot match it;
    //   - `connection-lost-lwt` / `reconnect-recovery` prove offline via the BROKER's will,
    //     and `updateLastSeen()` writes `last_seen_at` ONLY — a Heartbeat cannot set
    //     `is_online` back to true (StationRepository.php:108), only a Boot does;
    //   - 13 files never send a BootNotification at all, so nothing ever arms.
    //
    // The one file that IS affected is affected through `stations.last_seen_at`, which
    // `CheckStationHeartbeatsCommand` has compared against `ceil(interval x 3.5)` since
    // csms-server 2026-08-29 — NOT through the `ospp:heartbeat:*` key it used to SCAN, whose
    // tracker now carries "a write and a delete with no reader" in its own docblock.
    expect(declaring).toEqual(['core/heartbeat-silence-offline-sweep.yaml']);
  });

  it('every declaration carries a REASON, never a bare boolean', () => {
    for (const rel of declaring) {
      const s = parseYaml(fs.readFileSync(path.join(SCENARIOS_DIR, rel), 'utf-8')) as Record<
        string,
        unknown
      >;
      expect(String(s.suppress_heartbeat).trim().length, rel).toBeGreaterThan(20);
    }
  });
});
