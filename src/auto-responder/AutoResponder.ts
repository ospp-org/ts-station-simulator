import type { OsppAction } from '@ospp/protocol';
import { type AutoResponderConfig, getActionBehavior, DEFAULT_BEHAVIOR } from './BehaviorConfig.js';
import { DelaySimulator } from './DelaySimulator.js';

export class AutoResponder {
  private config: AutoResponderConfig;
  private delaySimulator: DelaySimulator;

  constructor(config?: Partial<AutoResponderConfig>) {
    this.config = {
      defaultBehavior: config?.defaultBehavior ?? DEFAULT_BEHAVIOR,
      overrides: config?.overrides ?? {},
    };
    this.delaySimulator = new DelaySimulator();
  }

  async shouldAccept(action: OsppAction): Promise<boolean> {
    const behavior = getActionBehavior(this.config, action);
    if (!behavior.enabled) return false;
    await this.delaySimulator.delay(behavior.responseDelayMs);
    return Math.random() < behavior.acceptRate;
  }

  async applyDelay(action: OsppAction): Promise<void> {
    const behavior = getActionBehavior(this.config, action);
    await this.delaySimulator.delay(behavior.responseDelayMs);
  }

  getConfig(): AutoResponderConfig {
    return this.config;
  }

  updateConfig(config: Partial<AutoResponderConfig>): void {
    if (config.defaultBehavior) {
      this.config.defaultBehavior = { ...this.config.defaultBehavior, ...config.defaultBehavior };
    }
    if (config.overrides) {
      this.config.overrides = { ...this.config.overrides, ...config.overrides };
    }
  }
}
