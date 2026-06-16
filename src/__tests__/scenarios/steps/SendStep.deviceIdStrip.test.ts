import { describe, it, expect } from 'vitest';
import {
  SendStep,
  buildTransactionEventReceiptFields,
} from '../../../scenarios/steps/SendStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';
import {
  OsppAction,
  MessageType,
  MessageSource,
  createEnvelope,
  type OsppEnvelope,
} from '@ospp/protocol';
import type { Station } from '../../../station/Station.js';

interface CapturedSend {
  action: OsppAction;
  messageType: MessageType;
  payload: Record<string, unknown>;
}

function makeMockStation(): { station: Station; captured: CapturedSend[] } {
  const captured: CapturedSend[] = [];
  const sender = {
    async send(
      action: OsppAction,
      messageType: MessageType,
      payload: Record<string, unknown>,
      correlationId?: string,
    ): Promise<OsppEnvelope> {
      captured.push({ action, messageType, payload });
      return createEnvelope({
        messageId: correlationId ?? 'msg-test',
        messageType,
        action,
        source: MessageSource.STATION,
        payload,
      });
    },
  };
  const station = {
    sender,
    sessions: new Map(),
    config: { stationId: 'stn_test' },
  } as unknown as Station;
  return { station, captured };
}

// A TransactionEvent Request WITHOUT a `receipt` — signTransactionEventReceipt
// returns early (no receipt-key needed), but the deviceId strip still runs.
const TX_PAYLOAD = {
  offlineTxId: 'otx_1',
  offlinePassId: 'opass_1',
  userId: 'sub_1',
  deviceId: 'dev_smoke_recon01', // receipt-only; must NOT reach the wire
  bayId: 'bay_1',
  serviceId: 'svc_1',
  startedAt: '2026-01-01T10:00:00.000Z',
  endedAt: '2026-01-01T10:05:00.000Z',
  durationSeconds: 300,
  creditsCharged: 150,
  txCounter: 1,
} as const;

describe('SendStep — TransactionEvent deviceId is receipt-only (signed in, stripped off the wire)', () => {
  const step = new SendStep();

  it('strips deviceId from the published payload (not a wire field — schema is additionalProperties:false)', async () => {
    const { station, captured } = makeMockStation();
    await step.execute(
      { action: 'send', message: 'TransactionEvent', messageType: 'Request', payload: { ...TX_PAYLOAD } },
      createContext(),
      station,
    );
    expect(captured[0].payload.deviceId).toBeUndefined();
    // The legitimate wire identity fields are untouched.
    expect(captured[0].payload.offlinePassId).toBe('opass_1');
    expect(captured[0].payload.userId).toBe('sub_1');
  });

  it('keeps deviceId in the signed receipt body (gate check #6: receipt.deviceId <-> pass.device_id)', () => {
    const fields = buildTransactionEventReceiptFields({ ...TX_PAYLOAD }, 'stn_test');
    expect(fields.deviceId).toBe('dev_smoke_recon01');
  });

  it('receipt deviceId falls back to dev_<stationId> when the payload omits it', () => {
    const { deviceId: _omit, ...noDevice } = TX_PAYLOAD;
    const fields = buildTransactionEventReceiptFields(noDevice, 'stn_test');
    expect(fields.deviceId).toBe('dev_stn_test');
  });

  it('does NOT strip deviceId from non-TransactionEvent sends (the change is scoped)', async () => {
    const { station, captured } = makeMockStation();
    await step.execute(
      {
        action: 'send',
        message: 'StatusNotification',
        messageType: 'Event',
        payload: { bayId: 'bay_1', bayNumber: 1, status: 'Available', deviceId: 'keep-me' },
      },
      createContext(),
      station,
    );
    expect(captured[0].payload.deviceId).toBe('keep-me');
  });
});
