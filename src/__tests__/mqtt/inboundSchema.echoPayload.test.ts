import { describe, it, expect, vi, afterEach } from 'vitest';
import { format } from 'node:util';
import {
  computeMac,
  OsppAction,
  MessageType,
  MessageSource,
  OSPP_PROTOCOL_VERSION,
  type OsppEnvelope,
} from '@ospp/protocol';
import { echoPayload } from '../../mqtt/inboundSchema.js';
import { MessageRouter } from '../../mqtt/MessageRouter.js';

/*
 * A SCHEMA REFUSAL ECHOES THE PAYLOAD — AND A GetDiagnostics PAYLOAD CARRIES AN UPLOAD CREDENTIAL.
 *
 * `echoPayload` prints the offending payload so an operator can paste it into a bug report. For
 * a GetDiagnostics Request that payload is `{ uploadUrl }`, and csms-server mints that URL with a
 * single-use token in its path: the bug report would carry a working upload. The echo keeps the
 * shape of the payload and the shape of the URL, and loses the token.
 *
 * The controls pin that every other payload is echoed exactly as before, truncation included —
 * a redaction that re-encoded or re-ordered unrelated payloads would corrupt the evidence the
 * echo exists to preserve.
 */

const TOKEN = 'abc123SECRET';
const PLATFORM_URL = `https://api-uat.onestoppay.ro/api/v1/diagnostics/uploads/${TOKEN}`;
const KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('echoPayload — the uploadUrl is echoed without its token', () => {
  it('a payload with a tokened uploadUrl is echoed with the token redacted, and nothing else changed', () => {
    const out = echoPayload({ uploadUrl: PLATFORM_URL, unexpected: true });

    expect(out).toBe(
      '{"uploadUrl":"https://api-uat.onestoppay.ro/api/v1/diagnostics/uploads/<redacted>","unexpected":true}',
    );
    expect(out).not.toContain(TOKEN);
  });

  it('CONTROL: a payload without uploadUrl is echoed byte-for-byte as before, truncation included', () => {
    const short = { keys: 'all', nested: { uploadUrlLike: 'https://example.com/?q=1' } };
    expect(echoPayload(short)).toBe(JSON.stringify(short));
    expect(echoPayload([])).toBe('[]');

    const long = { pad: 'x'.repeat(2500) };
    const json = JSON.stringify(long);
    expect(echoPayload(long)).toBe(`${json.slice(0, 2000)}…(truncated, ${json.length} chars total)`);
  });

  it('the router warning for a refused GetDiagnostics carries the URL shape and not the token', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const router = new MessageRouter(() => KEY, { schemaMode: 'strict' });
    const env = {
      messageId: 'gd-bad',
      messageType: MessageType.REQUEST,
      action: OsppAction.GET_DIAGNOSTICS,
      timestamp: new Date().toISOString(),
      source: MessageSource.SERVER,
      protocolVersion: OSPP_PROTOCOL_VERSION,
      // `additionalProperties: false` — the unknown member is what makes this non-conformant.
      payload: { uploadUrl: PLATFORM_URL, unexpected: true },
    } as OsppEnvelope;

    router.route(
      'to-station',
      Buffer.from(JSON.stringify({ ...env, mac: computeMac(KEY, env as unknown as Record<string, unknown>) })),
    );

    // The gate fired. Without this the no-token assertion below could pass on a warning that
    // was never printed.
    expect(router.schemaViolations).toHaveLength(1);
    const printed = (warn.mock.calls as unknown[][]).map((args) => format(...args));
    expect(printed.some((l) => l.includes('REFUSED GetDiagnostics Request'))).toBe(true);
    expect(printed.join('\n')).toContain(
      'payload={"uploadUrl":"https://api-uat.onestoppay.ro/api/v1/diagnostics/uploads/<redacted>","unexpected":true}',
    );
    for (const line of printed) {
      expect(line).not.toContain(TOKEN);
    }
  });
});
