import type { SqlDatabase } from "@bayz/storage";
import { MODEL_ECONOMICS, type ModelEconomics } from "./economics.js";
import type { ModelCatalogueEntry } from "./model-list.js";
import { ProviderError } from "./errors.js";

/**
 * Persistence for model economics.
 *
 * The catalogue is a *cache of classifications*, never a cache of upstream prose: the
 * table holds a provider id, a model id, one classification, and when it was read. It
 * exists so routing can ask "is this model free" without making an upstream discovery
 * call on every chat — a per-request discovery would add a round trip to every request
 * and would let a discovery outage silently empty the free set, turning an availability
 * problem into a `no_free_route` storm.
 */
export type CatalogueRow = {
  providerId: string;
  model: string;
  economics: ModelEconomics;
  discoveredAt: string;
};

export interface CatalogueRepository {
  /**
   * Replace everything known about one provider.
   *
   * Replace rather than merge: a model the upstream no longer lists must disappear,
   * or a model that was free last month stays routable forever on stale evidence.
   */
  replace(providerId: string, entries: readonly ModelCatalogueEntry[]): number;
  get(providerId: string, model: string): CatalogueRow | undefined;
  listByProvider(providerId: string): CatalogueRow[];
  /** Every free row across every provider, sorted, deduplicated by (provider, model). */
  listFree(): CatalogueRow[];
}

const ECONOMICS = new Set<string>(MODEL_ECONOMICS);

/**
 * Re-validate a stored classification.
 *
 * A row edited outside this repository must not be able to introduce a value the
 * classifier never produces — `isFreeEconomics` would return false for it, but code
 * reading it as a `ModelEconomics` would be lying about the type.
 */
function readEconomics(value: unknown): ModelEconomics {
  const text = String(value);
  if (!ECONOMICS.has(text)) {
    throw new ProviderError("invalid_provider_config", "catalogue-economics");
  }
  return text as ModelEconomics;
}

function rowToRecord(row: Record<string, unknown>): CatalogueRow {
  return {
    providerId: String(row.provider_id),
    model: String(row.model),
    economics: readEconomics(row.economics),
    discoveredAt: String(row.discovered_at),
  };
}

export type CreateCatalogueRepositoryOptions = {
  now?: () => string;
};

export function createCatalogueRepository(
  db: SqlDatabase,
  options: CreateCatalogueRepositoryOptions = {},
): CatalogueRepository {
  const now = options.now ?? (() => new Date().toISOString());

  return {
    replace(providerId: string, entries: readonly ModelCatalogueEntry[]): number {
      if (!Array.isArray(entries)) {
        throw new ProviderError("invalid_provider_config", "catalogue-shape");
      }
      const timestamp = now();
      const remove = db.prepare("DELETE FROM model_catalogue WHERE provider_id = ?");
      const insert = db.prepare(
        `INSERT INTO model_catalogue (provider_id, model, economics, discovered_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(provider_id, model) DO UPDATE
           SET economics = excluded.economics, discovered_at = excluded.discovered_at`,
      );

      // One transaction: a half-written catalogue would leave routing reading a mix of
      // this discovery and the last one, and the free set is exactly what must not be
      // half-true.
      db.exec("BEGIN IMMEDIATE");
      try {
        remove.run(providerId);
        for (const entry of entries) {
          insert.run(providerId, entry.id, readEconomics(entry.economics), timestamp);
        }
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Already unwound; the original failure is what matters.
        }
        throw error;
      }
      return entries.length;
    },

    get(providerId: string, model: string): CatalogueRow | undefined {
      const row = db
        .prepare(
          "SELECT * FROM model_catalogue WHERE provider_id = ? AND model = ?",
        )
        .get(providerId, model);
      return row === undefined ? undefined : rowToRecord(row);
    },

    listByProvider(providerId: string): CatalogueRow[] {
      return db
        .prepare("SELECT * FROM model_catalogue WHERE provider_id = ? ORDER BY model")
        .all(providerId)
        .map(rowToRecord);
    },

    listFree(): CatalogueRow[] {
      // Filtered in SQL by the classifications that are free, rather than read-all and
      // filter in JS: the index is on `economics`, and an operator with forty providers
      // should not pay for a full scan to answer "what can I use for nothing".
      const free = ["FREE_VERIFIED", "FREE_TIER", "FREE_PREVIEW", "LOCAL"];
      const placeholders = free.map(() => "?").join(", ");
      return db
        .prepare(
          `SELECT * FROM model_catalogue
            WHERE economics IN (${placeholders})
            ORDER BY model, provider_id`,
        )
        .all(...free)
        .map(rowToRecord);
    },
  };
}
