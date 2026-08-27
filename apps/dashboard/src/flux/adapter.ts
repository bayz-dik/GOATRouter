import { FAILURE_CATEGORY_KEYS } from "./failure-categories";
import { ICON_KEYS, type FluxIconKey } from "./identity";
import type {
  FluxCoreViewModel,
  FluxProvider,
  FluxProviderState,
  FluxRouteParticipation,
  FluxRoutingMode,
} from "./types";
import { FLUX_NAMES, FLUX_SHARE } from "./engine";

/**
 * Real-telemetry adapter.
 *
 * Maps authenticated Usage API output onto the LOCKED Flux Core display-safe
 * boundary. Two rules govern it:
 *
 *  1. **Live and demo never merge.** A live model is built only from live data; an
 *     empty live field stays empty rather than being backfilled with demo values.
 *     An operator must never look at a chart and see invented providers.
 *  2. **Unknown stays unknown.** No token count, latency, cost, health, or traffic
 *     figure is fabricated. A field the API did not report is absent, and the model
 *     says so explicitly (`tokens.known`, `cost.available`).
 *
 * The function is pure: same input, same output, no timers, no React. High-frequency
 * animation stays in the canvas engine, and this only supplies bounded low-frequency
 * state.
 */

const MAX_DISPLAY_NAME = 128;

/** API row shapes, typed loosely because they cross a network boundary. */
export type UsageSummaryResponse = {
  period: string;
  totalRequests: number;
  okRequests: number;
  failedRequests: number;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
  tokenReports: number;
  averageLatencyMs: number | null;
  costAvailable: boolean;
  costReason: string;
};

export type UsageProviderRow = {
  providerId: string;
  displayName: string;
  kind: string;
  enabled: boolean;
  credentialPresent: boolean;
  attempts: number;
  failures: number;
  lastOutcome: "ok" | "failed" | null;
  lastFailureCategory: string | null;
  averageLatencyMs: number | null;
};

export type UsageRequestRow = {
  requestId: string;
  occurredAt: string;
  routeId: string | null;
  providerId: string | null;
  proxyId: string | null;
  model: string;
  routingMode: string;
  outcome: string;
  failureCategory: string | null;
  latencyMs: number;
  attempts: number;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
};

export type LiveViewModelInput = {
  summary: UsageSummaryResponse | undefined;
  providers: UsageProviderRow[] | undefined;
  requests?: UsageRequestRow[];
};

/**
 * Provider kind → local icon key. An unknown kind gets the generic mark.
 *
 * The mapping is a fixed local table in both directions: a kind whose name happens to
 * match an icon key uses it, and everything else is named explicitly here. Nothing in
 * an API response can introduce a new key, so provider metadata still cannot become an
 * asset reference or markup.
 */
const KIND_ICON_KEYS: Readonly<Record<string, FluxIconKey>> = {
  "custom-openai": "custom",
};

