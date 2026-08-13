import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { sshIdentityArgs, runUatSql } from '../../../scenarios/bootstrap/uatPrivileged.js';

// uatPrivileged does `import { spawn } from 'node:child_process'` — a live binding, which a
// vi.spyOn over the namespace object does NOT intercept. Getting that wrong once already ran
// a real ssh out of the test suite, so the module is mocked rather than spied.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

/**
 * Every ssh this repo spawns must be pinned to ONE identity.
 *
 * `-i <key>` alone only APPENDS a key: ssh still offers every identity the agent holds,
 * in agent order, before it reaches ours. On a dev box whose agent carries a dozen deploy
 * keys that is a dozen failed publickey attempts per connection — and the UAT host's
 * fail2ban counts them. It has already produced an hour-long ban.
 *
 * The fix that does NOT hold is blanking `SSH_AUTH_SOCK` in the spawn's env: that is a
 * property of whoever remembers to set it, so any caller spawning us with an inherited
 * environment gets the fan-out back with nothing to show it went missing. The flag has to
 * ride in the argv.
 *
 * The second test is the one that keeps this closed. It is a source sweep, not a unit
 * test, because the failure mode is a NEW ssh call site written the old way — which no
 * behavioural test of the existing three would ever see.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('sshIdentityArgs', () => {
  it('pins the key AND forbids the agent from offering anything else', () => {
    const args = sshIdentityArgs({
      sshHost: 'gabi@example.test',
      sshKey: '/home/gabi/.ssh/id_ed25519',
      container: 'c',
      dbUser: 'u',
      dbName: 'd',
    });

    expect(args).toEqual(['-i', '/home/gabi/.ssh/id_ed25519', '-o', 'IdentitiesOnly=yes']);
    // Order matters for readability but not for ssh; what matters is that the option is
    // present at all — without it the `-i` above is an addition, not a restriction.
    expect(args).toContain('IdentitiesOnly=yes');
  });
});

describe('runUatSql — the argv that actually reaches ssh', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('carries -i <key> AND -o IdentitiesOnly=yes, and does not blank SSH_AUTH_SOCK instead', async () => {
    let seenCmd = '';
    let seenArgs: readonly string[] = [];
    let seenOptions: unknown;

    vi.mocked(spawn).mockImplementation(((cmd: string, args: string[], options: unknown) => {
      seenCmd = cmd;
      seenArgs = args;
      seenOptions = options;
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: (): void => {}, end: (): void => {} };
      queueMicrotask(() => child.emit('close', 0));
      return child;
    }) as unknown as typeof spawn);

    await runUatSql('SELECT 1;', {
      sshHost: 'gabi@example.test',
      sshKey: '/home/gabi/.ssh/id_ed25519',
      container: 'csms-postgres-uat',
      dbUser: 'csms_uat',
      dbName: 'csms_uat',
    });

    expect(seenCmd).toBe('ssh');
    const i = seenArgs.indexOf('-i');
    expect(i).toBeGreaterThan(-1);
    expect(seenArgs[i + 1]).toBe('/home/gabi/.ssh/id_ed25519');
    expect(seenArgs).toContain('IdentitiesOnly=yes');
    // The env is left alone — the restriction rides in argv, so it survives any launcher.
    expect((seenOptions as { env?: unknown }).env).toBeUndefined();
  });
});

describe('every ssh call site in the repo', () => {
  const sources = [
    ...tsFilesUnder(path.join(REPO_ROOT, 'src')),
    ...tsFilesUnder(path.join(REPO_ROOT, 'scripts')),
  ];

  const spawnsSsh = sources.filter((f) => /(?:spawn|execFile\w*)\(\s*['"]ssh['"]/.test(readFileSync(f, 'utf-8')));

  it('finds the known ssh call sites (guards the sweep itself against matching nothing)', () => {
    expect(spawnsSsh.length).toBeGreaterThanOrEqual(3);
  });

  it.each(spawnsSsh.map((f) => [path.relative(REPO_ROOT, f), f] as const))(
    '%s passes sshIdentityArgs() into the spawn',
    (_rel, file) => {
      expect(readFileSync(file, 'utf-8')).toContain('sshIdentityArgs');
    },
  );

  it.each(spawnsSsh.map((f) => [path.relative(REPO_ROOT, f), f] as const))(
    '%s does not fall back to blanking SSH_AUTH_SOCK in the spawn env',
    (_rel, file) => {
      expect(readFileSync(file, 'utf-8')).not.toMatch(/SSH_AUTH_SOCK\s*:\s*['"]{2}/);
    },
  );
});
