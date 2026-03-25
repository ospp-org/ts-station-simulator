import { parse as parseYaml } from 'yaml';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { LintIssue, LintCheck, ParsedScenario } from './types.js';
import { CapturedVarsCheck } from './checks/CapturedVarsCheck.js';
import { MessageDirectionCheck } from './checks/MessageDirectionCheck.js';
import { EnumValuesCheck } from './checks/EnumValuesCheck.js';
import { WaitForCompletenessCheck } from './checks/WaitForCompletenessCheck.js';
import { PayloadSchemaCheck } from './checks/PayloadSchemaCheck.js';

export class ScenarioLinter {
  private checks: LintCheck[];

  constructor() {
    this.checks = [
      new CapturedVarsCheck(),
      new MessageDirectionCheck(),
      new EnumValuesCheck(),
      new WaitForCompletenessCheck(),
      new PayloadSchemaCheck(),
    ];
  }

  async lintFile(filePath: string): Promise<LintIssue[]> {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = parseYaml(content) as { name?: string; steps?: unknown[] };

    if (!parsed || !Array.isArray(parsed.steps)) {
      return [{
        file: filePath,
        step: -1,
        stepAction: '',
        message: 'Invalid scenario: missing or non-array "steps" field',
      }];
    }

    const scenario: ParsedScenario = {
      filePath,
      name: parsed.name ?? path.basename(filePath),
      steps: parsed.steps as Record<string, unknown>[],
    };

    const issues: LintIssue[] = [];
    for (const check of this.checks) {
      issues.push(...check.check(scenario));
    }

    return issues;
  }

  async lintDirectory(dirPath: string): Promise<Map<string, LintIssue[]>> {
    const results = new Map<string, LintIssue[]>();
    const files = await discoverYamlFiles(dirPath);

    for (const file of files) {
      const issues = await this.lintFile(file);
      results.set(file, issues);
    }

    return results;
  }
}

async function discoverYamlFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await discoverYamlFiles(fullPath));
    } else if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
      results.push(fullPath);
    }
  }

  return results.sort();
}
