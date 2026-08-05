import fs from 'node:fs/promises';
import path from 'node:path';
import { createPrivateKey, createPublicKey, webcrypto } from 'node:crypto';

import {
  buildCsr,
  ECDSA_P256_PARAMS,
  exportPrivateKeyPkcs8Pem,
  exportPublicKeySpkiPem,
  generateEcdsaP256KeyPair,
} from '../cli/provision.js';

/**
 * The provisioning key set, committed to durable storage BEFORE the request.
 *
 * spec/04-flows.md:253, step 6b:
 *
 *   "Before step 7 leaves the device, the SSP MUST commit every private key
 *    generated in steps 5–6a to non-volatile storage, durably — the write MUST
 *    be flushed, not merely buffered — and MUST retain them until the provision
 *    succeeds or reaches a terminal outcome."
 *
 * and :302, "Persisting the key set — before the request, not after":
 *
 *   "The ordering is the whole requirement, and generating-then-posting-then-
 *    persisting inverts it. […] the station MUST resubmit THOSE keys on every
 *    retry rather than generating new ones."
 *
 * Every provisioning site in this repo inverted it: generate, POST, write. Kill
 * the process between the POST reaching the server and the response landing on
 * disk, and the server has bound cert C1 to key set K1 while the simulator
 * restarts, regenerates K2, and retries on the same token — answered 409 / 4015
 * PROVISIONING_KEY_MISMATCH, which 04-flows.md:280 marks recoverable:false and
 * whose only recovery is an operator minting a new token out of band.
 *
 * The simulator is a test instrument, not a device, so nothing here is bricked.
 * But it is the only readable station-side reference the firmware integrator
 * has, and it demonstrated the ordering the spec added step 6b to forbid.
 */
export interface ProvisioningKeySet {
  /** PKCS#8 PEM of the mTLS client private key. */
  tlsKeyPem: string;
  /** SPKI PEM of the mTLS client public key. */
  tlsPubPem: string;
  /** PKCS#10 CSR over the TLS key, CN=<stationId>. */
  csrPem: string;
  /** PKCS#8 PEM of the receipt-signing private key. */
  receiptKeyPem: string;
  /** SPKI PEM of the receipt-signing public key — this is what the request submits. */
  receiptPubPem: string;
  /** True when the set was reloaded from disk rather than generated. */
  reused: boolean;
  paths: ProvisioningKeyPaths;
}

export interface ProvisioningKeyPaths {
  tlsKeyPath: string;
  receiptKeyPath: string;
  receiptPubPath: string;
}

export function provisioningKeyPaths(
  stationDir: string,
  stationId: string,
): ProvisioningKeyPaths {
  return {
    tlsKeyPath: path.join(stationDir, `${stationId}-key.pem`),
    receiptKeyPath: path.join(stationDir, `${stationId}-receipt-key.pem`),
    receiptPubPath: path.join(stationDir, `${stationId}-receipt-pub.pem`),
  };
}

/**
 * Write a file and FLUSH it, then flush the containing directory so the new
 * name is durable too.
 *
 * :253 says "the write MUST be flushed, not merely buffered", and a plain
 * fs.writeFile is exactly the buffered case it rules out — the data can sit in
 * the page cache across the whole network round trip. A directory fsync is
 * needed as well, or the file's *existence* is what a power cut discards.
 */
async function writeDurable(
  filePath: string,
  contents: string,
  mode: number,
): Promise<void> {
  const handle = await fs.open(filePath, 'w', mode);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }

  // Some platforms refuse to open a directory for fsync; the file flush above is
  // the load-bearing half, so a refusal here must not fail the provision.
  try {
    const dir = await fs.open(path.dirname(filePath), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    /* directory fsync unsupported on this platform */
  }
}

