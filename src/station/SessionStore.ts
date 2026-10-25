import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionEndedPayload, StopServiceResponse } from '@ospp/protocol';

/**
 * How stale the delivered time a station reports after a power loss may be: the session record's
 * delivered time is written at least this often while a wash runs (session-end rule S2 - "updated
 * as it delivers ... at least every 10 s"). ONE constant: the checkpoint timer reads it and nothing
 * else states the number.
 */
export const SESSION_CHECKPOINT_INTERVAL_SECONDS = 10;

/**
 * The OSPP Session Retention Horizon (02-transport.md §5.3): a stop answered `Accepted` is answered
 * the same way, from its cached RESPONSE, for at least this long (stop-service.md §6 rule 10).
 */
export const STOP_ANSWER_RETENTION_MS = 24 * 60 * 60 * 1000;

/** One live session, as the next power-on needs it. */
export interface StoredSession {
  sessionId: string;
  bayId: string;
  serviceId: string;
  /** start-service.md §6 rule 9's minimum record: the command's messageId, the session, the bay and the program. */
  startMessageId?: string;
  programNumber?: number;
  /** Wall clock, ISO-8601 - the stamp, never the origin of a duration. */
  startedAt: string;
  durationSeconds: number;
  /** Delivered when this record was written; what a restart that cannot resume reports. */
  deliveredSeconds: number;
  /** The wall-clock instant of that checkpoint, for a reader of the file. */
  checkpointedAt: string;
  /** The session's next seqNo (SequenceCounter.peek()). */
  seqNo: number;
  priceCreditsPerMinute: number;
}

/** A SessionEnded the station built and could not yet publish - kept with its original values (session-ended.md §5 rule 3). */
export interface HeldSessionEnded {
  /** Reused on every attempt, so a retransmission is the same message. */
  messageId: string;
  payload: SessionEndedPayload;
  endedAt: string;
}

/**
 * A message the broker did not acknowledge with success - a PUBACK 0x10 or any other code than 0x00, or none at a
 * reconnection to a broker that kept no session - kept for the replay after the next accepted boot (freeze item 33,
 * 01-architecture.md §6.5). A SessionEnded of the station's own sessions is held in `heldSessionEnded` instead.
 */
export interface HeldMessage {
  action: string;
  messageType: string;
  /** Reused by the resend, so a copy the server did receive is a duplicate it discards (02-transport.md §3.3). */
  messageId: string;
  payload: unknown;
  /** The PUBACK's reason code, or null when the broker kept no record of the message. */
  acknowledgement: number | null;
  /** Wall clock, ISO-8601: the order the replay keeps among records of one kind. */
  heldAt: string;
}

/** A stop answered `Accepted`: the RESPONSE a repeated StopService gets again (stop-service.md §6 rule 10). */
export interface StoppedSessionAnswer {
  sessionId: string;
  bayId: string;
  response: Extract<StopServiceResponse, { status: 'Accepted' }>;
  /** Wall clock, ISO-8601: the retention horizon runs from it. */
  answeredAt: string;
}

export interface StoredSessionState {
  stationId: string;
  savedAt: string;
  sessions: StoredSession[];
  heldSessionEnded: HeldSessionEnded[];
  stoppedSessions: StoppedSessionAnswer[];
  /** Absent from a record written before 2026-10-25, which held none. */
  heldMessages?: HeldMessage[];
}

export interface SessionStore {
  /** Where the record lives, or null for one kept in memory. */
  readonly path: string | null;
  load(): Promise<StoredSessionState | null>;
  save(state: StoredSessionState): Promise<void>;
}

/**
 * The live sessions this station holds, kept on disk - the simulator's NVS for them.
 *
 * Beside the certificates, like the catalog (CatalogStore) and the topology: the state a station
 * already keeps on disk. Written as a WHOLE REPLACEMENT, a temporary file renamed over the old one,
 * so a power loss mid-write leaves the previous record, never half of a new one.
 *
 * A record that cannot be read is REFUSED rather than treated as empty: a station that silently
 * dropped the sessions it held would be the orphaning station the session-end rule abolishes, and
 * the server would close each one with no record, charged in full.
 */
export class FileSessionStore implements SessionStore {
  readonly path: string;

  constructor(
    private readonly dir: string,
    private readonly stationId: string,
  ) {
    this.path = join(dir, `${stationId}-sessions.json`);
  }

  async load(): Promise<StoredSessionState | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<StoredSessionState>;
      for (const key of ['sessions', 'heldSessionEnded', 'stoppedSessions'] as const) {
        if (!Array.isArray(parsed[key])) throw new Error(`missing ${key}[]`);
      }
      if (parsed.heldMessages !== undefined && !Array.isArray(parsed.heldMessages)) throw new Error('heldMessages is not a list');
      for (const s of parsed.sessions as StoredSession[]) {
        if (typeof s.sessionId !== 'string' || typeof s.bayId !== 'string'
          || typeof s.durationSeconds !== 'number' || typeof s.deliveredSeconds !== 'number') {
          throw new Error('a session without sessionId, bayId, durationSeconds and deliveredSeconds');
        }
      }
      return parsed as StoredSessionState;
    } catch (err) {
      throw new Error(
        `Stored session record at ${this.path} is unreadable and will NOT be dropped: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          'Every session in it is one the server is waiting for an end record of; repair the file, ' +
          'or delete it knowing the server will close those sessions without one.',
      );
    }
  }

  async save(state: StoredSessionState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const temporary = `${this.path}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

/**
 * The same record kept in the process's own memory, for a station with no certificate directory (a
 * plaintext local target). It survives Station.restart() - the in-process power cycle - and nothing
 * else; `simulator connect` says so when it falls back to it.
 */
export class MemorySessionStore implements SessionStore {
  readonly path = null;
  private state: StoredSessionState | null = null;

  async load(): Promise<StoredSessionState | null> {
    return this.state === null ? null : structuredClone(this.state);
  }

  async save(state: StoredSessionState): Promise<void> {
    this.state = structuredClone(state);
  }
}
