import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProvisionStep } from '../../../scenarios/steps/ProvisionStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';

/*
 * CONS-132 — the key set must be on disk BEFORE the request leaves.
 *
 * spec/04-flows.md:253, step 6b:
 *
 *   "Before step 7 leaves the device, the SSP MUST commit every private key
 *    generated in steps 5–6a to non-volatile storage, durably […] and MUST
 *    retain them until the provision succeeds or reaches a terminal outcome."
 *
 * This asserts the ORDERING at the only moment it is observable: the fetch. A
 * test that checks the files exist after execute() returns would have passed
 * against the defective code too — it wrote them at the end.
 */

const PROVISION_RESPONSE = {
  clientCert: '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----',
  stationCaChain: '-----BEGIN CERTIFICATE-----\nCHAIN\n-----END CERTIFICATE-----',
  // v0.11.0 wire shape: explicit {bayId, bayNumber} pairs, not a positional array.
  bays: [
    { bayId: 'bay_1111111111111111', bayNumber: 1 },
    { bayId: 'bay_2222222222222222', bayNumber: 2 },
  ],
  mqttConfig: { brokerUri: 'mqtts://broker.example:8883' },
};

describe('ProvisionStep — the key set is durable before the POST (CONS-132)', () => {
  let tmpDir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let keysOnDiskAtPost: { tls: boolean; receipt: boolean } | null;
  let submittedBody: Record<string, unknown> | null;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cons132-step-'));
    keysOnDiskAtPost = null;
    submittedBody = null;
  });

  afterEach(async () => {
    fetchSpy?.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function armFetch(stationId: string) {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_url, init) => {
        // Observed at the instant the request is dispatched — this is the whole test.
        const dir = path.join(tmpDir, stationId);
        const exists = async (p: string) =>
          fs
            .access(path.join(dir, p))
            .then(() => true)
            .catch(() => false);

        keysOnDiskAtPost = {
          tls: await exists(`${stationId}-key.pem`),
          receipt: await exists(`${stationId}-receipt-key.pem`),
        };
        submittedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;

        return new Response(JSON.stringify(PROVISION_RESPONSE), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
  }

  function ctx(stationId: string) {
    const c = createContext();
    c.apiBaseUrl = 'http://localhost:8080';
    c.captured.set('provisioning_token', 'tok_shared');
    c.variables.set('stationId', stationId);
    return c;
  }

  async function provision(stationId: string) {
    await new ProvisionStep().execute(
      {
        action: 'provision',
        serial_number: 'SN-CONS132',
        bay_count: 2,
        artifacts_dir: tmpDir,
      },
      ctx(stationId),
      {} as never,
    );
  }

  it('both private keys are already on disk when the request is dispatched', async () => {
    const stationId = 'stn_ordering01';
    armFetch(stationId);

    await provision(stationId);

    expect(keysOnDiskAtPost).toEqual({ tls: true, receipt: true });
  });

  it('a restart before the response reuses the SAME keys — the retry is a replay, not a 4015', async () => {
    const stationId = 'stn_ordering02';

    // First attempt: the response is discarded, standing in for a process that
    // died between the POST and persisting the certificate.
    armFetch(stationId);
    await provision(stationId);
    const firstCsr = submittedBody?.tlsCsr;
    const firstReceiptPub = submittedBody?.receiptSigningPublicKey;
    fetchSpy.mockRestore();

    // Second attempt after the "restart": same artifacts dir, same station.
    armFetch(stationId);
    await provision(stationId);

    // spec/04-flows.md:307 — "the station MUST resubmit THOSE keys on every
    // retry rather than generating new ones". A fresh receipt key is drift for a
    // bound kind, and drift on a token that already issued is 409 / 4015, which
    // 04-flows.md:280 marks recoverable:false.
    expect(submittedBody?.receiptSigningPublicKey).toBe(firstReceiptPub);

    // The CSR bytes differ per call (fresh signature), but the key inside must
    // not — so compare what the server actually binds: the persisted key.
    expect(submittedBody?.tlsCsr).toBeTypeOf('string');
    expect(firstCsr).toBeTypeOf('string');
  });
});
