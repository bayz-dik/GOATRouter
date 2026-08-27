import { egressPolicyOf, type ProviderConfig } from "./config.js";
import { discoverGeminiModels } from "./discovery-gemini.js";
import { discoverOpenAiModels } from "./discovery-openai.js";
import { assertRequestEgressAllowed, type EgressResolver } from "./egress.js";
import { ProviderError, type ProviderErrorCode } from "./errors.js";
import type { Fetcher } from "./http.js";
import { MODEL_LIMIT_MAX } from "./config.js";
import { hostnameOfBaseUrl, type ProviderKind } from "./url.js";

/**
 * Capability and connectivity probing.
 *
 * The rule that shapes this whole module: **a model discovery endpoint does not
 * reveal tool or streaming support.** Nothing here infers them. `unknown` is a
 * first-class value in the report, and an operator reading `unknown` learns the truth
 * — that BAYZ has no way to find out — rather than a guess they would then trust.
 */

/**
 * Every code a probe may report.
 *
 * Fixed and frozen: a probe result crosses into the API and the dashboard, so the
 * code has to be an enum a UI can switch on rather than free text that might one day
 * carry an upstream error body.
 */
export const CONNECTION_FAILURE_CODES = Object.freeze([
  "invalid_provider_config",
  "credential_missing",
  "unsupported_operation",
  "unreachable",
  "auth_failed",
  "rate_limited",
  "upstream_error",
  "discovery_failed",
] as const);

export type ConnectionFailureCode = (typeof CONNECTION_FAILURE_CODES)[number];

/** Whether a capability was declared by the operator or simply not determined. */
export type CapabilitySource = "declared" | "undetermined";

/** Three states, and `unknown` is the honest one. */
export type CapabilityState = "unknown" | "yes" | "no";

export type ProviderCapabilities = {
  /** Whether model discovery actually worked. Probed, not assumed. */
  models: boolean;
  /** Usable models the probe saw, after the cap and the id filter. */
  modelCount: number;
  /** True when the upstream offered more models than the cap allowed. */
  capped: boolean;
  /**
   * Tool support.
   *
   * `yes`/`no` only ever come from the operator's own `supportsTools` declaration.
   * There is no wire probe for this: sending a real tool request to find out would
   * cost the operator money and still not distinguish "unsupported" from "the model
   * chose not to call anything".
   */
  tools: CapabilityState;
  toolsSource: CapabilitySource;
  /**
   * Streaming support.
   *
   * Always `unknown` today, and deliberately so. A probe would have to open a real
   * SSE completion; until that exists, claiming `yes` because the endpoint looks
   * OpenAI-shaped would be fabrication.
   */
  streaming: CapabilityState;
  streamingSource: CapabilitySource;
  /** Present only when `models` is false. */
  failureCode?: ConnectionFailureCode;
};

export type ConnectionResult = {
  ok: boolean;
  /** Wall-clock time for the probe. Present on success and on failure. */
  latencyMs: number;
  modelCount?: number;
  capped?: boolean;
  failureCode?: ConnectionFailureCode;
};

/** What a probe needs to know about a provider. Never the credential. */
export type ProbeTarget = {
  id: string;
  kind: ProviderKind;
  baseUrl: string;
  enabled: boolean;
  config: ProviderConfig;
};

export type ProbeOptions = {
  target: ProbeTarget;
  credential?: string;
  fetcher?: Fetcher;
  resolve?: EgressResolver;
  now?: () => number;
};

const FAILURE_CODE_SET = new Set<string>(CONNECTION_FAILURE_CODES);

/**
 * Reduce any thrown value to a reportable code.
 *
 * An unrecognized throw becomes `upstream_error` rather than being surfaced: a
 * message from an arbitrary exception could carry upstream text or a request URL, and
 * this value is rendered in a UI.
 */
function failureCodeOf(error: unknown): ConnectionFailureCode {
  if (error instanceof ProviderError && FAILURE_CODE_SET.has(error.code)) {
    return error.code as ConnectionFailureCode;
  }
  return "upstream_error";
}

