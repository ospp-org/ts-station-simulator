import { describe, it, expect } from 'vitest';
import { SequenceCounter } from '../../station/SequenceCounter.js';

// ---------------------------------------------------------------------------
// The sequence counter is the STATION's. It was the scenario's.
//
// SendStep.injectSeqNoFields() read `session.seqNo`, stamped it into the payload
// only when the YAML omitted one, and advanced the counter to `payload.seqNo + 1`
// — from whatever the YAML said. So a scenario could:
//
//   - assert on a sequence the station never produced, and
//   - move the station's counter to an arbitrary value by writing one.
//
// That makes the simulator useless as evidence about ordering: a wire proof of
// "MeterValues arrive in sequence" would have been proving the YAML.
//
// Overriding is still needed — negative tests emit a late MeterValues with
// seqNo > finalSeqNo — but it must be an explicit, named act on the station's
// counter, not an incidental consequence of writing a number in a payload.
// ---------------------------------------------------------------------------

describe('SequenceCounter — the station owns the ordering', () => {
  it('starts at zero and advances one per issue', () => {
    const c = new SequenceCounter();

    expect([c.next(), c.next(), c.next()]).toEqual([0, 1, 2]);
  });

  it('peek does not advance', () => {
    const c = new SequenceCounter();
    c.next();

    expect(c.peek()).toBe(1);
    expect(c.peek()).toBe(1);
    expect(c.next()).toBe(1);
  });

  it('a value handed in from outside does NOT move the counter', () => {
    // The defect: `session.seqNo = payload.seqNo + 1` let a payload set the
    // station's next value. A scenario writing seqNo: 500 used to leave the
    // station issuing 501 next.
    const c = new SequenceCounter();
    c.next();
    c.next();

    expect(c.peek()).toBe(2);
  });

  it('forceTo() is the explicit override, and it is named', () => {
    // Negative tests need a late MeterValues with seqNo > finalSeqNo. That
    // remains possible — but as a deliberate call on the counter, so a reader of
    // a scenario can see that the ordering was tampered with on purpose.
    const c = new SequenceCounter();
    c.forceTo(500);

    expect(c.next()).toBe(500);
    expect(c.next()).toBe(501);
  });

  it('refuses to go backwards without saying so', () => {
    // Silently accepting a lower value would let a scenario replay a sequence
    // the station had already issued, which is the shape of the very defect the
    // ordering fields exist to detect.
    const c = new SequenceCounter();
    c.next();
    c.next();

    expect(() => c.forceTo(0)).toThrow(/backwards/i);
  });

  it('two sessions do not share a counter', () => {
    const a = new SequenceCounter();
    const b = new SequenceCounter();
    a.next();
    a.next();

    expect(b.next()).toBe(0);
  });
});
