import type { FastifyInstance } from "fastify";
import { errorEnvelope, handleDomain } from "../http-errors.js";
import type { BayzRuntime } from "../runtime.js";

/**
 * Usage endpoints.
 *
 * Every response is assembled here from repository records by copying named scalar
 * fields — the same closed-set discipline the telemetry boundary uses on the way in.
 * A provider view is never spread wholesale into a response, because that is how a
 * future field would leak.
 */

const PERIODS = {
  today: 24 * 3600_000,
  "24h": 24 * 3600_000,
  "7d": 7 * 24 * 3600_000,
  "30d": 30 * 24 * 3600_000,
} as const;

type Period = keyof typeof PERIODS;

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/** Strict period parsing: an unrecognized value is a 400, never a silent default. */
function parsePeriod(raw: unknown): Period | undefined {
  if (raw === undefined) {
    return "today";
  }
  return typeof raw === "string" && raw in PERIODS ? (raw as Period) : undefined;
}

/** Strict limit parsing: only a plain positive integer within bounds. */
function parseLimit(raw: unknown): number | undefined {
  if (raw === undefined) {
    return DEFAULT_LIMIT;
  }
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    return undefined;
  }
  const parsed = Number(raw);
  return parsed >= 1 && parsed <= MAX_LIMIT ? parsed : undefined;
}

export function registerUsageRoutes(app: FastifyInstance, runtime: BayzRuntime): void {
  app.get<{ Querystring: { period?: string } }>(
    "/api/usage/summary",
    async (request, reply) => {
      const period = parsePeriod(request.query.period);
      if (period === undefined) {
        return reply
          .code(400)
          .send(
            errorEnvelope(
              request,
              "invalid_request",
              "period must be one of today, 24h, 7d, 30d",
            ),
          );
      }
      return handleDomain(request, reply, () => {
        const summary = runtime.usage.summarize(Date.now() - PERIODS[period]);
        return {
          period,
          totalRequests: summary.totalRequests,
          okRequests: summary.okRequests,
          failedRequests: summary.failedRequests,
          // `null` is deliberate: no provider reported a count. It is not zero.
          promptTokens: summary.promptTokens ?? null,
          completionTokens: summary.completionTokens ?? null,
          cachedTokens: summary.cachedTokens ?? null,
          tokenReports: summary.tokenReports,
          averageLatencyMs: summary.averageLatencyMs ?? null,
          // Bayz has no pricing table and no billing API; saying so is the honest
          // answer, and an estimate would be a fabricated number wearing a label.
          costAvailable: summary.costAvailable,
          costReason: summary.costReason,
          retention: {
            requests: runtime.usage.requestRetention(),
            attempts: runtime.usage.attemptRetention(),
          },
        };
      });
    },
  );

  app.get<{ Querystring: { limit?: string } }>(
    "/api/usage/requests",
    async (request, reply) => {
      const limit = parseLimit(request.query.limit);
      if (limit === undefined) {
        return reply
          .code(400)
          .send(
            errorEnvelope(
              request,
              "invalid_request",
              `limit must be an integer from 1 to ${MAX_LIMIT}`,
            ),
          );
      }
      return handleDomain(request, reply, () => ({
        requests: runtime.usage.recentRequests(limit).map((row) => ({
          requestId: row.requestId,
          occurredAt: row.occurredAt,
          routeId: row.routeId ?? null,
          providerId: row.providerId ?? null,
          proxyId: row.proxyId ?? null,
          model: row.model,
          routingMode: row.routingMode,
          outcome: row.outcome,
          failureCategory: row.failureCategory ?? null,
          latencyMs: row.latencyMs,
          attempts: row.attempts,
          promptTokens: row.promptTokens ?? null,
          completionTokens: row.completionTokens ?? null,
          cachedTokens: row.cachedTokens ?? null,
        })),
      }));
    },
  );

  app.get<{ Querystring: { period?: string } }>(
    "/api/usage/providers",
    async (request, reply) => {
      const period = parsePeriod(request.query.period);
      if (period === undefined) {
        return reply
          .code(400)
          .send(
            errorEnvelope(
              request,
              "invalid_request",
              "period must be one of today, 24h, 7d, 30d",
            ),
          );
      }
      return handleDomain(request, reply, () => {
        const activity = new Map(
          runtime.usage
            .providerActivity(Date.now() - PERIODS[period])
            .map((entry) => [entry.providerId, entry]),
        );

        // Registered providers are the spine of the list so a provider with no
        // traffic still appears; activity is layered on where it exists.
        const providers = runtime.providers.listProviders().map((provider) => {
          const stats = activity.get(provider.id);
          return {
            providerId: provider.id,
            displayName: provider.displayName,
            kind: provider.kind,
            enabled: provider.enabled,
            // Presence only. There is no read path for the value anywhere in Bayz.
            credentialPresent: provider.credentialPresent,
            attempts: stats?.attempts ?? 0,
            failures: stats?.failures ?? 0,
            lastOutcome: stats?.lastOutcome ?? null,
            lastFailureCategory: stats?.lastFailureCategory ?? null,
            averageLatencyMs: stats?.averageLatencyMs ?? null,
          };
        });

        // Attempts against a provider that has since been deleted are still real
        // history, so they are reported rather than dropped.
        for (const [providerId, stats] of activity) {
          if (!providers.some((entry) => entry.providerId === providerId)) {
            providers.push({
              providerId,
              displayName: providerId,
              kind: "openai-compatible",
              enabled: false,
              credentialPresent: false,
              attempts: stats.attempts,
              failures: stats.failures,
              lastOutcome: stats.lastOutcome ?? null,
              lastFailureCategory: stats.lastFailureCategory ?? null,
              averageLatencyMs: stats.averageLatencyMs ?? null,
            });
          }
        }

        return { period, providers };
      });
    },
  );

  app.delete("/api/usage/requests", async (request, reply) =>
    handleDomain(request, reply, () => {
      runtime.usage.purge();
      // 204 either way: idempotent, and identical whether or not rows existed, so
      // the response reveals nothing about stored state.
      void reply.code(204);
      return null;
    }),
  );
}
