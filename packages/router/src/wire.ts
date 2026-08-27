import { ProviderError, type ProviderKind } from "@bayz/providers";
import type { ChatRequest } from "./request.js";

const CHAT_PATH = "/chat/completions";

export type TransportProvider = {
  kind: ProviderKind;
  baseUrl: string;
  requestTimeoutMs: number;
  /**
   * Whether tools may be forwarded to this provider.
   *
   * `undefined` means unknown, and unknown forwards. See `ProviderConfig.supportsTools`.
   */
  supportsTools?: boolean;
  /**
   * How long a stream may go without producing a byte.
   *
   * Distinct from `requestTimeoutMs` on purpose: a long generation is legitimate
   * and must not be killed by a total budget sized for a stalled connection, while
   * a stream that has gone silent must not be held open by a generous total.
   */
  idleTimeoutMs?: number;
};

/**
 * Translate the validated request into the OpenAI wire shape.
 *
 * Only fields the caller actually supplied are emitted. `stream` is emitted only
 * when the caller is genuinely consuming a stream — sending `stream: false` on a
 * streaming path would leave the reader waiting for events until the total
 * timeout, and omitting it on a streaming path would do the same.
 */
export function wireBody(request: ChatRequest, stream: boolean): string {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
  };
  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }
  if (request.maxTokens !== undefined) {
    body.max_tokens = request.maxTokens;
  }
  if (request.topP !== undefined) {
    body.top_p = request.topP;
  }
  if (request.stop !== undefined) {
    body.stop = request.stop;
  }
  if (request.tools !== undefined) {
    body.tools = request.tools;
    if (request.toolChoice !== undefined) {
      body.tool_choice = request.toolChoice;
    }
  }
  if (stream) {
    body.stream = true;
  }
  return JSON.stringify(body);
}

export function authHeaders(
  kind: ProviderKind,
  credential: string | undefined,
): Record<string, string> {
  if (credential === undefined || credential.length === 0) {
    return {};
  }
  // Never a query parameter: a URL-borne key lands in proxy logs and error text.
  return kind === "gemini"
    ? { "x-goog-api-key": credential }
    : { authorization: `Bearer ${credential}` };
}

export function mapStatus(
  status: number,
): "auth_failed" | "rate_limited" | "upstream_error" | undefined {
  if (status >= 200 && status < 300) {
    return undefined;
  }
  if (status === 401 || status === 403) {
    return "auth_failed";
  }
  if (status === 429) {
    return "rate_limited";
  }
  return "upstream_error";
}

export function chatUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(`${baseUrl.replace(/\/+$/, "")}${CHAT_PATH}`);
  } catch {
    throw new ProviderError("upstream_error", "chat-url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProviderError("upstream_error", "chat-url-scheme");
  }
  return url;
}
