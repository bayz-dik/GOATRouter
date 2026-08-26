import type { Agent as HttpAgent, IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import type { Agent as HttpsAgent } from "node:https";
import { request as httpsRequest } from "node:https";
import { ProviderError, type ProviderKind } from "@bayz/providers";
import { RouterError } from "./errors.js";
import type { ChatRequest } from "./request.js";
import { parseChatResponse, type ChatResponse } from "./response.js";

/** 2 MiB of upstream JSON. Beyond this the response is hostile, not verbose. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CHAT_PATH = "/chat/completions";

export type TransportProvider = {
  kind: ProviderKind;
  baseUrl: string;
  requestTimeoutMs: number;
};

export type SendChatRequestOptions = {
  provider: TransportProvider;
  request: ChatRequest;
  credential?: string;
  /** Supplied by the router when the route binds a proxy. */
  agent?: HttpAgent | HttpsAgent;
  maxResponseBytes?: number;
};

/**
 * Translate the validated request into the OpenAI wire shape.
 *
 * Only fields the caller actually supplied are emitted, and `stream` is never
 * emitted: streaming is not implemented in this phase, and sending the flag would
 * make an upstream reply in a format the router cannot parse.
 */
function wireBody(request: ChatRequest): string {
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
  return JSON.stringify(body);
}

function authHeaders(
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

function mapStatus(status: number): "auth_failed" | "rate_limited" | "upstream_error" | undefined {
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

type RawResponse = {
  status: number;
  body: Buffer;
};

/**
 * Perform the POST and read a byte-capped response.
 *
 * `node:http` is used rather than `fetch` precisely because it accepts a custom
 * agent: that is what lets a proxy-bound route actually traverse its proxy. The
 * read loop destroys the request as soon as the cap is exceeded, so a hostile
 * upstream cannot force unbounded buffering.
 */
function performRequest(
  options: SendChatRequestOptions,
  body: string,
): Promise<RawResponse> {
  const { provider, credential, agent, maxResponseBytes = MAX_RESPONSE_BYTES } = options;

  let url: URL;
  try {
    url = new URL(`${provider.baseUrl.replace(/\/+$/, "")}${CHAT_PATH}`);
  } catch {
    throw new ProviderError("upstream_error", "chat-url");
  }
  const secure = url.protocol === "https:";
  if (!secure && url.protocol !== "http:") {
    throw new ProviderError("upstream_error", "chat-url-scheme");
  }

  return new Promise<RawResponse>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    const requestFn = secure ? httpsRequest : httpRequest;
    const clientRequest = requestFn(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        ...(url.port === "" ? {} : { port: Number(url.port) }),
        path: `${url.pathname}${url.search}`,
        method: "POST",
        ...(agent === undefined ? {} : { agent }),
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "content-length": String(Buffer.byteLength(body, "utf8")),
          ...authHeaders(provider.kind, credential),
        },
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxResponseBytes) {
            response.destroy();
            clientRequest.destroy();
            fail(new RouterError("response_too_large", "response-bytes"));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          if (!settled) {
            settled = true;
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks, total),
            });
          }
        });
        response.on("error", () =>
          fail(new ProviderError("unreachable", "response-stream")),
        );
      },
    );

    clientRequest.setTimeout(provider.requestTimeoutMs, () => {
      clientRequest.destroy();
      fail(new ProviderError("unreachable", "request-timeout"));
    });
    // DNS failures, refused connections, and proxy handshake failures are
    // indistinguishable to a caller and equally not actionable in detail.
    clientRequest.on("error", () =>
      fail(new ProviderError("unreachable", "request-error")),
    );

    clientRequest.end(body);
  });
}

/**
 * Send one chat completion request to one provider.
 *
 * This is a single attempt with no retry: failover across candidate routes is the
 * router's job, which keeps "what happened to this attempt" and "what do we do
 * next" as separate, separately testable decisions.
 */
export async function sendChatRequest(
  options: SendChatRequestOptions,
): Promise<ChatResponse> {
  if (options.provider.kind === "codex-oauth") {
    // Deferred honestly: the OAuth flow is unimplemented, so there is no way to
    // authenticate this request.
    throw new ProviderError("unsupported_operation", "codex-chat");
  }

  const raw = await performRequest(options, wireBody(options.request));

  const failure = mapStatus(raw.status);
  if (failure !== undefined) {
    // The upstream body is discarded: an error page routinely echoes the
    // credential that was just rejected.
    throw new ProviderError(failure, `chat-status-${raw.status}`);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw.body);
  } catch {
    throw new RouterError("invalid_response", "decode-body");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RouterError("invalid_response", "parse-body");
  }

  return parseChatResponse(parsed);
}
