import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameJournal, type JournalledFrame } from '../../mqtt/FrameJournal.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'frame-journal-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ENVELOPE = JSON.stringify({
  messageId: '11111111-2222-3333-4444-555555555555',
  messageType: 'Request',
  action: 'GetConfiguration',
  source: 'CSMS',
  protocolVersion: '0.3.0',
  payload: { keys: ['HeartbeatInterval'] },
});

describe('FrameJournal — the five fields the journal exists to carry', () => {
  it('records direction, action, messageId, a timestamp and the RAW payload, in and out', () => {
    const j = new FrameJournal();
    j.record('out', 'ospp/stations/stn_aaaaaaaa/server', ENVELOPE, 1);
    j.record('in', 'ospp/stations/stn_aaaaaaaa/station', ENVELOPE, 1);

    const frames = j.frames;
    expect(frames).toHaveLength(2);

    expect(frames[0].direction).toBe('out');
    expect(frames[1].direction).toBe('in');
    for (const f of frames) {
      expect(f.action).toBe('GetConfiguration');
      expect(f.messageType).toBe('Request');
      expect(f.messageId).toBe('11111111-2222-3333-4444-555555555555');
      // RAW, byte-for-byte — not a re-serialisation. A journal that re-encodes
      // cannot be used to prove what left the process.
      expect(f.payload).toBe(ENVELOPE);
      expect(f.bytes).toBe(Buffer.byteLength(ENVELOPE));
      expect(f.at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    }
  });

  it('seq is 1-based and strictly increasing, so wire order is recoverable', () => {
    const j = new FrameJournal();
    j.record('out', 't', ENVELOPE, 1);
    j.record('in', 't', ENVELOPE, 1);
    j.record('out', 't', ENVELOPE, 0);
    expect(j.frames.map(f => f.seq)).toEqual([1, 2, 3]);
  });

  it('monotonicMs never decreases, so elapsed is differenced off a monotonic source', () => {
    const j = new FrameJournal();
    for (let i = 0; i < 5; i++) j.record('out', 't', ENVELOPE, 1);
    const readings = j.frames.map(f => f.monotonicMs);
    for (let i = 1; i < readings.length; i++) {
      expect(readings[i]).toBeGreaterThanOrEqual(readings[i - 1]);
    }
  });
});

describe('FrameJournal — a frame that is not a parseable envelope is still journalled', () => {
  it('unparseable bytes journal with null action and the raw payload intact', () => {
    const j = new FrameJournal();
    j.record('in', 'ospp/stations/stn_aaaaaaaa/station', 'not json at all {{{', 1);

    const [f] = j.frames;
    expect(f.action).toBeNull();
    expect(f.messageType).toBeNull();
    expect(f.messageId).toBeNull();
    expect(f.payload).toBe('not json at all {{{');
  });

  it('valid JSON that is not an envelope journals with nulls rather than being dropped', () => {
    const j = new FrameJournal();
    j.record('in', 't', '[]', 1);
    j.record('in', 't', '{"payload":{}}', 1);
    expect(j.frames).toHaveLength(2);
    expect(j.frames.every(f => f.action === null)).toBe(true);
  });

  it('a Buffer payload is journalled as its utf-8 bytes', () => {
    const j = new FrameJournal();
    j.record('out', 't', Buffer.from(ENVELOPE, 'utf-8'), 1);
    expect(j.frames[0].payload).toBe(ENVELOPE);
    expect(j.frames[0].bytes).toBe(Buffer.byteLength(ENVELOPE));
  });
});

describe('FrameJournal — the file is JSONL and is written on the spot', () => {
  it('one JSON object per line, parseable without the producing process', () => {
    const file = join(dir, 'wire.jsonl');
    const j = new FrameJournal({ file });
    j.record('out', 'topic-a', ENVELOPE, 1);
    j.record('in', 'topic-b', 'garbage', 0);

    const lines = readFileSync(file, 'utf-8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);

    const parsed = lines.map(l => JSON.parse(l) as JournalledFrame);
    expect(parsed[0].direction).toBe('out');
    expect(parsed[0].topic).toBe('topic-a');
    expect(parsed[0].action).toBe('GetConfiguration');
    expect(parsed[1].direction).toBe('in');
    expect(parsed[1].action).toBeNull();
    expect(parsed[1].payload).toBe('garbage');
  });

  it('the line is on disk BEFORE record() returns — the last frame before an exit survives', () => {
    const file = join(dir, 'wire.jsonl');
    const j = new FrameJournal({ file });
    j.record('out', 't', ENVELOPE, 1);
    // No flush(), no close(), no await: read it straight back. This is the property
    // Part 3 rests on — a PlannedShutdown is the last frame before the process goes.
    expect(readFileSync(file, 'utf-8').trimEnd().split('\n')).toHaveLength(1);
  });

  it('a journal with no file keeps everything in memory and writes nothing', () => {
    const file = join(dir, 'never.jsonl');
    const j = new FrameJournal();
    j.record('out', 't', ENVELOPE, 1);
    expect(j.frames).toHaveLength(1);
    expect(existsSync(file)).toBe(false);
  });

  it('an unwritable path does not take the station down with it', () => {
    // A journal is an instrument. It may not become a reason a station fails to
    // publish — so a broken sink degrades to memory-only and says so.
    const j = new FrameJournal({ file: join(dir, 'no-such-dir', 'wire.jsonl') });
    expect(() => j.record('out', 't', ENVELOPE, 1)).not.toThrow();
    expect(j.frames).toHaveLength(1);
    expect(j.sinkError).toBeTruthy();
  });
});

describe('FrameJournal — the assertion surface a scenario reads', () => {
  const j = () => {
    const journal = new FrameJournal();
    journal.record('out', 't', JSON.stringify({ messageId: 'a', messageType: 'Request', action: 'BootNotification', payload: {} }), 1);
    journal.record('in', 't', JSON.stringify({ messageId: 'a', messageType: 'Response', action: 'BootNotification', payload: { status: 'Accepted' } }), 1);
    journal.record('out', 't', JSON.stringify({ messageId: 'b', messageType: 'Event', action: 'ConnectionLost', payload: { reason: 'PlannedShutdown' } }), 1);
    return journal;
  };

  it('select() filters by direction, action and messageType', () => {
    expect(j().select({ direction: 'out' })).toHaveLength(2);
    expect(j().select({ action: 'BootNotification' })).toHaveLength(2);
    expect(j().select({ direction: 'out', action: 'BootNotification' })).toHaveLength(1);
    expect(j().select({ messageType: 'Event' })).toHaveLength(1);
    expect(j().select({ direction: 'in', action: 'ConnectionLost' })).toHaveLength(0);
  });

  it('count() is the same filter, so an assertion can state a denominator', () => {
    expect(j().count({ direction: 'out', action: 'ConnectionLost' })).toBe(1);
    expect(j().count({ direction: 'out', action: 'StopService' })).toBe(0);
  });

  it('the projection exposes parsed envelopes AND counts, addressable by path', () => {
    const view = j().projection();
    expect(view.counts.out.ConnectionLost).toBe(1);
    expect(view.counts.in.BootNotification).toBe(1);
    expect(view.counts.out.StopService).toBeUndefined();
    expect(view.total).toBe(3);

    // The shape AssertStep's path resolver walks: an array of frames whose
    // `envelope` is the parsed frame, selectable on any envelope field.
    const outbound = view.out;
    expect(Array.isArray(outbound)).toBe(true);
    const lost = outbound.find(f => f.action === 'ConnectionLost');
    expect(lost?.envelope).toEqual({
      messageId: 'b',
      messageType: 'Event',
      action: 'ConnectionLost',
      payload: { reason: 'PlannedShutdown' },
    });
  });

  it('an unparseable frame appears in the projection with a null envelope', () => {
    const journal = new FrameJournal();
    journal.record('in', 't', 'garbage', 1);
    expect(journal.projection().in[0].envelope).toBeNull();
    expect(journal.projection().counts.in).toEqual({});
  });
});

describe('FrameJournal — the memory window is bounded and says when it dropped', () => {
  it('keeps the newest maxInMemory frames and counts what it let go', () => {
    const j = new FrameJournal({ maxInMemory: 3 });
    for (let i = 0; i < 5; i++) {
      j.record('out', 't', JSON.stringify({ messageId: String(i), messageType: 'Event', action: 'Heartbeat', payload: {} }), 1);
    }
    expect(j.frames).toHaveLength(3);
    expect(j.frames.map(f => f.seq)).toEqual([3, 4, 5]);
    expect(j.droppedFromMemory).toBe(2);
  });

  it('the file keeps every frame even when memory dropped some', () => {
    const file = join(dir, 'wire.jsonl');
    const j = new FrameJournal({ file, maxInMemory: 2 });
    for (let i = 0; i < 4; i++) j.record('out', 't', ENVELOPE, 1);
    expect(j.frames).toHaveLength(2);
    expect(readFileSync(file, 'utf-8').trimEnd().split('\n')).toHaveLength(4);
  });
});
