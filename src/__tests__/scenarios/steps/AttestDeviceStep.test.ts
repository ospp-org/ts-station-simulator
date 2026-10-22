import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as x509 from '@peculiar/x509';
import { AttestDeviceStep } from '../../../scenarios/steps/AttestDeviceStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';
import { createAttestationRoot, type AttestationRoot } from '../../../offline/androidKeyAttestation.js';
import type { Station } from '../../../station/Station.js';

const station = {} as Station;
const challenge = (): string => randomBytes(32).toString('base64');

let root: AttestationRoot;
let dir: string;

beforeAll(async () => {
  root = await createAttestationRoot('CN=Sim attestation test root');
  dir = mkdtempSync(path.join(tmpdir(), 'attest-step-'));
  writeFileSync(path.join(dir, 'root.pem'), root.certPem);
  writeFileSync(path.join(dir, 'root.key'), root.keyPem);
});

afterEach(() => {
  delete process.env.SIM_ATTESTATION_ROOT_CERT;
  delete process.env.SIM_ATTESTATION_ROOT_KEY;
});

function trustRoot(): void {
  process.env.SIM_ATTESTATION_ROOT_CERT = path.join(dir, 'root.pem');
  process.env.SIM_ATTESTATION_ROOT_KEY = path.join(dir, 'root.key');
}

describe('AttestDeviceStep', () => {
  it('captures the device key and its attestation, rooted in the configured root', async () => {
    trustRoot();
    const ctx = createContext();
    const c = challenge();
    await new AttestDeviceStep().execute(
      {
        action: 'attest_device',
        challenge: c,
        capture: { key: 'devicePublicKey', attestation: 'deviceKeyAttestation', priv: 'devicePrivateKeyPem' },
      },
      ctx,
      station,
    );

    expect(ctx.captured.get('key')).toMatch(/^[A-Za-z0-9+/]{44}$/);
    const att = ctx.captured.get('attestation') as { format: string; challenge: string; certificateChain: string[] };
    expect(att.format).toBe('android-key');
    expect(att.challenge).toBe(c);
    const last = new x509.X509Certificate(Buffer.from(att.certificateChain[2], 'base64'));
    expect(last.toString('pem').trim()).toBe(root.certPem.trim());
    expect(String(ctx.captured.get('priv'))).toMatch(/BEGIN PRIVATE KEY/);
  });

  it('roots an untrusted attestation in a fresh root of its own', async () => {
    trustRoot();
    const ctx = createContext();
    await new AttestDeviceStep().execute(
      { action: 'attest_device', challenge: challenge(), root: 'untrusted', capture: { attestation: 'deviceKeyAttestation' } },
      ctx,
      station,
    );
    const att = ctx.captured.get('attestation') as { certificateChain: string[] };
    const last = new x509.X509Certificate(Buffer.from(att.certificateChain[2], 'base64'));
    expect(last.toString('pem').trim()).not.toBe(root.certPem.trim());
  });

  it('refuses to run without a configured root when the attestation is to be trusted', async () => {
    await expect(
      new AttestDeviceStep().execute(
        { action: 'attest_device', challenge: challenge(), capture: { k: 'devicePublicKey' } },
        createContext(),
        station,
      ),
    ).rejects.toThrow(/SIM_ATTESTATION_ROOT_CERT/);
  });

  it('refuses an unknown output name and an unknown security level', async () => {
    trustRoot();
    await expect(
      new AttestDeviceStep().execute(
        { action: 'attest_device', challenge: challenge(), capture: { k: 'deviceSecret' } },
        createContext(),
        station,
      ),
    ).rejects.toThrow(/deviceSecret/);
    await expect(
      new AttestDeviceStep().execute(
        { action: 'attest_device', challenge: challenge(), security_level: 'Hardware', capture: { k: 'devicePublicKey' } },
        createContext(),
        station,
      ),
    ).rejects.toThrow(/Hardware/);
  });

  it('requires a challenge', async () => {
    trustRoot();
    await expect(
      new AttestDeviceStep().execute(
        { action: 'attest_device', capture: { k: 'devicePublicKey' } },
        createContext(),
        station,
      ),
    ).rejects.toThrow(/challenge/);
  });
});
