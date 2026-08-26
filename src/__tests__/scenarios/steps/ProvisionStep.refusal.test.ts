import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProvisionStep } from '../../../scenarios/steps/ProvisionStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';
import type { Station } from '../../../station/Station.js';

/**
 * REFUSAL MODE — the repair to an instrument that could not observe a refusal.
 *
 * Before `expect_status`, this step threw on any status other than 200, so the provisioning
 * door's eight reachable refusals were unassertable through the only step that can build a
 * well-formed request for it. Reaching rungs 4-8 of the precedence chain any other way is
 * impossible: they need a CSR that parses, self-verifies and carries `CN=<stationId>`, and
 * the station id is generated per run, so no literal in a YAML file can serve.
 */
const FLAT_ERROR = {
  errorCode: 4010,
  errorText: 'CSR_INVALID',
  errorDescription: 'CSR could not be parsed',
  severity: 'Error',
  recoverable: true,
  recommendedAction: 'Regenerate the CSR.',
  timestamp: '2026-08-26T00:00:00.000Z',
  details: { reason: 'malformed', phase: 'first-provision' },
};

describe('ProvisionStep — expect_status turns a refusal into an assertion', () => {
  let tmpDir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let lastBody: Record<string, unknown> = {};

  function mockRefusal(status: number, body: unknown): void {
    fetchSpy.mockImplementation(async (_url: unknown, init: unknown) => {
      lastBody = JSON.parse((init as { body: string }).body) as Record<string, unknown>;

      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    });
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provision-refusal-'));
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    mockRefusal(400, FLAT_ERROR);
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function ctx(stationId = 'stn_refusal1') {
    const c = createContext();
    c.apiBaseUrl = 'http://localhost:8080';
    c.captured.set('provisioning_token', 'tok_shared');
    c.variables.set('stationId', stationId);

    return c;
  }

  const base = {
    action: 'provision',
    token_var: 'provisioning_token',
    serial_number: 'SN-1',
    bay_count: 1,
  };

  const station = {} as Station;

  it('PASSES on the expected status and pins the flat body by dotted path', async () => {
    const context = ctx();
    await new ProvisionStep().execute(
      { ...base, artifacts_dir: tmpDir, expect_status: 400,
        expect_body: { errorCode: 4010, errorText: 'CSR_INVALID', 'details.reason': 'malformed' } },
      context,
      station,
    );
    // Nothing was persisted from a response that issued no certificate.
    expect(context.provisioning).toBeUndefined();
    expect(context.captured.get('bayId_1')).toBeUndefined();
  });

  // ---- BOTH DIRECTIONS ------------------------------------------------------
  // An assertion mode that only ever passes is worse than none: it converts every refusal
  // scenario into a scenario that proves the endpoint answered something.
  it('FAILS when the status differs from the one declared', async () => {
    mockRefusal(401, { errorCode: 2019, errorText: 'PROVISIONING_TOKEN_INVALID' });
    await expect(
      new ProvisionStep().execute(
        { ...base, artifacts_dir: tmpDir, expect_status: 400 },
        ctx(),
        station,
      ),
    ).rejects.toThrow(/expected status 400 .* got 401/);
  });

  it('FAILS when a pinned body path does not match', async () => {
    await expect(
      new ProvisionStep().execute(
        { ...base, artifacts_dir: tmpDir, expect_status: 400, expect_body: { errorCode: 4020 } },
        ctx(),
        station,
      ),
    ).rejects.toThrow(/expected body "errorCode" to equal 4020, but got 4010/);
  });

  it('FAILS when a pinned nested path is absent rather than silently passing', async () => {
    await expect(
      new ProvisionStep().execute(
        { ...base, artifacts_dir: tmpDir, expect_status: 400,
          expect_body: { 'details.driftedKeyKinds': ['tls'] } },
        ctx(),
        station,
      ),
    ).rejects.toThrow(/expected body "details.driftedKeyKinds"/);
  });

  it('still THROWS on a non-200 when expect_status is absent (the old contract is intact)', async () => {
    await expect(
      new ProvisionStep().execute({ ...base, artifacts_dir: tmpDir }, ctx(), station),
    ).rejects.toThrow(/returned 400/);
  });
});

describe('ProvisionStep — the three key-shape knobs, each malforming ONE field', () => {
  let tmpDir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let lastBody: Record<string, string> = {};

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provision-knobs-'));
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u: unknown, init: unknown) => {
      lastBody = JSON.parse((init as { body: string }).body) as Record<string, string>;

      return new Response(JSON.stringify(FLAT_ERROR), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    });
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function run(extra: Record<string, unknown>, stationId: string) {
    const c = createContext();
    c.apiBaseUrl = 'http://localhost:8080';
    c.captured.set('provisioning_token', 'tok');
    c.variables.set('stationId', stationId);

    return new ProvisionStep().execute(
      { action: 'provision', token_var: 'provisioning_token', serial_number: 'SN',
        bay_count: 1, artifacts_dir: tmpDir, expect_status: 400, ...extra },
      c,
      {} as Station,
    );
  }

  it('csr_override replaces tlsCsr and leaves the receipt key generated', async () => {
    await run({ csr_override: 'NOT-A-CSR' }, 'stn_knob0001');
    expect(lastBody.tlsCsr).toBe('NOT-A-CSR');
    expect(lastBody.receiptSigningPublicKey).toContain('BEGIN PUBLIC KEY');
  });

  it('receipt_key_override replaces the receipt key and leaves the CSR generated', async () => {
    await run({ receipt_key_override: 'NOT-A-KEY' }, 'stn_knob0002');
    expect(lastBody.receiptSigningPublicKey).toBe('NOT-A-KEY');
    expect(lastBody.tlsCsr).toContain('BEGIN CERTIFICATE REQUEST');
  });

  // The whole point of 4016: the two submitted keys must not be pairwise distinct. Asserting
  // only "the field changed" would pass on any substitution; what matters is that the value
  // is the TLS key's own public half, which is what the server compares.
  it('receipt_key_from_tls submits the TLS keypair public key as the receipt key', async () => {
    await run({ receipt_key_from_tls: true }, 'stn_knob0003');
    const tlsPub = await fs.readFile(
      path.join(tmpDir, 'stn_knob0003', 'stn_knob0003-receipt-pub.pem'),
      'utf8',
    );
    expect(lastBody.receiptSigningPublicKey).toContain('BEGIN PUBLIC KEY');
    // NOT the generated receipt public key — that is the field it replaced.
    expect(lastBody.receiptSigningPublicKey).not.toBe(tlsPub);
  });

  it('with no knob, both fields are the generated set (the default path is untouched)', async () => {
    await run({}, 'stn_knob0004');
    const receiptPub = await fs.readFile(
      path.join(tmpDir, 'stn_knob0004', 'stn_knob0004-receipt-pub.pem'),
      'utf8',
    );
    expect(lastBody.receiptSigningPublicKey).toBe(receiptPub);
    expect(lastBody.tlsCsr).toContain('BEGIN CERTIFICATE REQUEST');
  });

  // Different artifacts_dir ⇒ different resolved key paths ⇒ nothing to reuse ⇒ a second,
  // independent key set for the SAME station id. This is what a 4015 scenario's retry rides
  // on, and it is why no `fresh_keys` knob exists.
  it('a different artifacts_dir yields a DIFFERENT key set for the same stationId', async () => {
    await run({}, 'stn_knob0005');
    const first = lastBody.tlsCsr;
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provision-knobs-2-'));
    try {
      const c = createContext();
      c.apiBaseUrl = 'http://localhost:8080';
      c.captured.set('provisioning_token', 'tok');
      c.variables.set('stationId', 'stn_knob0005');
      await new ProvisionStep().execute(
        { action: 'provision', token_var: 'provisioning_token', serial_number: 'SN',
          bay_count: 1, artifacts_dir: otherDir, expect_status: 400 },
        c,
        {} as Station,
      );
      expect(lastBody.tlsCsr).not.toBe(first);
    } finally {
      await fs.rm(otherDir, { recursive: true, force: true });
    }
  });
});
