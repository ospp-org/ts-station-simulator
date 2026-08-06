import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { commitProvisioningKeySet } from '../../src/provisioning/persistedKeySet.js';

/*
 * CONS-132 — the key set must be durable BEFORE the POST, not after it.
 *
 * spec/04-flows.md:253, step 6b:
 *
 *   "Before step 7 leaves the device, the SSP MUST commit every private key
 *    generated in steps 5–6a to non-volatile storage, durably — the write MUST
 *    be flushed, not merely buffered — and MUST retain them until the provision
 *    succeeds or reaches a terminal outcome."
 *
 * and :302, "Persisting the key set — before the request, not after", whose
 * closing paragraph states the stakes:
 *
 *   "The ordering is the whole requirement, and generating-then-posting-then-
 *    persisting inverts it. […] the station MUST resubmit THOSE keys on every
 *    retry rather than generating new ones. […] committing them last costs the
 *    station its identity and the operator a site visit."
 *
 * All four provisioning sites in this repo inverted the ordering: keygen, POST,
 * then write. Kill the process between the POST reaching CSMS and the response
 * landing on disk and the server has already bound cert C1 to key set K1, while
 * the simulator restarts, regenerates K2, and retries on the same token —
 * answered 409 / 4015 PROVISIONING_KEY_MISMATCH, which 04-flows.md:280 marks
 * recoverable:false.
 */

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cons132-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('commitProvisioningKeySet', () => {
  it('writes both private keys to disk before it returns', async () => {
    const stationDir = path.join(dir, 'stn_aaaa1111');
    const keys = await commitProvisioningKeySet(stationDir, 'stn_aaaa1111');

    // The contract is that the caller can POST the moment this resolves.
    await expect(fs.readFile(keys.paths.tlsKeyPath, 'utf8')).resolves.toContain(
      'BEGIN PRIVATE KEY',
    );
    await expect(
      fs.readFile(keys.paths.receiptKeyPath, 'utf8'),
    ).resolves.toContain('BEGIN PRIVATE KEY');
    expect(keys.reused).toBe(false);
  });

  it('writes the private keys 0600', async () => {
    const stationDir = path.join(dir, 'stn_bbbb2222');
    const keys = await commitProvisioningKeySet(stationDir, 'stn_bbbb2222');

    const tlsMode = (await fs.stat(keys.paths.tlsKeyPath)).mode & 0o777;
    const receiptMode = (await fs.stat(keys.paths.receiptKeyPath)).mode & 0o777;

    expect(tlsMode).toBe(0o600);
    expect(receiptMode).toBe(0o600);
  });

  it('REUSES a persisted key set instead of generating a new one — the retry presents THOSE keys', async () => {
    const stationDir = path.join(dir, 'stn_cccc3333');

    const first = await commitProvisioningKeySet(stationDir, 'stn_cccc3333');
    // Simulates the process dying after the POST and restarting.
    const second = await commitProvisioningKeySet(stationDir, 'stn_cccc3333');

    expect(second.reused).toBe(true);
    expect(second.tlsKeyPem).toBe(first.tlsKeyPem);
    expect(second.receiptKeyPem).toBe(first.receiptKeyPem);

    // The receipt PUBLIC key is what the retry submits, and it is derived from
    // the reloaded private key — so a mismatch here is exactly the 4015 the
    // requirement exists to prevent.
    expect(second.receiptPubPem).toBe(first.receiptPubPem);
  });

  it('the reloaded TLS key still produces a CSR the server can bind', async () => {
    const stationDir = path.join(dir, 'stn_dddd4444');

    const first = await commitProvisioningKeySet(stationDir, 'stn_dddd4444');
    const second = await commitProvisioningKeySet(stationDir, 'stn_dddd4444');

    // A CSR carries the SubjectPublicKeyInfo the server binds. Same key in, same
    // SPKI out — a fresh keypair would be answered 4015 on the retry.
    expect(second.csrPem).toBeTypeOf('string');
    expect(second.csrPem).toContain('BEGIN CERTIFICATE REQUEST');
    expect(second.tlsPubPem).toBe(first.tlsPubPem);
  });

  it('discardProvisioningKeySet removes the key set at a terminal outcome', async () => {
    const stationDir = path.join(dir, 'stn_eeee5555');

    const { discardProvisioningKeySet } = await import(
      '../../src/provisioning/persistedKeySet.js'
    );

    const keys = await commitProvisioningKeySet(stationDir, 'stn_eeee5555');
    await discardProvisioningKeySet(stationDir, 'stn_eeee5555');

    // :302 requires retention until success OR a terminal outcome — retention is
    // bounded, not indefinite, so a station that was told 4015 starts clean.
    await expect(fs.access(keys.paths.tlsKeyPath)).rejects.toThrow();
    await expect(fs.access(keys.paths.receiptKeyPath)).rejects.toThrow();

    const regenerated = await commitProvisioningKeySet(stationDir, 'stn_eeee5555');
    expect(regenerated.reused).toBe(false);
    expect(regenerated.tlsKeyPem).not.toBe(keys.tlsKeyPem);
  });
});
