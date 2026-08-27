import type { Agent as HttpAgent, ClientRequest, IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import type { Agent as HttpsAgent } from "node:https";
import { request as httpsRequest } from "node:https";
import { ProviderError } from "@bayz/providers";
import { parseChatChunk, type ChatChunk } from "./chunk.js";
import { RouterError } from "./errors.js";
import type { ChatRequest } from "./request.js";
import { parseChatResponse, type ChatResponse } from "./response.js";
import { SseLineReader } from "./sse.js";
import {
  authHeaders,
  chatUrl,
  mapStatus,
  wireBody,
  type TransportProvider,
} from "./wire.js";

/** 2 MiB of upstream JSON. Beyond this the response is hostile, not verbose. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Default silence budget for a stream, when the provider does not set one. */
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

export type { TransportProvider };

export type SendChatRequestOptions = {
  provider: TransportProvider;
  request: ChatRequest;
  credential?: string;
  /** Supplied by the router when the route binds a proxy. */
  agent?: HttpAgent | HttpsAgent;
  maxResponseBytes?: number;
};

export type SendChatRequestStreamingOptions = SendChatRequestOptions & {
  /** Aborting destroys the upstream socket rather than merely stopping reads. */
  signal?: AbortSignal;
};

type RawResponse = {
  status: number;
  body: Buffer;
};

/**
 * Refuse a tool request the provider is known not to support.
 *
 * The refusal is explicit rather than a silent strip. A client whose `tools` were
 * dropped would receive a perfectly normal prose answer and never learn that its
 * tools were ignored — which is worse than an error, because it looks like the model
 * simply chose not to call anything.
 *
 * `supportsTools === undefined` deliberately forwards: BAYZ does not know, cannot
 * find out from a discovery endpoint, and guessing either way would be fabrication.
 * The upstream is the authority and its own error surfaces normally.
 */
function assertToolsSupported(options: SendChatRequestOptions): void {
  if (options.request.tools !== undefined && options.provider.supportsTools === false) {
    throw new RouterError("tools_unsupported", "provider-capability");
  }
}

/**
 * Open the upstream request.
 *
 * `node:http` is used rather than `fetch` precisely because it accepts a custom
 * agent: that is what lets a proxy-bound route actually traverse its proxy, for
 * streaming exactly as for a buffered response.
 */
function openRequest(
  options: SendChatRequestOptions,
  body: string,
  stream: boolean,
  onResponse: (response: IncomingMessage) => void,
): ClientRequest {
  const url = chatUrl(options.provider.baseUrl);
  const secure = url.protocol === "https:";
  const requestFn = secure ? httpsRequest : httpRequest;

  return requestFn(
    {
      protocol: url.protocol,
      hostname: url.hostname,
      ...(url.port === "" ? {} : { port: Number(url.port) }),
      path: `${url.pathname}${url.search}`,
      method: "POST",
      ...(options.agent === undefined ? {} : { agent: options.agent }),
      headers: {
        "content-type": "application/json",
        accept: stream ? "text/event-stream" : "application/json",
        "content-length": String(Buffer.byteLength(body, "utf8")),
        ...authHeaders(options.provider.kind, options.credential),
      },
    },
    onResponse,
  );
}

/**
 * Perform the POST and read a byte-capped response.
 *
 * The read loop destroys the request as soon as the cap is exceeded, so a hostile
 * upstream cannot force unbounded buffering.
 */
function performRequest(
  options: SendChatRequestOptions,
  body: string,
): Promise<RawResponse> {
  const { provider, maxResponseBytes = MAX_RESPONSE_BYTES } = options;

  return new Promise<RawResponse>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    const clientRequest = openRequest(options, body, false, (response) => {
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
    });

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
  assertToolsSupported(options);

  const raw = await performRequest(options, wireBody(options.request, false));

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

/**
 * A queue that lets the socket's `data` events hand chunks to an async consumer.
 *
 * Node's `IncomingMessage` is push-based and an async generator is pull-based, so
 * something has to bridge them. Doing it explicitly — rather than with
 * `Readable.from` or an async iterator over the response — is what makes the abort
 * and error paths inspectable, and those paths are the whole reason streaming is
 * risky.
 */
class ChunkQueue {
  #items: ChatChunk[] = [];
  #error: Error | undefined;
  #ended = false;
  #wake: (() => void) | undefined;

  push(chunk: ChatChunk): void {
    this.#items.push(chunk);
    this.#signal();
  }

  fail(error: Error): void {
    if (this.#error === undefined && !this.#ended) {
      this.#error = error;
      this.#signal();
    }
  }

  end(): void {
    this.#ended = true;
    this.#signal();
  }

  #signal(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  async next(): Promise<ChatChunk | undefined> {
    for (;;) {
      const item = this.#items.shift();
      if (item !== undefined) {
        return item;
      }
      // The error is raised only after every already-received chunk has been
      // delivered, so a consumer sees the content that genuinely arrived before
      // the failure rather than losing it.
      if (this.#error !== undefined) {
        const error = this.#error;
        this.#error = undefined;
        this.#ended = true;
        throw error;
      }
      if (this.#ended) {
        return undefined;
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }
}

/**
 * Stream one chat completion from one provider.
 *
 * Honest failover boundary: this function yields chunks as they arrive, so once
 * the caller has received one, the response is committed. The router therefore
 * cannot fail over after the first chunk, and `router.ts` states and tests that
 * rather than pretending mid-stream failover works.
 *
 * Cleanup is in a `finally` so it runs on normal completion, on error, and on a
 * consumer that breaks out of its loop — the last being the common case, since a
 * disconnecting client abandons the iterator. Without it every abandoned stream
 * would leak a socket and keep the provider generating tokens nobody reads.
 */
export async function* sendChatRequestStreaming(
  options: SendChatRequestStreamingOptions,
): AsyncGenerator<ChatChunk, void, undefined> {
  if (options.provider.kind === "codex-oauth") {
    throw new ProviderError("unsupported_operation", "codex-chat");
  }
  assertToolsSupported(options);
  if (options.signal?.aborted === true) {
    // Checked before any socket is opened, so an already-cancelled request costs
    // the provider nothing.
    throw new ProviderError("unreachable", "stream-aborted");
  }

  const { provider, maxResponseBytes = MAX_RESPONSE_BYTES } = options;
  const idleTimeoutMs = provider.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const body = wireBody(options.request, true);

  const queue = new ChunkQueue();
  const reader = new SseLineReader();
  let total = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  let totalTimer: NodeJS.Timeout | undefined;
  let response: IncomingMessage | undefined;
  let finished = false;

  const clearTimers = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    if (totalTimer !== undefined) {
      clearTimeout(totalTimer);
      totalTimer = undefined;
    }
  };

  const clientRequest = openRequest(options, body, true, (incoming) => {
    response = incoming;

    const failure = mapStatus(incoming.statusCode ?? 0);
    if (failure !== undefined) {
      // The body is drained and discarded rather than read: an upstream error page
      // routinely echoes the credential it just rejected.
      incoming.resume();
      incoming.destroy();
      clientRequest.destroy();
      queue.fail(new ProviderError(failure, `chat-status-${incoming.statusCode}`));
      return;
    }

    incoming.on("data", (chunk: Buffer) => {
      bumpIdle();
      total += chunk.length;
      if (total > maxResponseBytes) {
        queue.fail(new RouterError("response_too_large", "stream-bytes"));
        destroy();
        return;
      }
      try {
        for (const payload of reader.push(chunk)) {
          queue.push(parseChatChunk(JSON.parse(payload)));
        }
        if (reader.terminated) {
          finished = true;
          queue.end();
          destroy();
        }
      } catch (error) {
        queue.fail(
          error instanceof Error
            ? error
            : new RouterError("invalid_response", "stream-chunk"),
        );
        destroy();
      }
    });

    incoming.on("end", () => {
      if (finished) {
        return;
      }
      try {
        // Throws when the stream ended without `[DONE]`. Reporting success there
        // would hand the consumer a truncated completion that looks complete.
        reader.done();
        finished = true;
        queue.end();
      } catch (error) {
        queue.fail(
          error instanceof Error
            ? error
            : new RouterError("invalid_response", "stream-truncated"),
        );
      }
    });

    incoming.on("error", () => {
      if (!finished) {
        queue.fail(new ProviderError("unreachable", "stream-response"));
      }
    });

    incoming.on("aborted", () => {
      if (!finished) {
        queue.fail(new ProviderError("unreachable", "stream-aborted-upstream"));
      }
    });
  });

  function destroy(): void {
    clearTimers();
    response?.destroy();
    clientRequest.destroy();
  }

  function bumpIdle(): void {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      queue.fail(new ProviderError("unreachable", "stream-idle-timeout"));
      destroy();
    }, idleTimeoutMs);
    idleTimer.unref?.();
  }

  const onAbort = (): void => {
    queue.fail(new ProviderError("unreachable", "stream-aborted"));
    destroy();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  totalTimer = setTimeout(() => {
    queue.fail(new ProviderError("unreachable", "stream-total-timeout"));
    destroy();
  }, provider.requestTimeoutMs);
  totalTimer.unref?.();

  clientRequest.on("error", () => {
    if (!finished) {
      queue.fail(new ProviderError("unreachable", "request-error"));
    }
  });
  clientRequest.end(body);
  bumpIdle();

  try {
    for (;;) {
      const chunk = await queue.next();
      if (chunk === undefined) {
        return;
      }
      yield chunk;
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    destroy();
  }
}
