import { parse as parseYaml } from 'yaml';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { StepDefinition } from './steps/Step.js';
import type { StepResult } from './ScenarioContext.js';
import { createContext } from './ScenarioContext.js';
import { Station } from '../station/Station.js';
import {
  generateStationId,
  generateSerialNumber,
  generateBayId,
  generateServiceId,
} from '../station/StationConfig.js';
import type { StationConfig, BayConfig } from '../station/StationConfig.js';
import { SendStep } from './steps/SendStep.js';
import { WaitForStep } from './steps/WaitForStep.js';
import { AssertStep } from './steps/AssertStep.js';
import { ApiCallStep } from './steps/ApiCallStep.js';
import { DelayStep } from './steps/DelayStep.js';
import { FaultStep } from './steps/FaultStep.js';
import { ProvisionStep } from './steps/ProvisionStep.js';
import { ConnectMqttStep } from './steps/ConnectMqttStep.js';
import type { Step } from './steps/Step.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScenarioDefinition {
  name: string;
  target_url?: string;
  skip?: boolean;
  skip_reason?: string;
  /**
   * When true, the runner skips the automatic `station.connect()` call so
   * that scenarios can run pre-provisioning API steps (signup, org, station
   * register, provisioning-token) before the station has TLS material. The
   * scenario MUST include a `connect_mqtt` step once provisioning artifacts
   * exist on disk.
   */
  defer_mqtt_connect?: boolean;
  station: {
    stationId?: string;
    bayCount: number;
    behavior?: {
      accept_rate?: number;
      response_delay_ms?: [number, number];
    };
  };
  steps: StepDefinition[];
}

export interface TargetConfig {
  mqttUrl: string;
  apiBaseUrl?: string;
  tls?: {
    key?: string;
    cert?: string;
    keyPattern?: string;
    certPattern?: string;
    serverCa?: string;
  };
  mqttCredentials?: {
    usernameTemplate: string;
    passwordTemplate: string;
  };
  stationPool?: string[];
  credentials?: {
    email: string;
    password: string;
  };
}

export interface RunOptions {
  maxWorkers?: number;
  cooldownMs?: number;
  filter?: string;
}

export interface ScenarioResult {
  name: string;
  status: 'passed' | 'failed';
  durationMs: number;
  steps: StepResult[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Step registry
// ---------------------------------------------------------------------------

const STEP_REGISTRY: ReadonlyMap<string, Step> = new Map<string, Step>([
  ['send', new SendStep()],
  ['wait_for', new WaitForStep()],
  ['assert', new AssertStep()],
  ['api_call', new ApiCallStep()],
  ['delay', new DelayStep()],
  ['fault', new FaultStep()],
  ['provision', new ProvisionStep()],
  ['connect_mqtt', new ConnectMqttStep()],
]);

// ---------------------------------------------------------------------------
// Semaphore for parallel execution
// ---------------------------------------------------------------------------

class Semaphore {
  private count: number;
  private readonly waiting: Array<() => void> = [];

  constructor(count: number) {
    this.count = count;
  }

  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
      return;
    }
    return new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    if (this.waiting.length > 0) {
      this.waiting.shift()!();
    } else {
      this.count++;
    }
  }
}

// ---------------------------------------------------------------------------
// Template substitution
// ---------------------------------------------------------------------------

function substituteTemplateValue(
  value: string,
  variables: Map<string, string>,
  captured: Map<string, unknown>,
): string {
  return value.replace(/\{\{([^}]+)\}\}/g, (_match, varName: string) => {
    const trimmed = varName.trim();
    if (trimmed.startsWith('captured.')) {
      const captureKey = trimmed.slice('captured.'.length);
      const capturedVal = captured.get(captureKey);
      if (capturedVal === undefined) {
        throw new Error(`Captured variable not found: ${captureKey}`);
      }
      return String(capturedVal);
    }
    const variable = variables.get(trimmed);
    if (variable === undefined) {
      throw new Error(`Template variable not found: ${trimmed}`);
    }
    return variable;
  });
}

function substituteTemplates(
  value: unknown,
  variables: Map<string, string>,
  captured: Map<string, unknown>,
): unknown {
  if (typeof value === 'string') {
    return substituteTemplateValue(value, variables, captured);
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteTemplates(item, variables, captured));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = substituteTemplates(val, variables, captured);
    }
    return result;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Variable generation
// ---------------------------------------------------------------------------

function generateVariables(
  scenarioDef: ScenarioDefinition,
  target: TargetConfig,
  poolStationId?: string | null,
): Map<string, string> {
  const vars = new Map<string, string>();

  const stationId = poolStationId ?? scenarioDef.station.stationId ?? generateStationId();
  vars.set('stationId', stationId);
  vars.set('serialNumber', generateSerialNumber());
  vars.set('target_url', target.apiBaseUrl ?? target.mqttUrl);

  const bayCount = scenarioDef.station.bayCount;
  for (let i = 1; i <= bayCount; i++) {
    vars.set(`bayId_${i}`, generateBayId());
  }

  // Generate default service IDs unique per scenario run. csms-server
  // has UNIQUE(service_id) globally (services table migration, line 15),
  // so reusing svc_wash_basic across runs collides. We suffix each with
  // the station's hex tail to guarantee uniqueness while staying within
  // the 64-char VARCHAR limit and the /^svc_[a-zA-Z0-9_]+$/ regex.
  const stationIdHex = stationId.replace(/^stn_/, '');
  const defaultServices = ['wash_basic', 'wash_premium', 'dry', 'vacuum'];
  for (let i = 0; i < defaultServices.length; i++) {
    vars.set(
      `serviceId_${i + 1}`,
      generateServiceId(`${defaultServices[i]}_${stationIdHex}`),
    );
  }

  return vars;
}

