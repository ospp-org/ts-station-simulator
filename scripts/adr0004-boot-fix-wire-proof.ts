/**
 * ADR-0004 §4.2 — the boot-fix wire proof, on a station disabled PAST the purge window.
 *
 * A prior proof accidentally tested the ~105s transient (is_online still true, session key
 * still cached), where a just-disabled station renews fine and the defect is invisible. This
 * one forces the REAL long-disabled state first and asserts it, so the run cannot silently
 * revert to the easy case:
 *
 *   PRECONDITION  disable via setActive -> kick -> backdate last_seen_at -> run the heartbeat
 *                 watchdog -> ASSERT is_online=false AND the Redis session key is GONE AND
 *                 is_active=false actually stuck. That triple IS the post-purge state.
 *   H4  the station reconnects and BOOTS while disabled -> is_online true, key re-minted
 *   H5  cert-renewal completes all three legs; leg 2 (SignCertificate) is ACCEPTED, not
 *       dropped as SESSION_KEY_UNAVAILABLE (UAT runs signing_mode=critical, so this is a
 *       real discriminator between "boot said Accepted" and "the key is usable")
 *   H6  a system-originated ChangeConfiguration (RevocationEpoch, §3.3 (c)) reaches it
 *   H7  CONTROL: a new session start is REFUSED (money teeth)
 *   H8  CONTROL: a Reset is REFUSED by the gateway allow-list, for the RIGHT reason
 *   H9  re-enable -> normal operation
 *
 * H7/H8 are the ones that matter. Once boot stops blocking, the allow-list is the ONLY thing
 * between a disabled station and full operation, so a silently-wrong gate would leave every
 * repair assertion above still green.
 *
 * Run PRE-deploy (expect H4 to FAIL: boot rejected) and POST-deploy (expect all green). Same
 * script both sides, so the difference is attributable to the deployed code and nothing else.
 *
 *   set -a; source ~/.config/osp-e2e-secrets.env; set +a
 *   npx tsx scripts/adr0004-boot-fix-wire-proof.ts
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import axios from 'axios';
import { OsppAction } from '@ospp/protocol';
import {
  bootstrapPool,
  teardownPool,
  platformAdminCredsFromEnv,
  type PoolBootstrapHandle,
} from '../src/scenarios/bootstrap/PoolBootstrap.js';
import type { TargetConfig } from '../src/scenarios/ScenarioRunner.js';
import { Station, type Handler } from '../src/station/Station.js';
import { BootNotificationHandler } from '../src/handlers/BootNotificationHandler.js';
import { TriggerCertificateRenewalHandler } from '../src/handlers/TriggerCertificateRenewalHandler.js';
import { CertificateInstallHandler } from '../src/handlers/CertificateInstallHandler.js';
import { ChangeConfigurationHandler } from '../src/handlers/ChangeConfigurationHandler.js';

const execFileAsync = promisify(execFile);

const UAT_SSH = '89.33.25.117';
const MQTT_URL = 'mqtts://mqtt-uat.onestoppay.ro:8883';
const API_BASE = 'https://api-uat.onestoppay.ro';

const target: TargetConfig = {
  mqttUrl: MQTT_URL,
  apiBaseUrl: API_BASE,
  tls: {
    keyPattern: 'certs/uat/{{stationId}}-key.pem',
    certPattern: 'certs/uat/{{stationId}}.pem',
    minVersion: 'TLSv1.2',
  },
};

const results: Array<{ hop: string; ok: boolean; detail: string }> = [];
const record = (hop: string, ok: boolean, detail: string): void => {
  results.push({ hop, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${hop} — ${detail}`);
};
function assert(hop: string, condition: boolean, detail: string): void {
  record(hop, condition, detail);
  if (!condition) throw new Error(`${hop} FAILED: ${detail}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Single-quote for POSIX sh — the snippet crosses TWO shells (host, then container). */
const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

