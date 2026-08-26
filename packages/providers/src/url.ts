import { ProviderError } from "./errors.js";

/** Absolute cap on a stored base URL, before any path is appended. */
const MAX_BASE_URL_LENGTH = 2048;

export const PROVIDER_KINDS = [
  "openai-compatible",
  "openrouter",
  "gemini",
  "codex-oauth",
] as const;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export function isProviderKind(value: unknown): value is ProviderKind {
  return (
    typeof value === "string" && (PROVIDER_KINDS as readonly string[]).includes(value)
  );
}

export function assertProviderKind(value: unknown): ProviderKind {
  if (!isProviderKind(value)) {
    throw new ProviderError("invalid_provider_config", "provider-kind");
  }
  return value;
}

/**
 * Normalize an operator-supplied base URL.
 *
 * Userinfo is rejected and query/fragment are stripped because both are common
 * places for a credential to end up, and a credential inside a URL would be
 * written to the registry in cleartext and echoed into request logs. The
 * rejected input is never interpolated into the error for the same reason.
 */
export function normalizeBaseUrl(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ProviderError("invalid_provider_config", "base-url-type");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_BASE_URL_LENGTH) {
    throw new ProviderError("invalid_provider_config", "base-url-length");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ProviderError("invalid_provider_config", "base-url-parse");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderError("invalid_provider_config", "base-url-scheme");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ProviderError("invalid_provider_config", "base-url-userinfo");
  }
  if (url.hostname === "") {
    throw new ProviderError("invalid_provider_config", "base-url-host");
  }

  url.search = "";
  url.hash = "";

  const normalized = url.toString().replace(/\/+$/, "");
  if (normalized.length === 0 || normalized.length > MAX_BASE_URL_LENGTH) {
    throw new ProviderError("invalid_provider_config", "base-url-length");
  }
  return normalized;
}

/**
 * Only OpenRouter has a single well-known endpoint. Local OpenAI-compatible
 * runtimes, Gemini deployments, and Codex differ per install, so guessing one
 * would silently point a provider somewhere the operator never chose.
 */
export function defaultBaseUrl(kind: ProviderKind): string | undefined {
  return kind === "openrouter" ? "https://openrouter.ai/api" : undefined;
}
