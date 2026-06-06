import { describe, it, expect } from 'vitest';
import { buildTransactionEventReceiptFields } from '../../../scenarios/steps/SendStep.js';

/**
 * OSPP v0.4.2+ §6.2 mandates 11 receipt_fields in the signed body:
 *   offlineTxId, offlinePassId, userId, deviceId, bayId, serviceId,
 *   startedAt, endedAt, durationSeconds, creditsCharged, txCounter
 * (+ optional meterValues, signed when present; omitted-from-canonical
 * when absent per Note 4).
 *
 * Pre-fix the simulator built only 9 fields (Phase B audit finding (a) #9):
 *   missing offlinePassId, userId, deviceId — gate checks #2, #3, #6
 *   in csms-server's RevalidationGate would emit OFFLINE_RECEIPT_MISMATCH
 *   on a strict v0.4.2+ server.
 *
 * Reference: station-simulator (PHP) TransactionEventBuilder.php — same 11
 * fields in the same canonical ordering.
 */
describe('SendStep — buildTransactionEventReceiptFields (spec v0.4.2+ §6.2)', () => {
  const fullPayload = {
    offlineTxId: 'otx_a0000000001',
    offlinePassId: 'opass_a000000001',
    userId: 'sub_testuser01',
    deviceId: 'dev_smoke_recon01',
    bayId: 'bay_0001',
    serviceId: 'svc_eco',
    startedAt: '2026-01-01T10:00:00.000Z',
    endedAt: '2026-01-01T10:05:00.000Z',
    durationSeconds: 300,
    creditsCharged: 150,
    txCounter: 1,
  };

  it('builds the 11 mandatory fields when meterValues is absent', () => {
    const fields = buildTransactionEventReceiptFields(fullPayload, 'stn_test');

    expect(Object.keys(fields).sort()).toEqual(
      [
        'offlineTxId',
        'offlinePassId',
        'userId',
        'deviceId',
        'bayId',
        'serviceId',
        'startedAt',
        'endedAt',
        'durationSeconds',
        'creditsCharged',
        'txCounter',
      ].sort(),
    );
  });

  it('signed body carries gate-cross-check anchors offlinePassId/userId/deviceId (Phase B finding (a) #9)', () => {
    // These three fields were missing in the pre-fix 9-field body. With them
    // present, gate checks #2/#3/#6 in csms-server's RevalidationGate can
    // succeed (or fail with a meaningful OFFLINE_RECEIPT_MISMATCH cross-check
    // — the simulator now stages a signed body that a strict v0.4.2+ server
    // can actually evaluate end-to-end).
    const fields = buildTransactionEventReceiptFields(fullPayload, 'stn_test');

    expect(fields.offlinePassId).toBe('opass_a000000001');
    expect(fields.userId).toBe('sub_testuser01');
    expect(fields.deviceId).toBe('dev_smoke_recon01');
  });

  it('synthesizes deviceId from stationId when payload does not supply it (PHP sim parity)', () => {
    // PHP station-simulator TransactionEventBuilder.php defaults to
    // "dev_{stationId}" when an explicit override is missing. Mirrors that
    // here so existing scenarios without a deviceId YAML field still emit
    // a non-empty signed body (gate check #6 will reject unless the YAML
    // explicitly matches pass.device_id — that's the test author's job).
    const { deviceId: _drop, ...payloadWithoutDeviceId } = fullPayload;
    const fields = buildTransactionEventReceiptFields(payloadWithoutDeviceId, 'stn_alpha');

    expect(fields.deviceId).toBe('dev_stn_alpha');
  });

  it('includes meterValues when present (12-field signed body)', () => {
    const payloadWithMeter = {
      ...fullPayload,
      meterValues: { liquidMl: 42800, consumableMl: 470, energyWh: 138 },
    };
    const fields = buildTransactionEventReceiptFields(payloadWithMeter, 'stn_test');

    expect(Object.keys(fields)).toHaveLength(12);
    expect(fields.meterValues).toEqual({ liquidMl: 42800, consumableMl: 470, energyWh: 138 });
  });

  it('omits meterValues from canonical body when absent (spec Note 4: MUST-NOT-emit-empty)', () => {
    // The spec's §6.2 Note 4 invariant: an empty `meterValues: {}` in the
    // canonical form would change the signed bytes and break verification
    // on the server. When meterValues is not present on the wire payload,
    // it MUST be omitted from the canonical body entirely.
    const fields = buildTransactionEventReceiptFields(fullPayload, 'stn_test');

    expect('meterValues' in fields).toBe(false);
  });
});
