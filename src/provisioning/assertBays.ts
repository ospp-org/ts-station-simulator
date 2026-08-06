/**
 * Strict validation of the provisioning response's `bays`.
 *
 * The simulator is the only second implementation of this protocol we have, and
 * its whole value is refusing a response a conforming station could not act on.
 * A lenient reader — one that only checks the field is a non-empty array —
 * passes a server that returns the wrong bay set, which is precisely the defect
 * this gate exists to catch.
 *
 * v0.11.0 replaced `bayIds[]` with `bays[]`.
 * provisioning-response.schema.json:21 — "Server-assigned bay identifiers, each
 * paired EXPLICITLY with the bayNumber the station declared for it. This is the
 * mapping the station needs and the only one it is given."
 *
 * The predecessor of this file rested on the opposite premise: "the bayNumber is
 * not a member; it is the array INDEX", enforcing that the array be "ordered and
 * dense … covering 1..bayCount with no gaps". A station whose bay 2 was never
 * fitted declares {1,3}; under that rule the response came back as a two-element
 * array and the station re-indexed bay 3 into slot 2 — silently binding the
 * wrong hardware. The density check that was the old file's centrepiece IS the
 * bug, so it is gone rather than relaxed.
 *
 * What is kept is the strictness. The set must be exactly the declared set: a
 * token that bound {1,3}, replayed after something else minted more bays, comes
 * back with a set that is not the one declared, and that must fail loudly.
 */

/** `bay_` + 8..60 hex, per schemas/common/bay-id.schema.json. */
const BAY_ID_PATTERN = /^bay_[0-9a-f]{8,60}$/;

export interface BayPair {
  readonly bayId: string;
  readonly bayNumber: number;
}

export interface AssertBaysOptions {
  /** Prefix for thrown errors, so the caller is identifiable in a scenario log. */
  readonly context: string;
  /** The bay numbers the request DECLARED. The response set must equal this. */
  readonly declaredBayNumbers: readonly number[];
}

/**
 * Returns the validated pairs, or throws with a message naming the specific
 * violation. Never returns a partially-checked array.
 */
export function assertBays(
  value: unknown,
  { context, declaredBayNumbers }: AssertBaysOptions,
): BayPair[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `${context}: provisioning response is missing bays, or it is not an array. ` +
        `bays is REQUIRED by provisioning-response.schema.json.`,
    );
  }

  if (value.length === 0) {
    throw new Error(`${context}: provisioning response carries an empty bays array (minItems is 1).`);
  }

  const pairs: BayPair[] = [];
  for (const [i, entry] of value.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      // A server still emitting the 0.10.0 array of bare strings is refused
      // loudly rather than coerced. Coercing would put the positional bug back
      // in, one layer down and harder to see.
      throw new Error(
        `${context}: bays[${i}] is not an object (${JSON.stringify(entry)}). ` +
          `v0.11.0 carries {bayId, bayNumber} pairs; a bare string is the 0.10.0 shape.`,
      );
    }

    const { bayId, bayNumber } = entry as Partial<BayPair>;

    if (typeof bayId !== 'string' || !BAY_ID_PATTERN.test(bayId)) {
      throw new Error(
        `${context}: bays[${i}].bayId is not a well-formed bay id (${JSON.stringify(bayId)}); ` +
          `expected /^bay_[0-9a-f]{8,60}$/.`,
      );
    }

    if (typeof bayNumber !== 'number' || !Number.isInteger(bayNumber) || bayNumber < 1 || bayNumber > 64) {
      throw new Error(
        `${context}: bays[${i}].bayNumber is not an integer in 1..64 (${JSON.stringify(bayNumber)}).`,
      );
    }

    pairs.push({ bayId, bayNumber });
  }

  const numbers = pairs.map(p => p.bayNumber);
  if (new Set(numbers).size !== numbers.length) {
    throw new Error(
      `${context}: bays contains a duplicate bayNumber, so the mapping is ambiguous. ` +
        `Got ${JSON.stringify(numbers)}.`,
    );
  }

  const ids = pairs.map(p => p.bayId);
  if (new Set(ids).size !== ids.length) {
    throw new Error(
      `${context}: bays contains a duplicate bayId, so two bay numbers name the same bay. ` +
        `Got ${JSON.stringify(ids)}.`,
    );
  }

  // The set check, which is what the old length check was reaching for. Sets,
  // not counts and not order: {1,3} is a conforming declaration, and a response
  // covering {1,2} has the right count and the wrong bays.
  const declared = [...declaredBayNumbers].sort((a, b) => a - b);
  const answered = [...numbers].sort((a, b) => a - b);
  if (declared.length !== answered.length || declared.some((n, i) => n !== answered[i])) {
    throw new Error(
      `${context}: bays answers bay numbers ${JSON.stringify(answered)} but the request declared ` +
        `${JSON.stringify(declared)}. The response must pair exactly the declared set. A SURPLUS on a ` +
        `replay means the server answered from live bay rows instead of the set the token bound.`,
    );
  }

  return pairs;
}
