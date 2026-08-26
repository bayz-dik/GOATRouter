import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiErrorResponse } from "@bayz/contracts";
import { verifyApiToken } from "./api-token.js";

/** Requests per fixed window for an authenticated caller. */
export const DEFAULT_RATE_LIMIT_MAX = 120;
/** Failed authentications per fixed window — a brute-force brake. */
export const DEFAULT_AUTH_RATE_LIMIT_MAX = 10;
export const RATE_LIMIT_WINDOW_MS = 60_000;

const BEARER_RE = /^Bearer ([A-Za-z0-9._~+/=-]+)$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export type RateLimitOptions = {
  max?: number;
  authMax?: number;
  windowMs?: number;
};

export type InstallApiGuardsOptions = {
  apiToken: string;
  rateLimit?: RateLimitOptions;
  /** Extra hostnames an operator has explicitly bound the listener to. */
  allowedHosts?: readonly string[];
};

type Counter = {
  windowStart: number;
  total: number;
  authFailures: number;
};

function envelope(
  request: FastifyRequest,
  code: string,
  message: string,
): ApiErrorResponse {
  return { error: { code, message, requestId: String(request.id) } };
}

/** The host portion of a `Host` or `Origin` value, without the port. */
function hostnameOf(value: string): string {
  const withoutPort = value.startsWith("[")
    ? value.slice(0, value.indexOf("]") + 1)
    : value.split(":")[0]!;
  return withoutPort.toLowerCase();
}

/**
 * `/api/health` is the one deliberate exception.
 *
 * It is an unauthenticated liveness probe whose Phase 1 contract is pinned by a
 * regression test, and it reveals nothing about configuration or state. It is
 * also exempt from rate limiting, so an attacker burning the auth budget cannot
 * starve a supervisor's health check. Host validation still applies to it.
 */
const UNGUARDED_PATHS = new Set(["/api/health"]);

function isGuardedPath(url: string): boolean {
  const path = url.split("?")[0] ?? "";
  if (UNGUARDED_PATHS.has(path)) {
    return false;
  }
  return path.startsWith("/api/") || path.startsWith("/v1/") || path.startsWith("/__test/");
}

/**
 * Install authentication, origin/host validation, and rate limiting.
 *
 * The guard is a global `onRequest` hook rather than a per-route decorator on
 * purpose: a route added later cannot forget to opt in, and an unknown `/api/*`
 * path is rejected before Fastify resolves it, so route existence is not
 * discoverable without a token.
 */
export function installApiGuards(
  app: FastifyInstance,
  options: InstallApiGuardsOptions,
): void {
  const max = options.rateLimit?.max ?? DEFAULT_RATE_LIMIT_MAX;
  const authMax = options.rateLimit?.authMax ?? DEFAULT_AUTH_RATE_LIMIT_MAX;
  const windowMs = options.rateLimit?.windowMs ?? RATE_LIMIT_WINDOW_MS;
  const allowedHosts = new Set([
    ...LOOPBACK_HOSTS,
    ...(options.allowedHosts ?? []).map((host) => host.toLowerCase()),
  ]);
  const counters = new Map<string, Counter>();

  const counterFor = (key: string): Counter => {
    const now = Date.now();
    const existing = counters.get(key);
    if (existing === undefined || now - existing.windowStart >= windowMs) {
      const fresh: Counter = { windowStart: now, total: 0, authFailures: 0 };
      counters.set(key, fresh);
      // Bounded memory: a single local daemon sees few peers, but an unbounded
      // map would still be a slow leak under a spoofed-source flood.
      if (counters.size > 1024) {
        for (const [candidate, counter] of counters) {
          if (now - counter.windowStart >= windowMs) {
            counters.delete(candidate);
          }
        }
      }
      return fresh;
    }
    return existing;
  };

  const reject = (
    reply: FastifyReply,
    request: FastifyRequest,
    status: number,
    code: string,
    message: string,
  ): FastifyReply => {
    if (status === 429) {
      void reply.header("retry-after", String(Math.ceil(windowMs / 1000)));
    }
    if (status === 401) {
      void reply.header("www-authenticate", "Bearer");
    }
    return reply.code(status).send(envelope(request, code, message));
  };

  app.addHook("onRequest", async (request, reply) => {
    // DNS-rebinding defence: a browser tricked into resolving an attacker
    // hostname to 127.0.0.1 still sends that hostname in `Host`. Applied to every
    // route including health, so the probe cannot be used as a rebinding oracle.
    const hostHeader = request.headers.host;
    if (typeof hostHeader !== "string" || !allowedHosts.has(hostnameOf(hostHeader))) {
      return reject(
        reply,
        request,
        403,
        "forbidden_host",
        "Request Host is not permitted",
      );
    }

    const origin = request.headers.origin;
    if (typeof origin === "string" && origin.length > 0 && origin !== "null") {
      let originHost: string;
      try {
        originHost = new URL(origin).hostname.toLowerCase();
      } catch {
        return reject(
          reply,
          request,
          403,
          "forbidden_origin",
          "Request Origin is not permitted",
        );
      }
      // No CORS headers are ever emitted, so a compliant browser cannot read a
      // response; refusing the request outright also stops the side effects of a
      // simple cross-site POST.
      if (!allowedHosts.has(originHost) && originHost !== "[::1]") {
        return reject(
          reply,
          request,
          403,
          "forbidden_origin",
          "Request Origin is not permitted",
        );
      }
    }

    if (!isGuardedPath(request.url)) {
      return;
    }

    const key = request.ip ?? "unknown";
    const counter = counterFor(key);

    if (counter.authFailures >= authMax || counter.total >= max) {
      return reject(reply, request, 429, "rate_limited", "Too many requests");
    }
    counter.total += 1;

    const header = request.headers.authorization;
    const match = typeof header === "string" ? BEARER_RE.exec(header) : null;
    // A single, exactly-shaped bearer header is the only accepted form: no query
    // parameter, no Basic, no comma-joined duplicate, no trailing junk.
    if (match === null || !verifyApiToken(options.apiToken, match[1])) {
      counter.authFailures += 1;
      return reject(
        reply,
        request,
        401,
        "unauthorized",
        "A valid API token is required",
      );
    }
  });
}
