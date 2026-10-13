import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StationPool } from '../../scenarios/stations/StationPool.js';
import { fakePaymentsServer, type FakePayment } from '../helpers/fakePaymentsServer.js';

/**
 * WHAT THE CLI DOES WHEN A POOL TEARDOWN DOES NOT FINISH (Part C2, 2026-10-13).
 *
 * `run --bootstrap-pool` tears its pool down in `finally`; a teardown that threw printed a yellow
 * "Teardown warning", left the exit code as it was - 0 for a run whose scenarios passed - and
 * wrote no handle, so the pool's ids survived only in scrollback (M-SIM 3.1). Now:
 *  - exit 3: the teardown kept the pool because a card payment of its organization still holds
 *    money, is still pending, or could not be read - nothing was deleted;
 *  - exit 4: the teardown failed otherwise (the delete transaction was refused, or a local file
 *    could not be removed);
 *  - either way, when the pool is still on the server, its handle is written (mode 0600) to
 *    tests/artifacts/pool-handle.json, or beside it as pool-handle-<organization>.json when that
 *    file already holds another pool's handle, for `teardown-pool --handle` to finish.
 * `teardown-pool --handle` answers the same two codes and keeps its handle in both.
 *
 * The CLI is driven in-process: the module parses process.argv when it is imported, so each case
 * resets the module registry, sets argv and imports it again. bootstrapPool, the scenario runner and
 * the SQL channel are stand-ins; teardownPool is the real one, and the server is fakePaymentsServer.
 */

const h = vi.hoisted(() => ({
  runUatSql: vi.fn(async (_sql: string): Promise<string> => ''),
  bootstrapPool: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});
vi.mock('../../scenarios/bootstrap/uatPrivileged.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scenarios/bootstrap/uatPrivileged.js')>();
  return { ...actual, runUatSql: h.runUatSql };
});
vi.mock('../../scenarios/bootstrap/PoolBootstrap.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scenarios/bootstrap/PoolBootstrap.js')>();
  return { ...actual, bootstrapPool: h.bootstrapPool };
});
vi.mock('../../scenarios/ScenarioRunner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scenarios/ScenarioRunner.js')>();
  class ScenarioRunnerStandIn {
    setKeepCreated(): void {}
    setRunPool(): void {}
    setRunIdentities(): void {}
    async loadScenario(): Promise<unknown> { return { name: 'Teardown exit probe', steps: [] }; }
    async runScenario(): Promise<unknown> {
      return { name: 'Teardown exit probe', status: 'passed', durationMs: 1, steps: [] };
    }
  }
  return { ...actual, ScenarioRunner: ScenarioRunnerStandIn, unsatisfiedVariables: () => [] };
});

const API = 'https://api-uat.example.test';
const ORG = '019ef000-0000-7000-8000-000000000001';
const OWNER = 'sim-pool-owner-r1@onestoppay.dev';
const OWNER_PASSWORD = 'Pp1!0123456789abcdef0123456789abcd';
const BATCH = '01a13289-fdad-703c-9639-421aace7f759';
const BATCH_BT = '88c0b457-6f6b-4b54-9ad9-aeade6625071';
const RUN_ARGS = [
  'run', '--scenario', 'probe.yaml', '--bootstrap-pool',
  '--csms-url', API, '--mqtt-url', 'mqtts://mqtt.example.test:8883',
];

let dir: string;
let cwd: string;
let certFiles: string[];

const artifacts = (): string => join(dir, 'tests', 'artifacts');
const defaultHandlePath = (): string => join(artifacts(), 'pool-handle.json');

function poolHandle() {
  return {
    orgId: ORG,
    createdOrgId: ORG,
    ephemeralOwnerEmail: OWNER,
    locationId: '019e81fb-58db-7173-89b6-d1ae08cf9a0e',
    stationIds: ['stn_aaaa1111'],
    certFiles,
    seededServiceIds: [],
    identityCredentials: [{ email: 'sim-worker-r1-0@test.local', password: OWNER_PASSWORD }],
    pool: new StationPool(),
    apiBaseUrl: API,
  };
}

