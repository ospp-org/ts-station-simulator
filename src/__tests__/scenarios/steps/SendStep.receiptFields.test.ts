import { describe, it, expect } from 'vitest';
import { buildTransactionEventReceiptFields } from '../../../scenarios/steps/SendStep.js';

/**
 * OSPP §6.2 signed-body receipt_fields. Form-dependent (TransactionEvent oneOf):
 *  - pass-form  (12 fields): offlineTxId, offlinePassId, passCounter, userId,
 *    deviceId, bayId, serviceId, startedAt, endedAt, durationSeconds,
 *    creditsCharged, txCounter. `passCounter` added per N7 / spec 0.6.2 — the
 *    envelope copy MUST equal this signed value (csms reconcile gate #12), and
 *    the gate enforces global (offlinePassId, passCounter) uniqueness (#13).
 *  - auth-form (Partial A): authId + sessionId REPLACE offlinePassId+passCounter
 *    (see the auth-form describe block below; passCounter is FORBIDDEN there).
 * (+ optional meterValues, signed when present; omitted-from-canonical when
 * absent per Note 4 — an empty {} would change the signed bytes.)
 *
 * Pre-0.4.2 the simulator built only 9 fields (Phase B audit finding (a) #9:
 * missing offlinePassId/userId/deviceId → gate checks #2/#3/#6).
 *
 * Reference: station-simulator (PHP) TransactionEventBuilder.php.
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
    passCounter: 5,
  };

  it('builds the 12 mandatory pass-form fields incl passCounter (N7 / spec 0.6.2) when meterValues is absent', () => {
    const fields = buildTransactionEventReceiptFields(fullPayload, 'stn_test');

    expect(Object.keys(fields).sort()).toEqual(
      [
        'offlineTxId',
        'offlinePassId',
        'passCounter',
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
    // passCounter (5) is distinct from txCounter (1) — proves it is read from
    // payload.passCounter, not aliased to txCounter.
    expect(fields.passCounter).toBe(5);
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

  it('includes meterValues when present (13-field pass-form body: 12 + meterValues)', () => {
    const payloadWithMeter = {
      ...fullPayload,
      meterValues: { liquidMl: 42800, consumableMl: 470, energyWh: 138 },
    };
    const fields = buildTransactionEventReceiptFields(payloadWithMeter, 'stn_test');

    expect(Object.keys(fields)).toHaveLength(13);
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

/**
 * Auth-form (Partial A / ServerSignedAuth) reconcile: the receipt's signed body
 * carries {authId, sessionId} instead of {offlinePassId}. csms-server's
 * OfflineAuthReceiptGate cross-checks offlineTxId/authId/sessionId/creditsCharged
 * (envelope ↔ signed body); creditsCharged is the refund-lever binding. The
 * builder detects the form from the payload (authId+sessionId present ⇒ auth-form)
 * and MUST NOT emit offlinePassId (the auth-form receipt schema forbids it).
 */
describe('SendStep — buildTransactionEventReceiptFields (auth-form / Partial A)', () => {
  const authFormPayload = {
    offlineTxId: 'otx_auth00000001',
    authId: 'auth_a000000001',
    sessionId: 'sess_a000000001',
    userId: 'sub_testuser01',
    deviceId: 'dev_auth_recon01',
    bayId: 'bay_0001',
    serviceId: 'svc_eco',
    startedAt: '2026-01-01T10:00:00.000Z',
    endedAt: '2026-01-01T10:05:00.000Z',
    durationSeconds: 300,
    creditsCharged: 30,
    txCounter: 1,
  };

  it('builds the auth-form field set: authId + sessionId, NO offlinePassId', () => {
    const fields = buildTransactionEventReceiptFields(authFormPayload, 'stn_test');

    expect(Object.keys(fields).sort()).toEqual(
      [
        'offlineTxId',
        'authId',
        'sessionId',
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

  it('carries the gate cross-check anchors authId/sessionId/creditsCharged', () => {
    const fields = buildTransactionEventReceiptFields(authFormPayload, 'stn_test');

    expect(fields.authId).toBe('auth_a000000001');
    expect(fields.sessionId).toBe('sess_a000000001');
    expect(fields.creditsCharged).toBe(30);
  });

  it('MUST NOT emit offlinePassId on the auth-form signed body (oneOf forbids it)', () => {
    const fields = buildTransactionEventReceiptFields(authFormPayload, 'stn_test');

    expect('offlinePassId' in fields).toBe(false);
  });

  it('signs meterValues into the auth-form body when present', () => {
    const fields = buildTransactionEventReceiptFields(
      { ...authFormPayload, meterValues: { liquidMl: 1000, energyWh: 30 } },
      'stn_test',
    );

    expect(fields.meterValues).toEqual({ liquidMl: 1000, energyWh: 30 });
  });
});
