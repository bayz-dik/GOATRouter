/**
 * The telemetry event boundary.
 *
 * One rule governs this file: a stored row is a **closed set of scalar metadata**,
 * built by copying named fields onto a fresh object. Nothing is filtered out,
 * because nothing is copied in unless it is named here. That is the difference
 * between a boundary and a denylist — a denylist needs updating every time an
 * upstream type gains a field, and forgetting once leaks a prompt.
 *
 * Every string is treated as untrusted. Every number is bounded. A malformed event
 * is dropped whole rather than written partially.
 */

/** Events the router can genuinely observe today. */
export const USAGE_EVENT_KINDS = [
  "request.completed",
  "request.failed",
  "provider.attempted",
  "provider.failed",
  "failover.started",
] as const;

export type UsageEventKind = (typeof USAGE_EVENT_KINDS)[number];

/**
 * Normalized failure categories.
 *
 * A closed enum is what makes "no arbitrary upstream error text" structural: there
 * is no column an error body could occupy, and an unrecognized code becomes
 * `unknown_error` rather than being stored verbatim.
 */
export const FAILURE_CATEGORIES = [
  "auth_failed",
  "rate_limited",
  "unreachable",
  "timeout",
  "upstream_error",
  "invalid_response",
  "response_too_large",
  "credential_missing",
  "no_route",
  "all_routes_failed",
  "unsupported_operation",
  "proxy_error",
  "forbidden",
  "refused",
  "protocol_error",
  "unknown_error",
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export const ROUTING_MODES = ["direct", "combo", "failover"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

export type UsageOutcome = "ok" | "failed";

/** 24 hours: any longer and the value is a bug, not a slow request. */
export const MAX_LATENCY_MS = 86_400_000;
export const MAX_ATTEMPTS = 100;
export const MAX_TOKENS = 100_000_000;
const MAX_ID_LENGTH = 64;
const MAX_MODEL_LENGTH = 128;
/** Timestamps must fall within this window of now, else they are replaced. */
const TIMESTAMP_WINDOW_MS = 24 * 3600_000;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MODEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,126}[A-Za-z0-9])?$/;

const KIND_SET = new Set<string>(USAGE_EVENT_KINDS);
const CATEGORY_SET = new Set<string>(FAILURE_CATEGORIES);
const MODE_SET = new Set<string>(ROUTING_MODES);

/**
 * A normalized usage row.
 *
 * This type *is* the privacy contract: if a field is not here, it cannot be stored,
 * and a test asserts the row's key set matches exactly.
 */
export type UsageRow = {
  kind: UsageEventKind;
  requestId: string;
  occurredAt: string;
  routeId: string | undefined;
  providerId: string | undefined;
  proxyId: string | undefined;
  model: string;
  routingMode: RoutingMode;
  outcome: UsageOutcome;
  failureCategory: FailureCategory | undefined;
  latencyMs: number;
  attempts: number;
  promptTokens: number | undefined;
  completionTokens: number | undefined;
  cachedTokens: number | undefined;
};

/** The exact key set of a row, exported so a test can pin it. */
export function usageRowFields(): readonly (keyof UsageRow)[] {
  return [
    "kind",
    "requestId",
    "occurredAt",
    "routeId",
    "providerId",
    "proxyId",
    "model",
    "routingMode",
    "outcome",
    "failureCategory",
    "latencyMs",
    "attempts",
    "promptTokens",
    "completionTokens",
    "cachedTokens",
  ];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A required identifier: invalid means the whole event is dropped. */
function requiredId(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= MAX_ID_LENGTH &&
    ID_RE.test(value)
    ? value
    : undefined;
}

/**
 * An optional identifier: invalid degrades to absent.
 *
 * Dropping the whole record because a proxy id was malformed would lose the
 * request entirely, which is worse than losing one attribute of it.
 */
function optionalId(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requiredId(value);
}

function boundedInteger(value: unknown, max: number): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= max
    ? value
    : undefined;
}

/**
 * A token count.
 *
 * `undefined` means the provider did not report one. It must never become `0`:
 * "reported zero tokens" and "reported nothing" are different facts, and merging
 * them would silently falsify every aggregate built on top.
 */
function tokenCount(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return boundedInteger(value, MAX_TOKENS);
}

export function normalizeFailureCategory(value: unknown): FailureCategory {
  return typeof value === "string" && CATEGORY_SET.has(value)
    ? (value as FailureCategory)
    : "unknown_error";
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (
      Number.isFinite(parsed) &&
      Math.abs(parsed - Date.now()) <= TIMESTAMP_WINDOW_MS
    ) {
      return value;
    }
  }
  // A timestamp far in the future would sort above every real record and survive
  // retention forever, so an implausible value is replaced rather than trusted.
  return new Date().toISOString();
}

/**
 * Turn an arbitrary event into a stored row, or return `undefined`.
 *
 * The input is deliberately typed as `unknown`: callers may hand over an object
 * assembled from upstream data, and pretending it is already a known shape is how
 * a prompt ends up in a database.
 */
export function normalizeUsageEvent(event: unknown): UsageRow | undefined {
  if (!isPlainObject(event)) {
    return undefined;
  }

  const kind = event.kind;
  if (typeof kind !== "string" || !KIND_SET.has(kind)) {
    return undefined;
  }

  const requestId = requiredId(event.requestId);
  if (requestId === undefined) {
    return undefined;
  }

  const model = event.model;
  if (
    typeof model !== "string" ||
    model.length === 0 ||
    model.length > MAX_MODEL_LENGTH ||
    !MODEL_RE.test(model)
  ) {
    return undefined;
  }

  const routingMode = event.routingMode;
  if (typeof routingMode !== "string" || !MODE_SET.has(routingMode)) {
    return undefined;
  }

  const latencyMs = boundedInteger(event.latencyMs, MAX_LATENCY_MS);
  if (latencyMs === undefined) {
    return undefined;
  }

  const attempts = boundedInteger(event.attempts, MAX_ATTEMPTS);
  if (attempts === undefined) {
    return undefined;
  }

  const providerId = optionalId(event.providerId);
  // An attempt event exists to name a provider; without one it identifies nothing.
  if (
    (kind === "provider.attempted" ||
      kind === "provider.failed" ||
      kind === "failover.started") &&
    providerId === undefined
  ) {
    return undefined;
  }

  const failed = kind === "request.failed" || kind === "provider.failed";

  // Built field by field onto a fresh object. Any key not named below simply does
  // not exist on the result, which is what makes the closed set structural.
  const row: UsageRow = {
    kind: kind as UsageEventKind,
    requestId,
    occurredAt: normalizeTimestamp(event.occurredAt),
    routeId: optionalId(event.routeId),
    providerId,
    proxyId: optionalId(event.proxyId),
    model,
    routingMode: routingMode as RoutingMode,
    outcome: failed ? "failed" : "ok",
    failureCategory: failed ? normalizeFailureCategory(event.failureCategory) : undefined,
    latencyMs,
    attempts,
    promptTokens: tokenCount(event.promptTokens),
    completionTokens: tokenCount(event.completionTokens),
    cachedTokens: tokenCount(event.cachedTokens),
  };

  return row;
}
