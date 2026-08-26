import type { FastifyInstance } from "fastify";
import { assertProxyId } from "@bayz/proxy";
import { errorEnvelope, handleDomain, sendDomainError } from "../http-errors.js";
import type { BayzRuntime } from "../runtime.js";

/**
 * Read a `{ value: string }` secret write payload.
 *
 * Kept separate from every other body shape so a proxy password can only ever
 * arrive at this one endpoint, and nothing else can accidentally accept it.
 */
function readSecretValue(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "value") {
    return undefined;
  }
  const value = (body as { value: unknown }).value;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function registerProxyRoutes(app: FastifyInstance, runtime: BayzRuntime): void {
  const validId = (id: string): string => assertProxyId(id);

  app.get("/api/proxies", async (request, reply) =>
    handleDomain(request, reply, () => ({ proxies: runtime.proxies.listProxies() })),
  );

  app.post("/api/proxies", async (request, reply) =>
    handleDomain(request, reply, () => {
      const created = runtime.proxies.createProxy(request.body as never);
      void reply.code(201);
      return created;
    }),
  );

  app.get<{ Params: { id: string } }>("/api/proxies/:id", async (request, reply) =>
    handleDomain(request, reply, () => runtime.proxies.requireProxy(validId(request.params.id))),
  );

  app.patch<{ Params: { id: string } }>("/api/proxies/:id", async (request, reply) =>
    handleDomain(request, reply, () =>
      runtime.proxies.updateProxy(validId(request.params.id), request.body as never),
    ),
  );

  app.delete<{ Params: { id: string } }>("/api/proxies/:id", async (request, reply) =>
    handleDomain(request, reply, () => {
      runtime.proxies.deleteProxy(validId(request.params.id));
      // Idempotent, and identical whether or not the id existed, so a delete
      // cannot be used to enumerate ids.
      void reply.code(204);
      return null;
    }),
  );

  app.put<{ Params: { id: string } }>("/api/proxies/:id/password", async (request, reply) => {
    const value = readSecretValue(request.body);
    if (value === undefined) {
      return reply
        .code(400)
        .send(
          errorEnvelope(request, "invalid_request", "Body must be exactly { value: string }"),
        );
    }
    try {
      runtime.proxies.setPassword(validId(request.params.id), value);
    } catch (error) {
      return sendDomainError(request, reply, error);
    }
    // No body: a password must never be echoed, not even as confirmation.
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>(
    "/api/proxies/:id/password",
    async (request, reply) =>
      handleDomain(request, reply, () => {
        runtime.proxies.deletePassword(validId(request.params.id));
        void reply.code(204);
        return null;
      }),
  );

  app.post<{ Params: { id: string } }>("/api/proxies/:id/check", async (request, reply) =>
    handleDomain(request, reply, () => runtime.proxies.checkProxy(validId(request.params.id))),
  );
}
