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

export function exportPrivateKeyPkcs8Pem(privateKey: webcrypto.CryptoKey): string {
  const keyObj = KeyObject.from(privateKey);
  return keyObj.export({ type: 'pkcs8', format: 'pem' }) as string;
}

export function resolveStationTemplate(value: string, stationId: string): string {
  return value.replace(/\{\{stationId\}\}/g, stationId);
}
