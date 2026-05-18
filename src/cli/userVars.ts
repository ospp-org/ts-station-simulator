const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VALUE_RE = /^[A-Za-z0-9_-]+$/;

export function parseUserVars(pairs: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of pairs) {
    const eq = raw.indexOf('=');
    if (eq < 1) {
      throw new Error(
        `--var "${raw}" must be in KEY=VALUE form (got no '=' or empty key)`,
      );
    }
    const key = raw.slice(0, eq);
    const value = raw.slice(eq + 1);
    if (!KEY_RE.test(key)) {
      throw new Error(
        `--var key "${key}" must match identifier pattern /^[A-Za-z_][A-Za-z0-9_]*$/`,
      );
    }
    if (value.length === 0) {
      throw new Error(`--var value for key "${key}" must not be empty`);
    }
    if (!VALUE_RE.test(value)) {
      throw new Error(
        `--var value "${value}" for key "${key}" must match /^[A-Za-z0-9_-]+$/ ` +
          `(alphanumeric, underscore, hyphen — keeps placeholder substitution injection-safe)`,
      );
    }
    out.set(key, value);
  }
  return out;
}
