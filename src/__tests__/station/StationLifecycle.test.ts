import { describe, it, expect } from 'vitest';
import { StationLifecycle, canTransition } from '../../station/StationLifecycle.js';

describe('canTransition', () => {
  it('OFFLINE → ONLINE is true', () => {
    expect(canTransition(StationLifecycle.OFFLINE, StationLifecycle.ONLINE)).toBe(true);
  });

  it('ONLINE → OFFLINE is true', () => {
    expect(canTransition(StationLifecycle.ONLINE, StationLifecycle.OFFLINE)).toBe(true);
  });

  it('ONLINE → REBOOTING is true', () => {
    expect(canTransition(StationLifecycle.ONLINE, StationLifecycle.REBOOTING)).toBe(true);
  });

  it('REBOOTING → OFFLINE is true', () => {
    expect(canTransition(StationLifecycle.REBOOTING, StationLifecycle.OFFLINE)).toBe(true);
  });

  it('REBOOTING → ONLINE is true', () => {
    expect(canTransition(StationLifecycle.REBOOTING, StationLifecycle.ONLINE)).toBe(true);
  });

  it('OFFLINE → REBOOTING is false', () => {
    expect(canTransition(StationLifecycle.OFFLINE, StationLifecycle.REBOOTING)).toBe(false);
  });

  it('OFFLINE → OFFLINE is false', () => {
    expect(canTransition(StationLifecycle.OFFLINE, StationLifecycle.OFFLINE)).toBe(false);
  });

  it('REBOOTING → REBOOTING is false', () => {
    expect(canTransition(StationLifecycle.REBOOTING, StationLifecycle.REBOOTING)).toBe(false);
  });
});
