import type { OsppAction } from '@ospp/protocol';

export interface ActionBehavior {
  acceptRate: number;         // 0.0-1.0, probability of accepting
  responseDelayMs: [number, number];  // [min, max] random delay
  enabled: boolean;
}

export interface AutoResponderConfig {
  defaultBehavior: ActionBehavior;
  overrides: Partial<Record<OsppAction, Partial<ActionBehavior>>>;
}

export const DEFAULT_BEHAVIOR: ActionBehavior = {
  acceptRate: 1.0,
  responseDelayMs: [0, 0],
  enabled: true,
};

export function getActionBehavior(config: AutoResponderConfig, action: OsppAction): ActionBehavior {
  const override = config.overrides[action];
  if (!override) return config.defaultBehavior;
  return { ...config.defaultBehavior, ...override };
}
