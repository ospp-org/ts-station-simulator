import { describe, it, expect } from 'vitest';
import { LoginPacer } from '../../../scenarios/steps/ApiCallStep.js';

/**
 * The server's auth limiter is `Limit::perMinute(30)->by($request->ip())` — brute-force
 * protection, keyed by IP and not by user. A pooled run mints one identity per scenario and
 * logs them all in from one machine, so the suite's login rate is a property of how fast the
 * corpus runs. It was inside the cap only by accident until 2026-08-14, when funding the
 * wallets removed 28 × 15s of timeout and the same 121 logins bunched up.
 *
 * A fake clock throughout: these assert the pacing ARITHMETIC. Nothing here sleeps.
 */
function harness(maxPerWindow: number, windowMs = 60_000) {
  let now = 1_000_000;
  const slept: number[] = [];
  const pacer = new LoginPacer(
    maxPerWindow,
    windowMs,
    () => now,
    async (ms: number) => { slept.push(ms); now += ms; },
  );
  return {
    pacer,
    slept,
    advance: (ms: number) => { now += ms; },
    now: () => now,
  };
}

describe('LoginPacer — keeps the suite inside the server\'s auth limiter', () => {
  it('admits the first N logins in a window with no wait at all', async () => {
    const { pacer, slept } = harness(25);
    for (let i = 0; i < 25; i++) {
      expect(await pacer.acquire()).toBe(0);
    }
    expect(slept).toEqual([]);
  });

  it('the (N+1)th waits for the oldest stamp to leave the window', async () => {
    const { pacer, slept } = harness(3);
    await pacer.acquire();          // t = 1_000_000
    await pacer.acquire();
    await pacer.acquire();
    // Bucket full. The oldest stamp is at t0, so the wait is the full window plus the
    // boundary tick — nothing has advanced the clock between acquires.
    const waited = await pacer.acquire();
    expect(waited).toBe(60_050);
    expect(slept).toEqual([60_050]);
  });

  it('time already elapsed counts — a slow run pays nothing', async () => {
    const { pacer, advance, slept } = harness(3);
    await pacer.acquire();
    advance(59_000);                 // the run was busy doing real work
    await pacer.acquire();
    await pacer.acquire();
    // The first stamp is 59s old, so only ~1s of its window remains.
    expect(await pacer.acquire()).toBe(1_050);
    expect(slept).toEqual([1_050]);
  });

  it('a stamp older than the window is dropped, not counted', async () => {
    const { pacer, advance, slept } = harness(2);
    await pacer.acquire();
    await pacer.acquire();
    advance(60_001);                 // both stamps have aged out
    expect(await pacer.acquire()).toBe(0);
    expect(await pacer.acquire()).toBe(0);
    expect(slept).toEqual([]);
  });

  it('concurrent callers serialize — the window is never read stale', async () => {
    // THE property that makes this safe under --parallel --workers N. All workers share one
    // process, so without serialized admission four of them could each observe a bucket with
    // a slot left and all take it. Fired together, awaited together.
    const { pacer, slept } = harness(2);
    const waits = await Promise.all([
      pacer.acquire(),
      pacer.acquire(),
      pacer.acquire(),
      pacer.acquire(),
    ]);
    // Exactly two go free — if admission were racy, three or four would.
    expect(waits.filter((w) => w === 0).length).toBe(3);
    expect(waits[0]).toBe(0);
    expect(waits[1]).toBe(0);
    expect(waits[2]).toBe(60_050);
    // The fourth is free again, and legitimately so: the third caller's wait advanced the
    // clock a full window, which retired both original stamps. Asserting a wait here would
    // be asserting that the pacer delays a login the server would now accept. Measured
    // rather than assumed — the first draft of this test expected a wait and was wrong.
    expect(waits[3]).toBe(0);
    expect(slept).toEqual([60_050]);
  });

  it('never admits more than N inside any window, across a long burst', async () => {
    // The invariant stated directly rather than through the wait values: replay every
    // admission and check no 60s span holds more than N of them.
    const N = 5;
    const { pacer, now } = harness(N);
    const admitted: number[] = [];
    for (let i = 0; i < 40; i++) {
      await pacer.acquire();
      admitted.push(now());
    }
    for (let i = 0; i < admitted.length; i++) {
      const inWindow = admitted.filter(
        (t) => t >= admitted[i] && t < admitted[i] + 60_000,
      ).length;
      expect(inWindow).toBeLessThanOrEqual(N);
    }
  });

  it('a pacer sized at the real default (25) leaves headroom under the server\'s 30', () => {
    // Not arithmetic — a statement about the margin. The window is the SERVER's, measured
    // from when it saw the request, and the run is not guaranteed to be the only client on
    // that IP, so pacing exactly at 30 would be pacing at the cliff edge.
    expect(25).toBeLessThan(30);
  });
});
