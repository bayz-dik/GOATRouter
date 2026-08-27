import type { FastifyInstance } from "fastify";
import { assertProviderId } from "@bayz/providers";
import { errorEnvelope, handleDomain, sendDomainError } from "../http-errors.js";
import { requireScope } from "../scopes.js";
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
    requireScope(request, reply, "providers.read") ??
    handleDomain(request, reply, () => ({
      providers: runtime.providers.listProviders(),
    })),
  );

  app.post("/api/providers", async (request, reply) =>
    requireScope(request, reply, "providers.write") ??
    handleDomain(request, reply, () => {
      const created = runtime.providers.createProvider(request.body as never);
      void reply.code(201);
      return created;
    }),
  );

  app.get<{ Params: { id: string } }>("/api/providers/:id", async (request, reply) =>
    requireScope(request, reply, "providers.read") ??
    handleDomain(request, reply, () =>
      runtime.providers.requireProvider(validId(request.params.id)),
    ),
  );

  app.patch<{ Params: { id: string } }>("/api/providers/:id", async (request, reply) =>
    requireScope(request, reply, "providers.write") ??
    handleDomain(request, reply, () =>
      runtime.providers.updateProvider(validId(request.params.id), request.body as never),
    ),
  );

  app.delete<{ Params: { id: string } }>("/api/providers/:id", async (request, reply) =>
    requireScope(request, reply, "providers.write") ??
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
      const denied = requireScope(request, reply, "providers.write");
      if (denied !== undefined) {
        return denied;
      }
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
      requireScope(request, reply, "providers.write") ??
      handleDomain(request, reply, () => {
        runtime.providers.deleteCredential(validId(request.params.id));
        void reply.code(204);
        return null;
      }),
  );

  app.post<{ Params: { id: string } }>(
    "/api/providers/:id/discover",
    async (request, reply) =>
      requireScope(request, reply, "providers.write") ??
      handleDomain(request, reply, async () => ({
        models: await runtime.providers.discoverModels(validId(request.params.id)),
      })),
  );

  /**
   * Discover models with their economics.
   *
   * Separate from `/discover` rather than a flag on it: the existing endpoint's
   * `{ models: string[] }` contract is what several clients read, and widening it in
   * place would break them for a feature they did not ask for.
   */
  app.post<{ Params: { id: string } }>(
    "/api/providers/:id/catalogue",
    async (request, reply) =>
      requireScope(request, reply, "providers.write") ??
      handleDomain(request, reply, async () => ({
        models: await runtime.providers.refreshModelCatalogue(
          validId(request.params.id),
        ),
      })),
  );

  /**
   * Every model reachable for nothing, aggregated across providers.
   *
   * Guarded by `models.read` rather than `providers.read`: this answers "what can I
   * ask for", which is a client's question, and a client that can list models should
   * not need authority over provider configuration to learn which are free.
   */
  app.get("/api/models/free", async (request, reply) =>
    requireScope(request, reply, "models.read") ??
    handleDomain(request, reply, () => {
      // Collapsed to one entry per model id with the providers that offer it. The
      // operator's question is "what can I use for nothing", and the same model on
      // three providers is one answer with three ways to reach it.
      const byModel = new Map<string, string[]>();
      for (const row of runtime.providers.listFreeModels()) {
        const providers = byModel.get(row.model);
        if (providers === undefined) {
          byModel.set(row.model, [row.providerId]);
        } else {
          providers.push(row.providerId);
        }
      }
      return {
        models: [...byModel.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, providerIds]) => ({ id, providerIds: providerIds.sort() })),
      };
    }),
  );

  /**
   * Test whether a provider answers.
   *
   * `providers.write` rather than `read`: the call dials an upstream, which is a
   * write-shaped side effect even though it stores nothing. A read-scoped key must not
   * be able to make BAYZ originate traffic.
   *
   * Always 200 on a completed test. The *test* succeeded even when its subject failed,
   * and a 502 here would make "we could not reach your provider" indistinguishable
   * from "the test endpoint is broken".
   */
  app.post<{ Params: { id: string } }>("/api/providers/:id/test", async (request, reply) =>
    requireScope(request, reply, "providers.write") ??
    handleDomain(request, reply, async () =>
      runtime.providers.testConnection(validId(request.params.id)),
    ),
  );

  /** Report capabilities. `unknown` is a real answer; see `ProviderCapabilities`. */
  app.post<{ Params: { id: string } }>(
    "/api/providers/:id/capabilities",
    async (request, reply) =>
      requireScope(request, reply, "providers.write") ??
      handleDomain(request, reply, async () =>
        runtime.providers.detectCapabilities(validId(request.params.id)),
      ),
  );
}
