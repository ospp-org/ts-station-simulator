import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SendStep } from '../../../scenarios/steps/SendStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';
import { OsppAction, MessageType, MessageSource, createEnvelope, type OsppEnvelope } from '@ospp/protocol';
import type { Station } from '../../../station/Station.js';

/**
 * `envelope_overrides:` on a send - members set on the published payload AFTER its receipt is signed (csms-server,
 * the close of the offline server arc, 2026-10-23). The station signs its receipt from the same members it puts in
 * the TransactionEvent beside it, so a scenario could not state an envelope that differs from the signed body - the
 * case reconciliation.md 6.1 checks #1-#3 refuse, check #3 (the envelope's userId against the signed one) among them.
 * The override changes the envelope only: the signed `receipt.data` still carries the scenario's members.
 */

interface CapturedSend {
  action: OsppAction;
  payload: Record<string, unknown>;
}

function stationWithReceiptKey(): { station: Station; captured: CapturedSend[]; ctx: ReturnType<typeof createContext> } {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const dir = mkdtempSync(path.join(tmpdir(), 'envelope-overrides-'));
  const keyPath = path.join(dir, 'receipt-key.pem');
  writeFileSync(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
  const ctx = createContext();
  ctx.pool.register({ stationId: 'stn_a1b2c3d4e5f6', bayIds: ['bay_0011223344'], receiptKeyPath: keyPath });

  const captured: CapturedSend[] = [];
  const station = {
    sender: {
      async send(action: OsppAction, messageType: MessageType, payload: Record<string, unknown>, correlationId?: string): Promise<OsppEnvelope> {
        captured.push({ action, payload });
        return createEnvelope({ messageId: correlationId ?? 'msg-test', messageType, action, source: MessageSource.STATION, payload });
      },
    },
    sessions: new Map(),
    config: { stationId: 'stn_a1b2c3d4e5f6' },
  } as unknown as Station;

  return { station, captured, ctx };
}

const PARTIAL_A = {
  offlineTxId: 'otx_0123456789abcdef0123456789abcdef',
  authId: 'auth_0123456789abcdef',
  sessionId: 'sess_0123456789abcdef',
  userId: 'sub_signeduser',
  deviceId: 'dev_receipts',
  bayId: 'bay_0011223344',
  serviceId: 'svc_eco',
  startedAt: '2026-10-23T10:00:00.000Z',
  endedAt: '2026-10-23T10:05:00.000Z',
  durationSeconds: 300,
  creditsCharged: 50,
  txCounter: 1,
  receipt: { data: 'placeholder', signature: 'placeholder', signatureAlgorithm: 'ECDSA-P256-SHA256' },
};

describe('SendStep - envelope_overrides set the published payload after the receipt is signed', () => {
  it('publishes the override and signs the scenario\'s own member', async () => {
    const { station, captured, ctx } = stationWithReceiptKey();

    await new SendStep().execute(
      {
        action: 'send',
        message: 'TransactionEvent',
        messageType: 'Request',
        payload: structuredClone(PARTIAL_A),
        envelope_overrides: { userId: 'sub_envelopeuser' },
      },
      ctx,
      station,
    );

    const published = captured[0].payload;
    const signed = JSON.parse(Buffer.from(String((published.receipt as Record<string, unknown>).data), 'base64').toString('utf-8')) as Record<string, unknown>;
    expect(published.userId).toBe('sub_envelopeuser');
    expect(signed.userId).toBe('sub_signeduser');
  });

  it('templates in an override are substituted like the payload\'s', async () => {
    const { station, captured, ctx } = stationWithReceiptKey();
    ctx.captured.set('otherUser', 'sub_captured');

    await new SendStep().execute(
      {
        action: 'send',
        message: 'TransactionEvent',
        messageType: 'Request',
        payload: structuredClone(PARTIAL_A),
        envelope_overrides: { userId: '{{captured.otherUser}}' },
      },
      ctx,
      station,
    );

    expect(captured[0].payload.userId).toBe('sub_captured');
  });

  it('CONTROL: without overrides the envelope and the signed body agree', async () => {
    const { station, captured, ctx } = stationWithReceiptKey();

    await new SendStep().execute(
      { action: 'send', message: 'TransactionEvent', messageType: 'Request', payload: structuredClone(PARTIAL_A) },
      ctx,
      station,
    );

    const published = captured[0].payload;
    const signed = JSON.parse(Buffer.from(String((published.receipt as Record<string, unknown>).data), 'base64').toString('utf-8')) as Record<string, unknown>;
    expect(published.userId).toBe(signed.userId);
  });
});
