import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { MessageSender } from '../../mqtt/MessageSender.js';

// The package exports only "." and "./server" — not the schemas and not its own
// package.json — so the schema is read off disk, the same way the linter's SchemaValidator
// reaches it. Anchored on the resolved main entry (`.../dist/index.js`) so this follows the
// INSTALLED package rather than a relative guess: it is the copy the linter and the wire use.
const require_ = createRequire(import.meta.url);
const SCHEMA_DIR = path.join(path.dirname(require_.resolve('@ospp/protocol')), 'schemas/mqtt');
const bootSchema = JSON.parse(
  fs.readFileSync(path.join(SCHEMA_DIR, 'boot-notification-request.schema.json'), 'utf-8'),
) as Record<string, unknown>;

/**
 * `messageSigningMode` — the field the station could not send until the pin moved.
 *
 * Spec 0.31.0 added it to boot-notification-request as OPTIONAL, and until @ospp/protocol
 * `^0.26.0` -> `^0.29.0` a scenario could not have sent it even by hand: the schema is
 * `additionalProperties: false`, so the linter refuses an unknown key before it reaches a
 * broker. The pin was minor-locked on 0.x, three minors short, so `npm update` could not
 * move it either. That is the whole shape of the blockage — not a delay, a floor.
 *
 * WHY THE STATION SENDS IT RATHER THAN A SCENARIO DECLARING IT. It is a fact about what the
 * sender is DOING, and the sender already holds it. That makes it the third derived field in
 * the boot payload, beside `uptimeSeconds` and `bootReason`, and it inherits their rule: a
 * literal is a second copy of a fact, and the two drift. Nothing in the corpus asked for the
 * field, and nothing should have to — a scenario naming its own signing mode would be
 * asserting the fixture rather than the station.
 *
 * WHY IT MATTERS ON THE WIRE. BootNotification REQUEST is one of three structural exemptions
 * from message signing (06-security.md §5.6); the other 44 types are signed. So when the
 * station and the server disagree about the mode, this is the only message that still
 * arrives, and this field is the only place the station can say which mode it is in.
 * csms-server carries the reading half open (M83) and cannot be exercised against a station
 * that never says — and this simulator is the only station there is.
 */

const SRC = path.resolve(__dirname, '../..');

describe('boot payload — messageSigningMode is derived, not declared', () => {
  it('the pinned schema accepts the field (it did not before 0.29.0)', () => {
    const props = (bootSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toContain('messageSigningMode');
    // OPTIONAL — a station that omits it says nothing, which is what every station said
    // before 0.31.0. If this ever becomes required, every scenario boot payload is affected.
    const required = (bootSchema as { required?: string[] }).required ?? [];
    expect(required).not.toContain('messageSigningMode');
    // The closed object is why the field was unreachable at the old pin; keep that visible.
    expect((bootSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
  });

  it('the enum is exactly the two modes the sender can be in', () => {
    const props = (bootSchema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.messageSigningMode.enum).toEqual(['All', 'None']);
  });

  it('MessageSender reports the mode it actually signs with', () => {
    const stub = {} as never;
    expect(new MessageSender(stub, 'stn_test').currentSigningMode).toBe('All');
    expect(new MessageSender(stub, 'stn_test', () => null, 'None').currentSigningMode).toBe('None');
  });

  it('the boot payload reads it off the sender rather than a literal', () => {
    // Read as source rather than driven through a broker: the assertion is that this field
    // is DERIVED, and a value-equality test on a station built with the default mode passes
    // just as well against a hardcoded 'All'. What must not come back is a literal.
    const src = fs.readFileSync(path.join(SRC, 'station/Station.ts'), 'utf-8');
    expect(src).toContain('messageSigningMode: this.sender.currentSigningMode');
    expect(src).not.toMatch(/messageSigningMode:\s*'(All|None)'/);
  });

  it('no scenario declares the field by hand — it is not a fixture knob', () => {
    const scenarios = path.resolve(SRC, '../scenarios');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.yaml') && /^\s+messageSigningMode:/m.test(fs.readFileSync(full, 'utf-8'))) {
          offenders.push(path.relative(scenarios, full));
        }
      }
    };
    walk(scenarios);
    expect(
      offenders,
      'A scenario declaring messageSigningMode is asserting its own fixture. The station ' +
        'derives it from the sender; if a file needs a different mode, change the sender.',
    ).toEqual([]);
  });
});
