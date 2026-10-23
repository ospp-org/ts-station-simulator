import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApiCallStep } from '../../../scenarios/steps/ApiCallStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';
import type { Station } from '../../../station/Station.js';

/**
 * The app's copy of a receipt, uploaded: POST /api/v1/offline/receipts (app-contract.md 4) takes the
 * Receipt exactly as the app received it from the station over FFF6 - the identifiers beside the station's
 * signed `receipt`, `deviceId` among them, and none of the four signed-only fields of spec v0.45.0. The
 * simulator plays the station that signs it and the app that uploads it, so `sign_receipt: true` on an
 * api_call signs the body's receipt with the station's receipt-signing key, as a TransactionEvent's is
 * signed, before it is sent - the same canonical bytes, so the station's later TransactionEvent of the
 * same wash is the same receipt and the server answers it `Duplicate`.
 */

const station = { config: { stationId: 'stn_a1b2c3d4e5f6' } } as unknown as Station;

function contextWithReceiptKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const dir = mkdtempSync(path.join(tmpdir(), 'sign-receipt-'));
  const keyPath = path.join(dir, 'receipt-key.pem');
  writeFileSync(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
  const ctx = createContext();
  ctx.apiBaseUrl = 'http://test.local';
  ctx.pool.register({ stationId: 'stn_a1b2c3d4e5f6', bayIds: ['bay_0011223344'], receiptKeyPath: keyPath });

  return { ctx, publicKey };
}

const upload = {
  offlineTxId: 'otx_0123456789abcdef0123456789abcdef',
  offlinePassId: 'opass_0123456789abcdef',
  passCounter: 1,
  userId: 'sub_testuser01',
  deviceId: 'dev_receipts',
  bayId: 'bay_0011223344',
  serviceId: 'svc_eco',
  startedAt: '2026-10-22T10:00:00.000Z',
  endedAt: '2026-10-22T10:05:00.000Z',
  durationSeconds: 300,
  creditsCharged: 50,
  txCounter: 1,
  endReason: 'Local',
  bookedDurationSeconds: 600,
  clockState: 'Synchronized',
  receipt: {},
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ApiCallStep sign_receipt - the app uploads the receipt the station signed', () => {
  it('signs the body receipt with the station receipt key, the four signed-only fields inside and out of the envelope, deviceId kept', async () => {
    const { ctx, publicKey } = contextWithReceiptKey();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'Accepted' }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    await new ApiCallStep().execute(
      { action: 'api_call', method: 'POST', url: 'http://test.local/api/v1/offline/receipts', body: upload, sign_receipt: true, expect_status: 200 },
      ctx,
      station,
    );

    const sent = JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body)) as Record<string, unknown> & { receipt: { data: string; signature: string; signatureAlgorithm: string } };
    for (const member of ['endReason', 'bookedDurationSeconds', 'clockState', 'stationId']) {
      expect(sent, member).not.toHaveProperty(member);
    }
    expect(sent.deviceId).toBe('dev_receipts');
    expect(sent.receipt.signatureAlgorithm).toBe('ECDSA-P256-SHA256');

    const signed = JSON.parse(Buffer.from(sent.receipt.data, 'base64').toString('utf-8')) as Record<string, unknown>;
    expect(signed).toMatchObject({
      stationId: 'stn_a1b2c3d4e5f6',
      endReason: 'Local',
      bookedDurationSeconds: 600,
      clockState: 'Synchronized',
      deviceId: 'dev_receipts',
      offlineTxId: upload.offlineTxId,
    });
    const verifier = createVerify('SHA256');
    verifier.update(Buffer.from(sent.receipt.data, 'base64'));
    expect(verifier.verify(publicKey, Buffer.from(sent.receipt.signature, 'base64'))).toBe(true);
  });

  it('refuses a sign_receipt with no receipt member to sign', async () => {
    const { ctx } = contextWithReceiptKey();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const { receipt: _omitted, ...noReceipt } = upload;

    await expect(
      new ApiCallStep().execute(
        { action: 'api_call', method: 'POST', url: 'http://test.local/api/v1/offline/receipts', body: noReceipt, sign_receipt: true },
        ctx,
        station,
      ),
    ).rejects.toThrow(/sign_receipt/);
  });
});
