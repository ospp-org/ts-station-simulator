import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadTarget,
  toRunnerTarget,
  requireCredentials,
  requireMqttCredentials,
  resolveEnvVars,
} from '../../cli/config.js';

/**
 * THE GAP THIS FILE PINS.
 *
 * `loadTarget` resolved `${VAR}` over the WHOLE target node before any consumer
 * chose which fields it needed, so `simulator provision -t uat` died with
 * "Environment variable UAT_EMAIL is not set" — a login credential — before it
 * reached its certs check, its key commit, or its one unauthenticated POST. The
 * provisioning door takes a single-use token in the BODY and no Authorization
 * header at all; `UAT_EMAIL` has zero executable readers in `src/`, and the only
 * consumer of the resolved value is the scenario runner's login chain.
 *
 * The fix must not turn that into a SILENT success for `run`, which genuinely
 * needs the pair. So the requirement moves from load time to READ time, and the
 * read is explicit.
 */
const CREDENTIAL_VARS = ['UAT_EMAIL', 'UAT_PASSWORD', 'SANDBOX_GM_EMAIL', 'SANDBOX_GM_PASSWORD', 'SANDBOX_GM_MQTT_USER', 'SANDBOX_GM_MQTT_PASS'];

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of CREDENTIAL_VARS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of CREDENTIAL_VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('a target loads without the credentials a command does not use', () => {
  it('uat loads with UAT_EMAIL and UAT_PASSWORD unset', async () => {
    const target = await loadTarget('uat');
    expect(target.csmsUrl).toBe('https://api-uat.onestoppay.ro');
    expect(target.mqttUrl).toBe('mqtts://mqtt-uat.onestoppay.ro:8883');
  });

  it('the certs block — which provisioning DOES need — resolves', async () => {
    const target = await loadTarget('uat');
    expect(target.certs?.key).toBe('certs/uat/{{stationId}}-key.pem');
    expect(target.certs?.cert).toBe('certs/uat/{{stationId}}.pem');
    expect(target.certs?.stationCaChain).toBe('certs/uat/{{stationId}}-chain.pem');
  });

  it('the unresolvable credential section is ABSENT, and why is recorded', async () => {
    const target = await loadTarget('uat');
    expect(target.credentials).toBeUndefined();
    expect(target.credentialsError).toMatch(/UAT_EMAIL/);
  });

  it('sandbox-gm loads with all four of its vars unset', async () => {
    const target = await loadTarget('sandbox-gm');
    expect(target.credentials).toBeUndefined();
    expect(target.mqttCredentials).toBeUndefined();
    expect(target.credentialsError).toMatch(/SANDBOX_GM_/);
    expect(target.mqttCredentialsError).toMatch(/SANDBOX_GM_/);
  });

  it('a target with no placeholders is unaffected', async () => {
    const target = await loadTarget('local');
    expect(target.credentials).toEqual({ email: 'admin@csms.local', password: 'password' });
    expect(target.credentialsError).toBeUndefined();
  });

  it('with the vars SET, uat resolves them exactly as before', async () => {
    process.env['UAT_EMAIL'] = 'someone@example.test';
    process.env['UAT_PASSWORD'] = 'hunter2';
    const target = await loadTarget('uat');
    expect(target.credentials).toEqual({ email: 'someone@example.test', password: 'hunter2' });
    expect(target.credentialsError).toBeUndefined();
  });
});

describe('a command that NEEDS the credential still fails, and says the same thing', () => {
  it('requireCredentials throws the recorded message', async () => {
    const target = await loadTarget('uat');
    expect(() => requireCredentials(target)).toThrow(/UAT_EMAIL is not set/);
  });

  it('requireCredentials names the TARGET, so the message is actionable', async () => {
    const target = await loadTarget('uat');
    expect(() => requireCredentials(target)).toThrow(/uat/);
  });

  it('toRunnerTarget — the scenario-run path — refuses rather than running unauthenticated', async () => {
    // This is the regression that must not happen: `run --target uat` without the
    // pair has to fail, not proceed with no credentials and then 401 on every
    // scenario.
    const target = await loadTarget('uat');
    expect(() => toRunnerTarget(target)).toThrow(/UAT_EMAIL is not set/);
  });

  it('requireMqttCredentials throws for sandbox-gm', async () => {
    const target = await loadTarget('sandbox-gm');
    expect(() => requireMqttCredentials(target)).toThrow(/SANDBOX_GM_MQTT_USER is not set/);
  });

  it('both accessors return undefined for a target that declares no such section', async () => {
    const target = await loadTarget('local');
    expect(requireMqttCredentials(target)).toBeUndefined();
    expect(requireCredentials(target)).toEqual({ email: 'admin@csms.local', password: 'password' });
  });

  it('toRunnerTarget passes the resolved pair through when it is available', async () => {
    process.env['UAT_EMAIL'] = 'someone@example.test';
    process.env['UAT_PASSWORD'] = 'hunter2';
    const runner = toRunnerTarget(await loadTarget('uat'));
    expect(runner.credentials).toEqual({ email: 'someone@example.test', password: 'hunter2' });
  });
});

describe('an unresolvable placeholder OUTSIDE a credential section still fails at load', () => {
  it('resolveEnvVars itself is unchanged — it throws on an unset var', () => {
    expect(() => resolveEnvVars('${DEFINITELY_NOT_SET_ANYWHERE}')).toThrow(
      /Environment variable DEFINITELY_NOT_SET_ANYWHERE is not set/,
    );
  });

  it('a placeholder in a URL or a cert path would abort the load, not defer', async () => {
    // Deferring those would be wrong: no command can work without them, so a lazy
    // failure just moves the same abort further from its cause. Asserted as a
    // property of the loader rather than by editing the committed targets.yaml —
    // see loadTarget's EAGER list.
    const { EAGER_TARGET_SECTIONS, DEFERRED_TARGET_SECTIONS } = await import('../../cli/config.js');
    expect(DEFERRED_TARGET_SECTIONS).toEqual(['credentials', 'mqtt_credentials']);
    expect(EAGER_TARGET_SECTIONS).toContain('csms_url');
    expect(EAGER_TARGET_SECTIONS).toContain('mqtt_url');
    expect(EAGER_TARGET_SECTIONS).toContain('certs');
    expect(EAGER_TARGET_SECTIONS).toContain('station_pool');
    // Nothing may be in both lists, or the rule is undecidable.
    for (const section of DEFERRED_TARGET_SECTIONS) {
      expect(EAGER_TARGET_SECTIONS).not.toContain(section);
    }
  });
});
