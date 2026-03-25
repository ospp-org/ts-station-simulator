import { describe, it, expect } from 'vitest';
import { getActionBehavior, DEFAULT_BEHAVIOR } from '../../auto-responder/BehaviorConfig.js';
import type { AutoResponderConfig } from '../../auto-responder/BehaviorConfig.js';
import { OsppAction } from '@ospp/protocol';

describe('getActionBehavior', () => {
  it('returns default when no override exists', () => {
    const config: AutoResponderConfig = {
      defaultBehavior: DEFAULT_BEHAVIOR,
      overrides: {},
    };

    const behavior = getActionBehavior(config, OsppAction.HEARTBEAT);
    expect(behavior).toEqual(DEFAULT_BEHAVIOR);
  });

  it('returns merged override when one exists', () => {
    const config: AutoResponderConfig = {
      defaultBehavior: DEFAULT_BEHAVIOR,
      overrides: {
        [OsppAction.RESET]: {
          acceptRate: 0.0,
          responseDelayMs: [100, 200],
          enabled: false,
        },
      },
    };

    const behavior = getActionBehavior(config, OsppAction.RESET);
    expect(behavior.acceptRate).toBe(0.0);
    expect(behavior.responseDelayMs).toEqual([100, 200]);
    expect(behavior.enabled).toBe(false);
  });

  it('partial override fills from default', () => {
    const config: AutoResponderConfig = {
      defaultBehavior: DEFAULT_BEHAVIOR,
      overrides: {
        [OsppAction.HEARTBEAT]: {
          acceptRate: 0.5,
        },
      },
    };

    const behavior = getActionBehavior(config, OsppAction.HEARTBEAT);
    expect(behavior.acceptRate).toBe(0.5);
    // Filled from default
    expect(behavior.responseDelayMs).toEqual(DEFAULT_BEHAVIOR.responseDelayMs);
    expect(behavior.enabled).toBe(DEFAULT_BEHAVIOR.enabled);
  });
});
