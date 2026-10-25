/**
 * THE CREDITS OF A PER-MINUTE SERVICE FOR A DURATION, IN WHOLE UNITS (2026-10-25).
 *
 * `ceil(seconds / 60 * priceCreditsPerMinute)` (03-messages.md §3.4) is the ceiling of an exact rational, computed
 * here in integers: the product, divided by 60 and rounded up when anything is left. Evaluated as written in binary
 * floating point it is wrong in 10028 of the 3,600,000 cases of every second to an hour at every price to 1000 a
 * minute - 33 / 60 * 100 is 55.00000000000001, its ceiling 56 where 55 is owed - which is what the station reported,
 * and what the server charged until csms-server 248b50d4 (UAT, 2026-10-25).
 *
 * The product is exact while it is a safe integer, so a count that is not a whole, non-negative number, and a product
 * past Number.MAX_SAFE_INTEGER, are refused rather than rounded.
 */
export function perMinuteCredits(seconds: number, priceCreditsPerMinute: number): number {
  const units = seconds * priceCreditsPerMinute;
  if (!wholeCount(seconds) || !wholeCount(priceCreditsPerMinute) || !Number.isSafeInteger(units)) {
    throw new RangeError(`perMinuteCredits: ${seconds} s at ${priceCreditsPerMinute} a minute is not a whole, non-negative product a number holds exactly`);
  }
  const left = units % 60;
  return (units - left) / 60 + (left === 0 ? 0 : 1);
}

function wholeCount(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0;
}
