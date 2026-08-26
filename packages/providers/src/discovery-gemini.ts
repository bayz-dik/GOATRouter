import { ProviderError } from "./errors.js";
import { DEFAULT_MAX_BYTES, fetchJsonCapped, type Fetcher } from "./http.js";
import {
  collectModelIds,
  discoveryUrl,
  requireCredential,
  type DiscoveryTarget,
} from "./model-list.js";

export type DiscoverGeminiOptions = {
  provider: DiscoveryTarget;
  credential?: string;
  fetcher?: Fetcher;
  maxBytes?: number;
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
  return candidates.map((entry) => {
    const name =
      typeof entry === "object" && entry !== null
        ? (entry as { name?: unknown }).name
        : undefined;
    if (typeof name !== "string") {
      return undefined;
    }
    return name.startsWith("models/") ? name.slice("models/".length) : name;
  });
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
  const { provider, credential, fetcher, maxBytes = DEFAULT_MAX_BYTES } = options;

  if (provider.kind !== "gemini") {
    throw new ProviderError("unsupported_operation", "gemini-path-kind");
  }

  const key = requireCredential(credential, "gemini-credential");

  const body = await fetchJsonCapped({
    url: discoveryUrl(provider),
    headers: { "x-goog-api-key": key },
    timeoutMs: provider.config.timeoutMs,
    maxBytes,
    malformedCode: "discovery_failed",
    fetcher,
  });

  return collectModelIds(idsOf(candidatesOf(body)), provider.config.modelLimit);
}