function serve(payments: FakePayment[]) {
  const server = fakePaymentsServer({ api: API, orgId: ORG, ownerEmail: OWNER, ownerPassword: OWNER_PASSWORD, payments });
  vi.stubGlobal('fetch', server.fetch);
  return server;
}

const stillCaptured = (): FakePayment => ({
  id: BATCH, status: 'succeeded', amountCents: 600, processorTransactionId: BATCH_BT, referenceId: 'bay_aaaa0001',
  btAnswers: ['system-error'],
});

const deleteRan = (): boolean => h.runUatSql.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM'));

interface CliOutcome {
  /** The code process.exit was called with; undefined when the command ended without calling it. */
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
}

/** Import the CLI with `args` as its argv and move the fake clock until it exits or reports completion. */
async function runCli(args: string[]): Promise<CliOutcome> {
  vi.resetModules();
  const out: string[] = [];
  const err: string[] = [];
  let exitCode: number | undefined;
  let completed = false;
  const text = (a: unknown[]): string => a.map((x) => String(x)).join(' ');
  const spies = [
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      out.push(text(a));
      if (text(a).includes('Pool teardown complete.')) completed = true;
    }),
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { err.push(text(a)); }),
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(text(a)); }),
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { exitCode = code ?? 0; }) as never),
  ];
  const argv = process.argv;
  process.argv = ['node', 'simulator', ...args];
  try {
    await import('../../cli/index.js');
    for (let i = 0; exitCode === undefined && !(completed && args[0] === 'teardown-pool'); i++) {
      if (i > 20_000) throw new Error(`the CLI never finished; stdout:\n${out.join('\n')}\nstderr:\n${err.join('\n')}`);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    // Let a command that reported completion run to its end (a trailing file removal).
    await vi.advanceTimersByTimeAsync(5_000);
  } finally {
    process.argv = argv;
    for (const s of spies) s.mockRestore();
  }
  return { exitCode, stdout: out.join('\n'), stderr: err.join('\n') };
}

