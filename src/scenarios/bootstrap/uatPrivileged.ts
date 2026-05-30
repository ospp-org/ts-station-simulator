import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * Privileged UAT database access for the per-run pool bootstrap/teardown.
 *
 * UAT runs on a remote host (Server 1) in a `csms-postgres-uat` container,
 * reachable from the dev box over SSH. A handful of operations the OSPP server
 * exposes NO application/admin/API path for — notably flipping
 * `users.offline_enabled` (DB-only, see INVESTIGATE doc Q2) and a targeted
 * FK-safe teardown of provisioned rows — are performed here as raw SQL.
 *
 * SQL is delivered over psql STDIN (`docker exec -i … psql`), never as a `-c`
 * shell argument, so SQL text is not subject to remote-shell interpolation.
 * Literal values are still single-quote-escaped via {@link sqlLiteral} as
 * defense-in-depth (inputs are trusted: hex station IDs, configured email).
 *
 * All connection parameters are overridable via env so nothing host-specific
 * is hard-coded into committed behavior beyond sane defaults.
 */
export interface UatDbConfig {
  sshHost: string;
  sshKey: string;
  container: string;
  dbUser: string;
  dbName: string;
}

export function uatDbConfigFromEnv(): UatDbConfig {
  const home = os.homedir();
  const rawKey = process.env.UAT_SSH_KEY ?? path.join(home, '.ssh', 'id_ed25519');
  return {
    sshHost: process.env.UAT_SSH_HOST ?? 'gabi@89.33.25.117',
    // Expand a leading ~ since spawn() does not run a shell to do it for us.
    sshKey: rawKey.replace(/^~(?=$|\/)/, home),
    container: process.env.UAT_DB_CONTAINER ?? 'csms-postgres-uat',
    dbUser: process.env.UAT_DB_USER ?? 'csms_uat',
    dbName: process.env.UAT_DB_NAME ?? 'csms_uat',
  };
}

/** Single-quote-escape a SQL string literal (doubles embedded quotes). */
export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Run a SQL script against the UAT database over SSH+psql, feeding the SQL on
 * stdin. Resolves with psql stdout; rejects (with stderr) on a non-zero exit.
 * `ON_ERROR_STOP=1` makes any statement error abort the whole script.
 */
export function runUatSql(sql: string, cfg: UatDbConfig = uatDbConfigFromEnv()): Promise<string> {
  const remoteCmd =
    `docker exec -i ${cfg.container} psql -U ${cfg.dbUser} -d ${cfg.dbName} ` +
    `-v ON_ERROR_STOP=1 --no-psqlrc -q`;
  const args = [
    '-i', cfg.sshKey,
    '-o', 'ConnectTimeout=15',
    '-o', 'BatchMode=yes',
    cfg.sshHost,
    remoteCmd,
  ];

  return new Promise<string>((resolve, reject) => {
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) =>
      reject(new Error(`runUatSql: failed to spawn ssh — ${err.message}`)),
    );
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            `runUatSql: psql exited ${code ?? 'null'} — ${(stderr || stdout).trim().slice(0, 600)}`,
          ),
        );
      }
    });
    child.stdin.write(sql);
    child.stdin.end();
  });
}

/**
 * Fail-fast connectivity + credentials check. Throws a clear, actionable error
 * if the UAT DB cannot be reached so the bootstrap aborts before mutating
 * anything (rather than half-provisioning then failing on the offline step).
 */
export async function assertUatDbReachable(cfg: UatDbConfig = uatDbConfigFromEnv()): Promise<void> {
  try {
    await runUatSql('SELECT 1;', cfg);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `UAT DB unreachable (${cfg.sshHost} → ${cfg.container}). Privileged steps ` +
      `(offline-enable, teardown) require SSH+psql access. Override via UAT_SSH_HOST/` +
      `UAT_SSH_KEY/UAT_DB_CONTAINER/UAT_DB_USER/UAT_DB_NAME. Underlying: ${detail}`,
    );
  }
}

/** Set users.offline_enabled for a single user by email. Idempotent. */
export async function setOfflineEnabled(
  email: string,
  enabled: boolean,
  cfg: UatDbConfig = uatDbConfigFromEnv(),
): Promise<void> {
  await runUatSql(
    `UPDATE users SET offline_enabled = ${enabled ? 'true' : 'false'} WHERE email = ${sqlLiteral(email)};`,
    cfg,
  );
}
