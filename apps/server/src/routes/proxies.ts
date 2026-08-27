import type { FastifyInstance } from "fastify";
import { assertProxyId } from "@bayz/proxy";
import { errorEnvelope, handleDomain, sendDomainError } from "../http-errors.js";
import { requireScope } from "../scopes.js";
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

/**
 * Read a `{ providerIds: string[] }` bulk payload.
 *
 * Shape only — the ids themselves are validated by `@bayz/providers` pre-SQL, and
 * duplicating that alphabet here would give two places to keep in step. Extra keys
 * are refused so a typo'd field cannot be silently ignored on a 200-row write.
 */
function readProviderIds(body: unknown): string[] | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "providerIds") {
    return undefined;
  }
  const ids = (body as { providerIds: unknown }).providerIds;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
    return undefined;
  }
  return ids as string[];
}

export function registerProxyRoutes(app: FastifyInstance, runtime: BayzRuntime): void {
  const validId = (id: string): string => assertProxyId(id);

  /** Routes pinned to this proxy. An inheriting route follows its provider instead. */
  const routesUsingProxy = (proxyId: string): number =>
    runtime.router.listRoutes().filter((route) => route.proxyId === proxyId).length;

  /**
   * Translate an unknown provider in the batch into a body error.
   *
   * `assignProxy` raises `provider_not_found`, which maps to 404. On these URLs a
   * 404 already means *the proxy* does not exist, so passing it through would tell
   * the operator to check the wrong thing.
   */
  const bulkError = (error: unknown): unknown =>
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "provider_not_found"
      ? Object.assign(new Error("providerIds contains an unknown provider"), {
          code: "invalid_request",
        })
      : error;

  app.get("/api/proxies", async (request, reply) =>
    requireScope(request, reply, "proxies.read") ??
    handleDomain(request, reply, () => ({ proxies: runtime.proxies.listProxies() })),
  );

  app.post("/api/proxies", async (request, reply) =>
    requireScope(request, reply, "proxies.write") ??
    handleDomain(request, reply, () => {
      const created = runtime.proxies.createProxy(request.body as never);
      void reply.code(201);
      return created;
    }),
  );

  app.get<{ Params: { id: string } }>("/api/proxies/:id", async (request, reply) =>
    requireScope(request, reply, "proxies.read") ??
    handleDomain(request, reply, () => runtime.proxies.requireProxy(validId(request.params.id))),
  );

  app.patch<{ Params: { id: string } }>("/api/proxies/:id", async (request, reply) =>
    requireScope(request, reply, "proxies.write") ??
    handleDomain(request, reply, () =>
      runtime.proxies.updateProxy(validId(request.params.id), request.body as never),
    ),
  );

  app.delete<{ Params: { id: string } }>("/api/proxies/:id", async (request, reply) =>
    requireScope(request, reply, "proxies.write") ??
    handleDomain(request, reply, () => {
      runtime.proxies.deleteProxy(validId(request.params.id));
      // Idempotent, and identical whether or not the id existed, so a delete
      // cannot be used to enumerate ids.
      void reply.code(204);
      return null;
    }),
  );

  app.put<{ Params: { id: string } }>("/api/proxies/:id/password", async (request, reply) => {
    const denied = requireScope(request, reply, "proxies.write");
    if (denied !== undefined) {
      return denied;
    }
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
      requireScope(request, reply, "proxies.write") ??
      handleDomain(request, reply, () => {
        runtime.proxies.deletePassword(validId(request.params.id));
        void reply.code(204);
        return null;
      }),
  );

  app.post<{ Params: { id: string } }>("/api/proxies/:id/check", async (request, reply) =>
    requireScope(request, reply, "proxies.write") ??
    handleDomain(request, reply, () => runtime.proxies.checkProxy(validId(request.params.id))),
  );

  /**
   * Bulk assignment. One call carries the whole batch, because the alternative —
   * one request per provider — is not atomic and leaves a half-proxied fleet when
   * the tenth of forty fails.
   */
  app.post<{ Params: { id: string } }>("/api/proxies/:id/assign", async (request, reply) => {
    const denied = requireScope(request, reply, "proxies.write");
    if (denied !== undefined) {
      return denied;
    }
    const providerIds = readProviderIds(request.body);
    if (providerIds === undefined) {
      return reply
        .code(400)
        .send(
          errorEnvelope(
            request,
            "invalid_request",
            "Body must be exactly { providerIds: string[] }",
          ),
        );
    }
    try {
      const proxy = runtime.proxies.requireProxy(validId(request.params.id));
      const providerCount = runtime.providers.assignProxy(proxy.id, providerIds);
      return {
        proxyId: proxy.id,
        providerCount,
        proxyEnabled: proxy.enabled,
        // Staging configuration before enabling a proxy is legitimate, so this is a
        // note rather than a refusal. It is reported because traffic will not
        // traverse a disabled proxy — a route through it fails rather than silently
        // going direct.
        notes: proxy.enabled ? [] : ["proxy_disabled"],
      };
    } catch (error) {
      return sendDomainError(request, reply, bulkError(error));
    }
  });

  app.post<{ Params: { id: string } }>(
    "/api/proxies/:id/unassign",
    async (request, reply) => {
      const denied = requireScope(request, reply, "proxies.write");
      if (denied !== undefined) {
        return denied;
      }
      const providerIds = readProviderIds(request.body);
      if (providerIds === undefined) {
        return reply
          .code(400)
          .send(
            errorEnvelope(
              request,
              "invalid_request",
              "Body must be exactly { providerIds: string[] }",
            ),
          );
      }
      try {
        const proxy = runtime.proxies.requireProxy(validId(request.params.id));
        // Measured before the write: afterwards nothing distinguishes "was on this
        // proxy" from "was already direct", and the operator wants to know.
        const attached = new Set(runtime.providers.providersUsingProxy(proxy.id));
        const providerCount = runtime.providers.assignProxy(null, providerIds);
        const detachedFromProxy = new Set(
          providerIds.filter((id) => attached.has(id)),
        ).size;
        return { proxyId: proxy.id, providerCount, detachedFromProxy };
      } catch (error) {
        return sendDomainError(request, reply, bulkError(error));
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/proxies/:id/usage", async (request, reply) =>
    requireScope(request, reply, "proxies.read") ??
    handleDomain(request, reply, () => {
      const proxy = runtime.proxies.requireProxy(validId(request.params.id));
      const providerIds = runtime.providers.providersUsingProxy(proxy.id);
      // Ids only. No password, no `passwordPresent`, no credential state: this is a
      // "what breaks if I delete this" answer, and nothing else belongs in it.
      return {
        proxyId: proxy.id,
        providerCount: providerIds.length,
        routeCount: routesUsingProxy(proxy.id),
        providerIds,
      };
    }),
  );
}
