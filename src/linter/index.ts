#!/usr/bin/env node

import path from 'node:path';
import chalk from 'chalk';
import { ScenarioLinter } from './ScenarioLinter.js';

const args = process.argv.slice(2);
const scenariosDir = args[0] ?? 'scenarios';

async function main(): Promise<void> {
  const linter = new ScenarioLinter();
  const resolvedDir = path.resolve(scenariosDir);

  console.log(chalk.blue(`Linting scenarios in ${resolvedDir}...\n`));

  const results = await linter.lintDirectory(resolvedDir);

  let totalOk = 0;
  let totalErrors = 0;
  const allIssues: Array<{ file: string; issues: import('./types.js').LintIssue[] }> = [];

  for (const [file, issues] of results) {
    const relPath = path.relative(process.cwd(), file);
    if (issues.length === 0) {
      console.log(chalk.green(`  \u2713 ${relPath}`));
      totalOk++;
    } else {
      console.log(chalk.red(`  \u2717 ${relPath}`));
      for (const issue of issues) {
        const stepLabel = issue.step >= 0 ? `Step ${issue.step} (${issue.stepAction})` : 'File';
        console.log(chalk.red(`    ${stepLabel}: ${issue.message}`));
      }
      totalErrors++;
      allIssues.push({ file: relPath, issues });
    }
  }

  console.log();
  console.log(chalk.bold('Summary:'));
  console.log(`  ${chalk.green(`${totalOk} OK`)}, ${totalErrors > 0 ? chalk.red(`${totalErrors} with errors`) : '0 with errors'}`);

  if (totalErrors > 0) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(chalk.red(`Fatal: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
