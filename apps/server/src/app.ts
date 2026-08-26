import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { HealthResponse } from "@bayz/contracts";
import { installApiGuards, type RateLimitOptions } from "./auth.js";
import { installContentTypeGuard } from "./content-type.js";
import { installErrorHandling } from "./errors.js";
import { registerProviderRoutes } from "./routes/providers.js";
import type { BayzRuntime } from "./runtime.js";
import { registerStaticDashboard } from "./static-dashboard.js";

/** 1 MiB, matching the router's own request cap. */
export const MAX_BODY_BYTES = 1024 * 1024;

export type BuildAppOptions = {
  version?: string;
  logger?: boolean;
  registerTestRoutes?: boolean;
  dashboardRoot?: string;
  /** When present, every `/api/*` and `/v1/*` route requires this token. */
  apiToken?: string;
  rateLimit?: RateLimitOptions;
  allowedHosts?: readonly string[];
  /** When present, the managed API surface is registered. */
  runtime?: BayzRuntime;
};

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: MAX_BODY_BYTES,
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

  if (options.apiToken !== undefined) {
    installApiGuards(app, {
      apiToken: options.apiToken,
      ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
      ...(options.allowedHosts === undefined
        ? {}
        : { allowedHosts: options.allowedHosts }),
    });
  }
  installContentTypeGuard(app);

  app.get("/api/health", async (): Promise<HealthResponse> => ({
    status: "ok",
    version: options.version ?? "0.1.0",
    uptimeSeconds: process.uptime(),
  }));

  if (options.runtime !== undefined) {
    const runtime = options.runtime;
    app.get("/api/status", async () => runtime.describe());
    registerProviderRoutes(app, runtime);
  }

  if (options.registerTestRoutes) {
    app.get("/__test/error", async () => {
      throw new Error("sk-secret");
    });
    app.get("/__test/guarded", async () => ({ ok: true }));
    app.post("/__test/guarded", async () => ({ ok: true }));
  }

  if (options.dashboardRoot) {
    app.register(async (instance) => {
      await registerStaticDashboard(instance, { root: options.dashboardRoot! });
    });
  }

  installErrorHandling(app);
  return app;
}
