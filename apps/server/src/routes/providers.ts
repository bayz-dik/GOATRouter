import type { FastifyInstance } from "fastify";
import { assertProviderId } from "@bayz/providers";
import { errorEnvelope, handleDomain, sendDomainError } from "../http-errors.js";
import type { BayzRuntime } from "../runtime.js";

/**
 * Read a `{ value: string }` secret write payload.
 *
 * Deliberately its own narrow shape: a credential write must not share a body
 * schema with anything else, so no other field can ride along and no other
 * endpoint can accidentally accept a secret.
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

export function registerProviderRoutes(
  app: FastifyInstance,
  runtime: BayzRuntime,
): void {
  const validId = (id: string): string => assertProviderId(id);

  app.get("/api/providers", async (request, reply) =>
    handleDomain(request, reply, () => ({
      providers: runtime.providers.listProviders(),
    })),
  );

  app.post("/api/providers", async (request, reply) =>
    handleDomain(request, reply, () => {
      const created = runtime.providers.createProvider(request.body as never);
      void reply.code(201);
      return created;
    }),
  );

  app.get<{ Params: { id: string } }>("/api/providers/:id", async (request, reply) =>
    handleDomain(request, reply, () =>
      runtime.providers.requireProvider(validId(request.params.id)),
    ),
  );

  app.patch<{ Params: { id: string } }>("/api/providers/:id", async (request, reply) =>
    handleDomain(request, reply, () =>
      runtime.providers.updateProvider(validId(request.params.id), request.body as never),
    ),
  );

  app.delete<{ Params: { id: string } }>("/api/providers/:id", async (request, reply) =>
    handleDomain(request, reply, () => {
      runtime.providers.deleteProvider(validId(request.params.id));
      // 204 whether or not a row existed: a caller learns nothing about which ids
      // exist from a delete, and the end state is identical either way.
      void reply.code(204);
      return null;
    }),
  );

  app.put<{ Params: { id: string } }>(
    "/api/providers/:id/credential",
    async (request, reply) => {
      const value = readSecretValue(request.body);
      if (value === undefined) {
        return reply
          .code(400)
          .send(
            errorEnvelope(
              request,
              "invalid_request",
              "Body must be exactly { value: string }",
            ),
          );
      }
      try {
        runtime.providers.setCredential(validId(request.params.id), value);
      } catch (error) {
        return sendDomainError(request, reply, error);
      }
      // No body: the value must never be echoed, not even as confirmation.
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/providers/:id/credential",
    async (request, reply) =>
      handleDomain(request, reply, () => {
        runtime.providers.deleteCredential(validId(request.params.id));
        void reply.code(204);
        return null;
      }),
  );

  app.post<{ Params: { id: string } }>(
    "/api/providers/:id/discover",
    async (request, reply) =>
      handleDomain(request, reply, async () => ({
        models: await runtime.providers.discoverModels(validId(request.params.id)),
      })),
  );
}
