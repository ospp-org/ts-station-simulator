import fs from 'node:fs/promises';
import type { ScenarioResult } from '../scenarios/ScenarioRunner.js';

export class JsonReporter {
  report(results: ScenarioResult[]): string {
    return JSON.stringify({
      summary: {
        total: results.length,
        passed: results.filter(r => r.status === 'passed').length,
        failed: results.filter(r => r.status === 'failed').length,
        skipped: results.filter(r => r.status === 'skipped').length,
        durationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
      },
      scenarios: results,
    }, null, 2);
  }

  async writeToFile(results: ScenarioResult[], filePath: string): Promise<void> {
    const json = this.report(results);
    await fs.writeFile(filePath, json, 'utf-8');
  }
}
