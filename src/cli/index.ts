#!/usr/bin/env node

import { Command } from 'commander';
import {
  ScenarioRunner,
  unsatisfiedVariables,
  type TargetConfig as RunnerTargetConfig,
  type ScenarioResult,
  type ScenarioDefinition,
} from '../scenarios/ScenarioRunner.js';
import { loadTarget, type TargetConfig } from './config.js';
import { JUnitReporter } from '../reporting/JUnitReporter.js';
import { JsonReporter } from '../reporting/JsonReporter.js';
import { Station, type Handler } from '../station/Station.js';
import { OsppAction } from '@ospp/protocol';
import { generateStationId, generateSerialNumber } from '../station/StationConfig.js';
import { BootNotificationHandler } from '../handlers/BootNotificationHandler.js';
import { HeartbeatHandler } from '../handlers/HeartbeatHandler.js';
import { StartServiceHandler } from '../handlers/StartServiceHandler.js';
import { StopServiceHandler } from '../handlers/StopServiceHandler.js';
import { ReserveBayHandler } from '../handlers/ReserveBayHandler.js';
import { CancelReservationHandler } from '../handlers/CancelReservationHandler.js';
import { GetConfigurationHandler } from '../handlers/GetConfigurationHandler.js';
import { ChangeConfigurationHandler } from '../handlers/ChangeConfigurationHandler.js';
import { ResetHandler } from '../handlers/ResetHandler.js';
import { UpdateFirmwareHandler } from '../handlers/UpdateFirmwareHandler.js';
import { GetDiagnosticsHandler } from '../handlers/GetDiagnosticsHandler.js';
import { SetMaintenanceModeHandler } from '../handlers/SetMaintenanceModeHandler.js';
import { UpdateServiceCatalogHandler } from '../handlers/UpdateServiceCatalogHandler.js';
import { TriggerMessageHandler } from '../handlers/TriggerMessageHandler.js';
import { CertificateInstallHandler } from '../handlers/CertificateInstallHandler.js';
import { TriggerCertificateRenewalHandler } from '../handlers/TriggerCertificateRenewalHandler.js';
import { DataTransferHandler } from '../handlers/DataTransferHandler.js';
import { StatusNotificationHandler } from '../handlers/StatusNotificationHandler.js';
import { MeterValuesHandler } from '../handlers/MeterValuesHandler.js';
import { SecurityEventHandler } from '../handlers/SecurityEventHandler.js';
import chalk from 'chalk';
import path from 'node:path';
import fs from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import {
  generateEcdsaP256KeyPair,
  buildCsr,
  exportPrivateKeyPkcs8Pem,
  exportPublicKeySpkiPem,
  resolveStationTemplate,
} from './provision.js';
import { persistBrokerArtifacts, loadBrokerArtifacts } from './artifacts.js';
import { parseUserVars } from './userVars.js';
import { deriveBays } from './connectBays.js';
import {
  bootstrapPool,
  teardownPool,
  PoolBootstrapError,
  serializePoolHandle,
  handleFromSerialized,
  type PoolBootstrapHandle,
  type SerializedPoolHandle,
} from '../scenarios/bootstrap/PoolBootstrap.js';
import { commitProvisioningKeySet } from '../provisioning/persistedKeySet.js';

const POOL_HANDLE_PATH = path.resolve('tests/artifacts/pool-handle.json');

const program = new Command();

program
  .name('simulator')
  .description('OSPP Station Simulator CLI')
  .version('0.6.3');

interface RunCommandOptions {
  scenario?: string;
  suite?: string;
  all?: boolean;
  parallel?: boolean;
  workers: string;
  target?: string;
  mqttUrl?: string;
  csmsUrl?: string;
  station?: string;
  orgId?: string;
  output: string;
  outputFile?: string;
  var: string[];
  bootstrapPool?: boolean;
  poolSize: string;
  poolBays: string;
  identityPoolSize?: string;
  offlineEnable?: boolean;
  keepPool?: boolean;
  keepCreated?: boolean;
}

