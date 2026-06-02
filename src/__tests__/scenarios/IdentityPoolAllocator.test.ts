import { describe, it, expect } from 'vitest';
import {
  IdentityPoolAllocator,
  type IdentityCredentials,
} from '../../scenarios/ScenarioRunner.js';

function creds(n: number): IdentityCredentials[] {
  return Array.from({ length: n }, (_, i) => ({
    email: `sim-worker-test-${i}@test.local`,
    password: 'p',
  }));
}

describe('IdentityPoolAllocator (single-use FIFO)', () => {
  it('acquire() shifts identities off the head in FIFO order', () => {
    const allocator = new IdentityPoolAllocator(creds(3));
    expect(allocator.acquire().email).toBe('sim-worker-test-0@test.local');
    expect(allocator.acquire().email).toBe('sim-worker-test-1@test.local');
    expect(allocator.acquire().email).toBe('sim-worker-test-2@test.local');
  });

  it('every acquire returns a DISTINCT identity — single-use means no reuse', () => {
    const allocator = new IdentityPoolAllocator(creds(5));
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) seen.add(allocator.acquire().email);
    expect(seen.size).toBe(5);
  });

  it('throws on depletion — pool sizing contract violation', () => {
    const allocator = new IdentityPoolAllocator(creds(2));
    allocator.acquire();
    allocator.acquire();
    expect(() => allocator.acquire()).toThrow(/depleted/);
    expect(() => allocator.acquire()).toThrow(/2 identities consumed/);
  });

  it('error message points operators at the CLI auto-sizing contract', () => {
    const allocator = new IdentityPoolAllocator(creds(1));
    allocator.acquire();
    expect(() => allocator.acquire()).toThrow(/max\(scenarioCount, workers\)/);
  });

  it('remaining() + size() report depletion progress (diagnostics)', () => {
    const allocator = new IdentityPoolAllocator(creds(4));
    expect(allocator.size()).toBe(4);
    expect(allocator.remaining()).toBe(4);
    allocator.acquire();
    expect(allocator.remaining()).toBe(3);
    expect(allocator.size()).toBe(4); // size is the initial count, never changes
    allocator.acquire();
    allocator.acquire();
    allocator.acquire();
    expect(allocator.remaining()).toBe(0);
  });

  it('empty pool throws immediately on first acquire (caller-side safety net)', () => {
    const allocator = new IdentityPoolAllocator([]);
    expect(allocator.size()).toBe(0);
    expect(() => allocator.acquire()).toThrow(/depleted/);
  });

  it('defensive copy: mutating the source array after construction does not affect the pool', () => {
    const source = creds(2);
    const allocator = new IdentityPoolAllocator(source);
    source.length = 0; // truncate the caller's array
    // The allocator's internal copy is untouched — both identities still acquirable.
    expect(allocator.acquire().email).toBe('sim-worker-test-0@test.local');
    expect(allocator.acquire().email).toBe('sim-worker-test-1@test.local');
  });

  it('NO release() method on the API — identities are consumed once for the run', () => {
    const allocator = new IdentityPoolAllocator(creds(3));
    // The release method is intentionally absent (was on the previous rotation/release
    // design). Asserted to surface accidental re-additions in code review/refactors.
    expect((allocator as unknown as { release?: unknown }).release).toBeUndefined();
  });
});
