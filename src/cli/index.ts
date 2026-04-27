#!/usr/bin/env node

import { Command } from 'commander';
import {
  ScenarioRunner,
  type TargetConfig as RunnerTargetConfig,
  type ScenarioResult,
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

const program = new Command();

program
  .name('simulator')
  .description('OSPP Station Simulator CLI')
  .version('0.1.0');

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
  output: string;
  outputFile?: string;
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
  .option('--output <format>', 'Output format: console, junit, json', 'console')
  .option('--output-file <path>', 'File path for junit/json output')
  .action(async (opts: RunCommandOptions) => {
    try {
      // 1. Load target config
      const target = await resolveTarget(opts);
      const runnerTarget = toRunnerTarget(target);
      if (opts.station) {
        runnerTarget.stationPool = [opts.station];
      }

      // 2. Discover and run scenarios
      const runner = new ScenarioRunner();
      const maxWorkers = parseInt(opts.workers, 10);
      let results: ScenarioResult[];

      if (opts.scenario) {
        // Single scenario
        const scenarioPath = path.resolve(opts.scenario);
        const scenario = await runner.loadScenario(scenarioPath);

        console.log(chalk.blue(`Running scenario: ${scenario.name}`));
        console.log(chalk.blue(`  Target: ${opts.target ?? process.env['OSPP_TARGET'] ?? 'custom'}`));
        console.log();

        const result = await runner.runScenario(scenario, runnerTarget);
        results = [result];
      } else if (opts.suite) {
        // Suite — run all in scenarios/<name>/
        const suiteDir = path.resolve('scenarios', opts.suite);
        const scenarioPaths = await discoverYamlFiles(suiteDir);

        if (scenarioPaths.length === 0) {
          console.error(chalk.yellow(`No scenarios found in suite: ${opts.suite}`));
          process.exit(1);
        }

        console.log(chalk.blue(`Running ${scenarioPaths.length} scenario(s) from suite "${opts.suite}"...`));
        logRunConfig(opts);

        results = await runScenarioPaths(runner, scenarioPaths, runnerTarget, opts.parallel ?? false, maxWorkers);
      } else if (opts.all) {
        // All — run everything in scenarios/
        const scenariosDir = path.resolve('scenarios');
        const scenarioPaths = await discoverYamlFiles(scenariosDir);

        if (scenarioPaths.length === 0) {
          console.error(chalk.yellow('No scenarios found.'));
          process.exit(1);
        }

        console.log(chalk.blue(`Running ${scenarioPaths.length} scenario(s)...`));
        logRunConfig(opts);

        results = await runScenarioPaths(runner, scenarioPaths, runnerTarget, opts.parallel ?? false, maxWorkers);
      } else {
        console.error(chalk.red('Error: specify --scenario, --suite, or --all'));
        process.exit(1);
      }

      // 4. Output results
      await outputResults(results, opts);

      // 5. Exit with code 1 if any scenario failed
      const hasFailed = results.some(r => r.status === 'failed');
      if (hasFailed) {
        process.exit(1);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(chalk.red(`Fatal error: ${error.message}`));
      process.exit(1);
    }
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

async function runScenarioPaths(
  runner: ScenarioRunner,
  scenarioPaths: string[],
  target: RunnerTargetConfig,
  parallel: boolean,
  maxWorkers: number,
): Promise<ScenarioResult[]> {
  const scenarios = await Promise.all(
    scenarioPaths.map(p => runner.loadScenario(p)),
  );

  if (parallel && maxWorkers > 1) {
    return runner.runParallel(scenarios, target, maxWorkers);
  }

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const result = await runner.runScenario(scenario, target);
    results.push(result);
  }
  return results;
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
      serverCa: target.certs.serverCa,
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
    const icon = result.status === 'passed' ? chalk.green('\u2713') : chalk.red('\u2717');
    const name = result.status === 'passed'
      ? chalk.green(result.name)
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
    console.log();
  }

  // Summary
  const total = results.length;
  const passed = results.filter(r => r.status === 'passed').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0);

  console.log(chalk.bold('Summary:'));
  console.log(`  Total:    ${total}`);
  console.log(`  ${chalk.green(`Passed:   ${passed}`)}`);
  if (failed > 0) {
    console.log(`  ${chalk.red(`Failed:   ${failed}`)}`);
  }
  console.log(`  Duration: ${totalDuration}ms`);
}

// ---------------------------------------------------------------------------
// connect command
// ---------------------------------------------------------------------------

interface ConnectCommandOptions {
  target?: string;
  station?: string;
}

program
  .command('connect')
  .description('Boot a station and keep it connected, responding to all commands')
  .option('--target <name>', 'Target from config/targets.yaml')
  .option('--station <stationId>', 'Station ID to connect as')
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
      let tls: { key?: string; cert?: string; serverCa?: string } | undefined;
      if (target.certs) {
        const resolveP = (s: string | undefined) => s?.replace('{{stationId}}', stationId);
        tls = {
          key: resolveP(target.certs.keyPattern) ?? resolveP(target.certs.key),
          cert: resolveP(target.certs.certPattern) ?? resolveP(target.certs.cert),
          serverCa: resolveP(target.certs.serverCa),
        };
      }

      // Build station config with deterministic IDs
      const bayCount = 2;
      const stationHex = stationId.replace(/^stn_/, '');
      const bays = [];
      for (let i = 1; i <= bayCount; i++) {
        bays.push({
          bayId: `bay_${stationHex}${String(i).padStart(2, '0')}`,
          bayNumber: i,
          services: [{ serviceId: 'svc_wash_basic', serviceName: 'Basic Wash', available: true }],
        });
      }

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
            autoBoot: true,
          },
        },
        { mqttUrl: target.mqttUrl, stationId, tls, mqttCredentials },
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

      // Connect
      await station.connect();
      console.log(chalk.green(`\nStation ${stationId} connected and booted.\n`));
      console.log(chalk.bold('Station IDs:'));
      console.log(`  stationId:  ${stationId}`);
      for (const bay of bays) {
        console.log(`  bay ${bay.bayNumber}:      ${bay.bayId}  (service: ${bay.services[0].serviceId})`);
      }
      console.log();
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

program.parse();
