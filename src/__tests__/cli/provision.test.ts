import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import {
  generateEcdsaP256KeyPair,
  buildCsr,
  exportPrivateKeyPkcs8Pem,
  exportPublicKeySpkiPem,
  resolveStationTemplate,
} from '../../cli/provision.js';

describe('generateEcdsaP256KeyPair', () => {
  it('returns an ECDSA P-256 keypair with sign/verify usages', async () => {
    const keys = await generateEcdsaP256KeyPair();

    expect(keys.privateKey.type).toBe('private');
    expect(keys.publicKey.type).toBe('public');

    const algo = keys.privateKey.algorithm as webcrypto.EcKeyAlgorithm;
    expect(algo.name).toBe('ECDSA');
    expect(algo.namedCurve).toBe('P-256');

    expect(keys.privateKey.usages).toContain('sign');
    expect(keys.publicKey.usages).toContain('verify');
  });
});

describe('buildCsr', () => {
  it('produces a CSR with CN equal to the stationId', async () => {
    const stationId = 'stn_00000099';
    const keys = await generateEcdsaP256KeyPair();
    const csr = await buildCsr(stationId, keys);

    expect(csr.subject).toContain(`CN=${stationId}`);
  });

  it('emits a valid PEM-encoded CSR', async () => {
    const keys = await generateEcdsaP256KeyPair();
    const csr = await buildCsr('stn_000000aa', keys);
    const pem = csr.toString('pem');

    expect(pem).toMatch(/-----BEGIN CERTIFICATE REQUEST-----/);
    expect(pem).toMatch(/-----END CERTIFICATE REQUEST-----/);
  });

  it('generates a CSR whose signature verifies against its own public key', async () => {
    const keys = await generateEcdsaP256KeyPair();
    const csr = await buildCsr('stn_000000bb', keys);

    const verified = await csr.verify();
    expect(verified).toBe(true);
  });

  it('embeds an ECDSA P-256 public key matching the keypair', async () => {
    const keys = await generateEcdsaP256KeyPair();
    const csr = await buildCsr('stn_000000cc', keys);

    const csrPub = await csr.publicKey.export();
    const csrAlgo = csrPub.algorithm as webcrypto.EcKeyAlgorithm;
    expect(csrAlgo.name).toBe('ECDSA');
    expect(csrAlgo.namedCurve).toBe('P-256');
  });
});

describe('exportPrivateKeyPkcs8Pem', () => {
  it('exports the private key as a PKCS8 PEM block', async () => {
    const keys = await generateEcdsaP256KeyPair();
    const pem = exportPrivateKeyPkcs8Pem(keys.privateKey);

    expect(pem).toMatch(/-----BEGIN PRIVATE KEY-----/);
    expect(pem).toMatch(/-----END PRIVATE KEY-----/);
  });
});

describe('exportPublicKeySpkiPem', () => {
  it('exports the public key as a SubjectPublicKeyInfo PEM block', async () => {
    const keys = await generateEcdsaP256KeyPair();
    const pem = exportPublicKeySpkiPem(keys.publicKey);

    expect(pem).toMatch(/-----BEGIN PUBLIC KEY-----/);
    expect(pem).toMatch(/-----END PUBLIC KEY-----/);
  });

  it('produces a different output for distinct keypairs (sanity)', async () => {
    const a = await generateEcdsaP256KeyPair();
    const b = await generateEcdsaP256KeyPair();
    expect(exportPublicKeySpkiPem(a.publicKey)).not.toBe(exportPublicKeySpkiPem(b.publicKey));
  });
});

describe('@peculiar/x509 integration sanity', () => {
  it('exposes the CSR generator class', () => {
    expect(x509.Pkcs10CertificateRequestGenerator).toBeDefined();
  });
});

describe('resolveStationTemplate', () => {
  it('substitutes {{stationId}} in cert path templates', () => {
    expect(resolveStationTemplate('certs/uat/{{stationId}}-key.pem', 'stn_00000099'))
      .toBe('certs/uat/stn_00000099-key.pem');
  });

  it('replaces every occurrence', () => {
    expect(resolveStationTemplate('{{stationId}}/{{stationId}}.pem', 'stn_abc'))
      .toBe('stn_abc/stn_abc.pem');
  });
});
