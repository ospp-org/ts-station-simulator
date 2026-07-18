import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import {
  OsppAction,
  MessageType,
  MessageSource,
  OSPP_PROTOCOL_VERSION,
  type OsppEnvelope,
} from '@ospp/protocol';
import { CertificateInstallHandler } from '../../handlers/CertificateInstallHandler.js';
import type { StationContext } from '../../handlers/Handler.js';

interface CapturedSend {
  action: OsppAction;
  messageType: MessageType;
  payload: unknown;
  correlationId?: string;
}

interface InstallInput {
  certificatePem: string;
  privateKeyPem: string;
  caChainPem?: string;
}

function makeMockStation(pendingKey: string | null): {
  station: StationContext;
  captured: CapturedSend[];
  calls: { install: InstallInput[]; reconnect: number; reboot: number };
} {
  const captured: CapturedSend[] = [];
  const calls = { install: [] as InstallInput[], reconnect: 0, reboot: 0 };
  const station = {
    config: { stationId: 'stn_a1b2c3d4' },
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
    pendingRenewalKeyPem: pendingKey,
    async installRenewedCertificate(input: InstallInput): Promise<void> {
      calls.install.push(input);
    },
    async reconnectWithRenewedCertificate(): Promise<void> {
      calls.reconnect += 1;
    },
    async retryBoot(): Promise<void> {
      calls.reboot += 1;
    },
  } as unknown as StationContext;
  return { station, captured, calls };
}

const RENEWED_LEAF =
  '-----BEGIN CERTIFICATE-----\nMIIrenewedLeaf==\n-----END CERTIFICATE-----';
const CA_CHAIN =
  '-----BEGIN CERTIFICATE-----\nMIIissuingCa==\n-----END CERTIFICATE-----';

function installEnvelope(messageId = 'cmd_install_1'): OsppEnvelope {
  return {
    messageId,
    messageType: MessageType.REQUEST,
    action: OsppAction.CERTIFICATE_INSTALL,
    source: MessageSource.CSMS,
    timestamp: '2026-07-18T00:00:00.000Z',
    protocolVersion: OSPP_PROTOCOL_VERSION,
    payload: {
      certificateType: 'StationCertificate',
      certificate: RENEWED_LEAF,
      caCertificateChain: CA_CHAIN,
    },
  } as unknown as OsppEnvelope;
}

describe('CertificateInstallHandler — install renewed cert + re-handshake (ADR-0002 T1)', () => {
  it('installs the renewed leaf paired with the retained key, then ACKs Accepted', async () => {
    const { station, captured, calls } = makeMockStation('-----BEGIN PRIVATE KEY-----\nRENEWED\n-----END PRIVATE KEY-----');
    await new CertificateInstallHandler().handle(installEnvelope('cmd_i1'), station);

    // Swapped the client cert: leaf from the request, paired with the stashed key.
    expect(calls.install).toHaveLength(1);
    expect(calls.install[0].certificatePem).toBe(RENEWED_LEAF);
    expect(calls.install[0].privateKeyPem).toContain('RENEWED');
    expect(calls.install[0].caChainPem).toBe(CA_CHAIN);

    // Acknowledged, correlated to the inbound messageId.
    const ack = captured.find(
      (c) =>
        c.action === OsppAction.CERTIFICATE_INSTALL &&
        c.messageType === MessageType.RESPONSE,
    );
    expect(ack).toBeDefined();
    expect((ack!.payload as { status: string }).status).toBe('Accepted');
    expect(ack!.correlationId).toBe('cmd_i1');

    // The in-flight renewal key is consumed (single-use).
    expect(station.pendingRenewalKeyPem).toBeNull();
  });

  it('re-handshakes mTLS with the renewed cert (the decisive proof), then re-boots', async () => {
    const { station, calls } = makeMockStation('-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----');
    await new CertificateInstallHandler().handle(installEnvelope(), station);

    expect(calls.reconnect).toBe(1);
    expect(calls.reboot).toBe(1);
  });

  it('rejects when no renewal is in flight (no key to pair) — never installs a cert it cannot use', async () => {
    const { station, captured, calls } = makeMockStation(null);
    await new CertificateInstallHandler().handle(installEnvelope('cmd_orphan'), station);

    expect(calls.install).toHaveLength(0);
    expect(calls.reconnect).toBe(0);
    const ack = captured.find(
      (c) =>
        c.action === OsppAction.CERTIFICATE_INSTALL &&
        c.messageType === MessageType.RESPONSE,
    );
    expect(ack).toBeDefined();
    expect((ack!.payload as { status: string }).status).toBe('Rejected');
    expect(ack!.correlationId).toBe('cmd_orphan');
  });
});
