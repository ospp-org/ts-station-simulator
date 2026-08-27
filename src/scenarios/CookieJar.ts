/**
 * A per-scenario cookie store, and the smallest one that is honest about what it is.
 *
 * WHY IT EXISTS. `ApiCallStep` calls `fetch` directly, and `fetch` keeps nothing between
 * calls. Every endpoint the corpus reaches is a bearer-token JSON API, where that is exactly
 * right — an `Authorization` header is stateless and two calls sharing state would be a
 * source of order-dependence nobody asked for. The webpay landing flow is the first surface
 * in this programme that is NOT one: `GET /w/{slug}` and `POST /w/{slug}/process` are in
 * Laravel's `web` middleware group, so the CSRF token minted by the first is validated
 * against the SESSION carried in the second's `laravel_session` cookie. Without a jar the
 * two calls are two sessions, and the POST answers 419 for a reason that has nothing to do
 * with the token being wrong.
 *
 * WHY IT IS OPT-IN (`cookies: true` on the step). Turning it on globally would change the
 * request shape of all 145 existing files — every one of them would start sending back
 * whatever a previous step's response happened to set. Nothing in the corpus needs that, and
 * a silent change to what 145 files put on the wire is not a mechanism, it is a hazard.
 *
 * WHAT IT DELIBERATELY IS NOT. This is not RFC 6265. There is no `Path`, no `Domain`, no
 * `Expires`, no `Secure`, no `SameSite` evaluation. It is a per-ORIGIN name→value map, and
 * the origin is taken from the request URL rather than from the cookie's own attributes.
 *
 * That is STRICTER than a browser, never looser, and the direction matters: a browser would
 * send a `Domain=.example.com` cookie to `api.example.com`, and this will not. The cost of
 * being too strict is a scenario that goes red at a step whose request was missing a cookie
 * — visible, and attributable. The cost of being too loose is a cookie leaking to a host the
 * scenario did not mean to authenticate against, which is the kind of thing that passes.
 *
 * The one attribute it does read is `Max-Age=0`, because that is the form Laravel's
 * `Cookie::forget()` emits and a jar that kept sending a session the server has just
 * invalidated would be reporting a state that no longer exists.
 */
export class CookieJar {
  private readonly byOrigin = new Map<string, Map<string, string>>();

  /**
   * The `Cookie` request-header value for this URL's origin, or `undefined` when the jar
   * holds nothing for it. `undefined` rather than an empty string on purpose — an empty
   * `Cookie:` header is a header that was sent, and it reads in a capture as if the jar had
   * an answer.
   */
  header(url: string): string | undefined {
    const jar = this.byOrigin.get(originOf(url));
    if (jar === undefined || jar.size === 0) return undefined;
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** Absorb every `Set-Cookie` on a response, scoped to the origin the request went to. */
  absorb(url: string, headers: Headers): void {
    const origin = originOf(url);
    for (const raw of setCookieLines(headers)) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name === '') continue;

      let jar = this.byOrigin.get(origin);
      if (jar === undefined) {
        jar = new Map();
        this.byOrigin.set(origin, jar);
      }
      if (/;\s*max-age\s*=\s*0\s*(;|$)/i.test(raw)) {
        jar.delete(name);
        continue;
      }
      jar.set(name, value);
    }
  }

  /** Names held for an origin. Test/diagnostic surface — the jar is otherwise write-only. */
  namesFor(url: string): string[] {
    return [...(this.byOrigin.get(originOf(url))?.keys() ?? [])];
  }
}

/**
 * Multiple `Set-Cookie` headers do not survive `headers.get()` — it joins them with ", ",
 * and an `Expires=Wed, 01 Jan ...` attribute contains that same separator, so splitting the
 * joined string tears real cookies in half. `getSetCookie()` (undici, Node >= 18.14) returns
 * them as a list and is the only correct reader. The fallback exists for a runtime that
 * lacks it and handles the single-cookie case, which is the one that cannot be ambiguous.
 */
function setCookieLines(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetter.getSetCookie === 'function') {
    return withGetter.getSetCookie();
  }
  const single = headers.get('set-cookie');
  return single === null ? [] : [single];
}

function originOf(url: string): string {
  return new URL(url).origin;
}
