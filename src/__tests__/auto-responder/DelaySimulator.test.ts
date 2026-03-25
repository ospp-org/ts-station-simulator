import { describe, it, expect } from 'vitest';
import { DelaySimulator } from '../../auto-responder/DelaySimulator.js';

describe('DelaySimulator', () => {
  it('delay([0, 0]) resolves immediately', async () => {
    const simulator = new DelaySimulator();
    const start = Date.now();
    await simulator.delay([0, 0]);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it('delay([10, 20]) resolves within reasonable time', async () => {
    const simulator = new DelaySimulator();
    const start = Date.now();
    await simulator.delay([10, 20]);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(5);
    expect(elapsed).toBeLessThan(200);
  });
});
