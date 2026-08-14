import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ScenarioDefinition } from '../../scenarios/ScenarioRunner.js';
import { DEFAULT_IDENTITY_WALLET_CREDITS } from '../../scenarios/bootstrap/uatPrivileged.js';

/**
 * The money gate (`StartSessionAction.php:241-250` — 402 INSUFFICIENT_BALANCE / ospp_code
 * 4001) is the one server rule whose coverage the FIXTURE can silently delete.
 *
 * Both directions of that go wrong, and only one of them is loud:
 *
 *   - Fund every identity and the refusal stops firing. A file claiming to prove it passes
 *     against a wallet holding 1000 credits and reports green. Nothing breaks; the proof
 *     just evaporates. This is the direction that motivated the whole check.
 *   - Starve an identity that is not about money and the refusal fires everywhere. That was
 *     the 2026-08-14 pooled run: 28 scenarios down, every one of them reporting a `wait_for`
 *     timeout 15 seconds and three steps away from the 402 that caused it.
 *
 * A `wallet_balance:` declaration and a 4001 assertion are two halves of one statement, so
 * these tests read the committed corpus and require them to travel together.
 */

const SCENARIOS_DIR = path.resolve(__dirname, '../../../scenarios');

interface LoadedScenario {
  file: string;
  scenario: ScenarioDefinition;
  raw: string;
}

function loadCorpus(): LoadedScenario[] {
  const out: LoadedScenario[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.yaml')) {
        const raw = fs.readFileSync(full, 'utf-8');
        out.push({
          file: path.relative(SCENARIOS_DIR, full),
          scenario: parseYaml(raw) as ScenarioDefinition,
          raw,
        });
      }
    }
  };
  walk(SCENARIOS_DIR);
  return out;
}

/** Every `expect_body` map across a scenario's api_call steps. */
function expectBodies(scenario: ScenarioDefinition): Array<Record<string, unknown>> {
  const steps = (scenario.steps ?? []) as Array<Record<string, unknown>>;
  return steps
    .map((s) => s.expect_body)
    .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object');
}

function assertsInsufficientBalance(scenario: ScenarioDefinition): boolean {
  return expectBodies(scenario).some((b) => b['error.ospp_code'] === 4001);
}

const corpus = loadCorpus();

describe('money gate — the corpus proves the refusal it made everyone pay for', () => {
  it('the corpus is non-empty (guards a walk that silently found nothing)', () => {
    // Without this, every test below would pass vacuously on a broken path.
    expect(corpus.length).toBeGreaterThan(100);
  });

  it('at least one scenario proves the 402 INSUFFICIENT_BALANCE refusal', () => {
    const provers = corpus.filter(({ scenario }) => assertsInsufficientBalance(scenario));
    expect(
      provers.map((p) => p.file),
      'No scenario asserts error.ospp_code 4001. The server refuses card-free starts that ' +
      'cannot pay (StartSessionAction.php:241-250) and nothing in this corpus checks it — ' +
      'funding the fixtures removed the failures AND the coverage.',
    ).not.toEqual([]);
  });

  it('a scenario asserting 4001 declares wallet_balance: 0 — it cannot inherit the default', () => {
    // The default is 1000 credits, which covers every request the corpus makes. A 4001
    // proof on a default identity would be unreachable, so the assertion would never fire
    // and the file would fail for a reason unrelated to its subject the day someone
    // "fixed" it by relaxing the assertion.
    for (const { file, scenario } of corpus) {
      if (!assertsInsufficientBalance(scenario)) continue;
      expect(
        scenario.wallet_balance,
        `${file} asserts error.ospp_code 4001 but does not declare "wallet_balance: 0". ` +
        `Its identity would be funded at ${DEFAULT_IDENTITY_WALLET_CREDITS} credits and the ` +
        `start would be accepted.`,
      ).toBe(0);
    }
  });

  it('a scenario declaring wallet_balance: 0 asserts the refusal — no fixture starved for nothing', () => {
    // The reverse guard. An unfunded identity handed to a scenario that is not about money
    // reproduces the 28-failure mode one file at a time, and reports it as a timeout naming
    // a message that never arrived.
    for (const { file, scenario } of corpus) {
      if (scenario.wallet_balance !== 0) continue;
      expect(
        assertsInsufficientBalance(scenario),
        `${file} declares "wallet_balance: 0" but never asserts error.ospp_code 4001. An ` +
        `unfunded identity refuses every card-free start with a 402 that surfaces as a ` +
        `wait_for timeout three steps later — declare the balance only where the refusal ` +
        `is the subject.`,
      ).toBe(true);
    }
  });

  it('the refusal is asserted on 402 as well as 4001 (status and code are one claim)', () => {
    for (const { file, scenario } of corpus) {
      if (!assertsInsufficientBalance(scenario)) continue;
      const steps = (scenario.steps ?? []) as Array<Record<string, unknown>>;
      const refusal = steps.find(
        (s) => !!s.expect_body &&
          (s.expect_body as Record<string, unknown>)['error.ospp_code'] === 4001,
      );
      expect(refusal?.expect_status, `${file}: the 4001 step must pin its HTTP status`).toBe(402);
    }
  });

  it('the refusal step is FOREGROUND — a background api_call downgrades the mismatch to a warn', () => {
    // This is exactly how the 28 hid: `background: true` reports the step green the instant
    // the fetch is fired, turns a status mismatch into a console.warn, and refuses `capture`
    // / `expect_body` outright. A refusal proof cannot be written that way.
    for (const { file, scenario } of corpus) {
      if (!assertsInsufficientBalance(scenario)) continue;
      const steps = (scenario.steps ?? []) as Array<Record<string, unknown>>;
      const refusal = steps.find(
        (s) => !!s.expect_body &&
          (s.expect_body as Record<string, unknown>)['error.ospp_code'] === 4001,
      );
      expect(refusal?.background, `${file}: the 4001 step must not be background`).toBeFalsy();
    }
  });

  it('no scenario declares a wallet_balance the pool builder would treat as the default', () => {
    // Declaring the default value is legal but meaningless — it consumes a reserved identity
    // to obtain what a plain acquire() already gives. Almost always a copy-paste.
    for (const { file, scenario } of corpus) {
      if (scenario.wallet_balance === undefined) continue;
      expect(
        scenario.wallet_balance,
        `${file} declares the default balance; drop the line and inherit it.`,
      ).not.toBe(DEFAULT_IDENTITY_WALLET_CREDITS);
    }
  });
});
