import { XMLBuilder } from 'fast-xml-parser';
import fs from 'node:fs/promises';
import type { ScenarioResult } from '../scenarios/ScenarioRunner.js';
import type { StepResult } from '../scenarios/ScenarioContext.js';

interface TestCase {
  '@_name': string;
  '@_classname': string;
  '@_time': string;
  failure?: {
    '@_message': string;
    '#text': string;
  };
}

interface TestSuite {
  '@_name': string;
  '@_tests': number;
  '@_failures': number;
  '@_time': string;
  testcase: TestCase[];
}

interface TestSuites {
  '?xml': { '@_version': string; '@_encoding': string };
  testsuites: {
    '@_name': string;
    '@_tests': number;
    '@_failures': number;
    '@_time': string;
    testsuite: TestSuite[];
  };
}

function stepDescription(step: StepResult): string {
  return `[${step.stepIndex}] ${step.action}`;
}

export class JUnitReporter {
  report(results: ScenarioResult[]): string {
    const totalTests = results.reduce((sum, r) => sum + r.steps.length, 0);
    const totalFailures = results.reduce(
      (sum, r) => sum + r.steps.filter(s => s.status === 'failed').length,
      0,
    );
    const totalTime = results.reduce((sum, r) => sum + r.durationMs, 0) / 1000;

    const testSuites: TestSuite[] = results.map(scenario => {
      const failures = scenario.steps.filter(s => s.status === 'failed').length;
      const suiteTime = scenario.durationMs / 1000;

      const testCases: TestCase[] = scenario.steps.map(step => {
        const tc: TestCase = {
          '@_name': stepDescription(step),
          '@_classname': scenario.name,
          '@_time': (step.durationMs / 1000).toFixed(3),
        };

        if (step.status === 'failed') {
          tc.failure = {
            '@_message': step.error ?? 'Unknown error',
            '#text': step.error ?? 'Unknown error',
          };
        }

        return tc;
      });

      return {
        '@_name': scenario.name,
        '@_tests': scenario.steps.length,
        '@_failures': failures,
        '@_time': suiteTime.toFixed(3),
        testcase: testCases,
      };
    });

    const xmlObj: TestSuites = {
      '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
      testsuites: {
        '@_name': 'OSPP Station Simulator',
        '@_tests': totalTests,
        '@_failures': totalFailures,
        '@_time': totalTime.toFixed(3),
        testsuite: testSuites,
      },
    };

    const builder = new XMLBuilder({
      ignoreAttributes: false,
      format: true,
      suppressEmptyNode: true,
      processEntities: true,
    });

    return builder.build(xmlObj) as string;
  }

  async writeToFile(results: ScenarioResult[], filePath: string): Promise<void> {
    const xml = this.report(results);
    await fs.writeFile(filePath, xml, 'utf-8');
  }
}
