import {
  ProviderError,
  type EgressPolicy,
  type EgressResolver,
  type ProviderKind,
} from "@bayz/providers";
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
  /**
   * The egress policy this provider's config expresses.
   *
   * Absent means **deny loopback and private**, which is the safe reading: a caller
   * that forgot to pass a policy gets the restrictive one, not a bypass.
   */
  egress?: EgressPolicy;
  /** Validated custom headers. Never able to carry `authorization` or `host`. */
  headers?: Record<string, string>;
  /** Injectable resolver for the pre-connect address check. */
  resolve?: EgressResolver;
};

/**
 * Render the validated messages in the OpenAI wire shape.
 *
 * `ChatMessage` is BAYZ's internal shape and uses camelCase (`toolCalls`,
 * `toolCallId`); the wire contract is snake_case. Without this translation an
 * assistant tool-call message and its `role: "tool"` answer both reach the upstream
 * under names it does not recognise, so the model is handed a conversation with the
 * tool call and its result effectively missing — it answers without the data it asked
 * for, or asks again.
 *
 * That was live for the whole tool-roundtrip path and invisible to the 9B suite, which
 * asserted only that the result *string* appeared somewhere in the outbound body — true
 * either way, because `content` needs no renaming. Found by 9G Task 3, which had to read
 * the field names to prove a dispatched capability's output reaches the model.
 *
 * Fields are assembled one at a time rather than spread, so a field added to
 * `ChatMessage` later cannot reach the wire without a decision here.
 */
function wireMessages(messages: ChatRequest["messages"]): Record<string, unknown>[] {
  return messages.map((message) => {
    const wire: Record<string, unknown> = { role: message.role };
    if (message.content !== undefined) {
      wire.content = message.content;
    } else if (message.toolCalls !== undefined) {
      // An assistant message that is purely tool calls carries an explicit `null`,
      // which is what the OpenAI contract specifies. Omitting the key entirely makes
      // some upstreams reject the message outright.
      wire.content = null;
    }
    if (message.toolCalls !== undefined) {
      wire.tool_calls = message.toolCalls;
    }
    if (message.toolCallId !== undefined) {
      wire.tool_call_id = message.toolCallId;
    }
    return wire;
  });
}

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
    messages: wireMessages(request.messages),
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

/**
 * The egress policy to enforce for one attempt.
 *
 * Absent is deny-loopback and deny-private rather than allow, so a caller that
 * omitted the field is restricted rather than exempt.
 */
export function transportEgressPolicy(provider: TransportProvider): EgressPolicy {
  return (
    provider.egress ?? {
      allowLoopback: false,
      allowPrivate: false,
    }
  );
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
