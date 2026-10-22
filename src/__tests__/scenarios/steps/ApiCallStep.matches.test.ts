import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiCallStep } from '../../../scenarios/steps/ApiCallStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';
import type { Station } from '../../../station/Station.js';

/**
 * `matches` - a value the scenario cannot predict but can describe, at a path.
 *
 * The case it was built for: the trust bundle of an offline pass issuance (app-contract.md 3.4)
 * carries the Station CA's certificate and CRL, PEM, which no scenario knows byte for byte, and
 * `expect_body_text` is refused on JSON because a substring passes wherever the text appears.
 * `matches` resolves the path first, as every other `expect_body` entry does, and then holds the
 * value to a pattern - a string, matched as written (anchor it with ^ and $ to mean the whole).
 */
describe('ApiCallStep expect_body matches', () => {
  const dummyStation = {} as Station;
  afterEach(() => vi.restoreAllMocks());

  const issuance = () =>
    new Response(
      JSON.stringify({
        offlinePass: { passId: 'opass_0123456789ab', keyId: 'AbCdEfGhIjKlMnOpQrStUv' },
        trustBundle: {
          stationCas: [{ certificate: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n', crl: 'not a crl' }],
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

  const run = (expectBody: Record<string, unknown>) => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(issuance());
    return new ApiCallStep().execute(
      {
        action: 'api_call',
        method: 'POST',
        url: 'http://test.local/api/v1/offline/passes',
        expect_status: 200,
        expect_body: expectBody,
      },
      ctx,
      dummyStation,
    );
  };

  it('passes when the value at the path matches the pattern', async () => {
    await expect(
      run({
        'offlinePass.keyId': { matches: '^[A-Za-z0-9_-]{22}$' },
        'trustBundle.stationCas.0.certificate': { matches: '^-----BEGIN CERTIFICATE-----\\n' },
      }),
    ).resolves.toBeUndefined();
  });

  it('fails, naming the path and the value, when the value does not match', async () => {
    await expect(run({ 'trustBundle.stationCas.0.crl': { matches: '^-----BEGIN X509 CRL-----\\n' } }))
      .rejects.toThrow(/trustBundle\.stationCas\.0\.crl.*not a crl/s);
  });

  it('fails when the path resolves to nothing or to no string - absence never matches', async () => {
    await expect(run({ 'trustBundle.serverKeys': { matches: '.*' } })).rejects.toThrow(/trustBundle\.serverKeys/);
    await expect(run({ 'trustBundle.stationCas': { matches: '.*' } })).rejects.toThrow(/string/);
  });

  it('refuses a comparator with a sibling key, or a pattern that is no string or does not compile', async () => {
    await expect(run({ 'offlinePass.keyId': { matches: '.', is_recent: 5 } })).rejects.toThrow(/only key/);
    await expect(run({ 'offlinePass.keyId': { matches: 5 } })).rejects.toThrow(/pattern/);
    await expect(run({ 'offlinePass.keyId': { matches: '(' } })).rejects.toThrow(/pattern/);
  });
});
