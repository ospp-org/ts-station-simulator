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

describe('IdentityPoolAllocator', () => {
  it('hands out distinct credentials on consecutive acquires (no duplicates while in-use)', async () => {
    const allocator = new IdentityPoolAllocator(creds(3));
    const a = await allocator.acquire();
    const b = await allocator.acquire();
    const c = await allocator.acquire();
    expect(new Set([a.email, b.email, c.email]).size).toBe(3);
  });

  it('release returns the credential to the pool — subsequent acquire can pick it up', async () => {
    const allocator = new IdentityPoolAllocator(creds(2));
    const a = await allocator.acquire();
    const b = await allocator.acquire();
    allocator.release(a);
    const c = await allocator.acquire();
    // The released `a` is the only available slot now; `b` is still in-use.
    expect(c.email).toBe(a.email);
  });

  it('blocks acquire when all credentials are in use; resolves on release (waiting queue)', async () => {
    const allocator = new IdentityPoolAllocator(creds(2));
    const a = await allocator.acquire();
    const b = await allocator.acquire();
    // Third acquire must wait.
    let resolved: IdentityCredentials | null = null;
    const pending = allocator.acquire().then((c) => {
      resolved = c;
      return c;
    });
    // Give the event loop a chance — should still be unresolved.
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(resolved).toBeNull();
    // Releasing `a` should unblock the queued acquire.
    allocator.release(a);
    const c = await pending;
    expect(c.email).toBe(a.email);
    // `b` still in-use; releasing it cleans up the test pool.
    allocator.release(b);
  });

  it('concurrent acquires from a full pool round-robin distinct credentials', async () => {
    const allocator = new IdentityPoolAllocator(creds(5));
    const results = await Promise.all([
      allocator.acquire(), allocator.acquire(), allocator.acquire(),
      allocator.acquire(), allocator.acquire(),
    ]);
    expect(new Set(results.map((r) => r.email)).size).toBe(5);
  });

  it('release of an unknown credential is a no-op (defensive: cannot poison the pool)', () => {
    const allocator = new IdentityPoolAllocator(creds(2));
    // Releasing a credential that was never acquired is harmless — Set.delete on a
    // missing key is a no-op; waiting queue stays empty.
    expect(() => allocator.release({ email: 'stranger@x', password: 'y' })).not.toThrow();
  });
});
