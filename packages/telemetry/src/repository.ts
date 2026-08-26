import type { SqlDatabase } from "@bayz/storage";
import type { FailureCategory, RoutingMode, UsageOutcome, UsageRow } from "./events.js";

/**
 * Usage persistence with bounded retention.
 *
 * Reads and writes go through the `SqlDatabase` interface, so this file never
 * imports a concrete driver and the Phase 2 single-import boundary is unaffected.
 *
 * Retention is count-based and scoped by table name to `usage_requests` and
 * `usage_attempts`. Nothing else is ever deleted — a test seeds a provider, proxy,
 * route, and secret and asserts they survive heavy usage churn.
 */

/** Newest N requests kept. Count-based because it bounds disk deterministically. */
export const DEFAULT_REQUEST_RETENTION = 5_000;
/** Newest N attempts kept. Higher because one request can attempt many providers. */
export const DEFAULT_ATTEMPT_RETENTION = 20_000;
/**
 * The smallest configurable retention.
 *
 * One is legitimate — an operator may want only the last request kept — so the
 * floor exists only to reject zero and negatives, which would either delete
 * everything or make the bound meaningless.
 */
const MIN_RETENTION = 1;
const MAX_RETENTION = 1_000_000;
const MAX_READ_LIMIT = 200;
const DEFAULT_READ_LIMIT = 50;

export type UsageRequestRecord = {
  requestId: string;
  occurredAt: string;
  routeId: string | undefined;
  providerId: string | undefined;
  proxyId: string | undefined;
  model: string;
  routingMode: RoutingMode;
  outcome: UsageOutcome;
  failureCategory: FailureCategory | undefined;
  latencyMs: number;
  attempts: number;
  promptTokens: number | undefined;
  completionTokens: number | undefined;
  cachedTokens: number | undefined;
};

export type UsageAttemptRecord = {
  requestId: string;
  occurredAt: string;
  routeId: string | undefined;
  providerId: string;
  outcome: UsageOutcome;
  failureCategory: FailureCategory | undefined;
  latencyMs: number;
};

export type UsageSummary = {
  totalRequests: number;
  okRequests: number;
  failedRequests: number;
  /** Undefined when no request reported a count; never silently 0. */
  promptTokens: number | undefined;
  completionTokens: number | undefined;
  cachedTokens: number | undefined;
  /** How many requests actually reported token counts. */
  tokenReports: number;
  averageLatencyMs: number | undefined;
  /** Bayz has no pricing table, so cost is stated unavailable rather than guessed. */
  costAvailable: false;
  costReason: string;
};

export type ProviderActivity = {
  providerId: string;
  attempts: number;
  failures: number;
  lastOutcome: UsageOutcome | undefined;
  lastFailureCategory: FailureCategory | undefined;
  averageLatencyMs: number | undefined;
};

export interface UsageRepository {
  record(row: UsageRow): void;
  recentRequests(limit?: number): UsageRequestRecord[];
  recentAttempts(limit?: number): UsageAttemptRecord[];
  summarize(sinceEpochMs: number): UsageSummary;
  providerActivity(sinceEpochMs: number): ProviderActivity[];
  requestRetention(): number;
  attemptRetention(): number;
}

export type CreateUsageRepositoryOptions = {
  requestRetention?: number;
  attemptRetention?: number;
};

/**
 * Clamp a retention bound.
 *
 * A malformed value can never disable retention: it falls back to the documented
 * default, so unbounded growth is not reachable through configuration.
 */
function retentionOf(value: unknown, fallback: number): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_RETENTION ||
    value > MAX_RETENTION
  ) {
    return fallback;
  }
  return value;
}

function readLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return DEFAULT_READ_LIMIT;
  }
  return Math.min(value, MAX_READ_LIMIT);
}

