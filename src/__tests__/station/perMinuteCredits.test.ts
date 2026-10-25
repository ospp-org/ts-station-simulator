import { describe, it, expect } from 'vitest';
import { perMinuteCredits } from '../../station/perMinuteCredits.js';

/*
 * ceil(seconds / 60 x priceCreditsPerMinute) in whole units (03-messages.md §3.4), against the exact ceiling computed in
 * BigInt over every second to an hour at every price to 1000 credits a minute - where the formula evaluated as written
 * in binary floating point is wrong in 10028 cases (33 s at 100 a minute: 56 for 55), as it is in PHP (csms-server,
 * 2026-10-25).
 */
function exact(seconds: number, price: number): number {
  return Number((BigInt(seconds) * BigInt(price) + 59n) / 60n);
}

describe('perMinuteCredits', () => {
  it('is the exact ceiling at every second to an hour and every price to 1000 credits a minute', () => {
    const wrong: string[] = [];
    for (let s = 0; s <= 3600; s++) {
      for (let p = 0; p <= 1000; p++) {
        if (perMinuteCredits(s, p) !== exact(s, p)) wrong.push(`${s} s at ${p}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('CONTROL: the grid discriminates - the formula as written, in floating point, is wrong in 10028 of its cases', () => {
    let wrong = 0;
    for (let s = 0; s <= 3600; s++) {
      for (let p = 0; p <= 1000; p++) {
        if (Math.ceil((s / 60) * p) !== exact(s, p)) wrong++;
      }
    }
    expect(wrong).toBe(10028);
  });

  it('refuses what is not a whole, non-negative count, and a product past the integers a number holds exactly', () => {
    expect(() => perMinuteCredits(1.5, 100)).toThrow(RangeError);
    expect(() => perMinuteCredits(-1, 100)).toThrow(RangeError);
    expect(() => perMinuteCredits(60, 0.5)).toThrow(RangeError);
    expect(() => perMinuteCredits(60, Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
  });
});
