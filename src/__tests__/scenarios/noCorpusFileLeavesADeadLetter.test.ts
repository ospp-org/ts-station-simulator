import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * NO CORPUS FILE SENDS A SCHEMA-INVALID EVENT (csms-server, the close of the offline server arc, 2026-10-23).
 *
 * The server answers a schema-invalid REQUEST - with its error, or with the silence of an action that has no error
 * shape - but it cannot answer an EVENT: it dead-letters it, fail-closed, and keeps it for 30 days
 * (`mqtt:dlq:purge --older-than=30`), and `MqttDlqBacklog` fires on any dead letter for 15 minutes. A corpus file
 * that sends one asserts nothing - no surface reads a dead letter back per station or per run - and leaves its
 * residue in the deployment it runs against: `chaos/malformed-messages.yaml` sent two StatusNotifications every run,
 * the two dead letters each full corpus left on UAT, the DLQ at 57 and the alert firing since 2026-10-22. The
 * server's handling of such an event is pinned by its own tests, which is where it can be asserted.
 */
const SCENARIOS_DIR = path.resolve(__dirname, '../../../scenarios');

interface Step {
  action?: string;
  message?: string;
  messageType?: string;
  expect_invalid?: boolean;
}

describe('the corpus leaves no dead letter', () => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.yaml')) files.push(full);
    }
  };
  walk(SCENARIOS_DIR);

  it('reads the whole corpus (the denominator)', () => {
    expect(files.length).toBeGreaterThan(150);
  });

  it('no file sends an EVENT it marks schema-invalid', () => {
    const offending = files.flatMap((f) => {
      const scenario = parseYaml(fs.readFileSync(f, 'utf-8')) as { steps?: Step[] } | null;
      return (scenario?.steps ?? [])
        .filter((s) => s.action === 'send' && s.expect_invalid === true && s.messageType === 'Event')
        .map((s) => `${path.relative(SCENARIOS_DIR, f)}: ${s.message ?? '?'}`);
    });

    expect(offending).toEqual([]);
  });

  it('CONTROL: a schema-invalid REQUEST stays allowed - the server answers it, and the file asserts the answer', () => {
    const requests = files.filter((f) => {
      const scenario = parseYaml(fs.readFileSync(f, 'utf-8')) as { steps?: Step[] } | null;
      return (scenario?.steps ?? []).some((s) => s.action === 'send' && s.expect_invalid === true && s.messageType !== 'Event');
    });

    expect(requests.length).toBeGreaterThan(0);
  });
});