program
  .command('run')
  .description('Run scenario(s) against a target CSMS')
  .option('--scenario <path>', 'Run a single scenario YAML file')
  .option('--suite <name>', 'Run all scenarios in scenarios/<name>/')
  .option('--all', 'Run all scenarios')
  .option('--parallel', 'Run scenarios in parallel')
  .option('--workers <n>', 'Max parallel workers', '5')
  .option('--target <name>', 'Target from config/targets.yaml (local, uat, sandbox)')
  .option('--mqtt-url <url>', 'Override MQTT URL')
  .option('--csms-url <url>', 'Override CSMS URL')
  .option('--station <stationId>', 'Force a specific stationId (overrides station_pool)')
  .option('--org-id <uuid>', 'Organization UUID for X-Organization-Id header (overrides auto-discovery)')
  .option('--bootstrap-pool', 'Provision a fresh per-run station pool (+ org/location + offline-enable) at suite start; tear it down at the end')
  .option('--pool-size <n>', 'Number of stations to provision when --bootstrap-pool is set', '5')
  .option('--identity-pool-size <n>', 'Number of per-scenario tenant_operator identities to mint (single-use FIFO; defaults to max(scenarioCount, --workers); startup-fails if explicitly set below scenarioCount)')
  .option('--pool-bays <n>', 'Bays per provisioned pool station', '4')
  .option('--no-offline-enable', 'Skip the privileged users.offline_enabled step during --bootstrap-pool')
  .option('--keep-pool', 'Do not tear down the bootstrapped pool on success; persist a handle for `teardown-pool` (debug/inspection)')
  .option('--keep-created', 'Do not tear down the org/location/station/user a self-provisioning scenario creates (`creates:` in its YAML); print the ids instead (debug/inspection)')
  .option('--output <format>', 'Output format: console, junit, json', 'console')
  .option('--output-file <path>', 'File path for junit/json output')
  .option(
    '--var <pair>',
    'Override scenario placeholder ({{KEY}}). Format: KEY=VALUE. Repeatable.',
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .action(async (opts: RunCommandOptions) => {
    let bootstrapHandle: PoolBootstrapHandle | undefined;
    let exitCode = 0;
    try {
      // 1. Load target config
      const target = await resolveTarget(opts);
      const runnerTarget = toRunnerTarget(target);
      if (opts.station) {
        runnerTarget.stationPool = [opts.station];
      }
      if (opts.orgId) {
        runnerTarget.orgId = opts.orgId;
      }

      // Parse --var KEY=VALUE pairs into a Map<string,string>.
      // Empty Map => undefined so downstream `if (userVars)` paths stay no-op
      // when the flag isn't used.
      const userVars = parseUserVars(opts.var ?? []);
      const userVarsArg = userVars.size > 0 ? userVars : undefined;

      const runner = new ScenarioRunner();
      runner.setKeepCreated(opts.keepCreated === true);
      const maxWorkers = parseInt(opts.workers, 10);

      // 2. Resolve the scenario set (discovery only — no mutation yet, so a
      //    misconfigured invocation fails before any UAT bootstrap happens).
      let scenarioPaths: string[];
      let singleScenario: ScenarioDefinition | undefined;
      if (opts.scenario) {
        const scenarioPath = path.resolve(opts.scenario);
        singleScenario = await runner.loadScenario(scenarioPath);
        scenarioPaths = [scenarioPath];
        console.log(chalk.blue(`Running scenario: ${singleScenario.name}`));
        console.log(chalk.blue(`  Target: ${opts.target ?? process.env['OSPP_TARGET'] ?? 'custom'}`));
        logUserVars(userVarsArg);
        console.log();
      } else if (opts.suite) {
        const suiteDir = path.resolve('scenarios', opts.suite);
        scenarioPaths = await discoverYamlFiles(suiteDir);
        if (scenarioPaths.length === 0) {
          throw new Error(`No scenarios found in suite: ${opts.suite}`);
        }
        console.log(chalk.blue(`Running ${scenarioPaths.length} scenario(s) from suite "${opts.suite}"...`));
        logRunConfig(opts);
        logUserVars(userVarsArg);
      } else if (opts.all) {
        const scenariosDir = path.resolve('scenarios');
        scenarioPaths = await discoverYamlFiles(scenariosDir);
        if (scenarioPaths.length === 0) {
          throw new Error('No scenarios found.');
        }
        console.log(chalk.blue(`Running ${scenarioPaths.length} scenario(s)...`));
        logRunConfig(opts);
        logUserVars(userVarsArg);
      } else {
        throw new Error('specify --scenario, --suite, or --all');
      }

      // 2b. Variable preflight — the answer to "can this scenario run at all?", asked
      //     BEFORE any bootstrap and therefore before any of the run's wall clock.
      //
      //     `multiunit-e2e/single-session-drive` requires `--var reason=<SessionEndReason>`;
      //     it is a parameterized harness meant to be swept once per reason, and its header
      //     says so at length. Nothing generates the variable, so an `--all` run spent eight
      //     minutes reaching step 9 and then threw `Template variable not found: reason`.
      //     Documented, known, and still a red line in every full run — which is the actual
      //     cost: a standing failure trains you to skim the failure list, and the one run
      //     where it means something looks exactly like the twenty where it did not.
      //
      //     WHY NOT a default value: the file exists to sweep the SessionEnded reasons, so a
      //     default would quietly pin one arm and report the sweep as done. The corpus already
      //     made this argument once — `generateVariables` deliberately names its generated id
      //     `runOfflineTxId` rather than `offlineTxId`, precisely so the offline-auth files
      //     keep throwing instead of running against a grant the server never issued.
      //
      //     WHY NOT only a per-file `skip_when_pooled`: that mechanism already exists and 8
      //     files use it — this one simply did not, which is how the hole opened. It is
      //     hand-maintained, and it fires only in pooled mode, so `--all --station X` would
      //     still fail at minute eight. Deriving the requirement from the file itself needs no
      //     declaration and cannot drift.
      //
      //     Explicit `--scenario` REFUSES rather than skips: naming a file and silently
      //     getting a skip answers a question the caller did not ask.
      const loadedScenarios: ScenarioDefinition[] = singleScenario
        ? [singleScenario]
        : await Promise.all(scenarioPaths.map(p => runner.loadScenario(p)));

      const unsatisfied = loadedScenarios
        .map(scenario => ({
          scenario,
          missing: unsatisfiedVariables(scenario, runnerTarget, userVarsArg),
        }))
        .filter(x => x.missing.length > 0);

      if (unsatisfied.length > 0 && singleScenario) {
        const { missing } = unsatisfied[0];
        const plural = missing.length > 1;
        throw new Error(
          `"${singleScenario.name}" needs ${plural ? 'variables' : 'a variable'} nothing ` +
          `generates: ${missing.join(', ')}. Substitution would throw at the step that uses ` +
          `${plural ? 'them' : 'it'}, so this is refused now rather than mid-run. Pass ` +
          `${missing.map(v => `--var ${v}=<value>`).join(' ')} — the scenario header states ` +
          `the accepted values.`,
        );
      }

      // Bulk selection: skip transparently, listed up front, still counted in the total.
      // A file already carrying a declaration that WILL fire keeps its own reason — it is
      // usually the richer one, and overwriting it would lose why the pool cannot host it.
      const preflightSkipped = unsatisfied.filter(({ scenario }) =>
        !scenario.skip && !(scenario.skip_when_pooled && opts.bootstrapPool));
      if (preflightSkipped.length > 0) {
        console.log(chalk.yellow(
          `Preflight: ${preflightSkipped.length} scenario(s) SKIPPED — required --var not supplied ` +
          `(they cannot run in this invocation; this is not a failure):`,
        ));
        for (const { scenario, missing } of preflightSkipped) {
          scenario.skip = true;
          scenario.skip_reason =
            `required --var not supplied: ${missing.join(', ')}. Nothing generates ` +
            `${missing.length > 1 ? 'these' : 'this'}; run the file directly with --scenario ` +
            `and --var to exercise it.`;
          console.log(chalk.yellow(`  - ${scenario.name} → ${missing.join(', ')}`));
        }
        console.log();
      }

      // 3. Per-run pool bootstrap (F-PROC-1). Runs after discovery and before
      //    the scenarios so a fresh pool + org/location + offline-enable exist,
      //    and is torn down in `finally` regardless of outcome.
      if (opts.bootstrapPool) {
        const poolSize = parseInt(opts.poolSize, 10);
        const bayCount = parseInt(opts.poolBays, 10);
        // Per-scenario identity pool: every scenario gets its OWN tenant_operator user
        // (single-use FIFO; never reused within a run). Default size is
        // max(scenarioCount, workers) so a run cannot deplete the pool by design — the
        // server-side session-mutate bucket (10/min/user) physically cannot be contested
        // across scenarios. If --identity-pool-size is explicitly set BELOW the scenario
        // count, we FAIL AT STARTUP rather than silently re-introduce identity sharing
        // (commit #3's surface bug — single-bucket bursts → 60s Retry-After → wait_for
        // timeouts). The contract is enforced here, not by honor system.
        const scenarioCount = scenarioPaths.length;
        const explicitIdentityPoolSize = opts.identityPoolSize !== undefined
          ? parseInt(opts.identityPoolSize, 10)
          : undefined;
        if (explicitIdentityPoolSize !== undefined && explicitIdentityPoolSize < scenarioCount) {
          throw new Error(
            `--identity-pool-size ${explicitIdentityPoolSize} < scenario count ${scenarioCount}. ` +
            `Per-scenario isolation guarantee broken (identities would be reused mid-run, ` +
            `re-introducing single-bucket bursts on the session-mutate rate limit). ` +
            `Raise --identity-pool-size to >= ${scenarioCount} or omit it to auto-size.`,
          );
        }
        const identityPoolSize = explicitIdentityPoolSize ?? Math.max(scenarioCount, maxWorkers);
        console.log(chalk.blue(
          `Bootstrapping per-run pool: ${poolSize} station(s), ${bayCount} bay(s) each, ` +
          `${identityPoolSize} identity(ies) (per-scenario, single-use), ` +
          `offline-enable=${opts.offlineEnable !== false}`,
        ));
        try {
          bootstrapHandle = await bootstrapPool(runnerTarget, {
            poolSize,
            bayCount,
            enableOffline: opts.offlineEnable !== false,
            identityPoolSize,
            orgId: runnerTarget.orgId,
          });
        } catch (err) {
          // Preserve the partial handle so `finally` can clean up what was made.
          if (err instanceof PoolBootstrapError) bootstrapHandle = err.handle;
          throw err;
        }
        runnerTarget.stationPool = bootstrapHandle.stationIds;
        runnerTarget.orgId = bootstrapHandle.orgId;
        runner.setRunPool(bootstrapHandle.pool);
        runner.setRunIdentities(bootstrapHandle.identityCredentials);
        console.log();
      }

      // 4. Run
      let results: ScenarioResult[];
      if (singleScenario) {
        results = [await runner.runScenario(singleScenario, runnerTarget, userVarsArg)];
      } else {
        // The preflight-annotated objects, NOT a fresh load — reloading would discard the
        // skip marks it just set and put the mid-run failures straight back.
        results = await runLoadedScenarios(runner, loadedScenarios, runnerTarget, opts.parallel ?? false, maxWorkers, userVarsArg);
      }

      // 5. Output results
      await outputResults(results, opts);

      if (results.some(r => r.status === 'failed')) {
        exitCode = 1;
      }
    } catch (err) {
      if (err instanceof PoolBootstrapError && !bootstrapHandle) {
        bootstrapHandle = err.handle;
      }
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(chalk.red(`Fatal error: ${error.message}`));
      exitCode = 1;
    } finally {
      // 6. Teardown — runs even on failure, BEFORE exit (process.exit is deferred
      //    so cleanup is never short-circuited). --keep-pool preserves a SUCCESSFUL
      //    run's pool for inspection (persisting a handle for `teardown-pool`); a
      //    failed run is always torn down regardless.
      if (bootstrapHandle) {
        if (opts.keepPool && exitCode === 0) {
          try {
            await fs.mkdir(path.dirname(POOL_HANDLE_PATH), { recursive: true });
            await fs.writeFile(
              POOL_HANDLE_PATH,
              JSON.stringify(serializePoolHandle(bootstrapHandle), null, 2),
            );
            console.log(chalk.yellow(
              `Pool KEPT (--keep-pool): ${bootstrapHandle.stationIds.length} station(s) under org ` +
              `${bootstrapHandle.orgId}.\n  Handle: ${POOL_HANDLE_PATH}\n  Tear down later with: simulator teardown-pool`,
            ));
          } catch (e) {
            console.error(chalk.yellow(`Could not persist pool handle: ${e instanceof Error ? e.message : String(e)}`));
          }
        } else {
          console.log(chalk.blue('Tearing down per-run pool...'));
          try {
            await teardownPool(bootstrapHandle);
            console.log(chalk.green('Pool teardown complete.'));
          } catch (e) {
            console.error(chalk.yellow(`Teardown warning: ${e instanceof Error ? e.message : String(e)}`));
          }
        }
      }
    }
    process.exit(exitCode);
  });

function logRunConfig(opts: RunCommandOptions): void {
  if (opts.parallel) {
    console.log(chalk.blue(`  Mode: parallel (max ${opts.workers} workers)`));
  }
  console.log(chalk.blue(`  Target: ${opts.target ?? process.env['OSPP_TARGET'] ?? 'custom'}`));
  console.log();
}

async function discoverYamlFiles(dir: string): Promise<string[]> {
  const results: string[] = [];

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await discoverYamlFiles(fullPath);
      results.push(...nested);
    } else if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
      results.push(fullPath);
    }
  }

  return results.sort();
}

