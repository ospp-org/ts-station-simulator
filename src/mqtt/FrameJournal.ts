import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { monotonicNowMs } from '../station/monotonicClock.js';

export type FrameDirection = 'out' | 'in';

/**
 * One frame, in one direction, exactly as it crossed the socket.
 *
 * `payload` is the RAW string. Not a re-serialisation of a parsed object: a
 * journal that re-encodes cannot be used to prove what left the process, which
 * is the only thing it is for. Key order, whitespace and a trailing byte are all
 * preserved, so a MAC recomputed from a journalled frame verifies.
 */
export interface JournalledFrame {
  /** 1-based, per journal, strictly increasing. Wire order is recoverable from it. */
  seq: number;
  /**
   * Wall clock, ISO-8601, for a human reading the file.
   *
   * NOT what an elapsed-time assertion differences — see `monotonicMs`. Both are
   * carried because the two readers want different clocks and this repo has paid
   * for conflating them: a wall-clock step made a 40-second session bill 6067
   * credits.
   */
  at: string;
  /** The monotonic reading at the same instant. The only source an elapsed is differenced from. */
  monotonicMs: number;
  direction: FrameDirection;
  topic: string;
  /**
   * Derived from the payload by a TOLERANT parse, `null` when the bytes are not a
   * recognisable envelope.
   *
   * Null is a value here, not a failure: a malformed or forged frame is exactly
   * the frame an adversarial run is looking for, so it is journalled with nulls
   * rather than dropped. The three gates in MessageRouter (parse, MAC, schema)
   * each refuse a frame and emit nothing — a journal placed behind them would be
   * blind to every refusal.
   */
  action: string | null;
  messageType: string | null;
  messageId: string | null;
  /** Byte length of the raw payload, so an envelope-cap argument can be made from the file. */
  bytes: number;
  qos: 0 | 1 | 2;
  payload: string;
}

export interface FrameSelector {
  direction?: FrameDirection;
  action?: string;
  messageType?: string;
  messageId?: string;
}

/** A journalled frame with its envelope parsed, for path-based assertions. */
export interface ProjectedFrame extends JournalledFrame {
  /** The parsed envelope, or `null` for bytes that are not one. */
  envelope: Record<string, unknown> | null;
}

export interface JournalProjection {
  total: number;
  out: ProjectedFrame[];
  in: ProjectedFrame[];
  frames: ProjectedFrame[];
  /** `counts.out.ConnectionLost` — per direction, per action. Absent action means zero. */
  counts: { out: Record<string, number>; in: Record<string, number> };
  droppedFromMemory: number;
  file?: string;
}

export interface FrameJournalOptions {
  /**
   * Append every frame here as JSONL. Omit for memory only.
   *
   * The write is SYNCHRONOUS and happens inside `record()`. That is a deliberate
   * trade of throughput for two properties an instrument cannot do without:
   *
   *   order    — the file order is the order `record()` was called, which is the
   *              order frames crossed the socket. An async queue can settle a
   *              slow outbound write after a fast inbound one and silently
   *              reorder cause and effect;
   *   the last
   *   frame    — a buffered writer loses whatever is still in the buffer when the
   *              process exits, and the interesting frame is very often the last
   *              one (a ConnectionLost/PlannedShutdown is published immediately
   *              before a clean DISCONNECT and the exit that follows it).
   *
   * Frames are small and few — hundreds per run, not millions — so the cost is
   * not measurable next to a network round trip.
   */
  file?: string;
  /**
   * How many frames stay addressable in memory. The FILE keeps every frame
   * regardless; this bounds only the assertion window, so a long-lived `connect`
   * session cannot grow without limit. Whatever falls out is COUNTED
   * (`droppedFromMemory`) rather than silently forgotten — an assertion that
   * reads a truncated window must be able to tell.
   */
  maxInMemory?: number;
}

const DEFAULT_MAX_IN_MEMORY = 5000;

/**
 * Every frame in and out, machine-readable.
 *
 * `connect` printed frames to stdout and kept nothing, so nothing could be
 * asserted on the wire: every adversarial round so far wrote its own MQTT client
 * rather than use this simulator, and the absence of a journal is one of the
 * three reasons. Reading the journal is not grepping the log — the file is JSONL
 * and the in-memory projection is addressable by path from a scenario.
 *
 * Placed at the MqttConnection chokepoints (`publish()` and the client's
 * 'message' event) rather than at MessageSender/MessageRouter, because those two
 * see only the frames that pass their own gates: `MessageRouter.route()` refuses
 * and emits nothing on a parse, MAC or schema failure, and the LWT never travels
 * through `send()` at all — a journal behind either would miss exactly the frames
 * worth measuring. (`MessageSender.sendEnvelope()` was a third reason until it was
 * deleted as an uncalled publish path that skipped the signing guard.)
 */
export class FrameJournal {
  private readonly entries: JournalledFrame[] = [];
  private readonly maxInMemory: number;
  private readonly sink?: string;
  private nextSeq = 1;
  private dropped = 0;
  private sinkFailure: string | null = null;

  constructor(options: FrameJournalOptions = {}) {
    this.sink = options.file;
    this.maxInMemory = options.maxInMemory ?? DEFAULT_MAX_IN_MEMORY;
  }

  /** The addressable window, oldest first. */
  get frames(): readonly JournalledFrame[] {
    return this.entries;
  }

