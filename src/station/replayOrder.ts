import type { HeldMessage, HeldSessionEnded } from './SessionStore.js';

/** One record the replay sends: a message the broker did not acknowledge, or a SessionEnded of the station's own. */
export type ReplayItem = { kind: 'message'; message: HeldMessage } | { kind: 'end'; end: HeldSessionEnded };

/**
 * The kinds the replay sends fresh - the BootNotification (step 1), the bay reports (step 2) and the Heartbeats
 * (step 5) of 01-architecture.md §6.5's Reconnection Transmission Order. A held one is not sent again: the fresh one
 * stands in for it (freeze item 33).
 */
export const SENT_FRESH_BY_THE_REPLAY: ReadonlySet<string> = new Set(['BootNotification', 'StatusNotification', 'Heartbeat']);

const SESSION_RECORDS: ReadonlySet<string> = new Set(['MeterValues', 'SessionEnded']);
const OFFLINE_RECORDS: ReadonlySet<string> = new Set(['TransactionEvent', 'SessionStarted']);

/**
 * WHAT THE REPLAY SENDS, IN THE ORDER IT SENDS IT (freeze item 33, 2026-10-25) - the Reconnection Transmission Order of
 * 01-architecture.md §6.5 and connection-lost.md §6 step 4, after the boot and the bay reports: the SecurityEvents
 * (step 3); the session records, session by session - the sessions in the order their first record was held, each
 * session's records in the order its seqNo counts, its MeterValues before its SessionEnded (02-transport.md §3.2); the
 * offline records, TransactionEvents and SessionStarted, in the order they were held; then any other message, in the
 * order it was held. The kinds the replay sends fresh are left out (SENT_FRESH_BY_THE_REPLAY).
 */
export function replayOrder(held: readonly HeldMessage[], ends: readonly HeldSessionEnded[]): ReplayItem[] {
  const messages = held.filter((m) => !SENT_FRESH_BY_THE_REPLAY.has(m.action));

  const security = messages.filter((m) => m.action === 'SecurityEvent');

  const records: Array<{ sessionId: string; seqNo: number; at: string; item: ReplayItem }> = [
    ...messages
      .filter((m) => SESSION_RECORDS.has(m.action))
      .map((m) => ({ sessionId: field(m.payload, 'sessionId'), seqNo: seqNoOf(m.payload), at: m.heldAt, item: { kind: 'message' as const, message: m } })),
    ...ends.map((e) => ({ sessionId: e.payload.sessionId, seqNo: seqNoOf(e.payload), at: e.endedAt, item: { kind: 'end' as const, end: e } })),
  ];
  const firstHeld = new Map<string, string>();
  for (const r of records) {
    const seen = firstHeld.get(r.sessionId);
    if (seen === undefined || r.at < seen) firstHeld.set(r.sessionId, r.at);
  }
  const sessions = [...firstHeld.entries()].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(([id]) => id);
  const sessionRecords = sessions.flatMap((id) =>
    records.filter((r) => r.sessionId === id).sort((a, b) => a.seqNo - b.seqNo).map((r) => r.item));

  const offline = messages.filter((m) => OFFLINE_RECORDS.has(m.action));
  const rest = messages.filter((m) => m.action !== 'SecurityEvent' && !SESSION_RECORDS.has(m.action) && !OFFLINE_RECORDS.has(m.action));

  return [
    ...security.map((m) => ({ kind: 'message' as const, message: m })),
    ...sessionRecords,
    ...offline.map((m) => ({ kind: 'message' as const, message: m })),
    ...rest.map((m) => ({ kind: 'message' as const, message: m })),
  ];
}

function field(payload: unknown, name: string): string {
  const value = (payload as Record<string, unknown> | null)?.[name];
  return typeof value === 'string' ? value : '';
}

/** A record's seqNo; one that carries none goes after those that do. */
function seqNoOf(payload: unknown): number {
  const value = (payload as Record<string, unknown> | null)?.seqNo;
  return typeof value === 'number' ? value : Number.MAX_SAFE_INTEGER;
}