async function runLoadedScenarios(
  runner: ScenarioRunner,
  scenarios: ScenarioDefinition[],
  target: RunnerTargetConfig,
  parallel: boolean,
  maxWorkers: number,
  userVars?: Map<string, string>,
): Promise<ScenarioResult[]> {
  if (parallel && maxWorkers > 1) {
    return runner.runParallel(scenarios, target, maxWorkers, userVars);
  }

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const result = await runner.runScenario(scenario, target, userVars);
    results.push(result);
  }
  return results;
}

function logUserVars(userVars: Map<string, string> | undefined): void {
  if (!userVars || userVars.size === 0) return;
  const summary = [...userVars.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  console.log(chalk.cyan(`  Overrides (${userVars.size}): ${summary}`));
}

function toRunnerTarget(target: TargetConfig): RunnerTargetConfig {
  const runnerTarget: RunnerTargetConfig = {
    mqttUrl: target.mqttUrl,
    apiBaseUrl: target.csmsUrl,
  };

  if (target.certs) {
    runnerTarget.tls = {
      key: target.certs.key,
      cert: target.certs.cert,
      keyPattern: target.certs.keyPattern,
      certPattern: target.certs.certPattern,
      chain: target.certs.stationCaChain,
      serverCa: target.certs.serverCa,
      minVersion: target.certs.minVersion,
      maxVersion: target.certs.maxVersion,
    };
  }

  if (target.mqttCredentials) {
    runnerTarget.mqttCredentials = {
      usernameTemplate: target.mqttCredentials.usernameTemplate,
      passwordTemplate: target.mqttCredentials.passwordTemplate,
    };
  }

  if (target.stationPool) {
    runnerTarget.stationPool = target.stationPool;
  }

  if (target.credentials) {
    runnerTarget.credentials = target.credentials;
  }

  return runnerTarget;
}

async function resolveTarget(opts: RunCommandOptions): Promise<TargetConfig> {
  // CLI overrides take precedence
  if (opts.mqttUrl || opts.csmsUrl) {
    return {
      mqttUrl: opts.mqttUrl ?? 'mqtt://localhost:1883',
      mqttTls: opts.mqttUrl?.startsWith('mqtts://') ?? false,
      csmsUrl: opts.csmsUrl ?? 'http://localhost:8080',
    };
  }

  // Named target from --target or OSPP_TARGET env var
  const targetName = opts.target ?? process.env['OSPP_TARGET'] ?? 'local';
  return loadTarget(targetName);
}

async function outputResults(results: ScenarioResult[], opts: RunCommandOptions): Promise<void> {
  switch (opts.output) {
    case 'junit': {
      const reporter = new JUnitReporter();
      if (opts.outputFile) {
        await reporter.writeToFile(results, opts.outputFile);
        console.log(chalk.green(`JUnit report written to ${opts.outputFile}`));
      } else {
        console.log(reporter.report(results));
      }
      break;
    }

    case 'json': {
      const reporter = new JsonReporter();
      if (opts.outputFile) {
        await reporter.writeToFile(results, opts.outputFile);
        console.log(chalk.green(`JSON report written to ${opts.outputFile}`));
      } else {
        console.log(reporter.report(results));
      }
      break;
    }

    case 'console':
    default:
      printConsoleReport(results);
      break;
  }
}

function printConsoleReport(results: ScenarioResult[]): void {
  for (const result of results) {
    const icon = result.status === 'passed'
      ? chalk.green('\u2713')
      : result.status === 'skipped'
        ? chalk.gray('\u2013')
        : chalk.red('\u2717');
    const name = result.status === 'passed'
      ? chalk.green(result.name)
      : result.status === 'skipped'
        ? chalk.gray(result.name)
        : chalk.red(result.name);
    const duration = chalk.gray(`(${result.durationMs}ms)`);

    console.log(`${icon} ${name} ${duration}`);

    for (const step of result.steps) {
      const stepLabel = `[${step.stepIndex}] ${step.action}`;
      const stepIcon = step.status === 'passed'
        ? chalk.green('  \u2713')
        : step.status === 'failed'
          ? chalk.red('  \u2717')
          : chalk.gray('  -');
      const stepDesc = step.status === 'failed'
        ? chalk.red(stepLabel)
        : step.status === 'skipped'
          ? chalk.gray(stepLabel)
          : stepLabel;
      const stepDuration = chalk.gray(`(${step.durationMs}ms)`);

      console.log(`${stepIcon} ${stepDesc} ${stepDuration}`);

      if (step.error) {
        console.log(chalk.red(`    Error: ${step.error}`));
      }
    }

    // A scenario can fail with NO failing step: anything that throws before the
    // step loop records a result (pre-step setup, pool/identity allocation, a
    // connect the scenario did not mark as expected-to-fail) lands only on
    // `result.error`. This block printed steps and nothing else, so those failures
    // rendered as a bare red name — no step, no reason. A scenario that fails
    // invisibly is worse than one that fails wrongly: the second is a wrong answer,
    // the first is no answer at all.
    if (result.status === 'failed' && result.error) {
      // `includes`, not equality: a step may wrap the same cause with context
      // (e.g. "template substitution failed: <cause>"), and printing both the
      // wrapped and bare form twice is noise, not detail.
      const alreadyOnAStep = result.steps.some(
        s => s.error !== undefined && s.error.includes(result.error as string),
      );
      if (!alreadyOnAStep) {
        console.log(chalk.red(`    Error: ${result.error}`));
      }
    }
    console.log();
  }

  // Summary
  const total = results.length;
  const passed = results.filter(r => r.status === 'passed').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0);

  console.log(chalk.bold('Summary:'));
  console.log(`  Total:    ${total}`);
  console.log(`  ${chalk.green(`Passed:   ${passed}`)}`);
  if (failed > 0) {
    console.log(`  ${chalk.red(`Failed:   ${failed}`)}`);
  }
  if (skipped > 0) {
    console.log(`  ${chalk.gray(`Skipped:  ${skipped}`)} (passed + failed + skipped = ${total})`);
  }
  console.log(`  Duration: ${totalDuration}ms`);
}

