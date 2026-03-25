import { describe, it, expect, afterEach } from 'vitest';
import { ScenarioLinter } from '../../linter/ScenarioLinter.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

let tmpFiles: string[] = [];

async function writeTmpYaml(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'linter-test-'));
  const filePath = path.join(dir, 'scenario.yaml');
  await fs.writeFile(filePath, content, 'utf-8');
  tmpFiles.push(dir);
  return filePath;
}

afterEach(async () => {
  for (const dir of tmpFiles) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tmpFiles = [];
});

describe('ScenarioLinter', () => {
  it('lintFile on a valid YAML file returns no issues', async () => {
    const yaml = `
name: "Valid Scenario"
station:
  bayCount: 1
steps:
  - action: send
    message: BootNotification
    messageType: Request
    payload:
      stationId: "stn_00000001"
      firmwareVersion: "1.0.0"
      stationModel: "WashPro X200"
      stationVendor: "SimCorp"
      serialNumber: "SN-12345678"
      bayCount: 2
      uptimeSeconds: 0
      pendingOfflineTransactions: 0
      timezone: "Europe/Bucharest"
      bootReason: "PowerOn"
      capabilities:
        bleSupported: false
        offlineModeSupported: false
        meterValuesSupported: true
      networkInfo:
        connectionType: "Ethernet"
  - action: wait_for
    message: BootNotification
    messageType: Response
    timeout_ms: 5000
`;
    const filePath = await writeTmpYaml(yaml);
    const linter = new ScenarioLinter();
    const issues = await linter.lintFile(filePath);
    expect(issues).toHaveLength(0);
  });

  it('lintFile on an invalid YAML detects issues', async () => {
    const yaml = `
name: "Invalid Scenario"
station:
  bayCount: 1
steps:
  - action: send
    message: BootNotification
    messageType: Request
    payload:
      bootReason: "BadReason"
  - action: wait_for
    message: BootNotification
    messageType: Response
`;
    const filePath = await writeTmpYaml(yaml);
    const linter = new ScenarioLinter();
    const issues = await linter.lintFile(filePath);
    // Should detect at least: invalid bootReason + missing timeout_ms
    expect(issues.length).toBeGreaterThanOrEqual(2);
    const messages = issues.map(i => i.message);
    expect(messages.some(m => m.includes('bootReason'))).toBe(true);
    expect(messages.some(m => m.includes('timeout_ms'))).toBe(true);
  });
});
