import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { HealthResponse } from "@bayz/contracts";
import { installErrorHandling } from "./errors.js";

export type BuildAppOptions = {
  version?: string;
  logger?: boolean;
  registerTestRoutes?: boolean;
};

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? true,
    genReqId(request) {
      const supplied = request.headers["x-request-id"];
      return typeof supplied === "string" && SAFE_REQUEST_ID.test(supplied)
        ? supplied
        : `req_${randomUUID()}`;
    },
  });

  app.addHook("onSend", async (request, reply, payload) => {
    void reply.header("x-request-id", request.id);
    return payload;
  });

  app.get("/api/health", async (): Promise<HealthResponse> => ({
    status: "ok",
    version: options.version ?? "0.1.0",
    uptimeSeconds: process.uptime(),
  }));

  if (options.registerTestRoutes) {
    app.get("/__test/error", async () => {
      throw new Error("sk-secret");
    });
  }

  installErrorHandling(app);
  return app;
}
