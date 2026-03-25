import { BootReason, BayStatus, SessionEndReason, MessageType } from '@ospp/protocol';
import type { LintIssue, LintCheck, ParsedScenario } from '../types.js';

const BOOT_REASONS = new Set(Object.values(BootReason));
const BAY_STATUSES = new Set(Object.values(BayStatus));
const SESSION_END_REASONS = new Set(Object.values(SessionEndReason));
const MESSAGE_TYPES = new Set(Object.values(MessageType));

export class EnumValuesCheck implements LintCheck {
  name = 'enum-values';

  check(scenario: ParsedScenario): LintIssue[] {
    const issues: LintIssue[] = [];

    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      const action = step.action as string;
      const message = step.message as string | undefined;
      const messageType = step.messageType as string | undefined;
      const payload = step.payload as Record<string, unknown> | undefined;

      // Check messageType on send/wait_for
      if (messageType && !MESSAGE_TYPES.has(messageType as MessageType)) {
        issues.push({
          file: scenario.filePath,
          step: i,
          stepAction: action,
          message: `Invalid messageType "${messageType}" -- valid: ${[...MESSAGE_TYPES].join(', ')}`,
        });
      }

      if (action !== 'send' || !payload) continue;

      // Check bootReason on BootNotification
      if (message === 'BootNotification' && payload.bootReason) {
        const val = payload.bootReason as string;
        if (!isTemplate(val) && !BOOT_REASONS.has(val as BootReason)) {
          issues.push({
            file: scenario.filePath,
            step: i,
            stepAction: action,
            message: `Invalid bootReason "${val}" -- valid: ${[...BOOT_REASONS].join(', ')}`,
          });
        }
      }

      // Check status on StatusNotification
      if (message === 'StatusNotification' && payload.status) {
        const val = payload.status as string;
        if (!isTemplate(val) && !BAY_STATUSES.has(val as BayStatus)) {
          issues.push({
            file: scenario.filePath,
            step: i,
            stepAction: action,
            message: `Invalid bay status "${val}" -- valid: ${[...BAY_STATUSES].join(', ')}`,
          });
        }
      }

      // Check reason on SessionEnded
      if (message === 'SessionEnded' && payload.reason) {
        const val = payload.reason as string;
        if (!isTemplate(val) && !SESSION_END_REASONS.has(val as SessionEndReason)) {
          issues.push({
            file: scenario.filePath,
            step: i,
            stepAction: action,
            message: `Invalid SessionEnded reason "${val}" -- valid: ${[...SESSION_END_REASONS].join(', ')}`,
          });
        }
      }
    }

    return issues;
  }
}

function isTemplate(val: string): boolean {
  return val.includes('{{');
}
