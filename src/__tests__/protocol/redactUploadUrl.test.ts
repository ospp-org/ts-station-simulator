import { describe, it, expect } from 'vitest';
import { logSafePayload, redactUploadUrl } from '../../protocol/redactUploadUrl.js';

/*
 * THE DIAGNOSTICS UPLOAD URL IS A BEARER CREDENTIAL, AND A LOG IS NOT A SAFE PLACE FOR ONE.
 *
 * csms-server mints the URL a GetDiagnostics Request carries: `PUT/HEAD
 * {base}/api/v1/diagnostics/uploads/{token}`, where the last segment is a single-use token that
 * on its own grants the upload. An operator may instead hand over an external URL, and those
 * carry their secret elsewhere: a presigned object-store URL in its query string, a basic-auth
 * one in its userinfo.
 *
 * Every case below plants a secret and asserts two things: that it is gone, and that what a
 * reader needs to debug the upload (scheme, host, port, path shape, query keys) is still there.
 * A redaction that returned a fixed placeholder for every input would pass the first half and
 * fail the second, and the control at the end is what keeps it honest in the other direction.
 */

const TOKEN = 'abc123SECRET';
const PLATFORM_URL = `https://api-uat.onestoppay.ro/api/v1/diagnostics/uploads/${TOKEN}`;

describe('redactUploadUrl', () => {
  it('drops the platform token from the path and keeps where the upload goes', () => {
    const out = redactUploadUrl(PLATFORM_URL);

    expect(out).toBe('https://api-uat.onestoppay.ro/api/v1/diagnostics/uploads/<redacted>');
    expect(out).not.toContain(TOKEN);
  });

  it('replaces only the token segment — a port and a deeper path stay readable', () => {
    const out = redactUploadUrl(`https://csms.local:8443/api/v1/diagnostics/uploads/${TOKEN}/part`);

    expect(out).toBe('https://csms.local:8443/api/v1/diagnostics/uploads/<redacted>/part');
    expect(out).not.toContain(TOKEN);
  });

  it('drops every query VALUE of a presigned URL and keeps the keys', () => {
    const out = redactUploadUrl(
      'https://uploads.example.com/diag/stn.tar.gz?X-Amz-Signature=SECRET&X-Amz-Expires=300',
    );

    expect(out).toBe(
      'https://uploads.example.com/diag/stn.tar.gz?X-Amz-Signature=<redacted>&X-Amz-Expires=<redacted>',
    );
    expect(out).not.toContain('SECRET');
    expect(out).not.toContain('300');
  });

  it('treats a bare query token with no "=" as a value, not as a key to keep', () => {
    // URLSearchParams would read `?abc123SECRET` as a KEY with an empty value, and "keep the
    // keys" would then keep the whole secret.
    const out = redactUploadUrl(`https://uploads.example.com/in?${TOKEN}`);

    expect(out).toBe('https://uploads.example.com/in?<redacted>');
    expect(out).not.toContain(TOKEN);
  });

  it('drops the userinfo', () => {
    const out = redactUploadUrl('https://diag:hunter2@uploads.example.com/in');

    expect(out).toBe('https://<redacted>@uploads.example.com/in');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('diag:');
  });

  it('never echoes a string it cannot parse — it may still carry the token', () => {
    for (const raw of [`/api/v1/diagnostics/uploads/${TOKEN}`, `not a url ${TOKEN}`]) {
      expect(redactUploadUrl(raw)).toBe('<unparseable url>');
    }
  });

  it('CONTROL: a URL with no token, query or userinfo comes back unchanged', () => {
    const plain = 'https://api-uat.onestoppay.ro/api/v1/admin/stations/stn_00000001/diagnostics';

    expect(redactUploadUrl(plain)).toBe(plain);
  });
});

describe('logSafePayload', () => {
  it('returns a copy with uploadUrl redacted and leaves the received payload intact', () => {
    const payload = { uploadUrl: PLATFORM_URL, startTime: '2026-09-25T09:00:00.000Z' };

    const safe = logSafePayload(payload);

    expect(safe).toEqual({
      uploadUrl: 'https://api-uat.onestoppay.ro/api/v1/diagnostics/uploads/<redacted>',
      startTime: '2026-09-25T09:00:00.000Z',
    });
    // The original still carries the real URL: the router's violation record and the handler
    // read it, and only what is SHOWN is redacted.
    expect(payload.uploadUrl).toBe(PLATFORM_URL);
  });

  it('CONTROL: anything without a string uploadUrl is returned as is, same reference', () => {
    const inputs: unknown[] = [{ keys: [] }, { uploadUrl: 7 }, [PLATFORM_URL], PLATFORM_URL, null, undefined, 42];

    for (const input of inputs) {
      expect(logSafePayload(input)).toBe(input);
    }
  });
});
