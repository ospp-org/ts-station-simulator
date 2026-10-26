import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageType, OsppAction } from '@ospp/protocol';
import { MessageSender } from '../../mqtt/MessageSender.js';
import type { MqttConnection } from '../../mqtt/MqttConnection.js';

/*
 * EVERY ACKNOWLEDGEMENT, WHEN A PROOF ASKS FOR IT (csms-server TODO A0 item 14, 2026-10-25).
 *
 * A broker can acknowledge a message with PUBACK 0x00 and lose it: EMQX 5.8.6 acknowledges a message for a durable
 * subscription as it enters its write buffer, and a SIGKILL loses what the buffer had not written. A station releases a
 * message at its 0x00 (freeze item 33), so the station's own record of each acknowledgement is the only evidence of what
 * the broker took and lost - the broker's trace is written asynchronously, and a SIGKILL takes its last lines too. The
 * simulator logs every message the broker did not acknowledge with success, and none of the ones it did: on UAT, at a
 * crash, one MeterValues per station reached no server and was not logged as held, which reads as a 0x00 only by
 * elimination (csms-server EV30, uat/proofs/R1-crash). With OSPP_SIM_LOG_ACKNOWLEDGEMENTS=1 each send logs one line - the
 * station, the action and message type, the messageId and the PUBACK's reason code, or none - and without it nothing.
 */

function senderAcknowledgedWith(acknowledgement: number | null): MessageSender {
  const fakeConnection = {
    publish: async (_topic: string, _payload: string, _qos: number): Promise<number | null> => acknowledgement,
  } as unknown as MqttConnection;
  return new MessageSender(fakeConnection, 'stn_simtest01', () => null, 'None');
}

function acknowledgementLines(log: ReturnType<typeof vi.spyOn>): string[] {
  return log.mock.calls.map((call) => call.map(String).join(' ')).filter((line) => line.includes('[Acknowledgement]'));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('MessageSender — every acknowledgement, when a proof asks for it', () => {
  it.each<[number | null, string]>([
    [0x00, '0x00'],
    [0x10, '0x10'],
    [null, 'none'],
  ])('logs the station, the message and its PUBACK - %s as %s - with OSPP_SIM_LOG_ACKNOWLEDGEMENTS=1', async (acknowledgement, written) => {
    vi.stubEnv('OSPP_SIM_LOG_ACKNOWLEDGEMENTS', '1');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const sent = await senderAcknowledgedWith(acknowledgement).send(OsppAction.METER_VALUES, MessageType.EVENT, { values: {} });

    expect(acknowledgementLines(log)).toEqual([
      `[Acknowledgement] stn_simtest01 MeterValues Event ${sent.envelope.messageId} PUBACK ${written}`,
    ]);
  });

  it('CONTROL - logs nothing of the acknowledgements without it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await senderAcknowledgedWith(0x00).send(OsppAction.METER_VALUES, MessageType.EVENT, { values: {} });

    expect(acknowledgementLines(log)).toEqual([]);
  });
});
