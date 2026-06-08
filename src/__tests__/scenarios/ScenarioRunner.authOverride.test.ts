import { describe, it, expect } from 'vitest';
import { _resolveScenarioAuthForTesting } from '../../scenarios/ScenarioRunner.js';

describe('scenario.auth override (C-018 platform admin)', () => {
  const targetCreds = { email: 'tenant-owner@uat.com', password: 'tenant-pass' };

  it('returns target.credentials when scenario.auth is absent', () => {
    const result = _resolveScenarioAuthForTesting(undefined, targetCreds, {});
    expect(result).toEqual(targetCreds);
  });

  it('returns undefined when scenario.auth is absent AND target has no credentials', () => {
    const result = _resolveScenarioAuthForTesting(undefined, undefined, {});
    expect(result).toBeUndefined();
  });

  it('resolves email_env/password_env from process.env when scenario.auth is set', () => {
    const env = {
      UAT_E2E_PLATFORM_ADMIN_EMAIL: 'platform@uat.com',
      UAT_E2E_PLATFORM_ADMIN_PASSWORD: 'platform-pass',
    };
    const result = _resolveScenarioAuthForTesting(
      { email_env: 'UAT_E2E_PLATFORM_ADMIN_EMAIL', password_env: 'UAT_E2E_PLATFORM_ADMIN_PASSWORD' },
      targetCreds,
      env,
    );
    expect(result).toEqual({ email: 'platform@uat.com', password: 'platform-pass' });
  });

  it('scenario.auth wins over target.credentials (override semantics)', () => {
    const env = { E: 'override@x.com', P: 'override-pass' };
    const result = _resolveScenarioAuthForTesting(
      { email_env: 'E', password_env: 'P' },
      targetCreds,
      env,
    );
    expect(result).not.toEqual(targetCreds);
    expect(result?.email).toBe('override@x.com');
  });

  it('throws with clear message when email env var is unset', () => {
    expect(() => _resolveScenarioAuthForTesting(
      { email_env: 'UNSET_EMAIL_VAR', password_env: 'P' },
      targetCreds,
      { P: 'pp' },
    )).toThrow(/UNSET_EMAIL_VAR/);
  });

  it('throws with clear message when password env var is unset', () => {
    expect(() => _resolveScenarioAuthForTesting(
      { email_env: 'E', password_env: 'UNSET_PASS_VAR' },
      targetCreds,
      { E: 'a@b' },
    )).toThrow(/UNSET_PASS_VAR/);
  });

  it('throws on empty-string env values (not just undefined)', () => {
    expect(() => _resolveScenarioAuthForTesting(
      { email_env: 'EMPTY_EMAIL', password_env: 'P' },
      targetCreds,
      { EMPTY_EMAIL: '', P: 'pp' },
    )).toThrow(/EMPTY_EMAIL/);
  });

  it('does not mutate target.credentials object', () => {
    const env = { E: 'a@b.com', P: 'pp' };
    const beforeSnapshot = JSON.stringify(targetCreds);
    _resolveScenarioAuthForTesting({ email_env: 'E', password_env: 'P' }, targetCreds, env);
    expect(JSON.stringify(targetCreds)).toBe(beforeSnapshot);
  });

  it('returns a fresh object literal (not a reference to env)', () => {
    const env = { E: 'a@b.com', P: 'pp' };
    const r1 = _resolveScenarioAuthForTesting({ email_env: 'E', password_env: 'P' }, targetCreds, env);
    const r2 = _resolveScenarioAuthForTesting({ email_env: 'E', password_env: 'P' }, targetCreds, env);
    expect(r1).not.toBe(r2);
    expect(r1).toEqual(r2);
  });
});
