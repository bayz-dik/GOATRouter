import { ProviderError } from "./errors.js";
import type { ProviderKind } from "./url.js";

export type ProviderConfig = {
  timeoutMs: number;
  discoveryPath: string;
  modelLimit: number;
  /**
   * Whether this provider supports tool calling.
   *
   * Three states, and the third is the important one:
   *
   * - `true`  — the operator has confirmed it. Tools are forwarded.
   * - `false` — the operator has confirmed it does not. A request carrying tools is
   *             refused with `tools_unsupported` rather than having them silently
   *             stripped, because a client whose tools vanished would receive a
   *             plain answer and never learn its tools were ignored.
   * - absent  — **unknown**, and BAYZ says so instead of guessing. Tools are
   *             forwarded and the upstream decides. A model-discovery endpoint does
   *             not reveal tool support, so inferring it would be fabrication.
   */
  supportsTools?: boolean;
};

export const TIMEOUT_MS_MIN = 1000;
export const TIMEOUT_MS_MAX = 120000;
export const TIMEOUT_MS_DEFAULT = 30000;
export const MODEL_LIMIT_MIN = 1;
export const MODEL_LIMIT_MAX = 500;
export const MODEL_LIMIT_DEFAULT = 100;
const MAX_DISCOVERY_PATH_LENGTH = 512;

/**
 * Path-only characters. No `?`, no `#`, and no scheme punctuation, so a
 * discovery path can never grow into a different URL or carry a query-string
 * credential.
 */
const DISCOVERY_PATH_RE = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;

/** The accepted key set. Anything else is a hard error, see below. */
const ALLOWED_KEYS = new Set([
  "timeoutMs",
  "discoveryPath",
  "modelLimit",
  "supportsTools",
]);

function defaultDiscoveryPath(kind: ProviderKind): string {
  return kind === "gemini" ? "/v1beta/models" : "/v1/models";
}

function parseBoundedInteger(
  value: unknown,
  min: number,
  max: number,
  stage: string,
): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ProviderError("invalid_provider_config", stage);
  }
  if (value < min || value > max) {
    throw new ProviderError("invalid_provider_config", stage);
  }
  return value;
}

function parseDiscoveryPath(value: unknown, stage: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_DISCOVERY_PATH_LENGTH ||
    !DISCOVERY_PATH_RE.test(value) ||
    value.includes("..") ||
    value.startsWith("//")
  ) {
    // `//host` would be a protocol-relative URL and `..` a traversal; both would
    // redirect discovery away from the base URL the operator approved.
    throw new ProviderError("invalid_provider_config", stage);
  }
  return value;
}

/**
 * Strict provider configuration parsing.
 *
 * Unknown keys are rejected rather than ignored, which is what makes header
 * smuggling structurally impossible: there is no key in this schema that can
 * carry an `Authorization` value, and an attempt to add one fails loudly instead
 * of being silently dropped. A non-plain prototype is rejected for the same
 * reason — an inherited `timeoutMs` must not shadow the validated value.
 */
export function parseProviderConfig(
  input: unknown,
  kind: ProviderKind,
): ProviderConfig {
  if (input === undefined) {
    return {
      timeoutMs: TIMEOUT_MS_DEFAULT,
      discoveryPath: defaultDiscoveryPath(kind),
      modelLimit: MODEL_LIMIT_DEFAULT,
    };
  }
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input)
  ) {
    throw new ProviderError("invalid_provider_config", "config-shape");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ProviderError("invalid_provider_config", "config-prototype");
  }

  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new ProviderError("invalid_provider_config", "config-unknown-key");
    }
  }

  if (record.supportsTools !== undefined && typeof record.supportsTools !== "boolean") {
    throw new ProviderError("invalid_provider_config", "config-supports-tools");
  }

  return {
    ...(record.supportsTools === undefined
      ? {}
      : { supportsTools: record.supportsTools as boolean }),
    timeoutMs:
      record.timeoutMs === undefined
        ? TIMEOUT_MS_DEFAULT
        : parseBoundedInteger(
            record.timeoutMs,
            TIMEOUT_MS_MIN,
            TIMEOUT_MS_MAX,
            "config-timeout",
          ),
    discoveryPath:
      record.discoveryPath === undefined
        ? defaultDiscoveryPath(kind)
        : parseDiscoveryPath(record.discoveryPath, "config-discovery-path"),
    modelLimit:
      record.modelLimit === undefined
        ? MODEL_LIMIT_DEFAULT
        : parseBoundedInteger(
            record.modelLimit,
            MODEL_LIMIT_MIN,
            MODEL_LIMIT_MAX,
            "config-model-limit",
          ),
  };
}