function optionalText(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

/** SQLite returns NULL as `null`; unknown must stay unknown, never become 0. */
function optionalCount(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

function toRequest(row: Record<string, unknown>): UsageRequestRecord {
  return {
    requestId: String(row.request_id),
    occurredAt: String(row.occurred_at),
    routeId: optionalText(row.route_id),
    providerId: optionalText(row.provider_id),
    proxyId: optionalText(row.proxy_id),
    model: String(row.model),
    routingMode: String(row.routing_mode) as RoutingMode,
    outcome: String(row.outcome) as UsageOutcome,
    failureCategory: optionalText(row.failure_category) as FailureCategory | undefined,
    latencyMs: Number(row.latency_ms),
    attempts: Number(row.attempts),
    promptTokens: optionalCount(row.prompt_tokens),
    completionTokens: optionalCount(row.completion_tokens),
    cachedTokens: optionalCount(row.cached_tokens),
  };
}

function toAttempt(row: Record<string, unknown>): UsageAttemptRecord {
  return {
    requestId: String(row.request_id),
    occurredAt: String(row.occurred_at),
    routeId: optionalText(row.route_id),
    providerId: String(row.provider_id),
    outcome: String(row.outcome) as UsageOutcome,
    failureCategory: optionalText(row.failure_category) as FailureCategory | undefined,
    latencyMs: Number(row.latency_ms),
  };
}

export function createUsageRepository(
  db: SqlDatabase,
  options: CreateUsageRepositoryOptions = {},
): UsageRepository {
  const requestRetention = retentionOf(options.requestRetention, DEFAULT_REQUEST_RETENTION);
  const attemptRetention = retentionOf(options.attemptRetention, DEFAULT_ATTEMPT_RETENTION);

  /**
   * Prune to the newest N rows.
   *
   * The table name is a literal from the two call sites below, never interpolated
   * from input, and the DELETE is scoped to that one table — retention has no way
   * to reach providers, proxies, routes, or secrets.
   */
  function prune(table: "usage_requests" | "usage_attempts", keep: number): void {
    const column = table === "usage_requests" ? "request_id" : "id";
    db.prepare(
      `DELETE FROM ${table}
         WHERE ${column} NOT IN (
           SELECT ${column} FROM ${table}
            ORDER BY occurred_at DESC, ${column} DESC
            LIMIT ?
         )`,
    ).run(keep);
  }

  const repository: UsageRepository = {
    record(row: UsageRow): void {
      if (row.kind === "request.completed" || row.kind === "request.failed") {
        // Upsert: a request is recorded once, and a re-record replaces rather than
        // duplicating, so a retry cannot inflate the totals.
        db.prepare(
          `INSERT INTO usage_requests
             (request_id, occurred_at, route_id, provider_id, proxy_id, model,
              routing_mode, outcome, failure_category, latency_ms, attempts,
              prompt_tokens, completion_tokens, cached_tokens)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(request_id) DO UPDATE SET
             occurred_at = excluded.occurred_at,
             route_id = excluded.route_id,
             provider_id = excluded.provider_id,
             proxy_id = excluded.proxy_id,
             model = excluded.model,
             routing_mode = excluded.routing_mode,
             outcome = excluded.outcome,
             failure_category = excluded.failure_category,
             latency_ms = excluded.latency_ms,
             attempts = excluded.attempts,
             prompt_tokens = excluded.prompt_tokens,
             completion_tokens = excluded.completion_tokens,
             cached_tokens = excluded.cached_tokens`,
        ).run(
          row.requestId,
          row.occurredAt,
          row.routeId ?? null,
          row.providerId ?? null,
          row.proxyId ?? null,
          row.model,
          row.routingMode,
          row.outcome,
          row.failureCategory ?? null,
          row.latencyMs,
          row.attempts,
          row.promptTokens ?? null,
          row.completionTokens ?? null,
          row.cachedTokens ?? null,
        );
        prune("usage_requests", requestRetention);
        return;
      }

      // Attempt-shaped events. `providerId` is guaranteed present by the boundary.
      if (row.providerId === undefined) {
        return;
      }
      db.prepare(
        `INSERT INTO usage_attempts
           (request_id, occurred_at, route_id, provider_id, outcome, failure_category,
            latency_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.requestId,
        row.occurredAt,
        row.routeId ?? null,
        row.providerId,
        row.outcome,
        row.failureCategory ?? null,
        row.latencyMs,
      );
      prune("usage_attempts", attemptRetention);
    },

    recentRequests(limit?: number): UsageRequestRecord[] {
      return db
        .prepare(
          `SELECT * FROM usage_requests
            ORDER BY occurred_at DESC, request_id DESC
            LIMIT ?`,
        )
        .all(readLimit(limit))
        .map(toRequest);
    },

    recentAttempts(limit?: number): UsageAttemptRecord[] {
      return db
        .prepare(
          `SELECT * FROM usage_attempts ORDER BY occurred_at DESC, id DESC LIMIT ?`,
        )
        .all(readLimit(limit))
        .map(toAttempt);
    },

    summarize(sinceEpochMs: number): UsageSummary {
      const since = new Date(
        Number.isFinite(sinceEpochMs) ? sinceEpochMs : Date.now() - 86_400_000,
      ).toISOString();

      const row = db
        .prepare(
          `SELECT
             COUNT(*)                                          AS total,
             SUM(CASE WHEN outcome = 'ok' THEN 1 ELSE 0 END)   AS ok,
             SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
             SUM(prompt_tokens)                                AS prompt_tokens,
             SUM(completion_tokens)                            AS completion_tokens,
             SUM(cached_tokens)                                AS cached_tokens,
             COUNT(prompt_tokens)                              AS token_reports,
             AVG(latency_ms)                                   AS avg_latency
           FROM usage_requests
           WHERE occurred_at >= ?`,
        )
        .get(since);

      const tokenReports = Number(row?.token_reports ?? 0);
      const total = Number(row?.total ?? 0);

      return {
        totalRequests: total,
        okRequests: Number(row?.ok ?? 0),
        failedRequests: Number(row?.failed ?? 0),
        // `SUM` over all-NULL yields NULL, which is exactly "nobody reported".
        promptTokens: tokenReports === 0 ? undefined : Number(row?.prompt_tokens ?? 0),
        completionTokens:
          tokenReports === 0 ? undefined : Number(row?.completion_tokens ?? 0),
        cachedTokens: tokenReports === 0 ? undefined : Number(row?.cached_tokens ?? 0),
        tokenReports,
        averageLatencyMs:
          total === 0 ? undefined : Math.round(Number(row?.avg_latency ?? 0)),
        costAvailable: false,
        costReason: "no_pricing_data",
      };
    },

    providerActivity(sinceEpochMs: number): ProviderActivity[] {
      const since = new Date(
        Number.isFinite(sinceEpochMs) ? sinceEpochMs : Date.now() - 86_400_000,
      ).toISOString();

      const rows = db
        .prepare(
          `SELECT
             provider_id,
             COUNT(*) AS attempts,
             SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failures,
             AVG(latency_ms) AS avg_latency
           FROM usage_attempts
           WHERE occurred_at >= ?
           GROUP BY provider_id
           ORDER BY provider_id`,
        )
        .all(since);

      const latest = db.prepare(
        `SELECT outcome, failure_category FROM usage_attempts
          WHERE provider_id = ? AND occurred_at >= ?
          ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      );

      return rows.map((row) => {
        const providerId = String(row.provider_id);
        const last = latest.get(providerId, since);
        return {
          providerId,
          attempts: Number(row.attempts),
          failures: Number(row.failures ?? 0),
          lastOutcome: optionalText(last?.outcome) as UsageOutcome | undefined,
          lastFailureCategory: optionalText(last?.failure_category) as
            | FailureCategory
            | undefined,
          averageLatencyMs:
            row.avg_latency === null ? undefined : Math.round(Number(row.avg_latency)),
        };
      });
    },

    requestRetention: () => requestRetention,
    attemptRetention: () => attemptRetention,
  };

  return repository;
}
