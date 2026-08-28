import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  denormalizeResponse,
  deriveProfile,
  normalizeRequest,
  type ClientProfile,
} from "@bayz/gateway";
import {
  encodeSseDone,
  encodeSseEvent,
  type ChatChunk,
  type RoutedChatChunk,
} from "@bayz/router";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { handleDomain, mapDomainError } from "../http-errors.js";
import { principalOf, requireScope } from "../scopes.js";
import { runToolLoop } from "../tool-loop.js";
import type { BayzRuntime } from "../runtime.js";

/**
 * Build the client profile for a request.
 *
 * Note what is *not* consulted: no `User-Agent`, no client name, no product
 * identifier of any kind. A profile is derived from the protocol path, the Accept
 * header, the body shape, and the caller's granted scopes — so two clients sending
 * the same bytes with the same authority get identical treatment, which is what
 * makes BAYZ client-agnostic rather than client-aware.
 */
function profileFor(request: FastifyRequest): ClientProfile {
  return deriveProfile({
    path: request.url,
    accept: typeof request.headers.accept === "string" ? request.headers.accept : undefined,
    body: request.body,
    grantedScopes: principalOf(request).scopes,
  });
}

/** Render one router chunk as an OpenAI streaming chunk object. */
function chunkBody(id: string, created: number, chunk: ChatChunk): Record<string, unknown> {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model: chunk.model ?? null,
    choices: [
      {
        index: 0,
        delta: chunk.contentDelta === undefined ? {} : { content: chunk.contentDelta },
        finish_reason: chunk.finishReason ?? null,
      },
    ],
    ...(chunk.usage === undefined
      ? {}
      : {
          usage: {
            prompt_tokens: chunk.usage.promptTokens ?? null,
            completion_tokens: chunk.usage.completionTokens ?? null,
            total_tokens: chunk.usage.totalTokens ?? null,
          },
        }),
  };
}

/**
 * Serve a streaming chat completion.
 *
 * The shape of this function is driven by one hard constraint: **HTTP status and
 * headers are sent with the first byte and cannot be revised.** So the first chunk
 * is pulled *before* anything is written. A failure up to that point is still a
 * normal JSON error envelope with a real status code; a failure after it can only
 * be a terminal event inside the stream, because the 200 has already gone out.
 *
 * That is also why the response never ends with `[DONE]` after a mid-stream
 * failure: a client must be able to distinguish a complete stream from a broken
 * one, and terminating normally after an error would claim success.
 */
async function serveStream(
  request: FastifyRequest,
  reply: FastifyReply,
  runtime: BayzRuntime,
  profile: ClientProfile,
): Promise<FastifyReply> {
  const normalized = normalizeRequest(profile, request.body);

  // Client disconnect must tear down the upstream, or an abandoned stream leaves
  // the provider generating tokens nobody will read.
  //
  // The listener is on the *response*, not the request. Fastify fully consumes and
  // destroys `request.raw` while parsing the JSON body, so `request.raw` emits
  // `close` before this handler even runs — wiring the abort there cancelled every
  // stream instantly. `reply.raw` closes when the socket does, and
  // `writableEnded` distinguishes a completed response from an abandoned one.
  const controller = new AbortController();
  const onClose = (): void => {
    if (!reply.raw.writableEnded) {
      controller.abort();
    }
  };
  reply.raw.once("close", onClose);

  const iterator = runtime.router
    .chatStream(normalized, { requestId: String(request.id), signal: controller.signal })
    [Symbol.asyncIterator]();

  let first: IteratorResult<RoutedChatChunk>;
  try {
    first = await iterator.next();
  } catch (error) {
    reply.raw.removeListener("close", onClose);
    // Nothing has been written, so the honest answer is the stable envelope a
    // client already knows how to parse rather than a 200 containing an error.
    const mapped = mapDomainError(error);
    return reply.code(mapped.status).send({
      error: { code: mapped.code, message: mapped.message, requestId: String(request.id) },
    });
  }

  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  // Written before the body, from the same chunk the body will carry, so the
  // headers and the payload cannot disagree about where the request went.
  if (first.value !== undefined) {
    void reply.header("x-bayz-route", first.value.routeId);
    void reply.header("x-bayz-provider", first.value.providerId);
    if (first.value.proxyId !== undefined) {
      void reply.header("x-bayz-proxy", first.value.proxyId);
    }
  }

  void reply.header("content-type", "text/event-stream; charset=utf-8");
  void reply.header("cache-control", "no-cache, no-transform");
  void reply.header("connection", "keep-alive");
  // Stops a reverse proxy buffering the stream into a single response, which would
  // silently defeat streaming for anyone running BAYZ behind nginx.
  void reply.header("x-accel-buffering", "no");

  const stream = Readable.from(
    (async function* frames(): AsyncGenerator<string, void, undefined> {
      try {
        let step = first;
        while (step.done !== true) {
          yield encodeSseEvent(chunkBody(id, created, step.value));
          step = await iterator.next();
        }
        yield encodeSseDone();
      } catch (error) {
        // A terminal error event, and deliberately no `[DONE]`.
        const mapped = mapDomainError(error);
        yield encodeSseEvent({
          id,
          object: "chat.completion.chunk",
          created,
          error: {
            code: mapped.code,
            message: mapped.message,
            requestId: String(request.id),
          },
        });
      } finally {
        reply.raw.removeListener("close", onClose);
        await iterator.return?.(undefined);
      }
    })(),
  );

  return reply.send(stream);
}

