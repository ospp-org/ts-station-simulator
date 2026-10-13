import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

/*
 * A connect-mode station on a stubbed MQTT link, for the tests that pin what the station does
 * on its OWN - the end of a wash, a restart, a reconnect (spec: every end it decides is reported
 * by SessionEnded, and every session it held is reported after a restart).
 *
 * The same stub the other Station tests declare inline, factored once because six files use it:
 * every publish is decoded into `wire.frames`, and the link's two events a real MqttConnection
 * re-emits from mqtt.js - `close` when the socket drops and `connect` when it comes back - are
 * driven by the test (`dropLink`, `restoreLink`), never by a timer.
 *
 * A test file mocks the module with it:
 *
 *   vi.mock('../../mqtt/MqttConnection.js', async () =>
 *     ({ MqttConnection: (await import('../helpers/stationHarness.js')).MqttConnectionStub }));
 */

export interface Frame {
  action: string;
  messageType: string;
  messageId: string;
  payload: Record<string, unknown>;
}

export const wire: {
  frames: Frame[];
  /** Called synchronously for every frame as it is published - to read the disk at that instant. */
  onPublish: ((frame: Frame) => void) | null;
  /** The certificate paths the next stub reports; the session record lives beside them. */
  tlsPaths: { key: string; cert: string } | null;
  connections: MqttConnectionStub[];
} = { frames: [], onPublish: null, tlsPaths: null, connections: [] };

export class MqttConnectionStub extends EventEmitter {
  setTls = vi.fn();
  destroyConnection = vi.fn();
  severConnection = vi.fn();
  disconnect = vi.fn(async () => undefined);
  subscribe = vi.fn(async () => undefined);
  onMessage = vi.fn();
  getTlsPaths = vi.fn(() => wire.tlsPaths ?? undefined);
  publish = vi.fn(async (_topic: string, raw: string | Buffer) => {
    const envelope = JSON.parse(String(raw)) as Frame;
    const frame: Frame = {
      action: envelope.action,
      messageType: envelope.messageType,
      messageId: envelope.messageId,
      payload: envelope.payload,
    };
    wire.frames.push(frame);
    wire.onPublish?.(frame);
  });
  connect = vi.fn(() => {
    // A microtask, not setImmediate: the tests fake the timers, and the connack must not wait for them.
    queueMicrotask(() => this.emit('connect', {}));
  });

  constructor() {
    super();
    wire.connections.push(this);
  }
}

export const SESSION_KEY = Buffer.from(new Uint8Array(32).fill(3)).toString('base64');
export const STATION_ID = 'stn_e2d00001';
export const BAY_ID = 'bay_e2d00001';
export const SERVICE_ID = 'svc_wash_basic';

/** The real timer, taken before any test fakes the clock: the disk works in real time. */
const realSetTimeout: typeof setTimeout = globalThis.setTimeout;

function realPause(ms: number): Promise<void> {
  return new Promise<void>((resolve) => realSetTimeout(resolve, ms));
}

/** The fake clock every one of these tests runs on - the monotonic one included, since durations are measured on it. */
export function fakeClock(): void {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
}

/**
 * Let `ms` of station time pass, a second at a time, with real time between the seconds.
 *
 * The station writes its session record on the REAL disk, and the fake clock does not wait for it:
 * one jump of 55 s fires every timer of those 55 s while the first write is still in flight - a
 * station whose disk took a minute to write. A real station's write lands within the second it
 * starts in, and this is that.
 */
export async function elapse(ms: number, stepMs = 1000): Promise<void> {
  for (let done = 0; done < ms; done += stepMs) {
    await vi.advanceTimersByTimeAsync(Math.min(stepMs, ms - done));
    await realPause(2);
  }
}

/** A temporary certificate directory: what the station keeps on disk lives beside its certificates. */
export async function certDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'station-ends-'));
  const cert = path.join(dir, `${STATION_ID}.crt`);
  const key = path.join(dir, `${STATION_ID}.key`);
  await writeFile(cert, 'stub');
  await writeFile(key, 'stub');
  wire.tlsPaths = { cert, key };
  // A station abandoned mid-test may still be landing a write: retried, not failed on.
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }) };
}

export function resetWire(): void {
  wire.frames.length = 0;
  wire.onPublish = null;
  wire.tlsPaths = null;
  wire.connections.length = 0;
}

