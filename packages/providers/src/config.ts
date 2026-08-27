import type { EgressPolicy } from "./egress.js";
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
  /**
   * Extra request headers a relay needs.
   *
   * Allowlisted by name pattern *then* denylisted, in that order — see
   * `parseCustomHeaders`. Names are normalized to lower case so the denylist cannot be
   * evaded by casing and so two spellings of one header cannot both be set.
   */
  headers?: Record<string, string>;
  /** Opt in to dialling loopback, for a local model runtime. Default is deny. */
  allowLoopback?: boolean;
  /** Opt in to dialling a private/LAN address. Default is deny. */
  allowPrivate?: boolean;
};

export const MAX_CUSTOM_HEADERS = 8;
export const MAX_HEADER_VALUE_LENGTH = 1024;

/** Letters, digits, and hyphens; must start with a letter. Bounded at 64. */
const HEADER_NAME_RE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
/** Printable ASCII only: no CR, no LF, no NUL, no tab, nothing above 0x7e. */
const HEADER_VALUE_RE = /^[\x20-\x7e]*$/;

/**
 * Headers a provider config may never set.
 *
 * Each one would either forge BAYZ's own authentication (`authorization`,
 * `proxy-authorization`), redirect the request (`host`), corrupt framing
 * (`content-length`, `transfer-encoding`, `connection`, `te`, `trailer`), or carry
 * ambient credentials (`cookie`).
 */
const DENIED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "host",
  "cookie",
  "set-cookie",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "keep-alive",
  "accept-encoding",
]);

/** Whole families that are forbidden by prefix rather than by exact name. */
const DENIED_PREFIXES = ["sec-", "proxy-"];

function parseCustomHeaders(value: unknown, stage: string): Record<string, string> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new ProviderError("invalid_provider_config", stage);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    // An inherited header would be sent without ever having been validated.
    throw new ProviderError("invalid_provider_config", "config-header-prototype");
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_CUSTOM_HEADERS) {
    throw new ProviderError("invalid_provider_config", "config-header-count");
  }

  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of entries) {
    // Allowlist first: the shape has to be sane before the name is judged.
    if (!HEADER_NAME_RE.test(rawName)) {
      throw new ProviderError("invalid_provider_config", "config-header-name");
    }
    const name = rawName.toLowerCase();
    // Denylist second, on the normalized name. Folding these into the pattern would
    // make `Authorization` pass while `authorization` failed.
    if (
      DENIED_HEADERS.has(name) ||
      DENIED_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      // The rejected header's *name* rides along, because "invalid config" would leave
      // an operator bisecting eight headers to find the one at fault. Never the value.
      throw new ProviderError(
        "invalid_provider_config",
        "config-header-denied",
        name,
      );
    }
    if (Object.hasOwn(headers, name)) {
      // Two spellings of one header: keeping either would make the winner depend on
      // insertion order.
      throw new ProviderError("invalid_provider_config", "config-header-duplicate");
    }
    if (typeof rawValue !== "string") {
      throw new ProviderError("invalid_provider_config", "config-header-value-type");
    }
    if (rawValue.length > MAX_HEADER_VALUE_LENGTH) {
      throw new ProviderError("invalid_provider_config", "config-header-value-length");
    }
    if (!HEADER_VALUE_RE.test(rawValue)) {
      // Header injection: a CRLF in a value would end the header and let the operator
      // — or whoever wrote their config — append arbitrary further headers.
      throw new ProviderError("invalid_provider_config", "config-header-value-bytes");
    }
    headers[name] = rawValue;
  }
  return headers;
}

function parseBoolean(value: unknown, stage: string): boolean {
  if (typeof value !== "boolean") {
    throw new ProviderError("invalid_provider_config", stage);
  }
  return value;
}

/**
 * The egress policy a config expresses.
 *
 * One function, so every call site agrees on what "no opt-in" means. Absent is
 * `false`: a config that was written before these keys existed denies by default.
 */
export function egressPolicyOf(config: ProviderConfig): EgressPolicy {
  return {
    allowLoopback: config.allowLoopback === true,
    allowPrivate: config.allowPrivate === true,
  };
}

/**
 * The configured headers that are safe to put on the wire.
 *
 * `parseProviderConfig` already refuses a denied header, so in normal operation this
 * filters nothing. It exists because the send path must not depend on that: a row
 * written by an older build, edited by hand, or produced by a future code path that
 * forgets to re-parse would otherwise forge `authorization` or redirect the request
 * with `host`. Filtering here is silent by design — the loud rejection belongs at
 * configuration time, and a request is the wrong place to fail for a stored defect.
 */
export function safeCustomHeaders(
  config: Partial<Pick<ProviderConfig, "headers">> & Record<string, unknown>,
): Record<string, string> {
  const configured = config.headers;
  if (configured === undefined || configured === null) {
    return {};
  }
  const safe: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(configured)) {
    if (typeof rawValue !== "string" || !HEADER_NAME_RE.test(rawName)) {
      continue;
    }
    const name = rawName.toLowerCase();
    if (DENIED_HEADERS.has(name) || DENIED_PREFIXES.some((p) => name.startsWith(p))) {
      continue;
    }
    if (rawValue.length > MAX_HEADER_VALUE_LENGTH || !HEADER_VALUE_RE.test(rawValue)) {
      continue;
    }
    safe[name] = rawValue;
  }
  return safe;
}

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
  "headers",
  "allowLoopback",
  "allowPrivate",
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
    ...(record.headers === undefined
      ? {}
      : { headers: parseCustomHeaders(record.headers, "config-headers") }),
    ...(record.allowLoopback === undefined
      ? {}
      : { allowLoopback: parseBoolean(record.allowLoopback, "config-allow-loopback") }),
    ...(record.allowPrivate === undefined
      ? {}
      : { allowPrivate: parseBoolean(record.allowPrivate, "config-allow-private") }),
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
