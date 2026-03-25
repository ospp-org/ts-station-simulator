import { describe, it, expect, vi } from 'vitest';
import { AutoResponder } from '../../auto-responder/AutoResponder.js';
import { OsppAction } from '@ospp/protocol';

describe('AutoResponder', () => {
  it('default config always accepts (acceptRate 1.0)', async () => {
    const responder = new AutoResponder();
    // With acceptRate 1.0 and Math.random() always < 1.0, shouldAccept returns true
    const results = await Promise.all(
      Array.from({ length: 20 }, () => responder.shouldAccept(OsppAction.HEARTBEAT)),
    );
    expect(results.every(r => r === true)).toBe(true);
  });

  it('acceptRate 0.0 always rejects', async () => {
    const responder = new AutoResponder({
      defaultBehavior: {
        acceptRate: 0.0,
        responseDelayMs: [0, 0],
        enabled: true,
      },
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => responder.shouldAccept(OsppAction.HEARTBEAT)),
    );
    expect(results.every(r => r === false)).toBe(true);
  });

  it('respects per-action overrides', async () => {
    const responder = new AutoResponder({
      defaultBehavior: {
        acceptRate: 1.0,
        responseDelayMs: [0, 0],
        enabled: true,
      },
      overrides: {
        [OsppAction.RESET]: {
          acceptRate: 0.0,
        },
      },
    });

    const heartbeatResults = await Promise.all(
      Array.from({ length: 10 }, () => responder.shouldAccept(OsppAction.HEARTBEAT)),
    );
    expect(heartbeatResults.every(r => r === true)).toBe(true);

    const resetResults = await Promise.all(
      Array.from({ length: 10 }, () => responder.shouldAccept(OsppAction.RESET)),
    );
    expect(resetResults.every(r => r === false)).toBe(true);
  });

  it('updateConfig() merges correctly', () => {
    const responder = new AutoResponder();
    responder.updateConfig({
      defaultBehavior: {
        acceptRate: 0.5,
        responseDelayMs: [10, 20],
        enabled: true,
      },
    });

    const config = responder.getConfig();
    expect(config.defaultBehavior.acceptRate).toBe(0.5);
    expect(config.defaultBehavior.responseDelayMs).toEqual([10, 20]);
  });

  it('updateConfig() merges overrides without losing existing ones', () => {
    const responder = new AutoResponder({
      overrides: {
        [OsppAction.HEARTBEAT]: { acceptRate: 0.5 },
      },
    });

    responder.updateConfig({
      overrides: {
        [OsppAction.RESET]: { acceptRate: 0.0 },
      },
    });

    const config = responder.getConfig();
    expect(config.overrides[OsppAction.HEARTBEAT]).toEqual({ acceptRate: 0.5 });
    expect(config.overrides[OsppAction.RESET]).toEqual({ acceptRate: 0.0 });
  });
});
