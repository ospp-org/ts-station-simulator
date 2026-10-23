import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTransactionEventReceiptFields, stripSignedOnlyFields } from '../../../scenarios/steps/SendStep.js';

/**
 * The receipt of spec v0.45.0 (06-security.md §6.2, Note 7): the signed body carries four fields no envelope
 * carries - `stationId`, the station that signed it; `endReason`, why the session ended (the SessionEnded
 * reasons and `ServerStopped`); `bookedDurationSeconds`, the duration the station started the service for;
 * and `clockState`, whether the station's clock had been set from the server since it last booted. All four
 * are SIGNED ONLY: they appear in `receipt_fields` and in no envelope, the TransactionEvent's and the FFF6
 * Receipt's included (`transaction-event-request.schema.json` and `receipt.schema.json` are closed), and the
 * server reads them from the signed body - settlement by service kind on `endReason` and the booked duration,
 * the gate's time checks through the clock offset on `clockState` (reconciliation.md §6.8, §8).
 *
 * A scenario names them on the TransactionEvent payload, as it names `deviceId`, and the send signs them in
 * and strips them out. Unnamed, a receipt is a wash that ran its booked time on a synchronized clock.
 */

const SDK_SCHEMAS = fileURLToPath(new URL('../../../../node_modules/@ospp/protocol/src/schemas', import.meta.url));

function schema(relative: string): { required: string[]; properties: Record<string, { enum?: string[] }> } {
  return JSON.parse(fs.readFileSync(path.join(SDK_SCHEMAS, relative), 'utf-8'));
}

const passForm = {
  offlineTxId: 'otx_0123456789abcdef0123456789abcdef',
  offlinePassId: 'opass_a000000001',
  passCounter: 5,
  userId: 'sub_testuser01',
  deviceId: 'dev_smoke_recon01',
  bayId: 'bay_0001aaaa',
  serviceId: 'svc_eco',
  startedAt: '2026-01-01T10:00:00.000Z',
  endedAt: '2026-01-01T10:05:00.000Z',
  durationSeconds: 300,
  creditsCharged: 150,
  txCounter: 1,
};

describe('the frozen receipt of spec v0.45.0 - four fields signed and in no envelope', () => {
  it('signs the station that signs it, and the three settlement fields, defaulted to a wash that ran its booked time on a synchronized clock', () => {
    const fields = buildTransactionEventReceiptFields(passForm, 'stn_a1b2c3d4');

    expect(fields.stationId).toBe('stn_a1b2c3d4');
    expect(fields.endReason).toBe('TimerExpired');
    expect(fields.bookedDurationSeconds).toBe(300);
    expect(fields.clockState).toBe('Synchronized');
  });

  it('signs what the scenario names', () => {
    const fields = buildTransactionEventReceiptFields(
      { ...passForm, endReason: 'Local', bookedDurationSeconds: 600, clockState: 'Unsynchronized' },
      'stn_a1b2c3d4',
    );

    expect(fields.endReason).toBe('Local');
    expect(fields.bookedDurationSeconds).toBe(600);
    expect(fields.clockState).toBe('Unsynchronized');
  });

  it('builds a body with every member receipt-data.schema.json requires, only members it defines, its enums respected', () => {
    const receiptData = schema('common/receipt-data.schema.json');
    const fields = buildTransactionEventReceiptFields({ ...passForm, endReason: 'ServerStopped' }, 'stn_a1b2c3d4');

    expect(receiptData.required.length).toBeGreaterThan(0);
    expect(receiptData.required.filter((k) => !(k in fields))).toEqual([]);
    expect(Object.keys(fields).filter((k) => !(k in receiptData.properties))).toEqual([]);
    expect(receiptData.properties.endReason.enum).toContain(fields.endReason);
    expect(receiptData.properties.clockState.enum).toContain(fields.clockState);
  });

  it('strips the signed-only members from the TransactionEvent envelope, which is closed over the fields it defines', () => {
    const envelope = schema('mqtt/transaction-event-request.schema.json');
    const payload: Record<string, unknown> = { ...passForm, endReason: 'Local', bookedDurationSeconds: 600, clockState: 'Synchronized' };

    stripSignedOnlyFields(payload, 'transaction-event');

    for (const member of ['endReason', 'bookedDurationSeconds', 'clockState', 'stationId', 'deviceId']) {
      expect(payload, member).not.toHaveProperty(member);
      expect(envelope.properties, `${member} is not a TransactionEvent member`).not.toHaveProperty(member);
    }
  });

  it('keeps deviceId on the FFF6 Receipt the app uploads, which carries it, and strips the four', () => {
    const receipt = schema('ble/receipt.schema.json');
    const payload: Record<string, unknown> = { ...passForm, endReason: 'Local', bookedDurationSeconds: 600, clockState: 'Synchronized' };

    stripSignedOnlyFields(payload, 'receipt');

    expect(payload.deviceId).toBe('dev_smoke_recon01');
    expect(receipt.properties).toHaveProperty('deviceId');
    for (const member of ['endReason', 'bookedDurationSeconds', 'clockState', 'stationId']) {
      expect(payload, member).not.toHaveProperty(member);
      expect(receipt.properties, `${member} is not a Receipt member`).not.toHaveProperty(member);
    }
  });
});