// ---------------------------------------------------------------------------
// Station factory
// ---------------------------------------------------------------------------

function createStationFromScenario(
  scenarioDef: ScenarioDefinition,
  variables: Map<string, string>,
  target: TargetConfig,
): Station {
  const stationId = variables.get('stationId')!;
  const bayCount = scenarioDef.station.bayCount;

  const bays: BayConfig[] = [];
  for (let i = 1; i <= bayCount; i++) {
    const bayId = variables.get(`bayId_${i}`)!;
    bays.push({
      bayId,
      bayNumber: i,
      services: [
        {
          serviceId: variables.get('serviceId_1') ?? generateServiceId('wash_basic'),
          serviceName: 'Basic Wash',
          available: true,
        },
      ],
    });
  }

  const behavior = scenarioDef.station.behavior;

  const config: StationConfig = {
    stationId,
    firmwareVersion: '1.0.0',
    stationModel: 'SimulatorModel',
    stationVendor: 'OSPP',
    serialNumber: variables.get('serialNumber')!,
    bayCount,
    timezone: 'UTC',
    bays,
    behavior: {
      acceptRate: behavior?.accept_rate ?? 1.0,
      responseDelayMs: behavior?.response_delay_ms ?? [0, 0],
      heartbeatIntervalSec: 60,
      meterValuesIntervalSec: 30,
      autoRetryBoot: (behavior as Record<string, unknown> | undefined)?.auto_retry_boot !== false,
      autoBoot: (behavior as Record<string, unknown> | undefined)?.auto_boot !== false,
    },
  };

  // Resolve MQTT credentials with template substitution
  let mqttCredentials: { username: string; password: string } | undefined;
  if (target.mqttCredentials) {
    const stationIdHex = stationId.replace(/^stn_/, '');
    const resolveTemplate = (tpl: string): string =>
      tpl.replace('{{stationIdHex}}', stationIdHex).replace('{{stationId}}', stationId);
    const username = resolveTemplate(target.mqttCredentials.usernameTemplate);
    const password = resolveTemplate(target.mqttCredentials.passwordTemplate);
    mqttCredentials = { username, password };
  }

  // Resolve {{stationId}} in all cert path fields
  let tls = target.tls;
  if (tls) {
    const resolve = (s: string | undefined) =>
      s?.replace('{{stationId}}', stationId);
    tls = {
      key: resolve(tls.keyPattern) ?? resolve(tls.key),
      cert: resolve(tls.certPattern) ?? resolve(tls.cert),
      serverCa: resolve(tls.serverCa),
    };
  }

  return new Station(config, {
    mqttUrl: target.mqttUrl,
    stationId,
    tls,
    mqttCredentials,
    cleanSession: !config.behavior.autoBoot,
  });
}

// ---------------------------------------------------------------------------
// ScenarioRunner
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Station pool allocator — picks stationIds from pool for sandbox targets
// ---------------------------------------------------------------------------

class StationPoolAllocator {
  private readonly pool: string[];
  private readonly inUse: Set<string> = new Set();
  private nextIndex = 0;
  private readonly waiting: Array<(stationId: string) => void> = [];

  constructor(pool: string[]) {
    this.pool = pool;
  }

  async acquire(): Promise<string> {
    // Find the next available stationId
    for (let attempts = 0; attempts < this.pool.length; attempts++) {
      const id = this.pool[this.nextIndex % this.pool.length];
      this.nextIndex++;
      if (!this.inUse.has(id)) {
        this.inUse.add(id);
        return id;
      }
    }
    // All in use — wait for one to be released
    return new Promise<string>((resolve) => this.waiting.push(resolve));
  }

  release(stationId: string): void {
    this.inUse.delete(stationId);
    if (this.waiting.length > 0) {
      this.inUse.add(stationId);
      this.waiting.shift()!(stationId);
    }
  }
}

export class ScenarioRunner {
  private poolAllocator: StationPoolAllocator | null = null;

  async loadScenario(filePath: string): Promise<ScenarioDefinition> {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = parseYaml(content) as ScenarioDefinition;

    if (!parsed.name) {
      throw new Error(`Scenario at ${filePath} is missing a "name" field`);
    }
    if (!parsed.station) {
      throw new Error(`Scenario at ${filePath} is missing a "station" field`);
    }
    if (!Array.isArray(parsed.steps)) {
      throw new Error(`Scenario at ${filePath} is missing a "steps" array`);
    }

    return parsed;
  }

