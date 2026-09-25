import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { format } from 'node:util';
import { OsppAction, MessageType, MessageSource, type OsppEnvelope } from '@ospp/protocol';
import type { StationContext } from '../../handlers/Handler.js';
import { GetDiagnosticsHandler } from '../../handlers/GetDiagnosticsHandler.js';

/*
 * THE ACCEPTED LINE SAYS WHERE THE UPLOAD GOES, NOT WITH WHAT.
 *
 * GetDiagnosticsHandler logs one line on every accepted request, and it used to print the
 * uploadUrl whole. csms-server now mints that URL with a single-use token in its path, so the
 * line handed a working upload credential to every place stdout is copied to: CI transcripts,
 * bug reports, a terminal scrollback on a shared host. An operator-supplied presigned URL
 * leaked its signature the same way.
 *
 * The line must still name the host and the upload path, or the next person debugging a failed
 * upload has nothing to go on. And the frames the server sees must not change at all: the
 * redaction is about what is printed, never about what is answered.
 */

const TOKEN = 'abc123SECRET';
const PLATFORM_URL = `https://api-uat.onestoppay.ro/api/v1/diagnostics/uploads/${TOKEN}`;
const SIGNATURE = 'SIGNATURE0123456789';
const PRESIGNED_URL =
  `https://uploads.example.com/diag/stn.tar.gz?X-Amz-Signature=${SIGNATURE}&X-Amz-Expires=300`;

interface Sent {
  action: OsppAction;
  messageType: MessageType;
  payload: Record<string, unknown>;
}

function mockStation(): { station: StationContext; sent: Sent[] } {
  const sent: Sent[] = [];
  const station = {
    config: { stationId: 'stn_redaction' },
    sender: {
      async send(
        action: OsppAction,
        messageType: MessageType,
        payload: Record<string, unknown>,
      ): Promise<void> {
        sent.push({ action, messageType, payload });
      },
    },
  } as unknown as StationContext;

  return { station, sent };
}

function envelope(payload: unknown): OsppEnvelope {
  return {
    messageId: 'msg_redaction_0001',
    messageType: MessageType.REQUEST,
    action: OsppAction.GET_DIAGNOSTICS,
    source: MessageSource.SERVER,
    timestamp: new Date().toISOString(),
    payload,
  } as unknown as OsppEnvelope;
}

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers();
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  log.mockRestore();
  vi.useRealTimers();
});

/** Drives the whole lifecycle, three 1s stage delays included, without 3s of wall clock. */
async function handle(payload: unknown, station: StationContext): Promise<void> {
  const done = new GetDiagnosticsHandler().handle(envelope(payload), station);
  await vi.runAllTimersAsync();
  await done;
}

/** Every console.log line as printed (format string applied), then every raw argument. */
function everythingLogged(): string[] {
  const calls = log.mock.calls as unknown[][];
  return [...calls.map((args) => format(...args)), ...calls.flat().map((arg) => String(arg))];
}

function acceptedLine(): string {
  const line = (log.mock.calls as unknown[][])
    .map((args) => format(...args))
    .find((l) => l.startsWith('[GetDiagnostics] Accepted'));
  expect(line, 'the Accepted line was not logged at all').toBeDefined();
  return line as string;
}

describe('GetDiagnosticsHandler — the uploadUrl is logged without its secret', () => {
  it('the platform-minted URL: host and upload path are logged, the token is not', async () => {
    const { station } = mockStation();

    await handle({ uploadUrl: PLATFORM_URL }, station);

    expect(acceptedLine()).toContain(
      'upload to https://api-uat.onestoppay.ro/api/v1/diagnostics/uploads/<redacted>,',
    );
    for (const logged of everythingLogged()) {
      expect(logged).not.toContain(TOKEN);
    }
  });

  it('an operator-supplied presigned URL: query keys are logged, their values are not', async () => {
    const { station } = mockStation();

    await handle({ uploadUrl: PRESIGNED_URL }, station);

    expect(acceptedLine()).toContain(
      'upload to https://uploads.example.com/diag/stn.tar.gz?X-Amz-Signature=<redacted>&X-Amz-Expires=<redacted>,',
    );
    for (const logged of everythingLogged()) {
      expect(logged).not.toContain(SIGNATURE);
    }
  });

  it('CONTROL: the frames the server sees are unchanged — Accepted with a fileName, then three stages', async () => {
    const { station, sent } = mockStation();

    await handle({ uploadUrl: PLATFORM_URL }, station);

    const responses = sent.filter((s) => s.messageType === MessageType.RESPONSE);
    expect(responses).toHaveLength(1);
    expect(responses[0]!.action).toBe(OsppAction.GET_DIAGNOSTICS);
    expect(responses[0]!.payload).toEqual({
      status: 'Accepted',
      fileName: expect.stringMatching(/^diagnostics_stn_redaction_\d+\.tar\.gz$/),
    });
    const stages = sent
      .filter((s) => s.action === OsppAction.DIAGNOSTICS_NOTIFICATION)
      .map((s) => s.payload.status);
    expect(stages).toEqual(['Collecting', 'Uploading', 'Uploaded']);
  });
});
