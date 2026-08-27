import { randomUUID } from "node:crypto";
import {
  denormalizeResponse,
  deriveProfile,
  normalizeRequest,
  type ClientProfile,
} from "@bayz/gateway";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { handleDomain } from "../http-errors.js";
import { principalOf, requireScope } from "../scopes.js";
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

export function registerChatRoutes(app: FastifyInstance, runtime: BayzRuntime): void {
  app.post("/v1/chat/completions", async (request, reply) => {
    const denied = requireScope(request, reply, "chat.completions");
    if (denied !== undefined) {
      return denied;
    }

    return handleDomain(request, reply, async () => {
      const profile = profileFor(request);
      // Streaming lands in 9B. Until the transport exists, the honest answer to
      // `stream: true` is a refusal naming the missing capability rather than a
      // buffered body a client will sit waiting to receive as events.
      if (profile.capabilities.has("chat.stream")) {
        return reply
          .code(400)
          .send({
            error: {
              code: "streaming_unsupported",
              message: "Streaming responses are not implemented; omit the stream field",
              requestId: String(request.id),
            },
          });
      }

      const normalized = normalizeRequest(profile, request.body);
      const result = await runtime.router.chat(normalized);

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