function writeKeptHandle(path: string): string {
  const { pool: _pool, ...serialized } = poolHandle();
  const body = JSON.stringify(serialized, null, 2);
  writeFileSync(path, body, { mode: 0o600 });
  return body;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  h.runUatSql.mockReset();
  h.runUatSql.mockImplementation(async () => '');
  h.bootstrapPool.mockReset();
  h.bootstrapPool.mockImplementation(async () => poolHandle());
  delete process.env.SIM_POOL_OWNER_EMAIL;
  delete process.env.SIM_POOL_OWNER_PASSWORD;
  dir = mkdtempSync(join(tmpdir(), 'pool-teardown-exit-'));
  mkdirSync(join(dir, 'certs'), { recursive: true });
  certFiles = ['stn_aaaa1111-key.pem', 'stn_aaaa1111.pem'].map((f) => {
    const p = join(dir, 'certs', f);
    writeFileSync(p, 'material');
    return p;
  });
  cwd = process.cwd();
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(cwd);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe('run --bootstrap-pool: a teardown that does not finish fails the run and keeps its handle', () => {
  it('exits 3 and writes the handle when card money is still captured after every try, and deletes nothing', async () => {
    serve([stillCaptured()]);

    const res = await runCli(RUN_ARGS);

    expect(res.exitCode, `a run that left 6 lei captured exited ${res.exitCode}\n${res.stderr}`).toBe(3);
    expect(deleteRan()).toBe(false);
    expect(existsSync(defaultHandlePath()), 'the kept pool has no handle').toBe(true);
    const written = JSON.parse(readFileSync(defaultHandlePath(), 'utf-8')) as Record<string, unknown>;
    expect(written.createdOrgId).toBe(ORG);
    expect(written.ephemeralOwnerEmail).toBe(OWNER);
    expect(written.apiBaseUrl).toBe(API);
    expect(statSync(defaultHandlePath()).mode & 0o777).toBe(0o600);
    expect(res.stderr).toContain(BATCH);
    expect(res.stderr).toContain(BATCH_BT);
    expect(res.stderr).toContain('teardown-pool --handle');
    for (const f of certFiles) expect(existsSync(f)).toBe(true);
  });

  it('exits 4 and writes the handle when the delete transaction is refused', async () => {
    serve([]);
    h.runUatSql.mockImplementation(async () => {
      throw new Error('runUatSql: psql exited 3 — ERROR:  update or delete on table "locations" violates foreign key constraint');
    });

    const res = await runCli(RUN_ARGS);

    expect(res.exitCode, `a run whose teardown failed exited ${res.exitCode}\n${res.stderr}`).toBe(4);
    expect(existsSync(defaultHandlePath()), 'the pool is still on the server and its handle is gone').toBe(true);
    expect(statSync(defaultHandlePath()).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(defaultHandlePath(), 'utf-8')).stationIds).toEqual(['stn_aaaa1111']);
    expect(res.stderr).toContain('violates foreign key constraint');
  });

  it("never overwrites another pool's handle: it writes its own beside it, named by its organization", async () => {
    serve([]);
    h.runUatSql.mockImplementation(async () => { throw new Error('runUatSql: psql exited 2 — connection refused'); });
    mkdirSync(artifacts(), { recursive: true });
    const other = JSON.stringify({ orgId: 'another-pool', stationIds: ['stn_bbbb2222'], certFiles: [] });
    writeFileSync(defaultHandlePath(), other);

    const res = await runCli(RUN_ARGS);

    expect(res.exitCode).toBe(4);
    expect(readFileSync(defaultHandlePath(), 'utf-8'), "another pool's handle was overwritten").toBe(other);
    const own = join(artifacts(), `pool-handle-${ORG}.json`);
    expect(existsSync(own), `no handle beside it; artifacts hold ${JSON.stringify(readdirSync(artifacts()))}`).toBe(true);
    expect(JSON.parse(readFileSync(own, 'utf-8')).createdOrgId).toBe(ORG);
    expect(res.stderr).toContain(own);
  });

  it('a teardown that finishes exits 0 and leaves no handle (control)', async () => {
    serve([]);

    const res = await runCli(RUN_ARGS);

    expect(res.exitCode).toBe(0);
    expect(existsSync(defaultHandlePath())).toBe(false);
    expect(deleteRan()).toBe(true);
  });
});

describe('teardown-pool --handle: the same two codes, and the handle is kept', () => {
  it('exits 3 and keeps the handle when card money is still captured, and deletes nothing', async () => {
    serve([stillCaptured()]);
    mkdirSync(artifacts(), { recursive: true });
    const body = writeKeptHandle(defaultHandlePath());

    const res = await runCli(['teardown-pool', '--handle', defaultHandlePath()]);

    expect(res.exitCode, `teardown-pool left 6 lei captured and answered ${res.exitCode}`).toBe(3);
    expect(deleteRan()).toBe(false);
    expect(existsSync(defaultHandlePath()), 'the handle of a pool still on the server was removed').toBe(true);
    expect(readFileSync(defaultHandlePath(), 'utf-8')).toBe(body);
    expect(res.stderr).toContain(BATCH);
  });

  it('exits 4 and keeps the handle when the delete transaction is refused', async () => {
    serve([]);
    h.runUatSql.mockImplementation(async () => { throw new Error('runUatSql: psql exited 2 — connection refused'); });
    mkdirSync(artifacts(), { recursive: true });
    writeKeptHandle(defaultHandlePath());

    const res = await runCli(['teardown-pool', '--handle', defaultHandlePath()]);

    expect(res.exitCode).toBe(4);
    expect(existsSync(defaultHandlePath())).toBe(true);
  });

  it('a teardown that finishes removes the handle (control)', async () => {
    serve([]);
    mkdirSync(artifacts(), { recursive: true });
    writeKeptHandle(defaultHandlePath());

    const res = await runCli(['teardown-pool', '--handle', defaultHandlePath()]);

    expect(res.exitCode ?? 0).toBe(0);
    expect(existsSync(defaultHandlePath())).toBe(false);
    expect(deleteRan()).toBe(true);
  });
});
