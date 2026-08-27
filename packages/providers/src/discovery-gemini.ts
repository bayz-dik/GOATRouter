import { egressPolicyOf, safeCustomHeaders } from "./config.js";
import { assertRequestEgressAllowed, type EgressResolver } from "./egress.js";
import { ProviderError } from "./errors.js";
import { DEFAULT_MAX_BYTES, fetchJsonCapped, type Fetcher } from "./http.js";
import {
  collectModelCatalogue,
  collectModelIds,
  discoveryUrl,
  economicsClassifierFor,
  requireCredential,
  type DiscoveryTarget,
  type ModelCandidate,
  type ModelCatalogueEntry,
} from "./model-list.js";
import { hostnameOfBaseUrl } from "./url.js";

export type DiscoverGeminiOptions = {
  provider: DiscoveryTarget;
  credential?: string;
  fetcher?: Fetcher;
  maxBytes?: number;
  /** Injectable resolver for the pre-connect address check. */
  resolve?: EgressResolver;
};

/**
 * Gemini returns `{ models: [{ name: "models/<id>" }] }`. Only that shape is
 * accepted: silently falling back to the OpenAI envelope would let a
 * misconfigured base URL appear to work while pointing at the wrong service.
 */
function candidatesOf(body: unknown): unknown[] {
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const models = (body as { models?: unknown }).models;
    if (Array.isArray(models)) {
      return models;
    }
  }
  throw new ProviderError("discovery_failed", "response-shape");
}

function idsOf(candidates: readonly unknown[]): unknown[] {
  return candidates.map((entry) => geminiIdOf(entry));
}

/** The model id a Gemini entry carries, with the `models/` prefix stripped. */
function geminiIdOf(entry: unknown): unknown {
  const name =
    typeof entry === "object" && entry !== null
      ? (entry as { name?: unknown }).name
      : undefined;
  if (typeof name !== "string") {
    return undefined;
  }
  return name.startsWith("models/") ? name.slice("models/".length) : name;
}

function candidatePairs(candidates: readonly unknown[]): ModelCandidate[] {
  return candidates.map((entry) => ({ id: geminiIdOf(entry), entry }));
}

/**
 * Fetch and validate the raw Gemini candidate list.
 *
 * Shared by both entry points so the id-only and economics-bearing paths cannot
 * disagree about which models exist.
 */
async function fetchCandidates(
  options: DiscoverGeminiOptions,
): Promise<unknown[]> {
  const { provider, credential, fetcher, maxBytes = DEFAULT_MAX_BYTES } = options;

  if (provider.kind !== "gemini") {
    throw new ProviderError("unsupported_operation", "gemini-path-kind");
  }

  await assertRequestEgressAllowed(
    hostnameOfBaseUrl(provider.baseUrl),
    egressPolicyOf(provider.config),
    options.resolve,
  );

  const key = requireCredential(credential, "gemini-credential");

  const body = await fetchJsonCapped({
    url: discoveryUrl(provider),
    // The credential header is assigned after the custom ones, so a stored config
    // cannot displace it.
    headers: { ...safeCustomHeaders(provider.config), "x-goog-api-key": key },
    timeoutMs: provider.config.timeoutMs,
    maxBytes,
    malformedCode: "discovery_failed",
    fetcher,
  });

  return candidatesOf(body);
}

/**
 * Discover Gemini models.
 *
 * The key is sent as the `x-goog-api-key` header rather than the `?key=`
 * query parameter Google's docs show first: a URL-borne key would be written to
 * proxy logs, browser history, and any error that echoed a request URL.
 */
export async function discoverGeminiModels(
  options: DiscoverGeminiOptions,
): Promise<string[]> {
  const candidates = await fetchCandidates(options);
  return collectModelIds(idsOf(candidates), options.provider.config.modelLimit);
}

/**
 * Discover Gemini models with their economics.
 *
 * Every entry classifies `UNKNOWN` unless the provider is a loopback runtime, because
 * the Gemini catalogue carries no pricing at all. Google's free tier is real, but it is
 * not machine-provable from this response, and asserting `FREE_TIER` here would be BAYZ
 * inventing a fact on the operator's behalf.
 */
export async function discoverGeminiCatalogue(
  options: DiscoverGeminiOptions,
): Promise<ModelCatalogueEntry[]> {
  const candidates = await fetchCandidates(options);
  return collectModelCatalogue(
    candidatePairs(candidates),
    options.provider.config.modelLimit,
    economicsClassifierFor(options.provider),
  );
}
