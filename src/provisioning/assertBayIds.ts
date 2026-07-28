/**
 * Strict validation of the provisioning response's `bayIds`.
 *
 * The simulator is the only second implementation of this protocol we have,
 * and its whole value is refusing a response a conforming station could not
 * act on. A lenient reader — one that only checks the field is a non-empty
 * array — passes a server that returns the wrong bay set, which is precisely
 * the defect this gate exists to catch.
 *
 * What the wire actually carries (spec/schemas/provisioning-response.schema.json
 * at 0.8.0) is an array of bay-id STRINGS, not objects. The bayNumber is not a
 * member; it is the array INDEX. spec/04-flows.md §2:
 *
 *   "The array is ordered and dense: the element at index i is the bayId of
 *    the bay whose bayNumber is i + 1, so bayIds[0] is bay number 1. It MUST
 *    cover bayNumber 1..bayCount with no gaps, and its length MUST equal the
 *    station's registered bay count."
 *
 * So "the bayNumber sequence is strictly increasing from 1" is not something
 * that can be read off the payload — it is an invariant the payload's SHAPE
 * either satisfies or violates. Checking it means checking that the array is
 * present, is all well-formed unique bay ids, and has exactly `bayCount`
 * elements. A response with the wrong length has a gap or a surplus somewhere
 * in 1..bayCount, whichever way it drifted.
 *
 * That length check is what catches a replay answered from live rows: a token
 * that bound 2 bays, replayed after a boot minted 2 more, comes back with 4
 * against a declared bayCount of 2.
 */

/** `bay_` + 8..60 hex, per schemas/common/bay-id.schema.json. */
const BAY_ID_PATTERN = /^bay_[0-9a-f]{8,60}$/;

export interface AssertBayIdsOptions {
  /** Prefix for thrown errors, so the caller is identifiable in a scenario log. */
  readonly context: string;
  /** The bayCount the request declared. The array length MUST equal it. */
  readonly expectedCount: number;
}

/**
 * Returns the validated bay ids, or throws with a message naming the specific
 * violation. Never returns a partially-checked array.
 */
export function assertBayIds(
  value: unknown,
  { context, expectedCount }: AssertBayIdsOptions,
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `${context}: provisioning response is missing bayIds, or it is not an array. ` +
        `bayIds is REQUIRED by provisioning-response.schema.json.`,
    );
  }

  if (value.length === 0) {
    throw new Error(`${context}: provisioning response carries an empty bayIds array (minItems is 1).`);
  }

  const bad = value.findIndex(
    (id) => typeof id !== 'string' || !BAY_ID_PATTERN.test(id),
  );
  if (bad !== -1) {
    throw new Error(
      `${context}: bayIds[${bad}] is not a well-formed bay id (${JSON.stringify(value[bad])}); ` +
        `expected /^bay_[0-9a-f]{8,60}$/.`,
    );
  }

  const ids = value as string[];

  if (new Set(ids).size !== ids.length) {
    throw new Error(
      `${context}: bayIds contains duplicates, so the index-to-bayNumber mapping is ambiguous. ` +
        `Got ${JSON.stringify(ids)}.`,
    );
  }

  // The density check. Index i is bayNumber i+1, so a correct array covers
  // 1..bayCount exactly; any other length means a gap or a surplus.
  if (ids.length !== expectedCount) {
    throw new Error(
      `${context}: bayIds has ${ids.length} entries but the request declared bayCount=${expectedCount}. ` +
        `spec/04-flows.md §2 requires the array to cover bayNumber 1..bayCount with no gaps, so its ` +
        `length MUST equal the registered bay count. A longer array on a REPLAY means the server ` +
        `answered from live bay rows instead of the set the token bound.`,
    );
  }

  return ids;
}
