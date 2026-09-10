import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import Ajv2020Module from 'ajv/dist/2020.js';
import {
  OsppAction,
  MessageType,
  MessageSource,
  BayStatus,
  OSPP_PROTOCOL_VERSION,
  type OsppEnvelope,
} from '@ospp/protocol';
import { StartServiceHandler } from '../../handlers/StartServiceHandler.js';
import { StopServiceHandler } from '../../handlers/StopServiceHandler.js';
import { Station } from '../../station/Station.js';
import type { StationConfig } from '../../station/StationConfig.js';
import type { StationContext, SessionInfo } from '../../handlers/Handler.js';

/**
 * ONE field, TWO clocks, and the simulator was reading the wrong one at both of
 * the two sites that produce it.
 *
 * spec/profiles/core/heartbeat.md:44 rule 5, present since the first tag
 * (v0.1.0-draft.1): "Clock adjustments MUST NOT affect the duration of active
 * sessions. The station MUST track session elapsed time using a monotonic timer,
 * not the wall clock." Restated on both carriers of the field it exists for —
 * spec/profiles/transaction/stop-service.md:47 rule 5 and
 * spec/profiles/transaction/session-ended.md:61 rule 2.
 *
 * heartbeat.md:51 rule 6 draws the line these tests police: "The wall clock's job
 * in a session is to stamp values that get ORDERED — the envelope `timestamp`,
 * `startedAt`, `endedAt`; the monotonic timer's job is to produce the one that
 * gets DIFFERENCED." So `startedAt` must stay a real wall-clock instant AND the
 * duration must stop being derived from it.
 *
 * Why nothing downstream catches it: the same rule 6 records that
 * `actualDurationSeconds` has `minimum: 0` and NO `maximum` on
 * stop-service-response.schema.json and session-ended-event.schema.json, and no
 * receiver rule cross-checks it against `startedAt`/`endedAt`. The receiver takes
 * it verbatim. A correction landing mid-session therefore ships straight into the
 * invoice.
 *
 * The assertions below land on the DURATION IN THE SENT FRAME, never on a log
 * line: `creditsCharged = ceil(actualDurationSeconds / 60 * priceCreditsPerMinute)`
 * is computed from it in the same breath, so the frame is where the money is.
 */

// A +1h step is the ordinary shape of the fault: a station whose time source is a
// network the operator does not control (cellular NITZ, NTP over a metered link)
// acquiring a fix mid-wash. heartbeat.md:51 names exactly that station.
const WALL_START_MS = Date.parse('2026-03-29T00:59:40.000Z');
const REAL_ELAPSED_MS = 40_000;
const JUMP_MS = 3_600_000;

/** ceil(40/60 * 100) = 67 — the honest bill for a 40-second wash at 100 cr/min. */
const HONEST_SECONDS = 40;
const HONEST_CREDITS = 67;

