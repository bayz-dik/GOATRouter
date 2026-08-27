import { IdentityError } from "./errors.js";

/**
 * The complete scope vocabulary.
 *
 * Ten words, and deliberately not one more. Note what is absent: there is no
 * scope that reads a provider credential, a proxy password, or the root key. That
 * absence is the security property — a route cannot be written to reveal a secret
 * because no vocabulary word would authorize it. An executable test asserts no
 * scope name matches /credential|password|secret|token|key/i.
 */
export const CLIENT_SCOPES = Object.freeze([
  "chat.completions",
  "models.read",
  "usage.read",
  "providers.read",
  "providers.write",
  "proxies.read",
  "proxies.write",
  "routes.read",
  "routes.write",
  "admin",
] as const);

export type ClientScope = (typeof CLIENT_SCOPES)[number];

/**
 * What a newly created client key holds unless the operator says otherwise.
 *
 * A client exists to talk to models. Arriving with any management authority would
 * make the blast radius of a leaked client key far wider than the operator
 * expected, so the default carries no write scope and never `admin`.
 */
export const DEFAULT_CLIENT_SCOPES = Object.freeze([
  "chat.completions",
  "models.read",
] as const satisfies readonly ClientScope[]);

/**
 * A Set, not an array scan and not an object lookup.
 *
 * An object literal would resolve `__proto__`, `constructor`, and `toString`
 * through the prototype chain and report them as known scopes.
 */
const SCOPE_SET: ReadonlySet<string> = new Set<string>(CLIENT_SCOPES);

export function isClientScope(value: unknown): value is ClientScope {
  return typeof value === "string" && SCOPE_SET.has(value);
}

/**
 * Validate an untrusted scope payload into a fresh array.
 *
 * The count is checked before the contents so a hostile 10,000-entry array is
 * refused without being walked. Duplicates are refused rather than deduplicated:
 * a caller sending the same scope twice has a bug, and silently accepting it
 * would hide it.
 */
export function assertScopes(value: unknown): ClientScope[] {
  if (!Array.isArray(value)) {
    throw new IdentityError("invalid_scope", "scopes-shape");
  }
  if (value.length === 0 || value.length > CLIENT_SCOPES.length) {
    throw new IdentityError("invalid_scope", "scopes-count");
  }
  const seen = new Set<string>();
  const scopes: ClientScope[] = [];
  for (const entry of value) {
    if (!isClientScope(entry)) {
      throw new IdentityError("invalid_scope", "scopes-unknown");
    }
    if (seen.has(entry)) {
      throw new IdentityError("invalid_scope", "scopes-duplicate");
    }
    seen.add(entry);
    scopes.push(entry);
  }
  return scopes;
}

/**
 * Does a granted set satisfy a required scope?
 *
 * `admin` satisfies everything, and nothing satisfies `admin`. No other
 * implication exists: `providers.write` does not grant `providers.read`, because
 * implication is where privilege creep starts and an operator who granted a write
 * form should not silently also have granted enumeration.
 */
export function satisfies(
  granted: ReadonlySet<ClientScope>,
  required: ClientScope,
): boolean {
  if (!isClientScope(required)) {
    throw new IdentityError("invalid_scope", "required-scope");
  }
  return granted.has(required) || granted.has("admin");
}
