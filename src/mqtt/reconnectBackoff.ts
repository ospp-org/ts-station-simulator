/**
 * THE RECONNECT BACKOFF OF 02-transport.md §4.5 (2026-10-25).
 *
 * "The station MUST use exponential backoff with jitter for reconnection attempts": before attempt `attempt`
 * (0 for the first after the link dropped) the station waits min(base_delay x multiplier^attempt, max_delay), plus a
 * jitter drawn uniformly from 0 to jitter_factor of that delay; the attempt count is reset on success. base_delay is
 * 1 s, the multiplier 2, the jitter factor 0.3, and max_delay is `ReconnectBackoffMax`, a configuration key the
 * station holds (08-configuration.md: 30 by default, 30-3600 s) - so 1.0-1.3 s, 2.0-2.6 s, 4.0-5.2 s, 8.0-10.4 s,
 * 16.0-20.8 s, then 30.0-39.0 s at the default.
 *
 * The simulator retried every 5 s, on mqtt.js's own fixed `reconnectPeriod`, in step with the server's bridge, which
 * retries every 5 s too: after a broker restart both came back in one round, which hid a race the spec's jitter
 * exists to expose (csms-server, 2026-10-25). MqttConnection paces its own attempts on this.
 */

export const RECONNECT_BASE_DELAY_MS = 1000;

export const RECONNECT_MULTIPLIER = 2;

export const RECONNECT_JITTER_FACTOR = 0.3;

/** `ReconnectBackoffMax`'s default (08-configuration.md); a station that holds another value caps there. */
export const DEFAULT_RECONNECT_BACKOFF_MAX_SECONDS = 30;

/**
 * The most the first attempt after a drop waits: the base delay and all its jitter. The will's delay must outlast it,
 * so that a reconnect to a persistent session lands inside the delay and MQTT 5 §3.1.3.2.2 suppresses the will
 * (MqttConnection.severWill.test.ts pins the two together).
 */
export const FIRST_RECONNECT_DELAY_MAX_MS = Math.round(RECONNECT_BASE_DELAY_MS * (1 + RECONNECT_JITTER_FACTOR));

/**
 * The wait before reconnection attempt `attempt` (0 for the first after the link dropped), in milliseconds:
 * min(1 s x 2^attempt, backoffMaxSeconds) plus random() x 30 % of it.
 */
export function reconnectDelayMs(attempt: number, backoffMaxSeconds: number, random: () => number = Math.random): number {
  const maxMs = backoffMaxSeconds * 1000;
  // Doubled one step at a time and stopped at the cap, so a long outage never computes 2^attempt past it.
  let calculated = RECONNECT_BASE_DELAY_MS;
  for (let i = 0; i < attempt && calculated < maxMs; i++) {
    calculated *= RECONNECT_MULTIPLIER;
  }
  calculated = Math.min(calculated, maxMs);
  return Math.round(calculated + random() * calculated * RECONNECT_JITTER_FACTOR);
}
