/**
 * Display-safe input boundary for Flux Core V2.
 *
 * This is the only shape the visualization accepts. It carries labels, states, and
 * counts — never a provider credential, proxy password, API token, Authorization
 * header, or any value read out of secret storage. Those have no read path in the
 * Bayz API and must not acquire one here.
 *
 * `source` is explicit rather than inferred: until real usage telemetry exists,
 * Flux Core runs the approved simulation and says so on screen, instead of
 * presenting invented numbers as measurements.
 */

export type FluxProviderState = "active" | "degraded" | "off" | "wake";

export type FluxProvider = {
  /** Stable identifier, used only as a React key and an ARIA label. */
  id: string;
  /** Human-readable label. Treated as untrusted text and never as markup. */
  label: string;
  state: FluxProviderState;
  /** Whole-percent traffic share, clamped for display. */
  sharePercent: number;
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
   * `"simulation"` means the approved demo behavior is driving the view.
   * `"live"` means every field came from the Bayz API.
   */
  source: "simulation" | "live";
  providers: FluxProvider[];
  /** Total routed requests, for the core stat line. */
  routedRequests?: number;
  /** Overrides the mode derived from the active provider count. */
  routingMode?: FluxRoutingMode;
  /** 0..100 network load for the meter, when a real metric exists. */
  loadPercent?: number;
  /** Recent events for the activity list. */
  activity?: FluxActivityEvent[];
  /** Selected usage period label, purely for display. */
  period?: string;
};

/** The approved five-position topology. Extra providers are not displayed. */
export const FLUX_MAX_PROVIDERS = 5;

export type FluxTempo = "calm" | "live" | "surge";
