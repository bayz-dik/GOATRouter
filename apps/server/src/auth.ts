import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiErrorResponse } from "@bayz/contracts";
import { verifyApiToken } from "./api-token.js";
import {
  bootstrapPrincipal,
  type BayzPrincipal,
  type IdentityResolver,
} from "./principal.js";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * The authenticated caller, set by the guard hook.
     *
     * Present on every guarded route and absent on `/api/health`. Deliberately not
     * the presented key: a handler has no reason to see a credential, and not
     * carrying one means no handler can leak one.
     */
    principal?: BayzPrincipal;
  }
}

/** Requests per fixed window for an authenticated caller. */
export const DEFAULT_RATE_LIMIT_MAX = 120;
/** Failed authentications per fixed window — a brute-force brake. */
export const DEFAULT_AUTH_RATE_LIMIT_MAX = 10;
export const RATE_LIMIT_WINDOW_MS = 60_000;

const BEARER_RE = /^Bearer ([A-Za-z0-9._~+/=-]+)$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * The presented bearer, or `undefined`.
 *
 * Exported for request signing, which needs the key as the HMAC secret. Reading it
 * back off the header rather than stashing it on the request is deliberate: the
 * `principal` contract stays credential-free, so no handler can leak one.
 */
export function presentedBearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  const match = typeof header === "string" ? BEARER_RE.exec(header) : null;
  return match === null ? undefined : match[1]!;
}

export type RateLimitOptions = {
  max?: number;
  authMax?: number;
  windowMs?: number;
};

export type InstallApiGuardsOptions = {
  apiToken: string;
  rateLimit?: RateLimitOptions;
  /**
   * Maximum guarded requests in flight at once. Omitted, non-integer, or below 1
   * leaves the listener uncapped, which is the Phase 6 behaviour every existing
   * loopback install already has.
   *
   * The cap is acquired *after* authentication succeeds, not before. A slot therefore
   * represents real work — a handler, a database read, an upstream call — rather than
   * an unauthenticated stranger's ability to occupy one. Credential-free floods are
   * bounded by `authMax` instead, so the two protections do not overlap and neither
   * can be used to starve the other.
   */
  concurrency?: number;
  /** Extra hostnames an operator has explicitly bound the listener to. */
  allowedHosts?: readonly string[];
  /**
   * Resolve a presented bearer to a scoped principal.
   *
   * Tried *after* the bootstrap token, so the Phase 6 token keeps working exactly
   * as before and a resolver cannot shadow it. 9C supplies the real registry.
   */
  resolveIdentity?: IdentityResolver;
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

/**
 * Is this path behind the guard?
 *
 * Exported so request signing can gate exactly the same set the token gates. Two
 * independent path lists would eventually disagree, and the disagreement would be an
 * unsigned guarded route.
 */
export function isGuardedPath(url: string): boolean {
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

  /*
   * The in-flight cap.
   *
   * A rate limit bounds requests *per window*; it does not bound how many are being
   * served at the same instant. A hundred slow upstream calls stay inside a 120/minute
   * budget while holding a hundred sockets, file handles, and database reads open, so
   * the posture ladder's `concurrency` figure needs its own enforcement.
   *
   * `undefined` means uncapped, and so does any value that is not an integer of at
   * least 1: coercing nonsense to 0 would refuse every request, turning a
   * misconfiguration into an outage.
   */
  const concurrency =
    typeof options.concurrency === "number" &&
    Number.isInteger(options.concurrency) &&
    options.concurrency >= 1
      ? options.concurrency
      : undefined;
  let inFlight = 0;
  // Which requests hold a slot. A `WeakSet` rather than a request property because a
  // release must be idempotent and must not depend on a field a handler could clear:
  // double-releasing would let the cap drift upward until it stopped capping anything.
  const holders = new WeakSet<FastifyRequest>();

  const release = (request: FastifyRequest): void => {
    if (holders.delete(request)) {
      inFlight -= 1;
    }
  };

  /**
   * Take a slot, or refuse.
   *
   * Refusal is `429 rate_limited` with `retry-after`, the same shape the window
   * limiter already uses: to a client both mean "you are being throttled, come back",
   * and inventing a second code would make every caller special-case a distinction it
   * cannot act on differently.
   */
  const acquire = (
    request: FastifyRequest,
    reply: FastifyReply,
  ): FastifyReply | undefined => {
    if (concurrency === undefined) {
      return undefined;
    }
    if (inFlight >= concurrency) {
      return reject(reply, request, 429, "rate_limited", "Too many requests");
    }
    inFlight += 1;
    holders.add(request);
    return undefined;
  };

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
    if (match === null) {
      counter.authFailures += 1;
      return reject(
        reply,
        request,
        401,
        "unauthorized",
        "A valid API token is required",
      );
    }

    const presented = match[1]!;
    // The bootstrap token is checked first and unconditionally, so an identity
    // resolver can never shadow or weaken the Phase 6 credential.
    if (verifyApiToken(options.apiToken, presented)) {
      request.principal = bootstrapPrincipal();
      return acquire(request, reply);
    }

    const identity = options.resolveIdentity?.(presented);
    if (identity === undefined) {
      // A failed identity lookup spends the same auth budget as a bad token, so
      // guessing a client key is throttled identically to guessing the admin one.
      counter.authFailures += 1;
      return reject(
        reply,
        request,
        401,
        "unauthorized",
        "A valid API token is required",
      );
    }
    request.principal = identity;
    return acquire(request, reply);
  });

  // Release on every terminal outcome Fastify has: a sent response (success or
  // error), and a client that disconnected before one could be sent. Registering
  // both is what makes the cap recover — a slot released only on success would let a
  // handful of failures or abandoned requests wedge the listener for good.
  app.addHook("onResponse", async (request) => {
    release(request);
  });
  app.addHook("onRequestAbort", async (request) => {
    release(request);
  });
}
