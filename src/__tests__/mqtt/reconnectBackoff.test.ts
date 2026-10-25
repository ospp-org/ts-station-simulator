import { describe, it, expect } from 'vitest';

const {
  reconnectDelayMs,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_JITTER_FACTOR,
  DEFAULT_RECONNECT_BACKOFF_MAX_SECONDS,
  FIRST_RECONNECT_DELAY_MAX_MS,
} = await import('../../mqtt/reconnectBackoff.js');

/*
 * THE RECONNECT BACKOFF OF 02-transport.md §4.5 (2026-10-25).
 *
 * "The station MUST use exponential backoff with jitter for reconnection attempts": base_delay 1 s,
 * multiplier 2, max_delay ReconnectBackoffMax (default 30 s, 08-configuration.md: 30-3600), jitter
 * random_uniform(0, calculated_delay x 0.3) added to it, the attempt reset on success - so 1.0-1.3 s,
 * 2.0-2.6 s, 4.0-5.2 s, 8.0-10.4 s, 16.0-20.8 s and 30.0-39.0 s from then on. The simulator retried every
 * 5 s instead, in step with the server's bridge, which retries every 5 s too: both lose the broker at one
 * instant and came back in one round - which hid the race of a broker restart in the run of 2026-10-25.
 */
describe('reconnectDelayMs - 02-transport.md §4.5', () => {
  it('waits base x 2^attempt before each attempt, capped at ReconnectBackoffMax: 1, 2, 4, 8, 16, then 30 s', () => {
    const noJitter = (): number => 0;

    expect([0, 1, 2, 3, 4, 5, 6, 12].map((attempt) => reconnectDelayMs(attempt, 30, noJitter)))
      .toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it('adds a jitter drawn uniformly from 0 to 30 % of that delay: 1.0-1.3 s up to 30.0-39.0 s', () => {
    const mostJitter = (): number => 0.999999;

    expect([0, 1, 2, 3, 4, 5].map((attempt) => reconnectDelayMs(attempt, 30, mostJitter)))
      .toEqual([1300, 2600, 5200, 10400, 20800, 39000]);
    expect(reconnectDelayMs(2, 30, () => 0.5)).toBe(4600);
  });

  it('caps at the ReconnectBackoffMax the station holds, not at a constant', () => {
    expect(reconnectDelayMs(10, 60, () => 0)).toBe(60000);
    expect(reconnectDelayMs(10, 3600, () => 0)).toBe(3600000);
    expect(reconnectDelayMs(10, 3600, () => 0.5)).toBe(4140000);
  });

  it('states the parameters of the spec, and the most the first attempt waits', () => {
    expect(RECONNECT_BASE_DELAY_MS).toBe(1000);
    expect(RECONNECT_JITTER_FACTOR).toBe(0.3);
    expect(DEFAULT_RECONNECT_BACKOFF_MAX_SECONDS).toBe(30);
    expect(FIRST_RECONNECT_DELAY_MAX_MS).toBe(1300);
  });
});
