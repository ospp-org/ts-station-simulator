import 'reflect-metadata';
import { createPrivateKey, randomBytes, webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { exportPrivateKeyPkcs8Pem } from '../cli/provision.js';
import { derEnumerated, derInteger, derOctetString, derSequence } from './der.js';

/**
 * An Android Key Attestation of a device key, as a phone's Keystore produces one - for a station
 * simulator that has no Keystore and must still obtain an offline pass.
 *
 * spec/profiles/offline/app-contract.md 3.6 item 2: the app generates the device key in the
 * Android Keystore with the server's challenge as its attestation challenge, and sends the key's
 * attestation certificate chain, leaf first, each certificate DER and Base64. The server verifies
 * that each certificate signs the next, that the chain roots in a trusted attestation root, that
 * the leaf's public key is `devicePublicKey` and that the leaf's key description carries the
 * challenge and a `TrustedEnvironment` or `StrongBox` security level.
 *
 * A genuine chain roots in Google's attestation root, which signs no simulator's keys, so this
 * one roots in a TEST root the server under test has been told to trust (csms-server's
 * OSPP_OFFLINE_ATTESTATION_TEST_ROOTS, which it refuses in production). Every other property is
 * the verifier's real input: the chain's signatures, the leaf's key, the key description's
 * challenge and level. A root the server does not trust, a Software level or another challenge
 * are what the refusals are proven with.
 */

/** Android's attestation extension: the key description, OID 1.3.6.1.4.1.11129.2.1.17. */
export const KEY_DESCRIPTION_OID = '1.3.6.1.4.1.11129.2.1.17';

/** KeyDescription's SecurityLevel: Software (0), TrustedEnvironment (1), StrongBox (2). */
export type AttestationSecurityLevel = 'Software' | 'TrustedEnvironment' | 'StrongBox';

const SECURITY_LEVEL: Record<AttestationSecurityLevel, number> = {
  Software: 0,
  TrustedEnvironment: 1,
  StrongBox: 2,
};

/** The KeyMint version this fixture states, 300 (attestation version 300, KeyMint 3). */
const KEYMINT_VERSION = 300;

export interface AttestationRoot {
  certPem: string;
  keyPem: string;
}

export interface AndroidKeyAttestation {
  /** The device key's public key, compressed SEC1, Base64 (44 characters). */
  devicePublicKey: string;
  deviceKeyAttestation: {
    format: 'android-key';
    challenge: string;
    certificateChain: string[];
  };
  /** The device key's private key, PKCS#8 PEM - what a later device proof signs with. */
  devicePrivateKeyPem: string;
}

export interface AndroidKeyAttestationOptions {
  /** The server's challenge, Base64 of 32 bytes. */
  challenge: string;
  root: AttestationRoot;
  securityLevel?: AttestationSecurityLevel;
}

const P256: webcrypto.EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' };

function useWebcrypto(): void {
  x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);
}

function serial(): string {
  // Positive, 16 octets: the first octet below 0x80 so the INTEGER needs no leading zero.
  const bytes = randomBytes(16);
  bytes[0] &= 0x7f;
  return bytes.toString('hex');
}

function validity(years: number): { notBefore: Date; notAfter: Date } {
  const now = Date.now();
  return {
    notBefore: new Date(now - 24 * 3600 * 1000),
    notAfter: new Date(now + years * 365 * 24 * 3600 * 1000),
  };
}

async function importSigningKey(keyPem: string): Promise<{ key: webcrypto.CryptoKey; hash: string }> {
  const keyObject = createPrivateKey(keyPem);
  const curve = keyObject.asymmetricKeyDetails?.namedCurve;
  const namedCurve = curve === 'prime256v1' ? 'P-256' : curve === 'secp384r1' ? 'P-384' : null;
  if (namedCurve === null) {
    throw new Error(`attestation root key: an EC P-256 or P-384 key is required, got ${String(curve)}`);
  }
  const der = keyObject.export({ type: 'pkcs8', format: 'der' });
  const key = await webcrypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve }, false, ['sign']);
  return { key, hash: namedCurve === 'P-256' ? 'SHA-256' : 'SHA-384' };
}

/** A self-signed EC P-256 CA, for tests and for minting a UAT test root once. */
export async function createAttestationRoot(subject: string): Promise<AttestationRoot> {
  useWebcrypto();
  const keys = await webcrypto.subtle.generateKey(P256, true, ['sign', 'verify']);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial(),
    name: subject,
    ...validity(10),
    keys,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
    ],
  });
  return { certPem: cert.toString('pem'), keyPem: exportPrivateKeyPkcs8Pem(keys.privateKey) };
}

/** The key description of a key attested for `challenge` at `level`; both authorization lists empty. */
export function keyDescription(challenge: Buffer, level: AttestationSecurityLevel): Buffer {
  const lvl = SECURITY_LEVEL[level];
  return derSequence(
    derInteger(KEYMINT_VERSION),
    derEnumerated(lvl),
    derInteger(KEYMINT_VERSION),
    derEnumerated(lvl),
    derOctetString(challenge),
    derOctetString(Buffer.alloc(0)),
    derSequence(),
    derSequence(),
  );
}

async function compressedPublicKey(key: webcrypto.CryptoKey): Promise<string> {
  const raw = Buffer.from(await webcrypto.subtle.exportKey('raw', key));
  const prefix = raw[64] % 2 === 0 ? 0x02 : 0x03;
  return Buffer.concat([Buffer.from([prefix]), raw.subarray(1, 33)]).toString('base64');
}

export async function buildAndroidKeyAttestation(
  options: AndroidKeyAttestationOptions,
): Promise<AndroidKeyAttestation> {
  useWebcrypto();
  const challengeBytes = Buffer.from(options.challenge, 'base64');
  if (challengeBytes.length !== 32 || challengeBytes.toString('base64') !== options.challenge) {
    throw new Error('the attestation challenge must be 32 bytes in Base64, as the server issues it');
  }
  const level = options.securityLevel ?? 'TrustedEnvironment';

  const rootCert = new x509.X509Certificate(options.root.certPem);
  const root = await importSigningKey(options.root.keyPem);

  const intermediateKeys = await webcrypto.subtle.generateKey(P256, true, ['sign', 'verify']);
  const intermediate = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    issuer: rootCert.subject,
    subject: 'CN=Sim attestation intermediate',
    ...validity(5),
    publicKey: intermediateKeys.publicKey,
    signingKey: root.key,
    signingAlgorithm: { name: 'ECDSA', hash: root.hash },
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true),
    ],
  });

  const deviceKeys = await webcrypto.subtle.generateKey(P256, true, ['sign', 'verify']);
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    issuer: intermediate.subject,
    subject: 'CN=Android Keystore Key',
    ...validity(1),
    publicKey: deviceKeys.publicKey,
    signingKey: intermediateKeys.privateKey,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    extensions: [
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.Extension(KEY_DESCRIPTION_OID, false, keyDescription(challengeBytes, level)),
    ],
  });

  const b64 = (cert: x509.X509Certificate): string => Buffer.from(cert.rawData).toString('base64');
  return {
    devicePublicKey: await compressedPublicKey(deviceKeys.publicKey),
    deviceKeyAttestation: {
      format: 'android-key',
      challenge: options.challenge,
      certificateChain: [b64(leaf), b64(intermediate), b64(rootCert)],
    },
    devicePrivateKeyPem: exportPrivateKeyPkcs8Pem(deviceKeys.privateKey),
  };
}
