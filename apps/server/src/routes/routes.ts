import type { FastifyInstance } from "fastify";
import { assertRouteId } from "@bayz/router";
import { handleDomain } from "../http-errors.js";
import { requireScope } from "../scopes.js";
import type { BayzRuntime } from "../runtime.js";

export function registerRouteRoutes(app: FastifyInstance, runtime: BayzRuntime): void {
  const validId = (id: string): string => assertRouteId(id);

  app.get("/api/routes", async (request, reply) =>
    requireScope(request, reply, "routes.read") ??
    handleDomain(request, reply, () => ({ routes: runtime.router.listRoutes() })),
  );

  app.post("/api/routes", async (request, reply) =>
    requireScope(request, reply, "routes.write") ??
    handleDomain(request, reply, () => {
      const created = runtime.router.createRoute(request.body as never);
      void reply.code(201);
      return created;
    }),
  );

  app.get<{ Params: { id: string } }>("/api/routes/:id", async (request, reply) =>
    requireScope(request, reply, "routes.read") ??
    handleDomain(request, reply, () => runtime.router.requireRoute(validId(request.params.id))),
  );

  app.patch<{ Params: { id: string } }>("/api/routes/:id", async (request, reply) =>
    requireScope(request, reply, "routes.write") ??
    handleDomain(request, reply, () => {
      const id = validId(request.params.id);
      const body = (request.body ?? {}) as { freeOnly?: unknown };
      const updated = runtime.router.updateRoute(id, request.body as never);

      /*
       * Turning free-only off leaves a trail.
       *
       * Recorded after the write, not before: an audit row for a change that failed
       * validation would be a false record. Only the disabling direction is recorded —
       * re-enabling free-only cannot start costing money, and logging both would bury
       * the one event an operator will later want to explain in routine noise.
       *
       * Metadata only: who, the action, and the route id. No prompt, no price, no
       * credential, consistent with the audit table's schema-level constraints.
       */
      if (body.freeOnly === false && updated.freeOnly === false) {
        runtime.identities.recordDecision({
          identityId: request.principal?.id ?? "unknown",
          action: "authorized",
          outcome: "allowed",
          scope: "routes.write",
          route: id,
        });
      }
      return updated;
    }),
  );

  app.delete<{ Params: { id: string } }>("/api/routes/:id", async (request, reply) =>
    requireScope(request, reply, "routes.write") ??
    handleDomain(request, reply, () => {
      runtime.router.deleteRoute(validId(request.params.id));
      // Idempotent and identical either way, so a delete cannot enumerate ids.
      void reply.code(204);
      return null;
    }),
  );
}
