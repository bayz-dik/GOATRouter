import { egressPolicyOf, safeCustomHeaders } from "./config.js";
import {
  assertRequestEgressAllowed,
  type EgressResolver,
} from "./egress.js";
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

export type DiscoverOpenAiOptions = {
  provider: DiscoveryTarget;
  credential?: string;
  fetcher?: Fetcher;
  maxBytes?: number;
  /** Injectable resolver for the pre-connect address check. */
  resolve?: EgressResolver;
};

/**
 * Extract the candidate entries from an OpenAI-style body.
 *
 * Both the documented `{ object: "list", data: [...] }` envelope and the bare
 * array that several local runtimes return are accepted; anything else is a
 * structural failure rather than a silent empty list, because "no models" and
 * "unintelligible response" call for different operator action.
 */
function candidatesOf(body: unknown): unknown[] {
  if (Array.isArray(body)) {
    return body;
  }
  if (typeof body === "object" && body !== null) {
    const data = (body as { data?: unknown }).data;
    if (Array.isArray(data)) {
      return data;
    }
  }
  throw new ProviderError("discovery_failed", "response-shape");
}

function idsOf(candidates: readonly unknown[]): unknown[] {
  return candidates.map((entry) =>
    typeof entry === "object" && entry !== null
      ? (entry as { id?: unknown }).id
      : undefined,
  );
}

/** Pair each extracted id with the entry it came from, in one pass. */
function candidatePairs(candidates: readonly unknown[]): ModelCandidate[] {
  return candidates.map((entry) => ({
    id:
      typeof entry === "object" && entry !== null
        ? (entry as { id?: unknown }).id
        : undefined,
    entry,
  }));
}

/**
 * Fetch and validate the raw candidate list.
 *
 * Shared by both public entry points, which is the whole reason they cannot disagree
 * about which models exist.
 */
async function fetchCandidates(
  options: DiscoverOpenAiOptions,
): Promise<unknown[]> {
  const { provider, credential, fetcher, maxBytes = DEFAULT_MAX_BYTES } = options;

  if (provider.kind === "codex-oauth") {
    // Deferred honestly: the OAuth device flow needs an external account, so
    // pretending to discover here would fabricate capability.
    throw new ProviderError("unsupported_operation", "codex-discovery");
  }
  if (provider.kind === "gemini") {
    throw new ProviderError("unsupported_operation", "gemini-openai-path");
  }

  // Before anything else, and before any socket: a stored row can hold a base URL
  // the current policy forbids, because loading such a row is deliberately allowed
  // so a pre-9D install still starts.
  await assertRequestEgressAllowed(
    hostnameOfBaseUrl(provider.baseUrl),
    egressPolicyOf(provider.config),
    options.resolve,
  );

  // Custom headers go on first, so a credential or framing header can never be
  // overwritten by one: the assignments below win.
  const headers: Record<string, string> = safeCustomHeaders(provider.config);
  if (provider.kind === "openrouter") {
    // A hosted aggregator never serves an anonymous catalogue, so failing before
    // the request keeps a pointless unauthenticated call off the wire.
    headers.authorization = `Bearer ${requireCredential(
      credential,
      "openrouter-credential",
    )}`;
  } else if (typeof credential === "string" && credential.trim().length > 0) {
    // Local OpenAI-compatible runtimes on Termux commonly need no key at all.
    headers.authorization = `Bearer ${credential}`;
  }

  const body = await fetchJsonCapped({
    url: discoveryUrl(provider),
    headers,
    timeoutMs: provider.config.timeoutMs,
    maxBytes,
    malformedCode: "discovery_failed",
    fetcher,
  });

  return candidatesOf(body);
}

/**
 * Discover models from an OpenAI-compatible endpoint. OpenRouter uses the same
 * wire format and therefore the same path, differing only in requiring a key.
 *
 * Kept returning `string[]` for backward compatibility. Every existing caller and
 * smoke depends on that contract, and the catalogue variant below is additive.
 */
export async function discoverOpenAiModels(
  options: DiscoverOpenAiOptions,
): Promise<string[]> {
  const candidates = await fetchCandidates(options);
  return collectModelIds(idsOf(candidates), options.provider.config.modelLimit);
}

/**
 * Discover models with their economics.
 *
 * Goes through the same fetch, the same shape validation, the same id filter, and the
 * same cap as `discoverOpenAiModels`, so the two cannot report different model sets. A
 * model whose economics cannot be determined appears as `UNKNOWN` rather than being
 * dropped: it exists and routing can reach it, so hiding it would be a silent
 * capability loss.
 */
export async function discoverOpenAiCatalogue(
  options: DiscoverOpenAiOptions,
): Promise<ModelCatalogueEntry[]> {
  const candidates = await fetchCandidates(options);
  return collectModelCatalogue(
    candidatePairs(candidates),
    options.provider.config.modelLimit,
    economicsClassifierFor(options.provider),
  );
}