function iconFor(kind: unknown): FluxIconKey {
  if (typeof kind !== "string") {
    return "generic";
  }
  const mapped = Object.hasOwn(KIND_ICON_KEYS, kind) ? KIND_ICON_KEYS[kind] : undefined;
  if (mapped !== undefined) {
    return mapped;
  }
  return (ICON_KEYS as readonly string[]).includes(kind) ? (kind as FluxIconKey) : "generic";
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

/** A category the display layer is willing to show, or the safe fallback. */
function safeCategory(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return typeof value === "string" && FAILURE_CATEGORY_KEYS.has(value)
    ? value
    : "unknown_error";
}

/**
 * Derive provider state from real attempt history.
 *
 * Ordering matters: a disabled provider is `off` regardless of history, because
 * that is an operator decision rather than an incident. Everything else is read
 * from what actually happened.
 */
function deriveState(row: UsageProviderRow): FluxProviderState {
  if (row.enabled !== true) {
    return "off";
  }
  const attempts = nonNegativeInteger(row.attempts) ?? 0;
  const failures = nonNegativeInteger(row.failures) ?? 0;

  if (attempts === 0) {
    // Enabled and reachable in principle, but carrying no traffic.
    return "standby";
  }
  if (row.lastOutcome === "failed") {
    // Every recent attempt failed: an incident, not a wobble.
    return failures >= attempts ? "failed" : "degraded";
  }
  if (failures === 0) {
    return "active";
  }
  // The latest attempt succeeded after failures. A majority-failure history reads
  // as recovering; a minority reads as degraded.
  return failures * 2 > attempts ? "recovering" : "degraded";
}

function deriveParticipation(row: UsageProviderRow, state: FluxProviderState): FluxRouteParticipation {
  if (state === "off") {
    return "none";
  }
  if (state === "standby") {
    return "reserve";
  }
  const attempts = nonNegativeInteger(row.attempts) ?? 0;
  return attempts > 0 ? "combo" : "reserve";
}

function displayNameOf(row: UsageProviderRow): string {
  const name = typeof row.displayName === "string" ? row.displayName.trim() : "";
  if (name.length === 0) {
    // Falling back to the id keeps the provider identifiable rather than blank.
    return String(row.providerId);
  }
  return name.length > MAX_DISPLAY_NAME ? name.slice(0, MAX_DISPLAY_NAME) : name;
}

/**
 * Build a live view model.
 *
 * Only the display-safe provider fields are constructed — the mapping is
 * copy-by-name, so a `credential`, `apiKey`, or `prompt` field on an API row has no
 * destination and cannot cross.
 */
export function buildLiveViewModel(input: LiveViewModelInput): FluxCoreViewModel {
  const rows = Array.isArray(input.providers) ? input.providers : [];

  const usable = rows.filter(
    (row) => typeof row?.providerId === "string" && row.providerId.length > 0,
  );

  const totalAttempts = usable.reduce(
    (sum, row) => sum + (nonNegativeInteger(row.attempts) ?? 0),
    0,
  );

  const providers: FluxProvider[] = usable.map((row) => {
    const state = deriveState(row);
    const attempts = nonNegativeInteger(row.attempts) ?? 0;
    const latencyMs = finiteNonNegative(row.averageLatencyMs);
    const incidentReason =
      state === "failed" || state === "degraded" || state === "recovering"
        ? safeCategory(row.lastFailureCategory)
        : undefined;

    return {
      id: String(row.providerId),
      displayName: displayNameOf(row),
      iconKey: iconFor(row.kind),
      state,
      // Share is real participation, not an invented weight.
      sharePercent: totalAttempts === 0 ? 0 : Math.round((attempts / totalAttempts) * 100),
      routeParticipation: deriveParticipation(row, state),
      ...(latencyMs === undefined ? {} : { latencyMs }),
      ...(incidentReason === undefined ? {} : { incidentReason }),
    };
  });

  const summary = input.summary;
  const tokenReports = nonNegativeInteger(summary?.tokenReports) ?? 0;
  const tokensKnown = tokenReports > 0;

  const carrying = providers.filter(
    (provider) => provider.state === "active" || provider.state === "recovering",
  ).length;
  const failing = providers.filter(
    (provider) => provider.state === "failed" || provider.state === "degraded",
  ).length;

  // A recent failover in request history is authoritative; otherwise mode follows
  // the observed participant set.
  const recentFailover = (input.requests ?? []).some(
    (request) => request?.routingMode === "failover",
  );
  const routingMode: FluxRoutingMode = recentFailover
    ? "failover"
    : failing > 0 && carrying > 0
      ? "failover"
      : carrying >= 2
        ? "combo"
        : "direct";

  // Load is derived from real activity: attempts against the busiest observed
  // window, bounded. With no traffic it is zero, not a decorative baseline.
  const loadPercent =
    totalAttempts === 0 ? 0 : Math.min(100, Math.round(Math.log2(totalAttempts + 1) * 12));

  return {
    source: "live",
    providers,
    ...(nonNegativeInteger(summary?.totalRequests) === undefined
      ? {}
      : { routedRequests: nonNegativeInteger(summary?.totalRequests) }),
    routingMode,
    loadPercent,
    ...(summary === undefined ? {} : { period: String(summary.period) }),
    tokens: {
      known: tokensKnown,
      ...(tokensKnown && summary?.promptTokens !== null && summary?.promptTokens !== undefined
        ? { promptTokens: summary.promptTokens }
        : {}),
      ...(tokensKnown &&
      summary?.completionTokens !== null &&
      summary?.completionTokens !== undefined
        ? { completionTokens: summary.completionTokens }
        : {}),
      ...(tokensKnown && summary?.cachedTokens !== null && summary?.cachedTokens !== undefined
        ? { cachedTokens: summary.cachedTokens }
        : {}),
    },
    cost: {
      // Never a number: Bayz has no pricing table, so the honest answer is that the
      // figure is unavailable and why.
      available: false,
      reason: summary?.costReason ?? "no_pricing_data",
    },
  };
}

/**
 * The approved demo adapter.
 *
 * Kept in one place and explicitly labelled `simulation`, so no code path can slip
 * demo numbers into a live view.
 */
export function buildDemoViewModel(): FluxCoreViewModel {
  return {
    source: "simulation",
    providers: FLUX_NAMES.map((name, index) => ({
      id: `sim-${name.toLowerCase()}`,
      displayName: name,
      iconKey: name.toLowerCase(),
      state: "active" as const,
      sharePercent: FLUX_SHARE[index] ?? 0,
      routeParticipation: "combo" as const,
    })),
    routingMode: "combo",
  };
}
