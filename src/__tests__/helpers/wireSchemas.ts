import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import Ajv2020Module from 'ajv/dist/2020.js';

/*
 * The frames a station test captures, validated against the SAME schemas the SDK ships and the
 * server validates with - the pattern of RejectionFramesAreSchemaValid.test.ts and
 * sessionDurationMonotonic.test.ts, factored once for the live-station tests that check several
 * frame kinds (StatusNotification, MeterValues, SessionEnded, the StopService and configuration
 * RESPONSEs).
 */

type SchemaValidator = ((data: unknown) => boolean) & {
  errors?: Array<{ instancePath: string; message?: string }> | null;
};
interface AjvLike {
  addSchema(schema: unknown, key?: string): void;
  getSchema(key: string): SchemaValidator | undefined;
}
// `ajv/dist/2020.js` is CJS reached through NodeNext: the default import is the namespace, and TS
// sees no construct signature on it (the same wart the two tests above type).
const Ajv2020 = Ajv2020Module as unknown as new (opts: Record<string, unknown>) => AjvLike;

const require_ = createRequire(import.meta.url);
const SCHEMA_ROOT = path.join(path.dirname(require_.resolve('@ospp/protocol')), 'schemas');
const ajv: AjvLike = new Ajv2020({ strict: false, allErrors: true });
for (const dir of ['common', 'mqtt', 'ble']) {
  const abs = path.join(SCHEMA_ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const f of fs.readdirSync(abs).filter((x) => x.endsWith('.schema.json'))) {
    const schema = JSON.parse(fs.readFileSync(path.join(abs, f), 'utf-8'));
    if (typeof schema.$id === 'string' && !ajv.getSchema(schema.$id)) ajv.addSchema(schema);
    // Refs are written relative ('../common/x.schema.json'), so that key is registered too.
    const rel = `../${dir}/${f}`;
    if (!ajv.getSchema(rel)) ajv.addSchema(schema, rel);
  }
}

/** What is wrong with `payload` against `mqtt/<schemaFile>` - empty when it is valid. */
export function schemaErrors(schemaFile: string, payload: unknown): string[] {
  const { $id } = JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, 'mqtt', schemaFile), 'utf-8')) as { $id?: string };
  const validate = ($id !== undefined ? ajv.getSchema($id) : undefined) ?? ajv.getSchema(`../mqtt/${schemaFile}`);
  if (validate === undefined) throw new Error(`schema not registered: ${schemaFile}`);
  // Through JSON, as the frame travels: a NaN reaches the broker as null.
  return validate(JSON.parse(JSON.stringify(payload)))
    ? []
    : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ''}`);
}
