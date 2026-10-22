import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { CaptureTimeStep } from '../../../scenarios/steps/CaptureTimeStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';
import type { Station } from '../../../station/Station.js';

const station = {} as Station;

/** The OSPP timestamp: ISO 8601 UTC with milliseconds (common/timestamp.schema.json). */
const OSPP_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('CaptureTimeStep', () => {
  it('captures the moment the step runs, as an OSPP timestamp', async () => {
    const ctx = createContext();
    const before = Date.now();
    await new CaptureTimeStep().execute({ action: 'capture_time', capture: { washStartedAt: 0 } }, ctx, station);
    const after = Date.now();

    const value = String(ctx.captured.get('washStartedAt'));
    expect(value).toMatch(OSPP_TIMESTAMP);
    expect(Date.parse(value)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(value)).toBeLessThanOrEqual(after);
  });

  it('moves each captured moment by its offset in seconds, either way', async () => {
    const ctx = createContext();
    const now = Date.now();
    await new CaptureTimeStep().execute(
      { action: 'capture_time', capture: { later: 300, earlier: -60 } },
      ctx,
      station,
    );

    expect(Date.parse(String(ctx.captured.get('later'))) - now).toBeGreaterThanOrEqual(299_000);
    expect(Date.parse(String(ctx.captured.get('later'))) - now).toBeLessThan(302_000);
    expect(now - Date.parse(String(ctx.captured.get('earlier')))).toBeGreaterThanOrEqual(58_000);
  });

  it('moves from the moment `from` names instead of the runner clock, so a wash is dated on the server clock', async () => {
    const ctx = createContext();
    ctx.captured.set('passExpiresAt', '2026-10-25T09:00:00.000Z');
    await new CaptureTimeStep().execute(
      // The runner pre-substitutes the step, so `from` arrives as the captured value itself.
      { action: 'capture_time', from: '2026-10-25T09:00:00.000Z', capture: { lastMinute: -60, after: 1 } },
      ctx,
      station,
    );

    expect(ctx.captured.get('lastMinute')).toBe('2026-10-25T08:59:00.000Z');
    expect(ctx.captured.get('after')).toBe('2026-10-25T09:00:01.000Z');
  });

  it('refuses a `from` that is no OSPP timestamp', async () => {
    const step = new CaptureTimeStep();
    await expect(
      step.execute({ action: 'capture_time', from: 'yesterday', capture: { t: 0 } }, createContext(), station),
    ).rejects.toThrow(/from/);
    await expect(
      step.execute({ action: 'capture_time', from: '2026-10-25T09:00:00Z', capture: { t: 0 } }, createContext(), station),
    ).rejects.toThrow(/from/);
  });

  it('refuses a step with no capture map, or an offset that is no whole number of seconds', async () => {
    const step = new CaptureTimeStep();
    await expect(step.execute({ action: 'capture_time' }, createContext(), station)).rejects.toThrow(/capture/);
    await expect(
      step.execute({ action: 'capture_time', capture: { t: 1.5 } }, createContext(), station),
    ).rejects.toThrow(/whole number of seconds/);
  });
});
