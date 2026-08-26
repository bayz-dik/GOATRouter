import { ProviderError } from "./errors.js";
import { DEFAULT_MAX_BYTES, fetchJsonCapped, type Fetcher } from "./http.js";
import {
  collectModelIds,
  discoveryUrl,
  requireCredential,
  type DiscoveryTarget,
} from "./model-list.js";

export type DiscoverOpenAiOptions = {
  provider: DiscoveryTarget;
  credential?: string;
  fetcher?: Fetcher;
  maxBytes?: number;
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

/**
 * Discover models from an OpenAI-compatible endpoint. OpenRouter uses the same
 * wire format and therefore the same path, differing only in requiring a key.
 */
export async function discoverOpenAiModels(
  options: DiscoverOpenAiOptions,
): Promise<string[]> {
  const { provider, credential, fetcher, maxBytes = DEFAULT_MAX_BYTES } = options;

  if (provider.kind === "codex-oauth") {
    // Deferred honestly: the OAuth device flow needs an external account, so
    // pretending to discover here would fabricate capability.
    throw new ProviderError("unsupported_operation", "codex-discovery");
  }
  if (provider.kind === "gemini") {
    throw new ProviderError("unsupported_operation", "gemini-openai-path");
  }

  const headers: Record<string, string> = {};
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

  return collectModelIds(idsOf(candidatesOf(body)), provider.config.modelLimit);
}
