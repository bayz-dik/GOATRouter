import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { HealthResponse } from "@bayz/contracts";
import { installApiGuards, type RateLimitOptions } from "./auth.js";
import { installContentTypeGuard } from "./content-type.js";
import { installErrorHandling } from "./errors.js";
import type { IdentityResolver } from "./principal.js";
import { requireScope } from "./scopes.js";
import { installSecurityHeaders } from "./security-headers.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerProxyRoutes } from "./routes/proxies.js";
import { registerRouteRoutes } from "./routes/routes.js";
import { registerUsageRoutes } from "./routes/usage.js";
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
  /** Resolve a non-bootstrap bearer to a scoped principal; 9C supplies the registry. */
  resolveIdentity?: IdentityResolver;
};

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: MAX_BODY_BYTES,
    // No implementation fingerprint in responses.
    disableRequestLogging: false,
    genReqId(request) {
      const supplied = request.headers["x-request-id"];
      return typeof supplied === "string" && SAFE_REQUEST_ID.test(supplied)
        ? supplied
        : `req_${randomUUID()}`;
    },
  });

  // Installed first so every response — including 401, 403, 404, and 500 — carries
  // the policy, not just successful ones.
  installSecurityHeaders(app);

  app.addHook("onSend", async (request, reply, payload) => {
    void reply.header("x-request-id", request.id);
    return payload;
  });

  if (options.apiToken !== undefined) {
    // When a runtime is present its identity manager is the resolver, so client
    // keys work without any caller wiring them up. An explicit `resolveIdentity`
    // still wins, which is what lets a test present a synthetic principal.
    const resolveIdentity =
      options.resolveIdentity ??
      (options.runtime === undefined
        ? undefined
        : (presented: string) => {
            const identity = options.runtime!.identities.verifyKey(presented);
            return identity === undefined
              ? undefined
              : { id: identity.id, scopes: new Set(identity.scopes) };
          });
    installApiGuards(app, {
      apiToken: options.apiToken,
      ...(resolveIdentity === undefined ? {} : { resolveIdentity }),
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
    app.get("/api/status", async (request, reply) =>
      // Status reports schema version, driver, key fingerprint, and counts. That is
      // operational shape, not content, but it is still more than a chat client has
      // any need for.
      requireScope(request, reply, "providers.read") ?? runtime.describe(),
    );
    registerProviderRoutes(app, runtime);
    registerProxyRoutes(app, runtime);
    registerRouteRoutes(app, runtime);
    registerChatRoutes(app, runtime);
    registerUsageRoutes(app, runtime);
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

  // The dashboard mount owns the 404 handler when present, because it must serve
  // index.html for client-side routes while still answering /api/* misses as JSON.
  installErrorHandling(app, { notFoundHandler: !options.dashboardRoot });
  return app;
}
