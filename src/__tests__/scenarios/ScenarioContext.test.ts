import { describe, it, expect } from 'vitest';
import { createContext } from '../../scenarios/ScenarioContext.js';

describe('createContext', () => {
  it('returns empty maps and arrays', () => {
    const ctx = createContext();
    expect(ctx.variables).toBeInstanceOf(Map);
    expect(ctx.variables.size).toBe(0);
    expect(ctx.captured).toBeInstanceOf(Map);
    expect(ctx.captured.size).toBe(0);
    expect(ctx.sentMessages).toEqual([]);
    expect(ctx.receivedMessages).toEqual([]);
    expect(ctx.stepResults).toEqual([]);
  });

  it('startTime is close to Date.now()', () => {
    const before = Date.now();
    const ctx = createContext();
    const after = Date.now();
    expect(ctx.startTime).toBeGreaterThanOrEqual(before);
    expect(ctx.startTime).toBeLessThanOrEqual(after);
  });
});
