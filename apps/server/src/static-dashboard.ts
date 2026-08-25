import staticPlugin from "@fastify/static";
import type { FastifyInstance } from "fastify";

export async function registerStaticDashboard(
  app: FastifyInstance,
  options: { root: string },
): Promise<void> {
  await app.register(staticPlugin, {
    root: options.root,
    wildcard: false,
    index: false,
  });
  app.get("/", async (_request, reply) => reply.sendFile("index.html"));
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/") || request.url.startsWith("/v1/")) {
      return reply.code(404).send({
        error: {
          code: "not_found",
          message: "Route not found",
          requestId: request.id,
        },
      });
    }
    return reply.sendFile("index.html");
  });
}
