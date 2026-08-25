import Fastify, { type FastifyInstance } from "fastify";
import type { HealthResponse } from "@bayz/contracts";

export type BuildAppOptions = {
  version?: string;
  logger?: boolean;
};

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });
  const version = options.version ?? "0.1.0";

  app.get("/api/health", async (): Promise<HealthResponse> => ({
    status: "ok",
    version,
    uptimeSeconds: process.uptime(),
  }));

  return app;
}
