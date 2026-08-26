import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { errorEnvelope, handleDomain } from "../http-errors.js";
import type { BayzRuntime } from "../runtime.js";

/**
 * Reject `stream` outright.
 *
 * Phase 5 does not implement SSE. Accepting the flag and answering with a
 * non-streamed body would leave a client waiting for events that never arrive, so
 * the honest behaviour is a clear refusal naming the missing capability.
 */
function rejectsStreaming(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    "stream" in (body as Record<string, unknown>)
  );
}

export function registerChatRoutes(app: FastifyInstance, runtime: BayzRuntime): void {
  app.post("/v1/chat/completions", async (request, reply) => {
    if (rejectsStreaming(request.body)) {
      return reply
        .code(400)
        .send(
          errorEnvelope(
            request,
            "streaming_unsupported",
            "Streaming responses are not implemented; omit the stream field",
          ),
        );
    }

    return handleDomain(request, reply, async () => {
      const result = await runtime.router.chat(request.body);

      // Routing facts travel in headers so the response body stays exactly the
      // OpenAI shape a client already knows how to parse.
      void reply.header("x-bayz-route", result.routeId);
      void reply.header("x-bayz-provider", result.providerId);
      if (result.proxyId !== undefined) {
        void reply.header("x-bayz-proxy", result.proxyId);
      }

      return {
        id: `chatcmpl-${randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: result.model ?? null,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: result.content },
            finish_reason: result.finishReason ?? null,
          },
        ],
        ...(result.usage === undefined
          ? {}
          : {
              usage: {
                prompt_tokens: result.usage.promptTokens ?? null,
                completion_tokens: result.usage.completionTokens ?? null,
                total_tokens: result.usage.totalTokens ?? null,
              },
            }),
      };
    });
  });

  app.get("/v1/models", async (request, reply) =>
    handleDomain(request, reply, () => {
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
    }),
  );
}
