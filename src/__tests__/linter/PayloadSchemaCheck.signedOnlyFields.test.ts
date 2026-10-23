import { describe, it, expect } from 'vitest';
import { PayloadSchemaCheck } from '../../linter/checks/PayloadSchemaCheck.js';
import type { ParsedScenario } from '../../linter/types.js';

/**
 * The linter validates a `send` step's payload as SendStep publishes it. Spec v0.45.0 signs four members
 * into the receipt that no TransactionEvent envelope carries - stationId, endReason,
 * bookedDurationSeconds, clockState (06-security.md 6.2 Note 7) - and a scenario names them on the
 * payload so the send signs them and strips them, as it has always stripped deviceId. The linter strips
 * the same members before it validates, so a scenario that names them lints clean, and one that puts
 * anything else beside the envelope still fails.
 */

const check = new PayloadSchemaCheck();

function transactionEvent(extra: Record<string, unknown>): ParsedScenario {
  return {
    filePath: 'test.yaml',
    name: 'test',
    declarations: {},
    steps: [
      {
        action: 'send',
        message: 'TransactionEvent',
        payload: {
          offlineTxId: 'otx_0123456789abcdef0123456789abcdef',
          offlinePassId: 'opass_0123456789abcdef',
          passCounter: 1,
          userId: 'sub_testuser01',
          deviceId: 'dev_signed_only',
          bayId: 'bay_0011223344',
          serviceId: 'svc_eco',
          startedAt: '2026-10-22T10:00:00.000Z',
          endedAt: '2026-10-22T10:05:00.000Z',
          durationSeconds: 300,
          creditsCharged: 50,
          receipt: { data: 'placeholder', signature: 'placeholder', signatureAlgorithm: 'ECDSA-P256-SHA256' },
          txCounter: 1,
          ...extra,
        },
      },
    ],
  };
}

describe('PayloadSchemaCheck - the receipt members the send signs and strips', () => {
  it('a TransactionEvent naming the four signed-only members lints clean, as the send strips them', () => {
    const issues = check.check(transactionEvent({
      stationId: 'stn_a1b2c3d4e5f6',
      endReason: 'Deauthorized',
      bookedDurationSeconds: 600,
      clockState: 'Unsynchronized',
    }));

    expect(issues).toEqual([]);
  });

  it('CONTROL: a member that is neither the envelope\'s nor a signed-only one still fails', () => {
    const issues = check.check(transactionEvent({ notAReceiptMember: 1 }));

    expect(issues.length).toBeGreaterThan(0);
  });
});