  async runScenario(
    scenario: ScenarioDefinition,
    target: TargetConfig,
  ): Promise<ScenarioResult> {
    if (scenario.skip) {
      console.log('[ScenarioRunner] Skipping "%s": %s', scenario.name, scenario.skip_reason ?? 'marked as skip');
      return {
        name: scenario.name,
        status: 'passed',
        durationMs: 0,
        steps: [{ stepIndex: -1, action: 'skip', status: 'skipped', durationMs: 0, error: scenario.skip_reason }],
      };
    }

    const context = createContext();

    // Lazy-init pool allocator for single-scenario runs (runAll does it in bulk)
    if (!this.poolAllocator && target.stationPool?.length) {
      this.poolAllocator = new StationPoolAllocator(target.stationPool);
    }

    // Allocate stationId from pool if available (skip if YAML hardcodes one)
    const hardcodedStationId = scenario.station.stationId &&
      !scenario.station.stationId.includes('{{');
    let poolStationId: string | null = null;
    if (this.poolAllocator && !hardcodedStationId) {
      poolStationId = await this.poolAllocator.acquire();
    }

    const variables = generateVariables(scenario, target, poolStationId);
    context.variables = variables;
    context.apiBaseUrl = target.apiBaseUrl;
    context.apiCredentials = target.credentials;

    const station = createStationFromScenario(scenario, variables, target);
    const startTime = Date.now();

    try {
      if (!scenario.defer_mqtt_connect) {
        await station.connect();
      }

      for (let i = 0; i < scenario.steps.length; i++) {
        const rawStep = scenario.steps[i];
        const stepStart = Date.now();

        // Apply template substitution to the entire step definition
        const substitutedStep = substituteTemplates(
          rawStep,
          context.variables,
          context.captured,
        ) as StepDefinition;

        const stepImpl = STEP_REGISTRY.get(substitutedStep.action);
        if (!stepImpl) {
          const result: StepResult = {
            stepIndex: i,
            action: substitutedStep.action,
            status: 'failed',
            durationMs: Date.now() - stepStart,
            error: `Unknown step action: ${substitutedStep.action}`,
          };
          context.stepResults.push(result);
          throw new Error(result.error);
        }

        try {
          await stepImpl.execute(substitutedStep, context, station);
          context.stepResults.push({
            stepIndex: i,
            action: substitutedStep.action,
            status: 'passed',
            durationMs: Date.now() - stepStart,
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          context.stepResults.push({
            stepIndex: i,
            action: substitutedStep.action,
            status: 'failed',
            durationMs: Date.now() - stepStart,
            error: errorMsg,
          });
          throw err;
        }
      }

      return {
        name: scenario.name,
        status: 'passed',
        durationMs: Date.now() - startTime,
        steps: context.stepResults,
      };
    } catch (err) {
      return {
        name: scenario.name,
        status: 'failed',
        durationMs: Date.now() - startTime,
        steps: context.stepResults,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      try {
        await station.disconnect();
      } catch {
        // Best-effort disconnect
      }
      if (poolStationId && this.poolAllocator) {
        this.poolAllocator.release(poolStationId);
      }
    }
  }

  async runAll(
    scenarioDir: string,
    target: TargetConfig,
    options: RunOptions = {},
  ): Promise<ScenarioResult[]> {
    const entries = await fs.readdir(scenarioDir, { withFileTypes: true });
    const yamlFiles = entries
      .filter(
        (e) =>
          e.isFile() &&
          (e.name.endsWith('.yaml') || e.name.endsWith('.yml')),
      )
      .map((e) => path.join(scenarioDir, e.name))
      .sort();

    const scenarios: ScenarioDefinition[] = [];
    for (const file of yamlFiles) {
      const scenario = await this.loadScenario(file);

      if (options.filter && !scenario.name.includes(options.filter)) {
        continue;
      }

      scenarios.push(scenario);
    }

    // Initialize pool allocator if target has station_pool
    if (target.stationPool && target.stationPool.length > 0) {
      this.poolAllocator = new StationPoolAllocator(target.stationPool);
    } else {
      this.poolAllocator = null;
    }

    if (options.maxWorkers && options.maxWorkers > 1) {
      return this.runParallel(scenarios, target, options.maxWorkers);
    }

    const cooldownMs = options.cooldownMs ?? 3000;
    const results: ScenarioResult[] = [];
    for (let i = 0; i < scenarios.length; i++) {
      if (i > 0 && cooldownMs > 0) {
        await new Promise<void>(r => setTimeout(r, cooldownMs));
      }
      const result = await this.runScenario(scenarios[i], target);
      results.push(result);
    }
    return results;
  }

  async runParallel(
    scenarios: ScenarioDefinition[],
    target: TargetConfig,
    maxWorkers: number,
  ): Promise<ScenarioResult[]> {
    const semaphore = new Semaphore(maxWorkers);

    const tasks = scenarios.map(async (scenario) => {
      await semaphore.acquire();
      try {
        return await this.runScenario(scenario, target);
      } finally {
        semaphore.release();
      }
    });

    return Promise.all(tasks);
  }
}
