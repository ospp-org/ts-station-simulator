import { describe, it, expect, vi } from 'vitest';
import type { ScenarioContext } from '../../../scenarios/ScenarioContext.js';
import type { Station as StationType } from '../../../station/Station.js';
import { StartHeartbeatStep } from '../../../scenarios/steps/StartHeartbeatStep.js';

// StartHeartbeatStep.execute only touches station.startHeartbeat; the context is
// unused, so an empty cast is sufficient (mirrors WaitForConnectStep.test.ts).
const ctx = {} as unknown as ScenarioContext;

describe('StartHeartbeatStep', () => {
  it('starts the station heartbeat at the given interval_sec', async () => {
    const startHeartbeat = vi.fn();
    const station = { startHeartbeat } as unknown as StationType;

    await new StartHeartbeatStep().execute(
      { action: 'start_heartbeat', interval_sec: 30 },
      ctx,
      station,
    );

    expect(startHeartbeat).toHaveBeenCalledWith(30);
  });

  it('honors a non-default interval_sec', async () => {
    const startHeartbeat = vi.fn();
    const station = { startHeartbeat } as unknown as StationType;

    await new StartHeartbeatStep().execute(
      { action: 'start_heartbeat', interval_sec: 20 },
      ctx,
      station,
    );

    expect(startHeartbeat).toHaveBeenCalledWith(20);
  });

  it('throws when interval_sec is missing (fail-loud, mirrors DelayStep.ms)', async () => {
    const startHeartbeat = vi.fn();
    const station = { startHeartbeat } as unknown as StationType;

    await expect(
      new StartHeartbeatStep().execute({ action: 'start_heartbeat' }, ctx, station),
    ).rejects.toThrow(/positive number/);
    expect(startHeartbeat).not.toHaveBeenCalled();
  });

  it('throws when interval_sec is non-positive', async () => {
    const startHeartbeat = vi.fn();
    const station = { startHeartbeat } as unknown as StationType;

    await expect(
      new StartHeartbeatStep().execute(
        { action: 'start_heartbeat', interval_sec: 0 },
        ctx,
        station,
      ),
    ).rejects.toThrow(/positive number/);
    expect(startHeartbeat).not.toHaveBeenCalled();
  });

  it('throws when interval_sec is non-numeric', async () => {
    const startHeartbeat = vi.fn();
    const station = { startHeartbeat } as unknown as StationType;

    await expect(
      new StartHeartbeatStep().execute(
        { action: 'start_heartbeat', interval_sec: 'fast' },
        ctx,
        station,
      ),
    ).rejects.toThrow(/positive number/);
    expect(startHeartbeat).not.toHaveBeenCalled();
  });
});