// ---------------------------------------------------------------------------
// teardown-pool command — tear down a pool kept by `run --keep-pool`
// ---------------------------------------------------------------------------

interface TeardownPoolOptions {
  handle: string;
}

program
  .command('teardown-pool')
  .description('Tear down a station pool previously kept by `run --keep-pool` (idempotent)')
  .option('--handle <path>', 'Path to the persisted pool handle JSON', POOL_HANDLE_PATH)
  .action(async (opts: TeardownPoolOptions) => {
    try {
      let raw: string;
      try {
        raw = await fs.readFile(opts.handle, 'utf-8');
      } catch {
        console.error(chalk.red(`No pool handle at ${opts.handle}. Nothing to tear down.`));
        process.exit(1);
        return;
      }
      const serialized = JSON.parse(raw) as SerializedPoolHandle;
      console.log(chalk.blue(
        `Tearing down ${serialized.stationIds?.length ?? 0} station(s) from ${opts.handle}...`,
      ));
      await teardownPool(handleFromSerialized(serialized));
      await fs.rm(opts.handle, { force: true });
      console.log(chalk.green('Pool teardown complete.'));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(chalk.red(`Fatal: ${error.message}`));
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// connect command
// ---------------------------------------------------------------------------

interface ConnectCommandOptions {
  target?: string;
  station?: string;
  var: string[];
}

program
  .command('connect')
  .description('Boot a station and keep it connected, responding to all commands')
  .option('--target <name>', 'Target from config/targets.yaml')
  .option('--station <stationId>', 'Station ID to connect as')
  .option(
    '--var <pair>',
    'Override deterministic IDs. Currently honored: bayId_<N>. Format: KEY=VALUE. Repeatable.',
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .action(async (opts: ConnectCommandOptions) => {
    try {
      const targetName = opts.target ?? process.env['OSPP_TARGET'] ?? 'local';
      const target = await loadTarget(targetName);

      const stationId = opts.station
        ?? target.stationPool?.[0]
        ?? generateStationId();

      console.log(chalk.blue(`Connecting station ${chalk.bold(stationId)} to ${targetName}...`));

      // Resolve MQTT credentials
      let mqttCredentials: { username: string; password: string } | undefined;
      if (target.mqttCredentials) {
        const stationIdHex = stationId.replace(/^stn_/, '');
        const resolveT = (t: string) => t.replace('{{stationIdHex}}', stationIdHex).replace('{{stationId}}', stationId);
        mqttCredentials = {
          username: resolveT(target.mqttCredentials.usernameTemplate),
          password: resolveT(target.mqttCredentials.passwordTemplate),
        };
      }

      // Resolve cert paths
      let tls: { key?: string; cert?: string; chain?: string; serverCa?: string } | undefined;
      if (target.certs) {
        const resolveP = (s: string | undefined) => s?.replace('{{stationId}}', stationId);
        tls = {
          key: resolveP(target.certs.keyPattern) ?? resolveP(target.certs.key),
          cert: resolveP(target.certs.certPattern) ?? resolveP(target.certs.cert),
          chain: resolveP(target.certs.stationCaChain),
          serverCa: resolveP(target.certs.serverCa),
        };
      }

      // Apply provisioning-response overrides (spec v0.3.0):
      //   <stationId>-broker-ca.pem → tls.serverCa (TLS trust anchor)
      //   <stationId>-mqtt.json     → effective mqttUrl (broker target)
      const persisted = await loadBrokerArtifacts(stationId, target.certs);
      const effectiveMqttUrl = persisted.brokerUri ?? target.mqttUrl;
      if (tls && persisted.brokerRootCaPath) {
        tls.serverCa = persisted.brokerRootCaPath;
        console.log(chalk.gray(`  Using persisted broker CA: ${persisted.brokerRootCaPath}`));
      }
      if (persisted.brokerUri) {
        console.log(chalk.gray(`  Using persisted broker URI: ${persisted.brokerUri}`));
      } else if (target.certs) {
        console.warn(chalk.yellow(
          `  No persisted mqttConfig for ${stationId}; falling back to targets.yaml mqtt_url (${target.mqttUrl})`,
        ));
      }

      // Build station config with deterministic IDs (overridable via --var bayId_<N>=<value>)
      const userVars = parseUserVars(opts.var ?? []);
      const userVarsArg = userVars.size > 0 ? userVars : undefined;
      const bayCount = 2;
      const { bays, warnings } = deriveBays(stationId, bayCount, userVars);
      for (const w of warnings) {
        console.warn(chalk.yellow(`  Warning: ${w}`));
      }
      logUserVars(userVarsArg);

      const station = new Station(
        {
          stationId,
          firmwareVersion: '1.0.0',
          stationModel: 'WashPro X200',
          stationVendor: 'SimCorp',
          serialNumber: generateSerialNumber(),
          bayCount,
          timezone: 'Europe/Bucharest',
          bays,
          behavior: {
            acceptRate: 1.0,
            responseDelayMs: [0, 0] as [number, number],
            heartbeatIntervalSec: 60,
            meterValuesIntervalSec: 30,
            autoRetryBoot: true,
          },
        },
        { mqttUrl: effectiveMqttUrl, stationId, tls, mqttCredentials },
      );

      // Register ALL handlers (cast needed: handlers use StationContext, registerHandler expects Station Handler)
      const reg = (a: typeof OsppAction[keyof typeof OsppAction], h: unknown) =>
        station.registerHandler(a, h as Handler);
      reg(OsppAction.BOOT_NOTIFICATION, new BootNotificationHandler());
      reg(OsppAction.HEARTBEAT, new HeartbeatHandler());
      reg(OsppAction.START_SERVICE, new StartServiceHandler());
      reg(OsppAction.STOP_SERVICE, new StopServiceHandler());
      reg(OsppAction.RESERVE_BAY, new ReserveBayHandler());
      reg(OsppAction.CANCEL_RESERVATION, new CancelReservationHandler());
      reg(OsppAction.GET_CONFIGURATION, new GetConfigurationHandler());
      reg(OsppAction.CHANGE_CONFIGURATION, new ChangeConfigurationHandler());
      reg(OsppAction.RESET, new ResetHandler());
      reg(OsppAction.UPDATE_FIRMWARE, new UpdateFirmwareHandler());
      reg(OsppAction.GET_DIAGNOSTICS, new GetDiagnosticsHandler());
      reg(OsppAction.SET_MAINTENANCE_MODE, new SetMaintenanceModeHandler());
      reg(OsppAction.UPDATE_SERVICE_CATALOG, new UpdateServiceCatalogHandler());
      reg(OsppAction.TRIGGER_MESSAGE, new TriggerMessageHandler());
      reg(OsppAction.CERTIFICATE_INSTALL, new CertificateInstallHandler());
      reg(OsppAction.TRIGGER_CERTIFICATE_RENEWAL, new TriggerCertificateRenewalHandler());
      reg(OsppAction.DATA_TRANSFER, new DataTransferHandler());
      reg(OsppAction.STATUS_NOTIFICATION, new StatusNotificationHandler());
      reg(OsppAction.METER_VALUES, new MeterValuesHandler());
      reg(OsppAction.SECURITY_EVENT, new SecurityEventHandler());

      // Connect + send initial BootNotification.
      // retryBoot() emits the BootNotification payload — name is historical
      // (also used by autoRetryBoot on Rejected/Pending); rename to publishBoot()
      // tracked as separate tech debt.
      await station.connect();
      await station.retryBoot();
      console.log(chalk.green(`\nStation ${stationId} connected. BootNotification sent.\n`));
      console.log(chalk.bold('Station IDs:'));
      console.log(`  stationId:  ${stationId}`);
      for (const bay of bays) {
        console.log(`  bay ${bay.bayNumber}:      ${bay.bayId}  (service: ${bay.services[0].serviceId})`);
      }
      console.log();

      // The post-boot StatusNotification per bay is BootNotificationHandler's job
      // (autoReact, on `Accepted`) and is not repeated here.
      //
      // This used to carry a second, corrective publish: wait for bootAccepted,
      // force each bay to Available locally, then re-report it. That existed
      // because boot left bays at `Unknown`, so the handler's own report put a
      // non-conforming value on the wire and the CSMS held the bay at unknown,
      // where GET /pay/{bay} refuses the customer with bay_unavailable. It patched
      // the symptom from outside and left two publishers racing over one bay.
      //
      // Bays now construct Available, so the handler's single report is correct on
      // its own. The second mechanism goes, and the race with it — and it could
      // not have stayed regardless: `setBayState(bay, AVAILABLE)` on an
      // already-Available bay is an Available -> Available transition, which is
      // not in the table and throws.
      console.log(chalk.gray('  StatusNotification per bay sent on boot acceptance.'));
      console.log(chalk.gray('Press Ctrl+C to disconnect.\n'));

      // Keep alive — wait for SIGINT
      await new Promise<void>((resolve) => {
        process.on('SIGINT', () => {
          console.log(chalk.yellow('\nDisconnecting...'));
          station.disconnect().then(resolve).catch(resolve);
        });
      });

      console.log(chalk.green('Disconnected.'));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(chalk.red(`Fatal: ${error.message}`));
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// provision command
// ---------------------------------------------------------------------------

interface ProvisionCommandOptions {
  target: string;
  token: string;
  serialNumber?: string;
  bayCount: string; // Commander returns string for option values
}

// F-05: FLAT normative provisioning body — no `data` envelope
// (provisioning-response.schema.json describes these fields at the top level).
interface ProvisioningResponse {
  clientCert: string;
  stationCaChain: string;
  brokerRootCa?: string;
  rootCaThumbprint: string;
  /**
   * v0.11.0: server-assigned bay identifiers, each paired EXPLICITLY with the
   * bayNumber the station declared for it. `bayIds[]` is gone — it was a
   * positional array, and provisioning-response.schema.json:21 says why the pair
   * replaced it: "This is the mapping the station needs and the only one it is
   * given." A declaration of {1,3} used to come back as a two-element array the
   * station had to re-index by position, which silently mapped bay 3 to slot 2.
   */
  bays?: Array<{ bayId: string; bayNumber: number }>;
  serverVerifyKey?: string;
  mqttConfig?: { brokerUri?: string; [key: string]: unknown };
}

program
  .command('provision <stationId>')
  .description('Provision an mTLS certificate via OSPP spec §2 (POST /api/v1/stations/provision)')
  .requiredOption('-t, --target <name>', 'target environment')
  .requiredOption('--token <provisioningToken>', 'single-use provisioning token from CSMS admin')
  .requiredOption('--bay-count <n>', 'declared bay count; must match the station registration')
  .option('--serial-number <s>', 'station serial number')
  .action(async (stationId: string, opts: ProvisionCommandOptions) => {
    try {
      const target = await loadTarget(opts.target);

      if (!target.certs?.key || !target.certs.cert || !target.certs.stationCaChain) {
        throw new Error(
          `Target "${opts.target}" is missing certs.key, certs.cert, or certs.station_ca_chain in config/targets.yaml`,
        );
      }

      const bayCount = Number.parseInt(opts.bayCount, 10);
      if (!Number.isFinite(bayCount) || bayCount < 1) {
        throw new Error(`--bay-count must be a positive integer, got "${opts.bayCount}"`);
      }

      const url = `${target.csmsUrl}/api/v1/stations/provision`;
      console.log(chalk.blue(`Provisioning station ${chalk.bold(stationId)} via ${url}...`));

      const keyPath = resolveStationTemplate(target.certs.key, stationId);
      const certPath = resolveStationTemplate(target.certs.cert, stationId);
      const chainPath = resolveStationTemplate(target.certs.stationCaChain, stationId);
      // Receipt-signing artifacts live alongside the TLS material in
      // certs/<env>/<stationId>-receipt-{key,pub}.pem so a future
      // "send signed receipt" command can find them by stationId convention.
      const receiptKeyPath = keyPath.replace(/-key\.pem$/, '-receipt-key.pem');
      const receiptPubPath = keyPath.replace(/-key\.pem$/, '-receipt-pub.pem');

      // TLS + receipt keypairs (separate keys per OSPP spec §4.3), COMMITTED
      // DURABLY BEFORE THE POST — spec/04-flows.md:253 step 6b, "Before step 7
      // leaves the device, the SSP MUST commit every private key generated in
      // steps 5-6a to non-volatile storage, durably". This used to generate here
      // and write after the response: kill the process in between and the server
      // held a cert bound to keys this process no longer had, so the retry on the
      // same token was answered 4015, which is recoverable:false.
      const keySet = await commitProvisioningKeySet(path.dirname(keyPath), stationId, {
        tlsKeyPath: keyPath,
        receiptKeyPath,
        receiptPubPath,
      });
      const csrPem = keySet.csrPem;
      const receiptSigningPublicKeyPem = keySet.receiptPubPem;

      // v0.11.0: the station DECLARES its topology here — bays, and the
      // programs each one physically has. provisioning-request.schema.json:8
      // makes `bays` required and `bayCount` is gone. §01-architecture.md:238:
      // this is the declaration that carries LABELS, because "this is the moment
      // the server creates the bay records and the moment an operator needs the
      // labels to build the service bindings".
      //
      // Derived from the same deriveBays() the connect path uses, so what the
      // station declares at provisioning is what it re-declares at boot. Deriving
      // them separately is how a station ends up disagreeing with itself.
      const { bays: declaredBays } = deriveBays(stationId, bayCount, new Map());

      const body = {
        provisioningToken: opts.token,
        serialNumber: opts.serialNumber ?? `SIM-${Date.now()}`,
        bays: declaredBays.map(b => ({
          bayNumber: b.bayNumber,
          programs: b.programs.map(p => ({
            programNumber: p.programNumber,
            label: p.label,
          })),
        })),
        tlsCsr: csrPem,
        receiptSigningPublicKey: receiptSigningPublicKeyPem,
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Provisioning failed: ${res.status} ${errText}`);
      }

      const data = (await res.json()) as ProvisioningResponse;

      // The private keys are already on disk and flushed; only the RESPONSE is
      // written here.
      await fs.mkdir(path.dirname(certPath), { recursive: true });
      await fs.mkdir(path.dirname(chainPath), { recursive: true });

      await fs.writeFile(certPath, data.clientCert);
      await fs.writeFile(chainPath, data.stationCaChain);

      // Persist bays.json so `simulator run --station <id>` can hydrate the
      // {{ provisioning.bayIds[N] }} template namespace from disk (V4
      // Finding #1 mitigation — no CLI --var override required).
      let baysJsonPath: string | undefined;
      if (data.bays && data.bays.length > 0) {
        baysJsonPath = path.join(
          path.dirname(keyPath),
          `${stationId}-bays.json`,
        );
        // The pairs are written verbatim; `bayIds` stays a 0-indexed array for the
        // {{ provisioning.bayIds[N] }} template namespace, sorted by bayNumber so
        // its order is the station's declaration rather than whatever order the
        // server answered in.
        const ordered = [...data.bays].sort((a, b) => a.bayNumber - b.bayNumber);
        await fs.writeFile(
          baysJsonPath,
          JSON.stringify(
            { stationId, bays: ordered, bayIds: ordered.map(p => p.bayId) },
            null,
            2,
          ),
        );
      }

      const persistedArtifacts = await persistBrokerArtifacts(keyPath, data);

      const cert = new X509Certificate(data.clientCert);

      console.log(chalk.green(`\nStation provisioned: ${chalk.bold(stationId)}`));
      console.log(`  Serial:           ${cert.serialNumber}`);
      console.log(`  Issuer:           ${cert.issuer.replace(/\n/g, ', ')}`);
      console.log(`  Valid from:       ${cert.validFrom}`);
      console.log(`  Valid to:         ${cert.validTo}`);
      console.log(`  TLS key:          ${keyPath}`);
      console.log(`  TLS cert:         ${certPath}`);
      console.log(`  CA chain:         ${chainPath}`);
      console.log(`  Receipt key:      ${receiptKeyPath}`);
      console.log(`  Receipt pub:      ${receiptPubPath}`);
      console.log(`  Root CA SHA256:   ${data.rootCaThumbprint}`);
      if (persistedArtifacts.brokerCaPath) {
        console.log(`  Broker CA:        ${persistedArtifacts.brokerCaPath}`);
      }
      if (persistedArtifacts.mqttJsonPath) {
        console.log(`  MQTT config:      ${persistedArtifacts.mqttJsonPath}`);
      }
      if (data.bays && data.bays.length > 0) {
        const pairs = data.bays.map(b => `${b.bayNumber}=${b.bayId}`).join(', ');
        console.log(`  Bays (${data.bays.length}):        ${pairs}`);
      }
      if (baysJsonPath) {
        console.log(`  Bays JSON:        ${baysJsonPath}`);
      }
      if (data.mqttConfig && typeof data.mqttConfig.brokerUri === 'string') {
        console.log(`  MQTT broker:      ${data.mqttConfig.brokerUri}`);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(chalk.red(`Fatal: ${error.message}`));
      process.exit(1);
    }
  });

program.parse();
