import { ProxyError } from "./errors.js";
import { parseProxyHost, parseProxyPort } from "./endpoint.js";

export type ProxyConfig = {
  connectTimeoutMs: number;
  healthCheckHost: string;
  healthCheckPort: number;
};

export const CONNECT_TIMEOUT_MS_MIN = 500;
export const CONNECT_TIMEOUT_MS_MAX = 60000;
export const CONNECT_TIMEOUT_MS_DEFAULT = 10000;
export const HEALTH_CHECK_HOST_DEFAULT = "1.1.1.1";
export const HEALTH_CHECK_PORT_DEFAULT = 443;

const ALLOWED_KEYS = new Set([
  "connectTimeoutMs",
  "healthCheckHost",
  "healthCheckPort",
]);

/**
 * Strict proxy configuration parsing.
 *
 * Unknown keys are rejected rather than ignored: there is no key in this schema
 * that can carry a command, a header, or a password, and an attempt to add one
 * fails loudly instead of being silently dropped. A non-plain prototype is
 * refused so an inherited value cannot shadow a validated one.
 */
export function parseProxyConfig(input: unknown): ProxyConfig {
  if (input === undefined) {
    return {
      connectTimeoutMs: CONNECT_TIMEOUT_MS_DEFAULT,
      healthCheckHost: HEALTH_CHECK_HOST_DEFAULT,
      healthCheckPort: HEALTH_CHECK_PORT_DEFAULT,
    };
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ProxyError("invalid_proxy_config", "config-shape");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ProxyError("invalid_proxy_config", "config-prototype");
  }

  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new ProxyError("invalid_proxy_config", "config-unknown-key");
    }
  }

  let connectTimeoutMs = CONNECT_TIMEOUT_MS_DEFAULT;
  if (record.connectTimeoutMs !== undefined) {
    const value = record.connectTimeoutMs;
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < CONNECT_TIMEOUT_MS_MIN ||
      value > CONNECT_TIMEOUT_MS_MAX
    ) {
      throw new ProxyError("invalid_proxy_config", "config-connect-timeout");
    }
    connectTimeoutMs = value;
  }

  return {
    connectTimeoutMs,
    healthCheckHost:
      record.healthCheckHost === undefined
        ? HEALTH_CHECK_HOST_DEFAULT
        : parseProxyHost(record.healthCheckHost),
    healthCheckPort:
      record.healthCheckPort === undefined
        ? HEALTH_CHECK_PORT_DEFAULT
        : parseProxyPort(record.healthCheckPort, "config-health-port"),
  };
}