  /** How many frames the memory window has let go. The file still has them. */
  get droppedFromMemory(): number {
    return this.dropped;
  }

  /**
   * Why the sink is not being written, or null.
   *
   * Recorded rather than thrown: a journal is an instrument, and it may never
   * become the reason a station fails to publish. A caller that wants the run to
   * stop on a broken sink reads this.
   */
  get sinkError(): string | null {
    return this.sinkFailure;
  }

  get file(): string | undefined {
    return this.sink;
  }

  record(
    direction: FrameDirection,
    topic: string,
    payload: string | Buffer,
    qos: 0 | 1 | 2,
  ): JournalledFrame {
    const raw = typeof payload === 'string' ? payload : payload.toString('utf-8');
    const parsed = parseEnvelope(raw);

    const frame: JournalledFrame = {
      seq: this.nextSeq++,
      at: new Date().toISOString(),
      monotonicMs: monotonicNowMs(),
      direction,
      topic,
      action: stringOrNull(parsed?.action),
      messageType: stringOrNull(parsed?.messageType),
      messageId: stringOrNull(parsed?.messageId),
      bytes: Buffer.byteLength(raw, 'utf-8'),
      qos,
      payload: raw,
    };

    this.entries.push(frame);
    while (this.entries.length > this.maxInMemory) {
      this.entries.shift();
      this.dropped++;
    }

    if (this.sink !== undefined && this.sinkFailure === null) {
      try {
        appendFileSync(this.sink, `${JSON.stringify(frame)}\n`, 'utf-8');
      } catch (err) {
        this.sinkFailure = err instanceof Error ? err.message : String(err);
        console.warn(
          '[FrameJournal] cannot append to %s (%s) — the journal continues in memory only',
          this.sink,
          this.sinkFailure,
        );
      }
    }

    return frame;
  }

  select(selector: FrameSelector = {}): JournalledFrame[] {
    return this.entries.filter(f =>
      (selector.direction === undefined || f.direction === selector.direction) &&
      (selector.action === undefined || f.action === selector.action) &&
      (selector.messageType === undefined || f.messageType === selector.messageType) &&
      (selector.messageId === undefined || f.messageId === selector.messageId));
  }

  count(selector: FrameSelector = {}): number {
    return this.select(selector).length;
  }

  /**
   * The shape a scenario asserts against.
   *
   * Counts are keyed by action and an action that never appeared is ABSENT rather
   * than zero. That is deliberate: `equals: 0` on a missing key and on a real zero
   * must not be the same assertion, because "this action was never seen" and "this
   * action was seen zero times" are the same fact only when the journal itself is
   * known to be live. `total` is there to establish that.
   */
  projection(): JournalProjection {
    const projected = this.entries.map(toProjected);
    const counts: JournalProjection['counts'] = { out: {}, in: {} };
    for (const f of this.entries) {
      if (f.action === null) continue;
      const bucket = counts[f.direction];
      bucket[f.action] = (bucket[f.action] ?? 0) + 1;
    }

    const view: JournalProjection = {
      total: projected.length,
      out: projected.filter(f => f.direction === 'out'),
      in: projected.filter(f => f.direction === 'in'),
      frames: projected,
      counts,
      droppedFromMemory: this.dropped,
    };
    if (this.sink !== undefined) view.file = this.sink;
    return view;
  }
}

function toProjected(frame: JournalledFrame): ProjectedFrame {
  return { ...frame, envelope: parseEnvelope(frame.payload) };
}

/**
 * Parse only what is recognisably an envelope: a JSON OBJECT. An array, a bare
 * number and a broken string all return null, and the raw bytes are kept either
 * way.
 */
function parseEnvelope(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Where `simulator connect` puts a journal when no path is given. Gitignored in full. */
export const DEFAULT_JOURNAL_DIR = 'tests/artifacts/journal';

/**
 * Turn the `--journal` / `--no-journal` pair into a sink path, or null for off.
 *
 * ON BY DEFAULT, deliberately. The whole reason `connect` was unusable as an
 * adversarial instrument is that nothing could be asserted on the wire
 * afterwards; a journal that has to be remembered is a journal that is missing
 * exactly on the run someone needed it for. `--no-journal` is the way out for a
 * run that must not write to disk.
 *
 * `--journal` with an empty value is REFUSED rather than read as the default: it
 * is what a shell produces from an unset variable (`--journal "$OUT"`), and
 * silently writing somewhere else is how evidence goes missing.
 */
export function resolveJournalSink(
  option: string | boolean | undefined,
  stationId: string,
  now: Date = new Date(),
): string | null {
  if (option === false) return null;
  if (typeof option === 'string') {
    if (option.length === 0) {
      throw new Error(
        '--journal was given an empty path. Pass a path, omit the flag for the default under ' +
          `${DEFAULT_JOURNAL_DIR}/, or pass --no-journal to turn journalling off.`,
      );
    }
    return option;
  }
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return join(DEFAULT_JOURNAL_DIR, `${stationId}-${stamp}.jsonl`);
}

/**
 * Create the sink's directory so the first `record()` does not degrade to
 * memory-only.
 *
 * Separate from the constructor because FrameJournal is also used with a path a
 * caller has already prepared, and a constructor that makes directories is a
 * constructor with a side effect on disk.
 */
export function prepareJournalSink(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
}