export function registerChatRoutes(app: FastifyInstance, runtime: BayzRuntime): void {
  app.post("/v1/chat/completions", async (request, reply) => {
    const denied = requireScope(request, reply, "chat.completions");
    if (denied !== undefined) {
      return denied;
    }

    const profile = profileFor(request);
    if (profile.capabilities.has("chat.stream")) {
      return handleDomain(request, reply, () =>
        serveStream(request, reply, runtime, profile),
      );
    }

    return handleDomain(request, reply, async () => {
      const normalized = normalizeRequest(profile, request.body);
      /*
       * 9G: tool calls this deployment has a registered capability for are dispatched
       * server-side; everything else is forwarded to the client exactly as before.
       *
       * The registry is empty unless an operator registers something, so with the
       * shipped configuration `runToolLoop` makes one router call and returns what
       * Phase 9B returned. The principal is passed rather than re-derived, so authority
       * comes from the authenticated identity and not from anything the model said.
       */
      const result = await runToolLoop({
        router: runtime.router,
        principal: principalOf(request),
        request: normalized as unknown as Record<string, unknown>,
        requestId: String(request.id),
      });

      // Routing facts travel in headers so the response body stays exactly the
      // OpenAI shape a client already knows how to parse.
      void reply.header("x-bayz-route", result.routeId);
      void reply.header("x-bayz-provider", result.providerId);
      if (result.proxyId !== undefined) {
        void reply.header("x-bayz-proxy", result.proxyId);
      }

      return denormalizeResponse(profile, {
        id: `chatcmpl-${randomUUID()}`,
        created: Math.floor(Date.now() / 1000),
        content: result.content,
        finishReason: result.finishReason,
        model: result.model,
        usage: result.usage,
        ...(result.toolCalls === undefined ? {} : { toolCalls: result.toolCalls }),
      });
    });
  });

  app.get("/v1/models", async (request, reply) => {
    const denied = requireScope(request, reply, "models.read");
    if (denied !== undefined) {
      return denied;
    }

    return handleDomain(request, reply, () => {
      // Wildcard patterns are route configuration, not usable model ids, so they
      // are not advertised: a client copying `gpt-4*` into a request would get a
      // validation error, which would be a confusing thing to publish.
      const models = [
        ...new Set(
          runtime.router
            .listRoutes()
            .filter((route) => route.enabled && !route.model.endsWith("*"))
            .map((route) => route.model),
        ),
      ].sort();

      return {
        object: "list",
        data: models.map((id) => ({
          id,
          object: "model",
          owned_by: "bayz",
        })),
      };
    });
  });
}
