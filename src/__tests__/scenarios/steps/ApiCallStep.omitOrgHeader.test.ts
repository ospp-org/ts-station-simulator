import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiCallStep } from '../../../scenarios/steps/ApiCallStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';
import type { Station } from '../../../station/Station.js';

/**
 * `omit_org_header` — a GENERAL flag for platform-scoped api_calls: suppress the
 * auto-injected `X-Organization-Id` header so the request resolves at the NULL
 * (platform) team instead of an org team.
 *
 * Why it's needed (empirically confirmed on UAT 2026-06-15): endpoints under
 * /api/v1/admin/ that are gated by a PLATFORM permission (e.g. install-certificate
 * + trigger-cert-renewal → permission:platform.certificates.manage) are filtered
 * for the platform_admin (NULL-scoped) identity WHEN X-Organization-Id forces an
 * org team scope → 403. The SAME call WITHOUT X-Organization-Id resolves the
 * platform permission at NULL team → authorized (200/202). Tenant-scoped admin
 * endpoints (configure/firmware/…) keep auto-injecting the header (default).
 */
describe('ApiCallStep omit_org_header (platform-scoped api_call → suppress X-Organization-Id)', () => {
  const dummyStation = {} as Station;
  afterEach(() => vi.restoreAllMocks());

  function platformCtx() {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    ctx.authToken = 'PLATFORM_TOKEN'; // skip login
    ctx.orgId = 'org-uuid-1';         // ensureOrgId returns this without a discovery fetch
    return ctx;
  }

  function ok202() {
    return new Response(JSON.stringify({ data: {} }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('OMITS X-Organization-Id on an /admin/ endpoint when omit_org_header is true (platform/NULL-team)', async () => {
    const ctx = platformCtx();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok202());

    await new ApiCallStep().execute(
      {
        action: 'api_call',
        method: 'POST',
        url: 'http://test.local/api/v1/admin/stations/stn_x/install-certificate',
        body: { certificateType: 'StationCertificate' },
        omit_org_header: true,
        expect_status: 202,
      },
      ctx,
      dummyStation,
    );

    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-Organization-Id']).toBeUndefined();
    expect(headers.Authorization).toBe('Bearer PLATFORM_TOKEN');
  });

  it('STILL auto-injects X-Organization-Id on /admin/ when omit_org_header is absent (default preserved)', async () => {
    const ctx = platformCtx();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok202());

    await new ApiCallStep().execute(
      {
        action: 'api_call',
        method: 'POST',
        url: 'http://test.local/api/v1/admin/stations/stn_x/firmware',
        body: {},
        expect_status: 202,
      },
      ctx,
      dummyStation,
    );

    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-Organization-Id']).toBe('org-uuid-1');
  });

  it('omit_org_header does not affect non-admin endpoints (no header there anyway)', async () => {
    const ctx = platformCtx();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { id: 's1' } }), { status: 201, headers: { 'Content-Type': 'application/json' } }),
    );

    await new ApiCallStep().execute(
      {
        action: 'api_call',
        method: 'POST',
        url: 'http://test.local/api/v1/sessions/start',
        body: { bay_id: 'b1', service_id: 'svc', duration_seconds: 60 },
        omit_org_header: true,
        expect_status: 201,
      },
      ctx,
      dummyStation,
    );

    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-Organization-Id']).toBeUndefined();
  });
});
