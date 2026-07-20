import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import {
  OsppAction,
  MessageType,
  MessageSource,
  OSPP_PROTOCOL_VERSION,
  type OsppEnvelope,
} from '@ospp/protocol';
import { TriggerCertificateRenewalHandler } from '../../handlers/TriggerCertificateRenewalHandler.js';
import type { StationContext } from '../../handlers/Handler.js';

interface CapturedSend {
  action: OsppAction;
  messageType: MessageType;
  payload: unknown;
  correlationId?: string;
}

function makeMockStation(stationId = 'stn_a1b2c3d4'): {
  station: StationContext;
  captured: CapturedSend[];
} {
  const captured: CapturedSend[] = [];
  const station = {
    config: { stationId },
    sender: {
      async send(
        action: OsppAction,
        messageType: MessageType,
        payload: unknown,
        correlationId?: string,
      ): Promise<void> {
        captured.push({ action, messageType, payload, correlationId });
      },
    },
    pendingRenewalKeyPem: null as string | null,
  } as unknown as StationContext;
  return { station, captured };
}

function triggerEnvelope(messageId = 'cmd_trigger_1'): OsppEnvelope {
  return {
    messageId,
    messageType: MessageType.REQUEST,
    action: OsppAction.TRIGGER_CERTIFICATE_RENEWAL,
    source: MessageSource.CSMS,
    timestamp: '2026-07-18T00:00:00.000Z',
    protocolVersion: OSPP_PROTOCOL_VERSION,
    payload: { certificateType: 'StationCertificate' },
  } as unknown as OsppEnvelope;
}

describe('TriggerCertificateRenewalHandler — real renewal handshake (ADR-0002 T1)', () => {
  it('acknowledges the trigger with Accepted, correlated to the inbound messageId', async () => {
    const { station, captured } = makeMockStation();
    await new TriggerCertificateRenewalHandler().handle(triggerEnvelope('cmd_xyz'), station);

    const ack = captured.find(
      (c) =>
        c.action === OsppAction.TRIGGER_CERTIFICATE_RENEWAL &&
        c.messageType === MessageType.RESPONSE,
    );
    expect(ack).toBeDefined();
    expect((ack!.payload as { status: string }).status).toBe('Accepted');
    expect(ack!.correlationId).toBe('cmd_xyz');
  });

  it('emits a SignCertificate REQUEST carrying a REAL P-256 CSR (CN=stationId), not the placeholder', async () => {
    const { station, captured } = makeMockStation('stn_a1b2c3d4');
    await new TriggerCertificateRenewalHandler().handle(triggerEnvelope(), station);

    const sign = captured.find(
      (c) =>
        c.action === OsppAction.SIGN_CERTIFICATE && c.messageType === MessageType.REQUEST,
    );
    expect(sign).toBeDefined();
    const csrPem = (sign!.payload as { csr: string; certificateType: string }).csr;
    expect((sign!.payload as { certificateType: string }).certificateType).toBe(
      'StationCertificate',
    );

    // The historical placeholder ('-----BEGIN CERTIFICATE REQUEST-----\nMIIBSimulated…')
    // is NOT a parseable PKCS#10 and the CSMS CsrValidator rejects it.
    expect(csrPem).not.toMatch(/Simulated/);

    const csr = new x509.Pkcs10CertificateRequest(csrPem);
    expect(csr.subject).toContain('CN=stn_a1b2c3d4');
    const pub = await csr.publicKey.export();
    const algo = pub.algorithm as webcrypto.EcKeyAlgorithm;
    expect(algo.name).toBe('ECDSA');
    expect(algo.namedCurve).toBe('P-256');
    expect(await csr.verify()).toBe(true);
  });

  it('retains the fresh private key on the station to pair with the CertificateInstall leaf', async () => {
    const { station } = makeMockStation();
    expect(station.pendingRenewalKeyPem).toBeNull();

    await new TriggerCertificateRenewalHandler().handle(triggerEnvelope(), station);

    expect(station.pendingRenewalKeyPem).toMatch(/-----BEGIN PRIVATE KEY-----/);
  });
});
