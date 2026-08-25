/**
 * Sensitive field names, written in their canonical normalized form:
 * lowercase with `-` and `_` removed. Matching normalizes candidate keys the
 * same way, so `apiKey`, `api_key`, `API-KEY`, and `apikey` all collapse onto
 * the single entry `apikey`.
 *
 * Matching is exact against the normalized name, never a substring, so
 * neighbours such as `tokenCount`, `secretName`, or `passwordPolicy` keep their
 * values. Substring matching here would silently destroy non-secret data.
 */
const SECRET_KEYS = new Set([
  // HTTP credential headers
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  // provider and proxy credentials
  "apikey",
  "password",
  "proxypassword",
  "token",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "secret",
  "credential",
  // key material and crypto internals
  "masterkey",
  "privatekey",
  "passphrase",
  "kek",
  "dek",
  "wrappeddek",
  "ciphertext",
]);

const SEPARATORS = /[-_]/g;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(SEPARATORS, "");
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(normalizeKey(key));
}

export function redactSecrets<T>(value: T): T {
  if (value === null || typeof value !== "object" || value instanceof Date) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry)) as T;
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = isSecretKey(key) ? "[REDACTED]" : redactSecrets(entry);
  }
  return output as T;
}
