import type { Agent as HttpAgent } from "node:http";
import type { Agent as HttpsAgent } from "node:https";
import { randomUUID } from "node:crypto";
import { redactSecrets } from "@bayz/security";
import {
  egressPolicyOf,
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
import {
  filterFreeCandidates,
  isFreeCandidate,
  resolveCandidates,
} from "./selection.js";
import { sendChatRequest, sendChatRequestStreaming } from "./transport.js";
import type { ChatChunk } from "./chunk.js";

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

/**
 * A streamed chunk plus the routing facts that produced it.
 *
 * The routing identity rides on every chunk rather than being reported separately,
 * because the server must write `x-bayz-route` and `x-bayz-provider` *before* the
 * first byte — HTTP headers cannot be revised afterwards. Carrying it on the chunk
 * means the header values come from the same object the body does, so they cannot
 * disagree.
 */
export type RoutedChatChunk = ChatChunk & {
  routeId: string;
  providerId: string;
  proxyId: string | undefined;
  attempts: number;
};

export type RouterLogger = (payload: Record<string, unknown>) => void;

/**
 * Observational telemetry sink.
 *
 * Receives display-safe metadata only. It is deliberately typed as an opaque
 * record: the router assembles named scalar fields and the telemetry boundary
 * validates them, so no request or response object is ever handed over.
 */
export type RouterRecorder = (event: Record<string, unknown>) => void;

export type ChatOptions = {
  /** Correlation id. Replaced when it is not a safe slug. */
  requestId?: string;
  /**
   * Cancellation from the client.
   *
   * A cancelled request is deliberately *not* a provider failure: aborting does
   * not consume a failover attempt and does not mark the provider unhealthy,
   * because the provider did nothing wrong.
   */
  signal?: AbortSignal;
};

export type CreateRouterOptions = {
  storage: SecretStorage;
  providers: ProviderManager;
  proxies: ProxyManager;
  logger?: RouterLogger;
  /** When present, routing facts are reported here as metadata. */
  recorder?: RouterRecorder;
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
  chat(request: unknown, options?: ChatOptions): Promise<ChatResult>;
  /**
   * Stream one chat completion.
   *
   * Failover happens only *before* the first chunk reaches the consumer. After
   * that the response is committed — BAYZ cannot un-send bytes, so retrying
   * elsewhere would interleave two completions. `router-stream.test.ts` asserts the
   * second origin observes zero requests in that case.
   */
  chatStream(
    request: unknown,
    options?: ChatOptions,
  ): AsyncGenerator<RoutedChatChunk, void, undefined>;
  close(): void;
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * A correlation id safe to store and log.
 *
 * A caller-supplied value is accepted only when it is already a bounded slug;
 * anything else is replaced with a generated id, so nothing user-controlled can
 * ride into telemetry through this field.
 */
function safeRequestId(supplied: unknown): string {
  return typeof supplied === "string" && SAFE_REQUEST_ID.test(supplied)
    ? supplied
    : `req_${randomUUID()}`;
}

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/**
 * The proxy an attempt actually uses.
 *
 * Order: route override → provider default → direct.
 *
 * `route.proxyId === undefined` means *inherit*, not direct, which is why
 * `forceDirect` exists: without it there would be no way to express "this one route
 * goes direct even though its provider is proxied", and an operator would have to
 * remove the provider default and re-add it to every other route.
 *
 * Everything downstream reads this one function — the agent, the telemetry, the
 * `x-bayz-proxy` header, and the chunk metadata. Two implementations would eventually
 * disagree, and the disagreement would show up as telemetry claiming a request went
 * direct when it went through a tunnel.
 */
function effectiveProxyId(
  route: RouteRecord,
  provider: ProviderView,
): string | undefined {
  if (route.forceDirect) {
    return undefined;
  }
  return route.proxyId ?? provider.proxyId;
}

export function createRouter(options: CreateRouterOptions): Router {
  const { storage, providers, proxies, now } = options;
  const log: RouterLogger = options.logger ?? (() => {});
  const recorder = options.recorder;
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
    // Header *values* come from `requestConfig` rather than the view: the view
    // withholds them because it is what the HTTP API serializes, and the router is the
    // one caller that legitimately needs them on the wire.
    const requestConfig = providers.requestConfig(provider.id);
    const transportProvider = {
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      requestTimeoutMs: route.config.requestTimeoutMs,
      // The provider's own opt-ins travel with the attempt. Without this the
      // transport's deny-by-default would refuse every legitimate local runtime.
      egress: egressPolicyOf(requestConfig),
      ...(requestConfig.headers === undefined
        ? {}
        : { headers: requestConfig.headers }),
      ...(provider.config.supportsTools === undefined
        ? {}
        : { supportsTools: provider.config.supportsTools }),
    };

    const proxyId = effectiveProxyId(route, provider);
    let agent: HttpAgent | HttpsAgent | undefined;
    if (proxyId !== undefined) {
      // A proxy-bound attempt must genuinely traverse its proxy; if the agent
      // cannot be built the attempt fails rather than silently going direct. That
      // holds for an inherited proxy exactly as for a route override — an operator
      // who disabled a proxy has not consented to their traffic leaving directly.
      agent = proxies.agentFor(proxyId, {
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

  /**
   * Open one streaming attempt against one candidate route.
   *
   * The first chunk is pulled *inside* the `withCredential` callback on purpose.
   * An async generator does not execute its body until first pulled, so merely
   * constructing it inside the callback would build the request headers later —
   * after the scoped-use window had closed. Awaiting the first chunk here keeps
   * header construction where the credential is legitimately lent.
   *
   * The agent is returned rather than destroyed: a streaming attempt outlives this
   * function, so tearing the agent down here would kill the stream it just opened.
   */
  const attemptStream = async (
    route: RouteRecord,
    provider: ProviderView,
    request: ChatRequest,
    signal: AbortSignal | undefined,
  ): Promise<{
    iterator: AsyncIterator<ChatChunk>;
    first: IteratorResult<ChatChunk>;
    agent: HttpAgent | HttpsAgent | undefined;
  }> => {
    const requestConfig = providers.requestConfig(provider.id);
    const transportProvider = {
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      requestTimeoutMs: route.config.requestTimeoutMs,
      egress: egressPolicyOf(requestConfig),
      ...(requestConfig.headers === undefined
        ? {}
        : { headers: requestConfig.headers }),
      ...(provider.config.supportsTools === undefined
        ? {}
        : { supportsTools: provider.config.supportsTools }),
    };

    // The same resolver as the buffered path. Two implementations would drift.
    const proxyId = effectiveProxyId(route, provider);
    let agent: HttpAgent | HttpsAgent | undefined;
    if (proxyId !== undefined) {
      agent = proxies.agentFor(proxyId, {
        tls: transportProvider.baseUrl.startsWith("https:"),
      });
    }

    const start = async (
      credential?: string,
    ): Promise<{ iterator: AsyncIterator<ChatChunk>; first: IteratorResult<ChatChunk> }> => {
      const iterator = sendChatRequestStreaming({
        provider: transportProvider,
        request,
        ...(credential === undefined ? {} : { credential }),
        ...(agent === undefined ? {} : { agent }),
        ...(signal === undefined ? {} : { signal }),
      })[Symbol.asyncIterator]();
      const first = await iterator.next();
      return { iterator, first };
    };

    try {
      const opened = provider.credentialPresent
        ? await providers.withCredential(provider.id, (credential) => start(credential))
        : await start();
      return { ...opened, agent };
    } catch (error) {
      agent?.destroy();
      throw error;
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

    async chat(input: unknown, chatOptions: ChatOptions = {}): Promise<ChatResult> {
      // Validated first: a malformed request must never reach route selection,
      // let alone the network. Nothing is emitted for a request that never entered
      // routing: there are no routing facts to observe yet.
      const request = parseChatRequest(input);
      const requestId = safeRequestId(chatOptions.requestId);

      /**
       * Emit one metadata event.
       *
       * Only named scalar fields are assembled here; no request, response, or error
       * object is ever passed through. A throwing sink is swallowed because
       * telemetry is observational and must never become part of routing
       * correctness.
       */
      const emit = (event: Record<string, unknown>): void => {
        if (recorder === undefined) {
          return;
        }
        try {
          recorder({
            requestId,
            occurredAt: new Date().toISOString(),
            model: request.model,
            ...event,
          });
        } catch {
          // A broken recorder cannot break a chat.
        }
      };

      const candidates = resolveCandidates(repository.list(), request.model);
      if (candidates.length === 0) {
        emit({
          kind: "request.failed",
          routingMode: "direct",
          failureCategory: "no_route",
          latencyMs: 0,
          attempts: 0,
        });
        throw new RouterError("no_route", "chat-select");
      }

      // Free-only filtering happens here, before any socket is opened, so a route that
      // may not spend money never reaches a paid provider even once. Refusing after an
      // attempt would already have cost the operator the request.
      const eligible = filterFreeCandidates(candidates, (route) =>
        providers.modelEconomics(route.providerId, route.model),
      );
      if (eligible.length === 0) {
        emit({
          kind: "request.failed",
          routingMode: "direct",
          // The fixed code and nothing else: no candidate list, no model, no price.
          failureCategory: "no_free_route",
          latencyMs: 0,
          attempts: 0,
        });
        throw new RouterError("no_free_route", "chat-free-only");
      }

      // Mode is a routing fact: more than one candidate means the request could
      // legitimately land elsewhere, and a second attempt makes it a failover.
      const baseMode = eligible.length >= 2 ? "combo" : "direct";
      let attempts = 0;
      let lastFailure: unknown;
      let skipped = 0;

      for (const route of eligible) {
        const provider = providers.getProvider(route.providerId);
        if (provider === undefined || !provider.enabled) {
          // A disabled provider is a configuration state, not a failed attempt,
          // so it is skipped without consuming an attempt or a network call.
          skipped += 1;
          continue;
        }
        // Re-checked per attempt, not just once up front: a fresh discovery can
        // reclassify a model to PAID between the first attempt and the failover, and
        // continuing on the stale reading is how a free-only route ends up spending.
        if (
          route.freeOnly &&
          !isFreeCandidate(providers.modelEconomics(route.providerId, route.model))
        ) {
          emit({
            kind: "request.failed",
            routingMode: attempts > 0 ? "failover" : baseMode,
            failureCategory: "no_free_route",
            latencyMs: 0,
            attempts,
          });
          throw new RouterError("no_free_route", "chat-free-only-recheck");
        }
        // Resolved once per candidate and used for every telemetry field below, so
        // what an operator reads is what the socket did. `attempt` calls the same pure
        // resolver, so the two cannot disagree.
        const effectiveProxy = effectiveProxyId(route, provider);

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
              proxied: effectiveProxy !== undefined,
              outcome: "ok",
              latencyMs,
            }),
          );
          const mode = attempts > 1 ? "failover" : baseMode;
          if (attempts > 1) {
            // The handoff itself is worth naming, so an operator can see which
            // provider took over.
            emit({
              kind: "failover.started",
              routeId: route.id,
              providerId: provider.id,
              ...(effectiveProxy === undefined ? {} : { proxyId: effectiveProxy }),
              routingMode: mode,
              latencyMs,
              attempts,
            });
          }
          emit({
            kind: "provider.attempted",
            routeId: route.id,
            providerId: provider.id,
            ...(effectiveProxy === undefined ? {} : { proxyId: effectiveProxy }),
            routingMode: mode,
            latencyMs,
            attempts,
          });
          emit({
            kind: "request.completed",
            routeId: route.id,
            providerId: provider.id,
            ...(effectiveProxy === undefined ? {} : { proxyId: effectiveProxy }),
            routingMode: mode,
            latencyMs,
            attempts,
            // Only counts the upstream actually reported. Absent stays absent: a
            // provider that reported nothing is not a provider that used zero.
            ...(response.usage?.promptTokens === undefined
              ? {}
              : { promptTokens: response.usage.promptTokens }),
            ...(response.usage?.completionTokens === undefined
              ? {}
              : { completionTokens: response.usage.completionTokens }),
            ...(response.usage?.totalTokens === undefined
              ? {}
              : { cachedTokens: undefined }),
          });
          return {
            ...response,
            routeId: route.id,
            providerId: provider.id,
            proxyId: effectiveProxy,
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
              proxied: effectiveProxy !== undefined,
              outcome: "failed",
              code: code ?? "unknown",
              latencyMs: Date.now() - started,
            }),
          );
          const failLatency = Date.now() - started;
          const category = code ?? "unknown_error";
          emit({
            kind: "provider.failed",
            routeId: route.id,
            providerId: provider.id,
            ...(effectiveProxy === undefined ? {} : { proxyId: effectiveProxy }),
            routingMode: attempts > 1 ? "failover" : baseMode,
            failureCategory: category,
            latencyMs: failLatency,
            attempts,
          });
          lastFailure = error;
          if (code === undefined || !FAILOVER_CODES.has(code)) {
            // Deterministic failures and credential problems must surface, not be
            // masked by trying somewhere else.
            emit({
              kind: "request.failed",
              routeId: route.id,
              providerId: provider.id,
              ...(effectiveProxy === undefined ? {} : { proxyId: effectiveProxy }),
              routingMode: attempts > 1 ? "failover" : baseMode,
              failureCategory: category,
              latencyMs: failLatency,
              attempts,
            });
            throw error;
          }
        }
      }

      if (lastFailure !== undefined) {
        emit({
          kind: "request.failed",
          routingMode: attempts > 1 ? "failover" : baseMode,
          failureCategory: codeOf(lastFailure) ?? "all_routes_failed",
          latencyMs: 0,
          attempts,
        });
        // The real upstream code is preserved rather than flattened, so an
        // operator sees whether they were rate limited or simply offline.
        throw lastFailure;
      }
      // Every candidate was skipped because its provider is disabled. That is a
      // distinct situation from "the network failed", and `no_route` would be
      // wrong too: routes exist, they are just unusable right now.
      emit({
        kind: "request.failed",
        routingMode: baseMode,
        failureCategory: "all_routes_failed",
        latencyMs: 0,
        attempts,
      });
      throw new RouterError("all_routes_failed", `chat-skipped-${skipped}`);
    },

    async *chatStream(
      input: unknown,
      chatOptions: ChatOptions = {},
    ): AsyncGenerator<RoutedChatChunk, void, undefined> {
      const request = parseChatRequest(input);
      const requestId = safeRequestId(chatOptions.requestId);
      const signal = chatOptions.signal;

      const emit = (event: Record<string, unknown>): void => {
        if (recorder === undefined) {
          return;
        }
        try {
          recorder({
            requestId,
            occurredAt: new Date().toISOString(),
            model: request.model,
            ...event,
          });
        } catch {
          // A broken recorder cannot break a chat.
        }
      };

      const candidates = resolveCandidates(repository.list(), request.model);
      if (candidates.length === 0) {
        emit({
          kind: "request.failed",
          routingMode: "direct",
          failureCategory: "no_route",
          latencyMs: 0,
          attempts: 0,
        });
        throw new RouterError("no_route", "chat-stream-select");
      }

      // The streaming path enforces free-only identically. A gap here would be the
      // easier one to miss and the more expensive one to have: streaming is what a
      // chat client uses by default.
      const eligible = filterFreeCandidates(candidates, (route) =>
        providers.modelEconomics(route.providerId, route.model),
      );
      if (eligible.length === 0) {
        emit({
          kind: "request.failed",
          routingMode: "direct",
          failureCategory: "no_free_route",
          latencyMs: 0,
          attempts: 0,
        });
        throw new RouterError("no_free_route", "chat-stream-free-only");
      }

      const baseMode = eligible.length >= 2 ? "combo" : "direct";
      let attempts = 0;
      let lastFailure: unknown;
      let skipped = 0;

      for (const route of eligible) {
        const provider = providers.getProvider(route.providerId);
        if (provider === undefined || !provider.enabled) {
          skipped += 1;
          continue;
        }
        if (
          route.freeOnly &&
          !isFreeCandidate(providers.modelEconomics(route.providerId, route.model))
        ) {
          emit({
            kind: "request.failed",
            routingMode: attempts > 0 ? "failover" : baseMode,
            failureCategory: "no_free_route",
            latencyMs: 0,
            attempts,
          });
          throw new RouterError("no_free_route", "chat-stream-free-only-recheck");
        }
        // Same resolver as the buffered path, for the same reason: the header written
        // before the first body byte has to match what the socket did.
        const effectiveProxy = effectiveProxyId(route, provider);

        attempts += 1;
        const started = Date.now();
        let opened: Awaited<ReturnType<typeof attemptStream>>;
        try {
          opened = await attemptStream(route, provider, request, signal);
        } catch (error) {
          const code = codeOf(error);
          const failLatency = Date.now() - started;
          log(
            redactSecrets({
              event: "router_stream_attempt",
              routeId: route.id,
              providerId: provider.id,
              proxied: effectiveProxy !== undefined,
              outcome: "failed",
              code: code ?? "unknown",
              latencyMs: failLatency,
            }),
          );
          emit({
            kind: "provider.failed",
            routeId: route.id,
            providerId: provider.id,
            ...(effectiveProxy === undefined ? {} : { proxyId: effectiveProxy }),
            routingMode: attempts > 1 ? "failover" : baseMode,
            failureCategory: code ?? "unknown_error",
            latencyMs: failLatency,
            attempts,
          });
          lastFailure = error;
          // A client cancellation is not a provider fault, so it never triggers
          // failover even though the transport reports it as `unreachable`.
          const aborted = signal?.aborted === true;
          if (aborted || code === undefined || !FAILOVER_CODES.has(code)) {
            emit({
              kind: "request.failed",
              routeId: route.id,
              providerId: provider.id,
              ...(effectiveProxy === undefined ? {} : { proxyId: effectiveProxy }),
              routingMode: attempts > 1 ? "failover" : baseMode,
              failureCategory: code ?? "unknown_error",
              latencyMs: failLatency,
              attempts,
            });
            throw error;
          }
          continue;
        }

        // Past this point a chunk has been produced and the response is committed.
        // Every remaining failure is terminal, and the loop is never re-entered.
        const mode = attempts > 1 ? "failover" : baseMode;
        const firstLatency = Date.now() - started;
        if (attempts > 1) {
          emit({
            kind: "failover.started",
            routeId: route.id,
            providerId: provider.id,
            ...(effectiveProxy === undefined ? {} : { proxyId: effectiveProxy }),
            routingMode: mode,
            latencyMs: firstLatency,
            attempts,
          });
        }
        emit({
          kind: "provider.attempted",
          routeId: route.id,
          providerId: provider.id,
          ...(effectiveProxy === undefined ? {} : { proxyId: effectiveProxy }),
          routingMode: mode,
          latencyMs: firstLatency,
          attempts,
        });

        let usage: ChatUsage | undefined;
        try {
          let step = opened.first;
          while (step.done !== true) {
            if (step.value.usage !== undefined) {
              usage = step.value.usage;
            }
            yield {
              ...step.value,
              routeId: route.id,
              providerId: provider.id,
              proxyId: effectiveProxy,
              attempts,
            };
            step = await opened.iterator.next();
          }
          const latencyMs = Date.now() - started;
          log(
            redactSecrets({
              event: "router_stream_attempt",
              routeId: route.id,
              providerId: provider.id,
              proxied: effectiveProxy !== undefined,
              outcome: "ok",
              latencyMs,
            }),
          );
          emit({
            kind: "request.completed",
            routeId: route.id,
            providerId: provider.id,
            ...(effectiveProxy === undefined ? {} : { proxyId: effectiveProxy }),
            routingMode: mode,
            latencyMs,
            attempts,
            ...(usage?.promptTokens === undefined
              ? {}
              : { promptTokens: usage.promptTokens }),
            ...(usage?.completionTokens === undefined
              ? {}
              : { completionTokens: usage.completionTokens }),
          });
          return;
        } catch (error) {
          const code = codeOf(error);
          const latencyMs = Date.now() - started;
          log(
            redactSecrets({
              event: "router_stream_attempt",
              routeId: route.id,
              providerId: provider.id,
              proxied: effectiveProxy !== undefined,
              outcome: "failed",
              code: code ?? "unknown",
              latencyMs,
              afterFirstChunk: true,
            }),
          );
          emit({
            kind: "request.failed",
            routeId: route.id,
            providerId: provider.id,
            ...(effectiveProxy === undefined ? {} : { proxyId: effectiveProxy }),
            routingMode: mode,
            failureCategory: code ?? "unknown_error",
            latencyMs,
            attempts,
          });
          throw error;
        } finally {
          // `return()` propagates into the generator's own `finally`, which
          // destroys the socket. Without this a consumer that broke out of its loop
          // would leave the upstream generating tokens nobody reads.
          await opened.iterator.return?.(undefined);
          opened.agent?.destroy();
        }
      }

      if (lastFailure !== undefined) {
        emit({
          kind: "request.failed",
          routingMode: attempts > 1 ? "failover" : baseMode,
          failureCategory: codeOf(lastFailure) ?? "all_routes_failed",
          latencyMs: 0,
          attempts,
        });
        throw lastFailure;
      }
      emit({
        kind: "request.failed",
        routingMode: baseMode,
        failureCategory: "all_routes_failed",
        latencyMs: 0,
        attempts,
      });
      throw new RouterError("all_routes_failed", `chat-stream-skipped-${skipped}`);
    },

    close(): void {
      storage.close();
    },
  };

  return router;
}
