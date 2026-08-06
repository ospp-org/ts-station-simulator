/**
 * The station's per-session ordering counter.
 *
 * It used to be the scenario's. `SendStep.injectSeqNoFields()` read
 * `session.seqNo`, stamped it only when the YAML omitted one, and then advanced
 * the counter to `payload.seqNo + 1` — from whatever the YAML said. So a scenario
 * could assert on a sequence the station never produced, and could move the
 * station's counter to any value simply by writing a number in a payload.
 *
 * That makes the simulator useless as evidence about ordering: a wire proof of
 * "MeterValues arrive in sequence" would have been proving the YAML file.
 *
 * Overriding is still needed — negative tests emit a late MeterValues with
 * seqNo > finalSeqNo — but it is `forceTo()` now: an explicit, named act on the
 * counter, visible to anyone reading the scenario, rather than an incidental
 * consequence of writing a field.
 */
export class SequenceCounter {
  private value = 0;

  /** Issue the next number and advance. */
  next(): number {
    return this.value++;
  }

  /** The number that would be issued next, without advancing. */
  peek(): number {
    return this.value;
  }

  /**
   * Deliberately jump the counter. For negative tests that need to emit an
   * out-of-range sequence on purpose.
   *
   * Going backwards throws: silently accepting a lower value would let a scenario
   * replay a sequence the station had already issued, which is the shape of the
   * defect the ordering fields exist to detect in the first place.
   */
  forceTo(value: number): void {
    if (value < this.value) {
      throw new Error(
        `SequenceCounter.forceTo(${value}) would move the counter backwards from ${this.value}. ` +
          'Replaying an already-issued sequence is what the ordering fields exist to detect; ' +
          'if a scenario genuinely needs a replay, construct the payload explicitly and say why.',
      );
    }
    this.value = value;
  }
}
