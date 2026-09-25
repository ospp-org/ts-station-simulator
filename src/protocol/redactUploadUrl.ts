/**
 * THE DIAGNOSTICS UPLOAD URL IS A CREDENTIAL, SO IT IS NEVER SHOWN WHOLE.
 *
 * csms-server mints the URL a GetDiagnostics Request carries: `PUT/HEAD
 * {base}/api/v1/diagnostics/uploads/{token}`. The last path segment is a single-use token, and
 * holding the URL is all it takes to perform the upload. An operator may instead supply an
 * external URL, which carries its secret elsewhere: a presigned object-store URL signs itself in
 * the query string, a basic-auth one keeps a password in the userinfo.
 *
 * A log line is not a safe place for any of those. stdout is copied into CI transcripts, pasted
 * into bug reports and left in scrollback on shared hosts, and a step's failure text is written
 * verbatim into the JSON and JUnit reports. So every log line, warning and error message that
 * shows this URL shows it through `redactUploadUrl`, which keeps what a reader needs to debug an
 * upload (scheme, host, port, the path around the token, the query KEYS) and drops what would let
 * that reader perform it.
 *
 * THE FRAME JOURNAL IS EXEMPT, BY CONTRACT. It records every frame's raw bytes because its one
 * job is to prove what crossed the socket, and a MAC recomputed over a redacted frame would not
 * verify (see FrameJournal). It writes under `tests/artifacts/`, which is gitignored in full
 * because every artifact there may carry credentials; the upload token is one more.
 *
 * WHY `src/protocol/`: three layers show this field, the GetDiagnostics handler, the inbound
 * schema gate and the scenario steps. One module keeps a single definition of what is secret in
 * it, instead of three that drift apart.
 */

/** What replaces every secret-bearing part. */
export const REDACTED = '<redacted>';

/**
 * What stands in for a value `URL` cannot parse.
 *
 * Fixed, never derived from the input: a string that does not parse can still carry the token
 * (a relative path, a URL with a typo in the scheme), and there is no structure left to find it
 * by.
 */
export const UNPARSEABLE_URL = '<unparseable url>';

/**
 * The one path segment that follows `/diagnostics/uploads/`, wherever that marker sits in the
 * path, so a deployment mounted under a prefix is covered too. Case-insensitive: the token stays
 * valid on the canonical route whatever case it was printed in.
 */
const UPLOAD_TOKEN_SEGMENT = /(\/diagnostics\/uploads\/)[^/]+/gi;

/**
 * The URL with the upload token, every query value and the userinfo replaced by `<redacted>`.
 *
 * Returned exactly as given when it has none of those parts, so an ordinary URL in a log line
 * reads the same as before. The fragment is kept: it is never sent to the server, so it cannot
 * carry an upload credential.
 */
export function redactUploadUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return UNPARSEABLE_URL;
  }

  const hasUserinfo = parsed.username !== '' || parsed.password !== '';
  const path = parsed.pathname.replace(UPLOAD_TOKEN_SEGMENT, `$1${REDACTED}`);
  const query = redactQueryValues(parsed.search);
  if (!hasUserinfo && path === parsed.pathname && query === parsed.search) {
    return url;
  }

  // Assembled by hand rather than through the URL setters, which would percent-encode the
  // placeholder into `%3Credacted%3E` and make the line harder to read, not safer.
  const authority = parsed.href.startsWith(`${parsed.protocol}//`)
    ? `//${hasUserinfo ? `${REDACTED}@` : ''}${parsed.host}`
    : '';
  return `${parsed.protocol}${authority}${path}${query}${parsed.hash}`;
}

/**
 * `?a=1&b=2` -> `?a=<redacted>&b=<redacted>`, keys kept as written.
 *
 * Split by hand rather than read through URLSearchParams, which would decode the keys and
 * re-encode the placeholder. A part with no `=` is redacted whole: URLSearchParams would call
 * `?abc123` a KEY with an empty value, and keeping keys would then keep the entire secret.
 */
function redactQueryValues(search: string): string {
  if (search === '') return '';
  const parts = search.slice(1).split('&').map((part) => {
    if (part === '') return part;
    const eq = part.indexOf('=');
    return eq === -1 ? REDACTED : `${part.slice(0, eq)}=${REDACTED}`;
  });
  return `?${parts.join('&')}`;
}

/**
 * A copy of a payload that is safe to print: when it is a JSON object with a string `uploadUrl`,
 * a shallow copy with that URL redacted; anything else, returned as is.
 *
 * A copy, never an edit in place. The payload being printed is the one the handler and the
 * router's violation record still read, and they need the real URL; only what is SHOWN changes.
 * Spreading keeps the key order, so the printed JSON differs from the original in that one value
 * and nowhere else.
 */
export function logSafePayload(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const uploadUrl = (payload as Record<string, unknown>).uploadUrl;
  if (typeof uploadUrl !== 'string') return payload;
  return { ...(payload as Record<string, unknown>), uploadUrl: redactUploadUrl(uploadUrl) };
}

/** A path whose last segment is `uploadUrl`: the value read there is the URL itself. */
const UPLOAD_URL_FIELD = /(?:^|\.)uploadUrl$/;

/**
 * A value read from a received message at `field`, made safe to show in a failure message.
 *
 * For the assertion messages, which print whatever a path resolved to. That is the URL itself
 * when the path ends in `uploadUrl`, which a payload-level check cannot recognise from the string
 * alone (an operator's presigned URL looks like any other URL), or a payload object carrying one.
 */
export function logSafeValue(field: string, value: unknown): unknown {
  if (typeof value === 'string' && UPLOAD_URL_FIELD.test(field)) return redactUploadUrl(value);
  return logSafePayload(value);
}