/**
 * The station config `simulator connect` builds, with the session-driving switches it sets. Typed
 * loosely on purpose: the switches are what these tests ask for, and on a tree that does not have
 * them yet the object must still be a StationConfig.
 */
export function connectConfig(extra: Record<string, unknown> = {}, behavior: Record<string, unknown> = {}): never {
  return {
    stationId: STATION_ID,
    firmwareVersion: '1.0.0',
    stationModel: 'WashPro X200',
    stationVendor: 'SimCorp',
    serialNumber: 'SN-E2D00001',
    bayCount: 1,
    timezone: 'Europe/Bucharest',
    bays: [
      {
        bayId: BAY_ID,
        bayNumber: 1,
        programs: [{ programNumber: 1, label: 'P1', available: true }],
        services: [{ serviceId: SERVICE_ID, serviceName: 'Basic Wash', available: true }],
      },
    ],
    behavior: {
      acceptRate: 1.0,
      responseDelayMs: [0, 0],
      heartbeatIntervalSec: 30,
      autoRetryBoot: false,
      ...behavior,
    },
    persistCatalog: true,
    persistSessions: true,
    rebootOnReconnect: true,
    ...extra,
  } as never;
}

export function request(action: string, payload: Record<string, unknown>, messageId?: string): never {
  return {
    messageId: messageId ?? `cmd_${action}_${Math.random().toString(16).slice(2, 10)}`,
    messageType: 'Request',
    action,
    source: 'Server',
    timestamp: new Date().toISOString(),
    protocolVersion: '0.3.0',
    payload,
  } as never;
}

export function bootAccepted(): never {
  return {
    messageId: `boot_${Math.random().toString(16).slice(2, 10)}`,
    messageType: 'Response',
    action: 'BootNotification',
    source: 'Server',
    timestamp: new Date().toISOString(),
    protocolVersion: '0.3.0',
    payload: {
      status: 'Accepted',
      serverTime: new Date().toISOString(),
      heartbeatIntervalSec: 30,
      sessionKey: SESSION_KEY,
    },
  } as never;
}

export function startService(sessionId: string, durationSeconds: number): never {
  return request('StartService', {
    sessionId,
    bayId: BAY_ID,
    serviceId: SERVICE_ID,
    durationSeconds,
    sessionSource: 'MobileApp',
    programNumber: 1,
  });
}

/** Wait in REAL time until `cond` holds - file writes finish there, not on the fake clock. */
export async function until(cond: () => boolean | Promise<boolean>, what: string, tries = 1500): Promise<void> {
  if (await settled(cond, tries)) return;
  throw new Error(`never happened: ${what}; frames: ${JSON.stringify(wire.frames.map((f) => `${f.action}/${f.messageType}`))}`);
}

/** The same wait, reporting instead of throwing - for a step whose absence a later assertion names better. */
export async function settled(cond: () => boolean | Promise<boolean>, tries = 1500): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await cond()) return true;
    await realPause(1);
  }
  return false;
}

export function frames(action: string, messageType?: string, since = 0): Frame[] {
  return wire.frames
    .slice(since)
    .filter((f) => f.action === action && (messageType === undefined || f.messageType === messageType));
}

export function indexOf(predicate: (f: Frame) => boolean, since = 0): number {
  const i = wire.frames.slice(since).findIndex(predicate);
  return i === -1 ? -1 : i + since;
}

/** The file the station keeps its live sessions in, beside its certificate. */
export function sessionRecordFile(): string {
  if (wire.tlsPaths === null) throw new Error('no certificate directory');
  return path.join(path.dirname(wire.tlsPaths.cert), `${STATION_ID}-sessions.json`);
}

/** What that file holds right now, read synchronously; an absent file holds nothing. */
export function readSessionRecord(): { sessions: Array<Record<string, unknown>>; heldSessionEnded: unknown[] } {
  const file = sessionRecordFile();
  if (!existsSync(file)) return { sessions: [], heldSessionEnded: [] };
  const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { sessions?: Array<Record<string, unknown>>; heldSessionEnded?: unknown[] };
  return { sessions: parsed.sessions ?? [], heldSessionEnded: parsed.heldSessionEnded ?? [] };
}
