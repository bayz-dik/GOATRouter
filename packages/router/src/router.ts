import type { Agent as HttpAgent } from "node:http";
import type { Agent as HttpsAgent } from "node:https";
import { redactSecrets } from "@bayz/security";
import {
  type ProviderManager,
  type ProviderView,
} from "@bayz/providers";
import type { ProxyManager } from "@bayz/proxy";
import type { SecretStorage } from "@bayz/storage";
import { RouterError } from "./errors.js";
import { parseChatRequest, type ChatRequest } from "./request.js";
import type { ChatResponse, ChatUsage } from "./response.js";
import {
  createRouteRepository,
  type CreateRouteInput,
  type CreateRouteRepositoryOptions,
  type RouteRecord,
  type RouteRepository,
  type UpdateRouteInput,
} from "./repository.js";
import { resolveCandidates } from "./selection.js";
import { sendChatRequest } from "./transport.js";

/**
 * Failures where another provider may legitimately succeed.
 *
 * `auth_failed` is deliberately absent: a bad credential is an operator problem,
 * and silently succeeding elsewhere would hide a misconfiguration indefinitely.
 * Validation and response-shape failures are absent for the same reason — they are
 * deterministic, so retrying cannot help.
 */
const FAILOVER_CODES = new Set(["unreachable", "rate_limited", "upstream_error"]);

export type ChatResult = ChatResponse & {
  routeId: string;
  providerId: string;
  proxyId: string | undefined;
  attempts: number;
  latencyMs: number;
  usage: ChatUsage | undefined;
};

export type RouterLogger = (payload: Record<string, unknown>) => void;

export type CreateRouterOptions = {
  storage: SecretStorage;
  providers: ProviderManager;
  proxies: ProxyManager;
  logger?: RouterLogger;
  now?: () => string;
};

export interface Router {
  readonly providers: ProviderManager;
  readonly proxies: ProxyManager;
  createRoute(input: CreateRouteInput): RouteRecord;
  getRoute(id: string): RouteRecord | undefined;
  requireRoute(id: string): RouteRecord;
  listRoutes(): RouteRecord[];
  updateRoute(id: string, patch: UpdateRouteInput): RouteRecord;
  deleteRoute(id: string): boolean;
  chat(request: unknown): Promise<ChatResult>;
  close(): void;
}

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export function createRouter(options: CreateRouterOptions): Router {
  const { storage, providers, proxies, now } = options;
  const log: RouterLogger = options.logger ?? (() => {});
  const repositoryOptions: CreateRouteRepositoryOptions =
    now === undefined ? {} : { now };
  const repository: RouteRepository = createRouteRepository(
    storage.sql,
    repositoryOptions,
  );

  /**
   * Run one attempt against one candidate route.
   *
   * The credential is obtained through `withCredential`, so the plaintext exists
   * only inside the call that builds the request headers — the router never holds
   * it in a variable of its own and never returns it.
   */
  const attempt = async (
    route: RouteRecord,
    provider: ProviderView,
    request: ChatRequest,
  ): Promise<ChatResponse> => {
    const transportProvider = {
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      requestTimeoutMs: route.config.requestTimeoutMs,
    };

    let agent: HttpAgent | HttpsAgent | undefined;
    if (route.proxyId !== undefined) {
      // A proxy-bound route must genuinely traverse its proxy; if the agent
      // cannot be built the attempt fails rather than silently going direct.
      agent = proxies.agentFor(route.proxyId, {
        tls: transportProvider.baseUrl.startsWith("https:"),
      });
    }

    try {
      const send = (credential?: string): Promise<ChatResponse> =>
        sendChatRequest({
          provider: transportProvider,
          request,
          ...(credential === undefined ? {} : { credential }),
          ...(agent === undefined ? {} : { agent }),
        });

      return provider.credentialPresent
        ? await providers.withCredential(provider.id, (credential) =>
            send(credential),
          )
        : await send();
    } finally {
      agent?.destroy();
    }
  };

  const router: Router = {
    providers,
    proxies,

    createRoute(input: CreateRouteInput): RouteRecord {
      const record = repository.create(input);
      log(
        redactSecrets({
          event: "route_created",
          routeId: record.id,
          model: record.model,
          providerId: record.providerId,
        }),
      );
      return record;
    },

    getRoute(id: string): RouteRecord | undefined {
      return repository.get(id);
    },

    requireRoute(id: string): RouteRecord {
      return repository.require(id);
    },

    listRoutes(): RouteRecord[] {
      return repository.list();
    },

    updateRoute(id: string, patch: UpdateRouteInput): RouteRecord {
      const record = repository.update(id, patch);
      log(redactSecrets({ event: "route_updated", routeId: record.id }));
      return record;
    },

    deleteRoute(id: string): boolean {
      const removed = repository.delete(id);
      if (removed) {
        log(redactSecrets({ event: "route_deleted", routeId: id }));
      }
      return removed;
    },

    async chat(input: unknown): Promise<ChatResult> {
      // Validated first: a malformed request must never reach route selection,
      // let alone the network.
      const request = parseChatRequest(input);
      const candidates = resolveCandidates(repository.list(), request.model);
      if (candidates.length === 0) {
        throw new RouterError("no_route", "chat-select");
      }

      let attempts = 0;
      let lastFailure: unknown;
      let skipped = 0;

      for (const route of candidates) {
        const provider = providers.getProvider(route.providerId);
        if (provider === undefined || !provider.enabled) {
          // A disabled provider is a configuration state, not a failed attempt,
          // so it is skipped without consuming an attempt or a network call.
          skipped += 1;
          continue;
        }

        attempts += 1;
        const started = Date.now();
        try {
          const response = await attempt(route, provider, request);
          const latencyMs = Date.now() - started;
          log(
            redactSecrets({
              event: "router_attempt",
              routeId: route.id,
              providerId: provider.id,
              proxied: route.proxyId !== undefined,
              outcome: "ok",
              latencyMs,
            }),
          );
          return {
            ...response,
            routeId: route.id,
            providerId: provider.id,
            proxyId: route.proxyId,
            attempts,
            latencyMs,
          };
        } catch (error) {
          const code = codeOf(error);
          log(
            redactSecrets({
              event: "router_attempt",
              routeId: route.id,
              providerId: provider.id,
              proxied: route.proxyId !== undefined,
              outcome: "failed",
              code: code ?? "unknown",
              latencyMs: Date.now() - started,
            }),
          );
          lastFailure = error;
          if (code === undefined || !FAILOVER_CODES.has(code)) {
            // Deterministic failures and credential problems must surface, not be
            // masked by trying somewhere else.
            throw error;
          }
        }
      }

      if (lastFailure !== undefined) {
        // The real upstream code is preserved rather than flattened, so an
        // operator sees whether they were rate limited or simply offline.
        throw lastFailure;
      }
      // Every candidate was skipped because its provider is disabled. That is a
      // distinct situation from "the network failed", and `no_route` would be
      // wrong too: routes exist, they are just unusable right now.
      throw new RouterError("all_routes_failed", `chat-skipped-${skipped}`);
    },

    close(): void {
      storage.close();
    },
  };

  return router;
}