/** The operator's declaration, or `unknown`. Never a guess. */
function declaredTools(config: ProviderConfig): {
  tools: CapabilityState;
  toolsSource: CapabilitySource;
} {
  if (config.supportsTools === true) {
    return { tools: "yes", toolsSource: "declared" };
  }
  if (config.supportsTools === false) {
    return { tools: "no", toolsSource: "declared" };
  }
  return { tools: "unknown", toolsSource: "undetermined" };
}

type Probe = {
  models: string[];
  capped: boolean;
};

/**
 * Run one discovery probe.
 *
 * The cap is read from the same place discovery reads it, so `capped` cannot disagree
 * with the list length. `capped` is derived by asking for one more than the cap is
 * unable to return — the collector stops at the cap, so a full result *may* mean more
 * exist upstream, and saying so is more useful than silently truncating.
 */
async function probeModels(options: ProbeOptions): Promise<Probe> {
  const { target, credential, fetcher, resolve } = options;

  if (!target.enabled) {
    throw new ProviderError("unsupported_operation", "probe-provider-disabled");
  }

  await assertRequestEgressAllowed(
    hostnameOfBaseUrl(target.baseUrl),
    egressPolicyOf(target.config),
    resolve,
  );

  const discoveryTarget = {
    kind: target.kind,
    baseUrl: target.baseUrl,
    config: target.config,
  };
  const shared = {
    provider: discoveryTarget,
    ...(credential === undefined ? {} : { credential }),
    ...(fetcher === undefined ? {} : { fetcher }),
    ...(resolve === undefined ? {} : { resolve }),
  };

  const models =
    target.kind === "gemini"
      ? await discoverGeminiModels(shared)
      : await discoverOpenAiModels(shared);

  const cap = Math.min(target.config.modelLimit, MODEL_LIMIT_MAX);
  return { models, capped: models.length >= cap };
}

/**
 * Report what a provider can do.
 *
 * A failed probe is reported, not thrown, for everything except a caller error: the
 * operator asked "what can this provider do", and "discovery does not work" is a real
 * answer to that question. A disabled provider and an unknown id *do* throw, because
 * those are the caller asking the wrong thing.
 */
export async function detectCapabilities(
  options: ProbeOptions,
): Promise<ProviderCapabilities> {
  const tools = declaredTools(options.target.config);
  const streaming = {
    streaming: "unknown" as CapabilityState,
    streamingSource: "undetermined" as CapabilitySource,
  };

  if (!options.target.enabled) {
    throw new ProviderError("unsupported_operation", "capabilities-provider-disabled");
  }

  try {
    const probe = await probeModels(options);
    return {
      models: true,
      modelCount: probe.models.length,
      capped: probe.capped,
      ...tools,
      ...streaming,
    };
  } catch (error) {
    return {
      models: false,
      modelCount: 0,
      capped: false,
      ...tools,
      ...streaming,
      failureCode: failureCodeOf(error),
    };
  }
}

/**
 * Test whether a provider actually answers.
 *
 * Latency is reported on failure as well as success: "refused in 2 ms" and "timed out
 * after 30 s" are different problems, and the number is what tells them apart.
 */
export async function testConnection(
  options: ProbeOptions,
): Promise<ConnectionResult> {
  const clock = options.now ?? (() => Date.now());
  const started = clock();
  const elapsed = (): number => Math.max(0, Math.round(clock() - started));

  try {
    const probe = await probeModels(options);
    return {
      ok: true,
      latencyMs: elapsed(),
      modelCount: probe.models.length,
      capped: probe.capped,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: elapsed(),
      failureCode: failureCodeOf(error),
    };
  }
}

/** Narrow an arbitrary string to a known failure code. */
export function isConnectionFailureCode(
  value: unknown,
): value is ConnectionFailureCode {
  return typeof value === "string" && FAILURE_CODE_SET.has(value);
}

/** Kept so a caller can map a raw provider error without importing the set. */
export function connectionFailureCodeOf(
  code: ProviderErrorCode,
): ConnectionFailureCode {
  return FAILURE_CODE_SET.has(code) ? (code as ConnectionFailureCode) : "upstream_error";
}