// ---------------------------------------------------------------------------
// The instrument: two independent clocks, driven separately.
//
// `toFake: ['Date']` replaces Date.now() and the Date constructor and leaves
// performance.now() alone, which is what lets a wall-clock step be planted
// WITHOUT real time passing. The monotonic reading is driven by spying on
// performance.now — production reads it through the global at call time, so the
// spy reaches it whatever the import style.
// ---------------------------------------------------------------------------
function useTwoClocks(): {
  passRealTime(ms: number): void;
  stepWallClockOnly(ms: number): void;
  wallNowMs(): number;
  monotonicNowMs(): number;
} {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(WALL_START_MS);
  // An ARBITRARY origin, as a real monotonic clock has: the value is meaningless
  // except against another reading of itself.
  let mono = 987_654.321;
  vi.spyOn(performance, 'now').mockImplementation(() => mono);

  return {
    /** Real time passes: BOTH clocks advance, as they do when nothing corrects. */
    passRealTime(ms: number): void {
      mono += ms;
      vi.setSystemTime(Date.now() + ms);
    },
    /** A CORRECTION: the wall clock steps, and no real time passes with it. */
    stepWallClockOnly(ms: number): void {
      vi.setSystemTime(Date.now() + ms);
    },
    wallNowMs: () => Date.now(),
    monotonicNowMs: () => mono,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Schema validation, so "the duration went negative" is stated as what it is on
// the wire — an invalid frame — and not merely as a number a test dislikes.
// ---------------------------------------------------------------------------
type SchemaValidator = ((data: unknown) => boolean) & {
  errors?: Array<{ instancePath: string; message?: string }> | null;
};
interface AjvLike {
  addSchema(schema: unknown, key?: string): void;
  getSchema(key: string): SchemaValidator | undefined;
}
// `ajv/dist/2020.js` is CJS reached through NodeNext, so the default import is the
// namespace and TS sees no construct signature on it. Same wart as
// RejectionFramesAreSchemaValid.test.ts; typed here rather than repeated untyped.
const Ajv2020 = Ajv2020Module as unknown as new (opts: Record<string, unknown>) => AjvLike;

const require_ = createRequire(import.meta.url);
const SCHEMA_ROOT = path.join(path.dirname(require_.resolve('@ospp/protocol')), 'schemas');
const ajv: AjvLike = new Ajv2020({ strict: false, allErrors: true });
for (const dir of ['common', 'mqtt', 'ble']) {
  const abs = path.join(SCHEMA_ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const f of fs.readdirSync(abs).filter((x) => x.endsWith('.schema.json'))) {
    const schema = JSON.parse(fs.readFileSync(path.join(abs, f), 'utf-8'));
    if (typeof schema.$id === 'string' && !ajv.getSchema(schema.$id)) ajv.addSchema(schema);
    const rel = `../${dir}/${f}`;
    if (!ajv.getSchema(rel)) ajv.addSchema(schema, rel);
  }
}
function schemaErrors(schemaFile: string, payload: unknown): string[] {
  // Look the schema up by the $id it was registered under, rather than compiling
  // the file a second time — ajv refuses a duplicate $id, and that refusal reads
  // as a harness error in the middle of a validity assertion.
  const abs = path.join(SCHEMA_ROOT, 'mqtt', schemaFile);
  const { $id } = JSON.parse(fs.readFileSync(abs, 'utf-8')) as { $id?: string };
  const validate = ($id !== undefined ? ajv.getSchema($id) : undefined) ?? ajv.getSchema(`../mqtt/${schemaFile}`);
  if (validate === undefined) throw new Error(`schema not registered: ${schemaFile}`);
  // Round-trip through JSON: a NaN reaches the broker as `null`, not as NaN.
  return validate(JSON.parse(JSON.stringify(payload)))
    ? []
    : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ''}`);
}

// POSITIVE CONTROL ON THE VALIDATOR: it must actually reject something. A
// validator that returns [] for everything would make every schema assertion
// below vacuously green.
describe('the schema validator itself', () => {
  it('rejects a negative actualDurationSeconds and accepts a non-negative one', () => {
    const bad = { status: 'Accepted', actualDurationSeconds: -3560, creditsCharged: 1, finalSeqNo: 0 };
    const good = { status: 'Accepted', actualDurationSeconds: 40, creditsCharged: 67, finalSeqNo: 0 };
    expect(schemaErrors('stop-service-response.schema.json', bad).join(' ')).toMatch(/actualDurationSeconds/);
    expect(schemaErrors('stop-service-response.schema.json', good)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Handler-level fixture: the REAL StartServiceHandler writes the session, so the
// anchor under test is the one production actually records.
// ---------------------------------------------------------------------------
interface Sent { action: OsppAction; messageType: MessageType; payload: Record<string, unknown> }

function makeStationContext(): { station: StationContext; sent: Sent[]; sessions: Map<string, SessionInfo> } {
  const sent: Sent[] = [];
  const sessions = new Map<string, SessionInfo>();
  let bayState = BayStatus.AVAILABLE;

  const station = {
    config: {
      bays: [{
        bayId: 'bay_c10c4a11', bayNumber: 1,
        programs: [{ programNumber: 1, label: 'P1', available: true }],
        services: [{ serviceId: 'svc_clock', serviceName: 'Wash', available: true }],
      }],
      behavior: { acceptRate: 1.0 },
    },
    sender: {
      async send(action: OsppAction, messageType: MessageType, payload: Record<string, unknown>): Promise<void> {
        sent.push({ action, messageType, payload });
      },
    },
    sessions,
    reservations: new Map(),
    currentRevocationEpoch: 0,
    getBayState: () => bayState,
    setBayState: (_b: string, s: BayStatus) => { bayState = s; },
  } as unknown as StationContext;

  return { station, sent, sessions };
}

function startEnvelope(): OsppEnvelope {
  return {
    messageId: 'msg-start', messageType: MessageType.REQUEST, action: OsppAction.START_SERVICE,
    timestamp: new Date().toISOString(), source: MessageSource.SERVER,
    protocolVersion: OSPP_PROTOCOL_VERSION,
    payload: {
      sessionId: 'sess_c10c4a11', bayId: 'bay_c10c4a11', serviceId: 'svc_clock',
      programNumber: 1, durationSeconds: 300, sessionSource: 'MobileApp',
    },
  } as unknown as OsppEnvelope;
}

function stopEnvelope(): OsppEnvelope {
  return {
    messageId: 'msg-stop', messageType: MessageType.REQUEST, action: OsppAction.STOP_SERVICE,
    timestamp: new Date().toISOString(), source: MessageSource.SERVER,
    protocolVersion: OSPP_PROTOCOL_VERSION,
    payload: { bayId: 'bay_c10c4a11', sessionId: 'sess_c10c4a11' },
  } as unknown as OsppEnvelope;
}

function stopResponseOf(sent: Sent[]): Record<string, unknown> {
  const r = sent.find(
    (s) => s.action === OsppAction.STOP_SERVICE && s.messageType === MessageType.RESPONSE,
  );
  expect(r, 'no StopService RESPONSE was sent').toBeDefined();
  return r!.payload;
}

// ===========================================================================
// 0. POSITIVE CONTROL ON THE INSTRUMENT — before believing any negative.
// ===========================================================================
describe('the instrument: a planted wall-clock step, and a monotonic clock that ignores it', () => {
  it('a step moves the wall clock by exactly the planted amount and moves the monotonic clock by nothing', () => {
    const clocks = useTwoClocks();
    const wall0 = clocks.wallNowMs();
    const mono0 = clocks.monotonicNowMs();

    clocks.stepWallClockOnly(JUMP_MS);

    expect(clocks.wallNowMs() - wall0).toBe(JUMP_MS);
    expect(clocks.monotonicNowMs() - mono0).toBe(0);
  });

  it('real time passing moves BOTH clocks by the same amount — so a green result is not green for want of a jump', () => {
    const clocks = useTwoClocks();
    const wall0 = clocks.wallNowMs();
    const mono0 = clocks.monotonicNowMs();

    clocks.passRealTime(REAL_ELAPSED_MS);

    expect(clocks.wallNowMs() - wall0).toBe(REAL_ELAPSED_MS);
    expect(clocks.monotonicNowMs() - mono0).toBe(REAL_ELAPSED_MS);
  });

  it('the faked Date reaches `new Date()`, which is what records `startedAt`', () => {
    useTwoClocks();
    expect(new Date().toISOString()).toBe(new Date(WALL_START_MS).toISOString());
  });
});

// ===========================================================================
// 1. StopService RESPONSE — stop-service.md:47 rule 5.
// ===========================================================================
describe('StopService RESPONSE — actualDurationSeconds survives a clock correction', () => {
  it('a +1h wall-clock step mid-session does not change the reported duration', async () => {
    const clocks = useTwoClocks();
    const { station, sent } = makeStationContext();

    await new StartServiceHandler().handle(startEnvelope(), station);
    clocks.passRealTime(REAL_ELAPSED_MS);
    clocks.stepWallClockOnly(JUMP_MS);
    await new StopServiceHandler().handle(stopEnvelope(), station);

    const p = stopResponseOf(sent);
    expect(p.status).toBe('Accepted');
    expect(p.actualDurationSeconds).toBe(HONEST_SECONDS);
    expect(p.creditsCharged).toBe(HONEST_CREDITS);
  });

  it('a -1h wall-clock step mid-session does not change it either — and the frame stays schema-valid', async () => {
    // The backwards direction is the worse one HERE: this site has no clamp, so a
    // wall-clock difference goes negative, and `minimum: 0` on
    // stop-service-response.schema.json makes that an invalid frame — a settlement
    // a validating server drops on ingest.
    const clocks = useTwoClocks();
    const { station, sent } = makeStationContext();

    await new StartServiceHandler().handle(startEnvelope(), station);
    clocks.passRealTime(REAL_ELAPSED_MS);
    clocks.stepWallClockOnly(-JUMP_MS);
    await new StopServiceHandler().handle(stopEnvelope(), station);

    const p = stopResponseOf(sent);
    expect(p.actualDurationSeconds).toBe(HONEST_SECONDS);
    expect(p.creditsCharged).toBe(HONEST_CREDITS);
    expect(schemaErrors('stop-service-response.schema.json', p)).toEqual([]);
  });

  it('INVERSE CONTROL: with no correction at all, a real 40s wash still reports 40s and 67 credits', async () => {
    // The control that keeps the fix from being "return a constant": nothing is
    // planted here, both clocks advance together, and the honest answer must be
    // unchanged from what the wall-clock version produced.
    const clocks = useTwoClocks();
    const { station, sent } = makeStationContext();

    await new StartServiceHandler().handle(startEnvelope(), station);
    clocks.passRealTime(REAL_ELAPSED_MS);
    await new StopServiceHandler().handle(stopEnvelope(), station);

    const p = stopResponseOf(sent);
    expect(p.actualDurationSeconds).toBe(HONEST_SECONDS);
    expect(p.creditsCharged).toBe(HONEST_CREDITS);
    expect(schemaErrors('stop-service-response.schema.json', p)).toEqual([]);
  });

  it('INVERSE CONTROL: the duration still TRACKS real time — 40s and 150s are not the same number', async () => {
    // A monotonic clock that never moved would pass every test above. This one
    // fails unless the reading actually advances with real elapsed time.
    const clocks = useTwoClocks();
    const { station, sent } = makeStationContext();

    await new StartServiceHandler().handle(startEnvelope(), station);
    clocks.passRealTime(150_000);
    await new StopServiceHandler().handle(stopEnvelope(), station);

    const p = stopResponseOf(sent);
    expect(p.actualDurationSeconds).toBe(150);
    expect(p.creditsCharged).toBe(250);
  });

  it('rounds to the NEAREST second, not by truncation — stop-service.md:47 rule 5', async () => {
    // The rule states the rounding because it is the last arithmetic before money:
    // 40.662s rounds to 41s/69cr and truncates to 40s/67cr — two conformant
    // stations billing 2 credits apart for one wash.
    const clocks = useTwoClocks();
    const { station, sent } = makeStationContext();

    await new StartServiceHandler().handle(startEnvelope(), station);
    clocks.passRealTime(40_662);
    await new StopServiceHandler().handle(stopEnvelope(), station);

    const p = stopResponseOf(sent);
    expect(p.actualDurationSeconds).toBe(41);
    expect(p.creditsCharged).toBe(69);
  });
});

// ===========================================================================
// 2. THE OTHER HALF OF RULE 6 — the wall clock keeps the job that IS its job.
// ===========================================================================
describe('the wire timestamp stays REAL time — heartbeat.md:51 rule 6', () => {
  it('`startedAt` is the wall-clock instant the session began, not a monotonic reading', async () => {
    // "The wall clock's job in a session is to stamp values that get ORDERED —
    // the envelope `timestamp`, `startedAt`, `endedAt`." Fixing the differenced
    // value must not move the stamped one onto the monotonic clock, which is
    // meaningless off-process and would be unorderable against anything.
    useTwoClocks();
    const { station, sessions } = makeStationContext();

    await new StartServiceHandler().handle(startEnvelope(), station);

    const session = sessions.get('sess_c10c4a11')!;
    expect(session.startedAt).toBe(new Date(WALL_START_MS).toISOString());
    expect(Date.parse(session.startedAt)).toBe(WALL_START_MS);
  });

  it('and it keeps tracking the wall clock across a correction — a later session stamps the CORRECTED time', async () => {
    // Positive control on the claim above: the stamp is not frozen, it is the
    // wall clock, so the +1h correction shows up in it. That is correct — the
    // stamp is what gets ordered against server-side rows.
    const clocks = useTwoClocks();
    const { station, sessions } = makeStationContext();

    clocks.stepWallClockOnly(JUMP_MS);
    await new StartServiceHandler().handle(startEnvelope(), station);

    expect(Date.parse(sessions.get('sess_c10c4a11')!.startedAt)).toBe(WALL_START_MS + JUMP_MS);
  });
});

// ===========================================================================
// 3. SessionEnded EVENT — session-ended.md:61 rule 2. The SECOND site.
// ===========================================================================
function makeStationConfig(): StationConfig {
  return {
    stationId: 'stn_c10c4a11',
    firmwareVersion: '1.0.0', stationModel: 'M', stationVendor: 'V', timezone: 'UTC',
    bays: [{
      bayId: 'bay_c10c4a11', bayNumber: 1,
      programs: [{ programNumber: 1, label: 'P1', available: true }],
      services: [{ serviceId: 'svc_clock', serviceName: 'Wash', available: true }],
    }],
    behavior: { acceptRate: 1, responseDelayMs: [0, 0], heartbeatIntervalSec: 30, meterValuesIntervalSec: 10 },
  } as unknown as StationConfig;
}

/** A real Station whose session was written by the real StartServiceHandler. */
async function realStationMidSession(): Promise<{ station: Station; sent: Record<string, unknown>[] }> {
  const station = new Station(makeStationConfig(), {} as never);
  const sent: Record<string, unknown>[] = [];
  vi.spyOn(station.sender, 'send').mockImplementation(
    (async (_a: unknown, _t: unknown, p: unknown) => {
      sent.push(p as Record<string, unknown>);
    }) as never,
  );
  await new StartServiceHandler().handle(startEnvelope(), station as unknown as StationContext);
  sent.length = 0; // drop the StartService RESPONSE; the settle is what is under test
  return { station, sent };
}

describe('SessionEnded EVENT — actualDurationSeconds survives a clock correction', () => {
  it('a +1h wall-clock step mid-session does not change the reported duration', async () => {
    const clocks = useTwoClocks();
    const { station, sent } = await realStationMidSession();

    clocks.passRealTime(REAL_ELAPSED_MS);
    clocks.stepWallClockOnly(JUMP_MS);
    await station.settleSessionAsOperatorStop('sess_c10c4a11');

    expect(sent).toHaveLength(1);
    expect(sent[0].actualDurationSeconds).toBe(HONEST_SECONDS);
    expect(sent[0].creditsCharged).toBe(HONEST_CREDITS);
  });

  it('a -1h step does not silently zero the bill for a wash that was delivered', async () => {
    // This site DOES clamp with Math.max(0, ...), so the backwards direction here
    // is not an invalid frame — it is a schema-valid claim that the customer
    // received nothing. That is the worse failure of the two, because nothing
    // downstream can see it.
    const clocks = useTwoClocks();
    const { station, sent } = await realStationMidSession();

    clocks.passRealTime(REAL_ELAPSED_MS);
    clocks.stepWallClockOnly(-JUMP_MS);
    await station.settleSessionAsOperatorStop('sess_c10c4a11');

    expect(sent[0].actualDurationSeconds).toBe(HONEST_SECONDS);
    expect(sent[0].creditsCharged).toBe(HONEST_CREDITS);
    expect(schemaErrors('session-ended-event.schema.json', sent[0])).toEqual([]);
  });

  it('INVERSE CONTROL: with no correction, a real 40s wash still reports 40s and 67 credits', async () => {
    const clocks = useTwoClocks();
    const { station, sent } = await realStationMidSession();

    clocks.passRealTime(REAL_ELAPSED_MS);
    await station.settleSessionAsOperatorStop('sess_c10c4a11');

    expect(sent[0].actualDurationSeconds).toBe(HONEST_SECONDS);
    expect(sent[0].creditsCharged).toBe(HONEST_CREDITS);
    expect(schemaErrors('session-ended-event.schema.json', sent[0])).toEqual([]);
  });

  it('INVERSE CONTROL: the duration still TRACKS real time', async () => {
    const clocks = useTwoClocks();
    const { station, sent } = await realStationMidSession();

    clocks.passRealTime(150_000);
    await station.settleSessionAsOperatorStop('sess_c10c4a11');

    expect(sent[0].actualDurationSeconds).toBe(150);
    expect(sent[0].creditsCharged).toBe(250);
  });
});

// ===========================================================================
// 4. uptimeSeconds — the THIRD differenced duration on the wire, and the one
//    whose corruption force-fails live sessions server-side.
// ===========================================================================
describe('BootNotification uptimeSeconds — a differenced duration too', () => {
  it('a -1h wall-clock step does not make a running station claim it just power-cycled', async () => {
    // The CSMS derives bootTime = now - uptimeSeconds and force-fails (and
    // refunds) every session that started before that instant. A backwards
    // correction drives the wall-clock difference negative, the clamp reports 0,
    // and 0 means "I just power-cycled" — which kills every live wash on the
    // station. Station.currentUptimeSeconds' own docblock states that
    // consequence for the hardcoded-0 defect; a clock step reaches it too.
    const clocks = useTwoClocks();
    const station = new Station(makeStationConfig(), {} as never);
    const sent: Record<string, unknown>[] = [];
    vi.spyOn(station.sender, 'send').mockImplementation(
      (async (_a: unknown, _t: unknown, p: unknown) => {
        sent.push(p as Record<string, unknown>);
      }) as never,
    );

    clocks.passRealTime(600_000); // ten minutes up
    clocks.stepWallClockOnly(-JUMP_MS);
    await station.retryBoot();

    expect(sent[0].uptimeSeconds).toBe(600);
  });

  it('INVERSE CONTROL: with no correction, uptime still reports the real elapsed time', async () => {
    const clocks = useTwoClocks();
    const station = new Station(makeStationConfig(), {} as never);
    const sent: Record<string, unknown>[] = [];
    vi.spyOn(station.sender, 'send').mockImplementation(
      (async (_a: unknown, _t: unknown, p: unknown) => {
        sent.push(p as Record<string, unknown>);
      }) as never,
    );

    clocks.passRealTime(600_000);
    await station.retryBoot();

    expect(sent[0].uptimeSeconds).toBe(600);
  });
});
