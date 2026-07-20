import 'reflect-metadata';
import { webcrypto, KeyObject } from 'node:crypto';
import * as x509 from '@peculiar/x509';

export const ECDSA_P256_PARAMS: webcrypto.EcKeyGenParams & webcrypto.EcdsaParams = {
  name: 'ECDSA',
  namedCurve: 'P-256',
  hash: 'SHA-256',
};

export async function generateEcdsaP256KeyPair(): Promise<webcrypto.CryptoKeyPair> {
  return webcrypto.subtle.generateKey(ECDSA_P256_PARAMS, true, ['sign', 'verify']);
}

export async function buildCsr(
  stationId: string,
  keys: webcrypto.CryptoKeyPair,
): Promise<x509.Pkcs10CertificateRequest> {
  x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);
  return x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${stationId}`,
    keys,
    signingAlgorithm: ECDSA_P256_PARAMS,
  });
}

/**
 * Mint a fresh ECDSA P-256 keypair and the matching CSR for `stationId`, and
 * return both as PEM. This is the single generator shared by station
 * provisioning (ProvisionStep, over HTTP) and certificate RENEWAL (the inbound
 * TriggerCertificateRenewal handler, over MQTT) — deliberately the SAME shape
 * so the CSMS `CsrValidator` accepts a renewal CSR exactly as it accepts a
 * provisioning one (EC secp256r1, `CN=<stationId>`, valid self-signature).
 *
 * The returned `privateKeyPem` is the device-held key the station must retain to
 * pair with the signed leaf the server later pushes in CertificateInstall. A
 * fresh keypair per call is intentional: a renewal is a genuine re-key, so the
 * server signs a new active cert (which the LeafCertificateRenewalScanner then
 * observes as completion) rather than short-circuiting on pubkey-idempotency.
 */
export async function buildStationCsr(
  stationId: string,
): Promise<{ csrPem: string; privateKeyPem: string }> {
  const keys = await generateEcdsaP256KeyPair();
  const csr = await buildCsr(stationId, keys);
  return {
    csrPem: csr.toString('pem'),
    privateKeyPem: exportPrivateKeyPkcs8Pem(keys.privateKey),
  };
}

export function exportPrivateKeyPkcs8Pem(privateKey: webcrypto.CryptoKey): string {
  const keyObj = KeyObject.from(privateKey);
  return keyObj.export({ type: 'pkcs8', format: 'pem' }) as string;
}

export function exportPublicKeySpkiPem(publicKey: webcrypto.CryptoKey): string {
  const keyObj = KeyObject.from(publicKey);
  return keyObj.export({ type: 'spki', format: 'pem' }) as string;
}

export function resolveStationTemplate(value: string, stationId: string): string {
  return value.replace(/\{\{stationId\}\}/g, stationId);
}