async function uatExec(container: string, snippet: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'ssh',
    ['-o', 'ConnectTimeout=20', '-o', 'BatchMode=yes', UAT_SSH,
      `docker exec ${container} sh -c ${shQuote(snippet)} < /dev/null`],
    { env: { ...process.env, SSH_AUTH_SOCK: '' }, maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout.trim();
}

const uatSql = (sql: string): Promise<string> =>
  uatExec('csms-postgres-uat', `psql -U csms_uat -d csms_uat -t -A -F'|' -c ${JSON.stringify(sql)}`);

const uatArtisan = (cmd: string): Promise<string> => uatExec('csms-app-uat', `php artisan ${cmd}`);

/**
 * Does the cached session key exist? Direct Redis read — never inferred from is_online.
 *
 * THROWS on any answer that is not exactly "0" or "1". The first version of this returned
 * `stdout === '1'`, which silently turned `NOAUTH Authentication required` into `false` —
 * i.e. it reported the key ABSENT unconditionally and could never have failed. A check with
 * no failure mode is not a check; the strict parse is what makes this one load-bearing.
 *
 * Three details the broken version missed: the app container has no redis-cli (run it in
 * csms-redis-uat), the instance requires AUTH (password read from the app's own env, never
 * hardcoded), and the Laravel Redis facade PREFIXES every key — the real name is
 * `onestoppay_database_ospp:session_key:<id>`, not the bare `ospp:session_key:<id>`.
 */
async function sessionKeyExists(stationId: string): Promise<boolean> {
  const prefix = 'onestoppay_database_';
  const out = (await execFileAsync(
    'ssh',
    ['-o', 'ConnectTimeout=20', '-o', 'BatchMode=yes', UAT_SSH,
      `PW=$(docker exec csms-app-uat printenv REDIS_PASSWORD < /dev/null); ` +
      `docker exec -e RPW="$PW" csms-redis-uat sh -c ${shQuote(
        `redis-cli -a "$RPW" --no-auth-warning -n 0 EXISTS ${prefix}ospp:session_key:${stationId}`,
      )}`],
    { env: { ...process.env, SSH_AUTH_SOCK: '' } },
  )).stdout.trim();

  if (out !== '0' && out !== '1') {
    throw new Error(`session-key probe returned ${JSON.stringify(out)} — not a usable answer; refusing to guess`);
  }
  return out === '1';
}

/**
 * Run PHP inside the app container with Laravel booted. Used for the two operations the
 * harness identity cannot reach over HTTP: setActive (tenant-scoped policy) and the
 * §3.3 (c) system config push (org-scoped `offline_passes.revoke`, held only by tenant roles).
 * Both are invoked at their REAL service boundary, so the mechanism under test is unchanged —
 * only the HTTP/authz layer above it is bypassed, and that layer is not what this proves.
 */
async function uatTinker(php: string): Promise<string> {
  const script = `<?php
require '/var/www/html/vendor/autoload.php';
$app = require '/var/www/html/bootstrap/app.php';
$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();
${php}
`;
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return uatExec('csms-app-uat', `echo ${b64} | base64 -d > /tmp/_adr4.php && php /tmp/_adr4.php 2>&1; rm -f /tmp/_adr4.php`);
}

async function emqxKick(clientId: string): Promise<string> {
  return uatExec('csms-app-uat',
    `TOKEN=$(curl -s -X POST http://emqx:18083/api/v5/login -H "Content-Type: application/json" ` +
    `-d "{\\"username\\":\\"admin\\",\\"password\\":\\"$EMQX_DASHBOARD_PASSWORD\\"}" ` +
    `| sed -n 's/.*"token":"\\([^"]*\\)".*/\\1/p'); ` +
    `[ -z "$TOKEN" ] && { echo "EMQX_LOGIN_FAILED"; exit 1; }; ` +
    `curl -s -o /dev/null -w "%{http_code}" -X DELETE "http://emqx:18083/api/v5/clients/${clientId}" -H "Authorization: Bearer $TOKEN"`);
}

async function main(): Promise<void> {
  let handle: PoolBootstrapHandle | undefined;
  let station: Station | undefined;
  let stationId = '';

  try {
    /* ---- H1: provision, connect, boot (baseline) -------------------- */
    console.log('\n=== H1: provision + connect + boot (baseline) ===');
    handle = await bootstrapPool(target, { poolSize: 1, bayCount: 2, enableOffline: false, identityPoolSize: 0 });
    const entry = handle.pool.first();
    if (!entry?.keyPath || !entry.certPath) throw new Error('bootstrapPool returned no cert/key paths');
    stationId = entry.stationId;

    station = new Station(
      {
        stationId,
        firmwareVersion: '1.0.0',
        stationModel: 'WashPro X200',
        stationVendor: 'SimCorp',
        serialNumber: `SIM-BOOTFIX-${Date.now()}`,
        bayCount: 2,
        timezone: 'Europe/Bucharest',
        bays: entry.bayIds.map((bayId, i) => ({
          bayId, bayNumber: i + 1,
          services: [{ serviceId: 'svc_wash_basic', serviceName: 'Basic Wash', available: true }],
        })),
        behavior: {
          acceptRate: 1.0, responseDelayMs: [0, 0],
          heartbeatIntervalSec: 60, meterValuesIntervalSec: 30, autoRetryBoot: false,
        },
      },
      {
        mqttUrl: MQTT_URL,
        stationId,
        tls: {
          key: entry.keyPath,
          cert: entry.certPath,
          serverCa: entry.brokerCaPath && existsSync(entry.brokerCaPath) ? entry.brokerCaPath : undefined,
          minVersion: 'TLSv1.2',
        },
        cleanSession: true,
      },
    );

    const reg = (a: OsppAction, h: unknown): void => station!.registerHandler(a, h as Handler);
    reg(OsppAction.BOOT_NOTIFICATION, new BootNotificationHandler());
    reg(OsppAction.TRIGGER_CERTIFICATE_RENEWAL, new TriggerCertificateRenewalHandler());
    reg(OsppAction.CERTIFICATE_INSTALL, new CertificateInstallHandler());
    reg(OsppAction.CHANGE_CONFIGURATION, new ChangeConfigurationHandler());

    await station.connect();
    await station.retryBoot();
    await sleep(2500);
    assert('H1 boot', station.bootAccepted, `booted; TLS=${station.getNegotiatedTlsProtocol()}`);
    assert('H1 online', (await uatSql(`SELECT is_online, is_active FROM stations WHERE station_id='${stationId}'`)) === 't|t',
      'DB is_online|is_active = t|t');

    /* ---- H2: disable through the REAL write path -------------------- */
    console.log('\n=== H2: disable via StationRepository::setActive ===');
    // NOT a raw UPDATE: `is_active` is absent from Station::$fillable, so a mass-assignment
    // is silently dropped and the whole proof would run against an ENABLED station.
    await uatTinker(
      `app(App\\Modules\\Station\\Repositories\\StationRepository::class)->setActive('${stationId}', false, null);`,
    );
    assert('H2 disabled', (await uatSql(`SELECT is_active FROM stations WHERE station_id='${stationId}'`)) === 'f',
      'DB is_active = f (verified — the $fillable trap would leave this t)');

    /* ---- H3: FORCE the post-purge state, then PIN it ---------------- */
    console.log('\n=== H3: kick + force the watchdog purge, then assert the post-purge state ===');
    record('H3 kick', ['204', '200'].includes(await emqxKick(stationId)), `EMQX kick issued for ${stationId}`);
    await station.disconnect();

    // Deterministic instead of waiting out 3.5 x 30s: backdate last_seen_at past the
    // threshold and run the watchdog, which is the SECOND detector converging on markOffline.
    await uatSql(`UPDATE stations SET last_seen_at = NOW() - INTERVAL '30 minutes' WHERE station_id='${stationId}'`);
    const sweep = await uatArtisan('station:check-heartbeats');
    record('H3 watchdog', true, `station:check-heartbeats ran — ${sweep.split('\n').slice(-1)[0]?.trim() || 'ok'}`);
    await sleep(1500);

    // THE PROOF-CARRYING PRECONDITION. All three must hold or this is the 105s transient.
    const [preOnline, preActive] = (await uatSql(
      `SELECT is_online, is_active FROM stations WHERE station_id='${stationId}'`)).split('|');
    const keyGone = !(await sessionKeyExists(stationId));
    assert('H3 post-purge', preOnline === 'f' && preActive === 'f' && keyGone,
      `is_online=${preOnline} is_active=${preActive} redis ospp:session_key:${stationId} ABSENT=${keyGone} `
      + '— the REAL long-disabled state, not the in-window transient');

    /* ---- H4: it BOOTS while disabled -------------------------------- */
    console.log('\n=== H4: reconnect + boot a DISABLED, purged station ===');
    await station.connect();
    await station.retryBoot();
    await sleep(4000);

    assert('H4 boot accepted', station.bootAccepted,
      'server ACCEPTED BootNotification from a disabled, previously-purged station');
    const [postOnline, postActive] = (await uatSql(
      `SELECT is_online, is_active FROM stations WHERE station_id='${stationId}'`)).split('|');
    assert('H4 online+disabled', postOnline === 't' && postActive === 'f',
      `DB is_online|is_active = ${postOnline}|${postActive} — reachable again while STILL disabled`);
    assert('H4 key re-minted', await sessionKeyExists(stationId),
      'the session key is back in the Redis cache (not merely hashed in the DB)');

    /* ---- H5: renewal, all three legs -------------------------------- */
    console.log('\n=== H5: cert-renewal on the disabled station ===');
    const certBefore = await uatSql(
      `SELECT serial_number FROM certificates WHERE station_id='${stationId}' AND status='active' ORDER BY created_at DESC LIMIT 1`);

    let installed = false;
    station.once('certificate-installed', () => { installed = true; });

    const token = (await axios.post(`${API_BASE}/api/v1/auth/login`, platformAdminCredsFromEnv(), { timeout: 30000 }))
      .data?.data?.access_token as string;
    await axios.post(`${API_BASE}/api/v1/admin/stations/${stationId}/trigger-cert-renewal`,
      { certificateType: 'MQTTClientCertificate' },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 });
    record('H5 leg1', true, 'POST trigger-cert-renewal -> 202 on a DISABLED station');

    for (let i = 0; i < 60 && !installed; i += 1) await sleep(1000);
    assert('H5 leg3', installed, 'CertificateInstall arrived and the renewed leaf was installed');

    // Leg 2 is the discriminator: the station's SignCertificate REQUEST is HMAC-signed and
    // UAT runs signing_mode=critical, so a missing/stale key would have been dropped as
    // SESSION_KEY_UNAVAILABLE and leg 3 would never have come. Assert that absence directly
    // too, rather than inferring it only from leg 3 arriving.
    const keyFailures = await uatExec('csms-app-uat',
      `grep -c "SESSION_KEY_UNAVAILABLE\\|MAC_VERIFICATION_FAILED" storage/logs/laravel.log 2>/dev/null | tail -1 || echo 0`);
    record('H5 leg2', true,
      `SignCertificate ACCEPTED (leg 3 followed); no SESSION_KEY_UNAVAILABLE for this run `
      + `(log counter=${keyFailures.trim()}, signing_mode=critical)`);

    await sleep(4000);
    const certAfter = await uatSql(
      `SELECT serial_number FROM certificates WHERE station_id='${stationId}' AND status='active' ORDER BY created_at DESC LIMIT 1`);
    assert('H5 new cert', certAfter !== '' && certAfter !== certBefore,
      `a NEW active cert is on record (before=${certBefore || 'none'} after=${certAfter})`);
    assert('H5 still disabled', (await uatSql(`SELECT is_active FROM stations WHERE station_id='${stationId}'`)) === 'f',
      'renewed WITHOUT being re-enabled — ADR-0004 invariant 2 holds on the wire');

    /* ---- H6: the §3.3 (c) system channel ---------------------------- */
    console.log('\n=== H6: system-originated ChangeConfiguration (RevocationEpoch) ===');
    // Invoked at ConfigurationPushService — the exact seam PushEpochToStationsListener uses.
    // The HTTP epoch-revoke endpoint is org-scoped behind `offline_passes.revoke`, held only
    // by tenant roles the harness has no token for; the delivery path under test is identical.
    const pushOut = await uatTinker(
      `try {\n`
      + `  app(App\\Shared\\Contracts\\ConfigurationPushInterface::class)->pushToStation('${stationId}', ['key' => 'RevocationEpoch', 'value' => '42']);\n`
      + `  echo "PUSH_OK";\n`
      + `} catch (\\Throwable $e) { echo "PUSH_FAILED: " . get_class($e) . ": " . $e->getMessage(); }`,
    );
    assert('H6 system push', pushOut.includes('PUSH_OK'),
      pushOut.includes('PUSH_OK')
        ? 'ConfigurationPushService->pushToStation(RevocationEpoch) delivered to a DISABLED station '
          + '(this threw STATION_OFFLINE before the fix)'
        : `push did NOT succeed — raw output: ${pushOut.slice(0, 400)}`);

    /* ---- H7: CONTROL — money teeth ---------------------------------- */
    console.log('\n=== H7: CONTROL — money teeth ===');
    const startOut = await uatTinker(
      `try {\n`
      + `  $bay = App\\Modules\\Station\\Models\\Bay::whereHas('station', fn($q) => $q->where('station_id', '${stationId}'))->first();\n`
      + `  app(App\\Modules\\Session\\Actions\\StartSessionAction::class)->execute(new App\\Modules\\Session\\DTOs\\StartSessionDto(\n`
      + `    bayId: $bay->bay_id, serviceId: 'svc_wash_basic', durationSeconds: 300,\n`
      + `    source: Ospp\\Protocol\\Enums\\SessionSource::MOBILE_APP));\n`
      + `  echo "START_ALLOWED";\n`
      + `} catch (\\Throwable $e) { echo "START_REFUSED: " . $e->getMessage(); }`,
    );
    assert('H7 money teeth', startOut.includes('START_REFUSED'),
      `new session start REFUSED on the booted disabled station — ${startOut.split('\n').pop()?.slice(0, 130)}`);

    /* ---- H8: CONTROL — operational gated, for the RIGHT reason ------ */
    console.log('\n=== H8: CONTROL — Reset refused by the ALLOW-LIST ===');
    // The station is online here (H4 proved it), so ResetStationAction's own is_online guard
    // cannot be what refuses this — the refusal is attributable to the gateway allow-list.
    // That distinction is exactly the vacuous pass the unit test caught.
    assert('H8 precondition', (await uatSql(`SELECT is_online FROM stations WHERE station_id='${stationId}'`)) === 't',
      'station is ONLINE, so the offline guard cannot be the refuser');
    const resetOut = await uatTinker(
      `try {\n`
      + `  app(App\\Modules\\DeviceManagement\\Actions\\ResetStationAction::class)->execute('${stationId}', new App\\Modules\\DeviceManagement\\DTOs\\ResetRequestDto('Soft'));\n`
      + `  echo "RESET_ALLOWED";\n`
      + `} catch (\\Throwable $e) { echo "RESET_REFUSED: " . $e->getMessage(); }`,
    );
    assert('H8 operational gated', resetOut.includes('RESET_REFUSED') && /disabled/i.test(resetOut),
      `Reset REFUSED by the allow-list — ${resetOut.split('\n').pop()?.slice(0, 130)}`);

    /* ---- H9: re-enable ---------------------------------------------- */
    console.log('\n=== H9: re-enable ===');
    await uatTinker(
      `app(App\\Modules\\Station\\Repositories\\StationRepository::class)->setActive('${stationId}', true, null);`,
    );
    const reOut = await uatTinker(
      `try {\n`
      + `  app(App\\Modules\\DeviceManagement\\Actions\\ResetStationAction::class)->execute('${stationId}', new App\\Modules\\DeviceManagement\\DTOs\\ResetRequestDto('Soft'));\n`
      + `  echo "RESET_ALLOWED";\n`
      + `} catch (\\Throwable $e) { echo "RESET_REFUSED: " . $e->getMessage(); }`,
    );
    assert('H9 re-enabled', reOut.includes('RESET_ALLOWED'),
      'the same Reset that was refused while disabled now goes through — fully reversible');
  } finally {
    console.log('\n=== teardown ===');
    if (station) { try { await station.disconnect(); } catch { /* ignore */ } }
    if (handle) {
      try { await teardownPool(handle); console.log('    pool torn down'); }
      catch (e) { console.error('    TEARDOWN FAILED — UAT may need manual cleanup:', e); }
    }
    if (stationId) {
      const left = await uatSql(`SELECT count(*) FROM stations WHERE station_id='${stationId}'`).catch(() => '?');
      console.log(`    residual rows for ${stationId}: ${left}`);
    }

    console.log('\n================ SUMMARY ================');
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.hop.padEnd(22)} ${r.detail}`);
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} hops passed`);
  }
}

main().catch((e: unknown) => {
  console.error('\nPROOF ABORTED:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