async function readIfPresent(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** Import a PKCS#8 PEM back into the WebCrypto key pair `buildCsr` needs. */
async function importKeyPair(
  privateKeyPem: string,
): Promise<webcrypto.CryptoKeyPair> {
  const nodePrivate = createPrivateKey(privateKeyPem);
  const nodePublic = createPublicKey(nodePrivate);

  const privateKey = await webcrypto.subtle.importKey(
    'pkcs8',
    nodePrivate.export({ type: 'pkcs8', format: 'der' }),
    ECDSA_P256_PARAMS,
    true,
    ['sign'],
  );
  const publicKey = await webcrypto.subtle.importKey(
    'spki',
    nodePublic.export({ type: 'spki', format: 'der' }),
    ECDSA_P256_PARAMS,
    true,
    ['verify'],
  );

  return { privateKey, publicKey };
}

/**
 * Resolve the provisioning key set for `stationId`, committing it durably before
 * returning. The caller may POST the moment this resolves — that is the contract.
 *
 * If a key set is already on disk it is RELOADED rather than replaced: a retry
 * must present the keys the token already bound (:307), and regenerating is what
 * turns a lost response into an unrecoverable 4015.
 */
export async function commitProvisioningKeySet(
  stationDir: string,
  stationId: string,
  override?: Partial<ProvisioningKeyPaths>,
): Promise<ProvisioningKeySet> {
  const paths = { ...provisioningKeyPaths(stationDir, stationId), ...override };

  // Every site here lays its artifacts out differently — the scenario steps use
  // <artifacts>/<stationId>/, the CLI and the pool bootstrap use a target's flat
  // certs/<env>/ templates — so create the directory each key actually lands in
  // rather than assuming one.
  await Promise.all(
    [...new Set(Object.values(paths).map((p) => path.dirname(p)))].map((d) =>
      fs.mkdir(d, { recursive: true }),
    ),
  );

  const existingTls = await readIfPresent(paths.tlsKeyPath);
  const existingReceipt = await readIfPresent(paths.receiptKeyPath);
  const reused = existingTls !== null && existingReceipt !== null;

  const tlsKeys = reused
    ? await importKeyPair(existingTls)
    : await generateEcdsaP256KeyPair();
  const receiptKeys = reused
    ? await importKeyPair(existingReceipt)
    : await generateEcdsaP256KeyPair();

  const tlsKeyPem = exportPrivateKeyPkcs8Pem(tlsKeys.privateKey);
  const tlsPubPem = exportPublicKeySpkiPem(tlsKeys.publicKey);
  const receiptKeyPem = exportPrivateKeyPkcs8Pem(receiptKeys.privateKey);
  const receiptPubPem = exportPublicKeySpkiPem(receiptKeys.publicKey);

  if (!reused) {
    // BEFORE the CSR is built and long before the POST. Sequential rather than
    // concurrent so a failure on the second write cannot leave the first
    // unflushed while the caller proceeds.
    await writeDurable(paths.tlsKeyPath, tlsKeyPem, 0o600);
    await writeDurable(paths.receiptKeyPath, receiptKeyPem, 0o600);
    await writeDurable(paths.receiptPubPath, receiptPubPem, 0o644);
  }

  const csr = await buildCsr(stationId, tlsKeys);

  return {
    tlsKeyPem,
    tlsPubPem,
    csrPem: csr.toString('pem'),
    receiptKeyPem,
    receiptPubPem,
    reused,
    paths,
  };
}

/**
 * Drop the persisted key set.
 *
 * :302 bounds retention: the station retains the keys "until one of: the
 * provision succeeds and the issued certificate has itself been persisted; or a
 * terminal outcome is reached — 4015 PROVISIONING_KEY_MISMATCH, or 4018
 * PROVISIONING_TOKEN_CONSUMED with details.reason: consumed_without_certificate,
 * or the token's TTL elapses". Retention is never indefinite, so a station told
 * one of those must start clean on the next token.
 */
export async function discardProvisioningKeySet(
  stationDir: string,
  stationId: string,
  override?: Partial<ProvisioningKeyPaths>,
): Promise<void> {
  const paths = { ...provisioningKeyPaths(stationDir, stationId), ...override };

  await Promise.all(
    [paths.tlsKeyPath, paths.receiptKeyPath, paths.receiptPubPath].map((p) =>
      fs.rm(p, { force: true }),
    ),
  );
}
