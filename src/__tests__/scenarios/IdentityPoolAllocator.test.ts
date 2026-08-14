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

describe('IdentityPoolAllocator — declared wallet_balance reservations', () => {
  // A scenario whose subject is the 402 INSUFFICIENT_BALANCE gate declares `wallet_balance: 0`
  // and the pool builder seeds it a matching identity. Two properties matter, and they pull
  // in opposite directions: the declaring scenario must GET the unfunded identity, and every
  // other scenario must never get it by accident.

  function pool(): IdentityCredentials[] {
    return [
      { email: 'w0@t', password: 'p', walletBalance: 1000 },
      { email: 'w1@t', password: 'p', walletBalance: 1000 },
      { email: 'poor@t', password: 'p', walletBalance: 0, declared: true },
      { email: 'rich@t', password: 'p', walletBalance: 5000, declared: true },
    ];
  }

  it('acquire(0) returns the identity reserved at 0', () => {
    expect(new IdentityPoolAllocator(pool()).acquire(0).email).toBe('poor@t');
  });

  it('acquire(5000) picks by balance, not by position', () => {
    expect(new IdentityPoolAllocator(pool()).acquire(5000).email).toBe('rich@t');
  });

  it('a plain acquire() NEVER hands out a reserved identity — even once the defaults run out', () => {
    // THE failure this split prevents: an undeclaring scenario receiving the unfunded
    // identity would be refused 402 for a reason it is not about, and would report it 15s
    // later as a `wait_for` timeout naming a message that never arrived.
    const allocator = new IdentityPoolAllocator(pool());
    expect(allocator.acquire().email).toBe('w0@t');
    expect(allocator.acquire().email).toBe('w1@t');
    expect(() => allocator.acquire()).toThrow(/depleted/);
  });

  it('an unmatched declaration THROWS rather than substituting a funded identity', () => {
    // Silently handing back a payable wallet would let a refusal proof pass for the wrong
    // reason — the one outcome worse than the run failing here.
    const allocator = new IdentityPoolAllocator(pool());
    expect(() => allocator.acquire(42)).toThrow(/no identity reserved at wallet_balance 42/);
    expect(() => allocator.acquire(42)).toThrow(/balances: \[0, 5000\]/);
  });

  it('the error names the wiring step that produces the reservation', () => {
    const allocator = new IdentityPoolAllocator([]);
    expect(() => allocator.acquire(0)).toThrow(/declaredWalletBalances/);
  });

  it('reserved identities are single-use too — two scenarios wanting 0 need two of them', () => {
    const allocator = new IdentityPoolAllocator([
      { email: 'poor-a@t', password: 'p', walletBalance: 0, declared: true },
      { email: 'poor-b@t', password: 'p', walletBalance: 0, declared: true },
    ]);
    expect(allocator.acquire(0).email).toBe('poor-a@t');
    expect(allocator.acquire(0).email).toBe('poor-b@t');
    expect(() => allocator.acquire(0)).toThrow(/no identity reserved at wallet_balance 0/);
  });

  it('remaining() counts both queues', () => {
    const allocator = new IdentityPoolAllocator(pool());
    expect(allocator.size()).toBe(4);
    expect(allocator.remaining()).toBe(4);
    allocator.acquire(0);
    expect(allocator.remaining()).toBe(3);
    allocator.acquire();
    expect(allocator.remaining()).toBe(2);
  });
});
