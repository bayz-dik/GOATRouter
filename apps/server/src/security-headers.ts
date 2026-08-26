import type { FastifyInstance } from "fastify";

/**
 * Strict, local-first security headers.
 *
 * The policy is a constant with no configuration knob. That is deliberate: a
 * "relax CSP" option is exactly the thing that gets reached for the first time
 * something breaks, and by then nobody remembers why the policy was strict.
 *
 * `default-src 'none'` means every fetch directive must be named explicitly, so a
 * resource type nobody thought about is denied rather than inheriting a permissive
 * default.
 *
 * Notes on the two non-`'none'` choices:
 *
 * - `img-src 'self' data:` — the provider marks are inline `<svg>` elements, which
 *   are not images for CSP purposes, but `data:` is retained for favicons and any
 *   future inline raster asset. `data:` is not a script execution vector under
 *   `script-src 'self'`.
 * - `style-src 'self'` with **no** `'unsafe-inline'` — React's `style` prop sets
 *   DOM properties (`element.style.width = …`), which CSP does not govern. Only a
 *   literal `style="…"` attribute in served HTML or an injected `<style>` element
 *   would need `'unsafe-inline'`, and the dashboard has neither. This is verified
 *   against the built bundle by the dashboard smoke script.
 */
export const CSP_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Companion headers.
 *
 * CSP is the load-bearing one; these close adjacent gaps that a local daemon has no
 * reason to leave open.
 */
const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["content-security-policy", CSP_POLICY],
  ["x-content-type-options", "nosniff"],
  ["referrer-policy", "no-referrer"],
  // Redundant with frame-ancestors, but honoured by older engines.
  ["x-frame-options", "DENY"],
  ["cross-origin-opener-policy", "same-origin"],
  ["cross-origin-resource-policy", "same-origin"],
  [
    "permissions-policy",
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  ],
];

/** Parse a policy into directives, for tests that assert structure not substrings. */
export function parseCspPolicy(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const tokens = part.trim().split(/\s+/).filter((token) => token.length > 0);
    const name = tokens.shift();
    if (name !== undefined) {
      directives.set(name, tokens);
    }
  }
  return directives;
}

/**
 * Install the headers on every response.
 *
 * An `onSend` hook rather than per-route wiring, so a route added later cannot
 * forget them — and an error response, a 401, and a 403 all carry the policy too.
 */
export function installSecurityHeaders(app: FastifyInstance): void {
  app.addHook("onSend", async (_request, reply, payload) => {
    for (const [name, value] of SECURITY_HEADERS) {
      void reply.header(name, value);
    }
    // Nothing should advertise the implementation.
    void reply.removeHeader("x-powered-by");
    return payload;
  });
}
