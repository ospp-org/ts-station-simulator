import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { webcrypto, randomBytes } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import {
  buildAndroidKeyAttestation,
  createAttestationRoot,
  KEY_DESCRIPTION_OID,
} from '../../offline/androidKeyAttestation.js';
import { readTlv, readSequence } from '../../offline/der.js';

x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

const challenge = (): string => randomBytes(32).toString('base64');

function certsOf(chain: string[]): x509.X509Certificate[] {
  return chain.map((b64) => new x509.X509Certificate(Buffer.from(b64, 'base64')));
}

/** The KeyDescription's fields by position (app-contract.md 3.6; Android's KeyDescription schema). */
function keyDescriptionOf(leaf: x509.X509Certificate): { securityLevel: number; challenge: Buffer } {
  const ext = leaf.getExtension(KEY_DESCRIPTION_OID);
  if (!ext) throw new Error('the leaf carries no KeyDescription');
  const fields = readSequence(Buffer.from(ext.value));
  // attestationVersion, attestationSecurityLevel, keyMintVersion, keyMintSecurityLevel,
  // attestationChallenge, uniqueId, softwareEnforced, hardwareEnforced
  expect(fields).toHaveLength(8);
  expect(fields[1].tag).toBe(0x0a);
  expect(fields[4].tag).toBe(0x04);
  return { securityLevel: fields[1].value[0], challenge: fields[4].value };
}

describe('buildAndroidKeyAttestation', () => {
  it('chains leaf -> intermediate -> the given root, each certificate signed by the next', async () => {
    const root = await createAttestationRoot('CN=Sim attestation test root');
    const att = await buildAndroidKeyAttestation({ challenge: challenge(), root });

    const chain = att.deviceKeyAttestation.certificateChain;
    expect(att.deviceKeyAttestation.format).toBe('android-key');
    expect(chain).toHaveLength(3);
    const [leaf, intermediate, rootCert] = certsOf(chain);
    expect(await leaf.verify({ publicKey: intermediate.publicKey, signatureOnly: true })).toBe(true);
    expect(await intermediate.verify({ publicKey: rootCert.publicKey, signatureOnly: true })).toBe(true);
    expect(await rootCert.verify({ signatureOnly: true })).toBe(true);
    expect(rootCert.toString('pem').trim()).toBe(root.certPem.trim());
  });

  it("names the leaf's key as devicePublicKey, compressed SEC1 in 44 Base64 characters", async () => {
    const root = await createAttestationRoot('CN=Sim attestation test root');
    const att = await buildAndroidKeyAttestation({ challenge: challenge(), root });

    expect(att.devicePublicKey).toMatch(/^[A-Za-z0-9+/]{44}$/);
    const [leaf] = certsOf(att.deviceKeyAttestation.certificateChain);
    const raw = Buffer.from(await webcrypto.subtle.exportKey('raw', await leaf.publicKey.export()));
    expect(raw[0]).toBe(0x04);
    const compressed = Buffer.concat([Buffer.from([raw[64] % 2 === 0 ? 0x02 : 0x03]), raw.subarray(1, 33)]);
    expect(compressed.toString('base64')).toBe(att.devicePublicKey);
  });

  it('carries the challenge, decoded, and TrustedEnvironment by default', async () => {
    const root = await createAttestationRoot('CN=Sim attestation test root');
    const c = challenge();
    const att = await buildAndroidKeyAttestation({ challenge: c, root });

    expect(att.deviceKeyAttestation.challenge).toBe(c);
    const kd = keyDescriptionOf(certsOf(att.deviceKeyAttestation.certificateChain)[0]);
    expect(kd.challenge.equals(Buffer.from(c, 'base64'))).toBe(true);
    expect(kd.securityLevel).toBe(1);
  });

  it('states the security level it is asked for', async () => {
    const root = await createAttestationRoot('CN=Sim attestation test root');
    for (const [level, value] of [['Software', 0], ['TrustedEnvironment', 1], ['StrongBox', 2]] as const) {
      const att = await buildAndroidKeyAttestation({ challenge: challenge(), root, securityLevel: level });
      expect(keyDescriptionOf(certsOf(att.deviceKeyAttestation.certificateChain)[0]).securityLevel).toBe(value);
    }
  });

  it('hands back the private key of the attested key, which signs what devicePublicKey verifies', async () => {
    const root = await createAttestationRoot('CN=Sim attestation test root');
    const att = await buildAndroidKeyAttestation({ challenge: challenge(), root });

    const { createSign, createVerify } = await import('node:crypto');
    const signature = createSign('SHA256').update('proof').sign(att.devicePrivateKeyPem);
    const [leaf] = certsOf(att.deviceKeyAttestation.certificateChain);
    expect(createVerify('SHA256').update('proof').verify(leaf.publicKey.toString('pem'), signature)).toBe(true);
  });

  it('refuses a challenge that is not 32 bytes in Base64', async () => {
    const root = await createAttestationRoot('CN=Sim attestation test root');
    await expect(buildAndroidKeyAttestation({ challenge: 'c2hvcnQ=', root })).rejects.toThrow(/32 bytes/);
  });
});

describe('readTlv', () => {
  it('reads a long-form length', () => {
    const value = Buffer.alloc(200, 7);
    const tlv = readTlv(Buffer.concat([Buffer.from([0x04, 0x81, 200]), value]), 0);
    expect(tlv.tag).toBe(0x04);
    expect(tlv.value.equals(value)).toBe(true);
    expect(tlv.end).toBe(203);
  });
});
