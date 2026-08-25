const SECRET_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "apikey",
  "api_key",
  "password",
  "proxypassword",
  "proxy_password",
  "access_token",
  "refresh_token",
]);

export function redactSecrets<T>(value: T): T {
  if (value === null || typeof value !== "object" || value instanceof Date) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry)) as T;
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = SECRET_KEYS.has(key.toLowerCase())
      ? "[REDACTED]"
      : redactSecrets(entry);
  }
  return output as T;
}
