/**
 * Display-safe input boundary for Flux Core V2.
 *
 * This is the only shape the visualization accepts. It carries labels, states,
 * counts, and icon *keys* — never a provider credential, proxy password, API
 * token, Authorization header, or any value read out of secret storage. Those
 * have no read path in the Bayz API and must not acquire one here.
 *
 * `source` is explicit rather than inferred: until real usage telemetry exists,
 * Flux Core runs the approved simulation and says so on screen, instead of
 * presenting invented numbers as measurements.
 */

/**
 * Provider lifecycle as the visualization understands it.
 *
 * `failed` and `recovering` are distinct from `off`: a disabled provider is an
 * operator decision, a failed one is an incident that must keep its identity and
 * receive label priority.
 */
export type FluxProviderState =
  | "active"
  | "degraded"
  | "failed"
  | "recovering"
  | "standby"
  | "off";

/** Whether a provider is currently carrying routed traffic. */
export type FluxRouteParticipation = "primary" | "combo" | "reserve" | "none";

export type FluxProvider = {
  /** Stable, non-secret identifier. Also seeds the safe short id. */
  id: string;
  /** Human-readable label. Untrusted text, never markup. */
  displayName: string;
  state: FluxProviderState;
  /** Whole-percent traffic share, clamped for display. */
  sharePercent: number;
  /**
   * Key into the local icon table. An unknown or hostile value falls back to the
   * generic mark; provider-supplied SVG, URLs, and data URIs are never rendered.
   */
  iconKey?: string;
  routeParticipation?: FluxRouteParticipation;
  /** 0..100 instantaneous load, when a real metric exists. */
  loadPercent?: number;
  /** Round-trip latency in milliseconds, when measured. */
  latencyMs?: number;
  /** Operator-facing failure reason. Untrusted text. */
  incidentReason?: string;
};

export type FluxActivityEvent = {
  id: string;
  /** Provider or subsystem label. Untrusted text. */
  label: string;
  /** Event description. Untrusted text. */
  message: string;
};

export type FluxRoutingMode = "combo" | "direct" | "failover";

export type FluxCoreViewModel = {
  /**
   * `"simulation"` means the approved demo adapter is driving the view.
   * `"live"` means every field came from the Bayz API. The two are never blended.
   */
  source: "simulation" | "live";
  providers: FluxProvider[];
  /** Total routed requests, for the core stat line. */
  routedRequests?: number;
  /** Overrides the mode derived from participation. */
  routingMode?: FluxRoutingMode;
  /** 0..100 network load for the meter, when a real metric exists. */
  loadPercent?: number;
  /** Recent events for the activity list. */
  activity?: FluxActivityEvent[];
  /** Selected usage period label, purely for display. */
  period?: string;
};

/**
 * The approved five positions are reproduced exactly for 1..5 providers.
 * Beyond that the constellation expands outward; no provider is ever dropped.
 */
export const FLUX_APPROVED_PROVIDERS = 5;

export type FluxTempo = "calm" | "live" | "surge";
