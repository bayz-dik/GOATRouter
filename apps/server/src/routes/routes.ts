import type { FastifyInstance } from "fastify";
import { assertRouteId } from "@bayz/router";
import { handleDomain } from "../http-errors.js";
import type { BayzRuntime } from "../runtime.js";

export function registerRouteRoutes(app: FastifyInstance, runtime: BayzRuntime): void {
  const validId = (id: string): string => assertRouteId(id);

  app.get("/api/routes", async (request, reply) =>
    handleDomain(request, reply, () => ({ routes: runtime.router.listRoutes() })),
  );

  app.post("/api/routes", async (request, reply) =>
    handleDomain(request, reply, () => {
      const created = runtime.router.createRoute(request.body as never);
      void reply.code(201);
      return created;
    }),
  );

  app.get<{ Params: { id: string } }>("/api/routes/:id", async (request, reply) =>
    handleDomain(request, reply, () => runtime.router.requireRoute(validId(request.params.id))),
  );

  app.patch<{ Params: { id: string } }>("/api/routes/:id", async (request, reply) =>
    handleDomain(request, reply, () =>
      runtime.router.updateRoute(validId(request.params.id), request.body as never),
    ),
  );

  app.delete<{ Params: { id: string } }>("/api/routes/:id", async (request, reply) =>
    handleDomain(request, reply, () => {
      runtime.router.deleteRoute(validId(request.params.id));
      // Idempotent and identical either way, so a delete cannot enumerate ids.
      void reply.code(204);
      return null;
    }),
  );
}
