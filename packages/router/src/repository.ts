import type { SqlDatabase } from "@bayz/storage";
import { RouterError } from "./errors.js";
import { assertModelPattern } from "./model.js";

const ROUTE_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const MAX_ATTEMPTS_MIN = 1;
export const MAX_ATTEMPTS_MAX = 5;
export const MAX_ATTEMPTS_DEFAULT = 2;
export const REQUEST_TIMEOUT_MS_MIN = 1000;
export const REQUEST_TIMEOUT_MS_MAX = 600000;
export const REQUEST_TIMEOUT_MS_DEFAULT = 60000;
export const PRIORITY_MIN = 0;
export const PRIORITY_MAX = 1000;
export const PRIORITY_DEFAULT = 100;

const ALLOWED_CONFIG_KEYS = new Set(["maxAttempts", "requestTimeoutMs"]);

export type RouteConfig = {
  maxAttempts: number;
  requestTimeoutMs: number;
};

export type RouteRecord = {
  id: string;
  model: string;
  providerId: string;
  /**
   * A proxy this route uses regardless of the provider's default.
   *
   * `undefined` does **not** mean direct — it means "inherit". See `forceDirect`.
   */
  proxyId: string | undefined;
  /**
   * Never proxy this route, even when its provider has a default.
   *
   * This exists because `proxyId: undefined` has to mean "inherit the provider's
   * proxy", which leaves no way to say "this one route goes direct". Two states, one
   * NULL column, so the flag is the only thing that can distinguish them.
   */
  forceDirect: boolean;
  /**
   * Whether this route may spend money.
   *
   * `true` — the default — restricts selection to candidates whose economics are
   * proven free. It is not a preference: there is no paid fallback when the free
   * candidates fail, because a fallback would spend money precisely when the operator
   * was least watching.
   */
  freeOnly: boolean;
  priority: number;
  enabled: boolean;
  config: RouteConfig;
  createdAt: string;
  updatedAt: string;
};

export type CreateRouteInput = {
  id: string;
  model: string;
  providerId: string;
  proxyId?: string;
  /** Mutually exclusive with `proxyId`: setting both is contradictory intent. */
  forceDirect?: boolean;
  /** Defaults to `true`. Paid routing is opt-in, per spec §25 rule 6. */
  freeOnly?: boolean;
  priority?: number;
  enabled?: boolean;
  config?: unknown;
};

export type UpdateRouteInput = {
  /** `null` returns the route to inheriting; `undefined` leaves it unchanged. */
  proxyId?: string | null;
  /**
   * Set or clear force-direct.
   *
   * Assigning a `proxyId` in the same patch clears this, because assigning a proxy is
   * unambiguous intent and refusing would make the operator issue two calls to express
   * one decision.
   */
  forceDirect?: boolean;
  /**
   * Turn free-only off (or back on).
   *
   * Setting this to `false` is the one patch in this repository that can start costing
   * the operator money, which is why the server records it as an audit event rather
   * than treating it as an ordinary field update.
   */
  freeOnly?: boolean;
  priority?: number;
  enabled?: boolean;
  config?: unknown;
};

export interface RouteRepository {
  create(input: CreateRouteInput): RouteRecord;
  get(id: string): RouteRecord | undefined;
  require(id: string): RouteRecord;
  list(): RouteRecord[];
  update(id: string, patch: UpdateRouteInput): RouteRecord;
  delete(id: string): boolean;
}

export function assertRouteId(id: unknown): string {
  if (
    typeof id !== "string" ||
    !ROUTE_ID_RE.test(id) ||
    id.includes("..") ||
    id.endsWith("-")
  ) {
    throw new RouterError("invalid_route_id", "route-id");
  }
  return id;
}

function parseBoundedInteger(
  value: unknown,
  min: number,
  max: number,
  stage: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new RouterError("invalid_route_config", stage);
  }
  return value;
}

/**
 * Strict route configuration parsing.
 *
 * Unknown keys are rejected rather than ignored, which is what keeps a caller
 * from smuggling `stream: true` or a header bag into a route: there is no key in
 * this schema that can carry either, and an attempt to add one fails loudly.
 */
export function parseRouteConfig(input: unknown): RouteConfig {
  if (input === undefined) {
    return {
      maxAttempts: MAX_ATTEMPTS_DEFAULT,
      requestTimeoutMs: REQUEST_TIMEOUT_MS_DEFAULT,
    };
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new RouterError("invalid_route_config", "config-shape");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RouterError("invalid_route_config", "config-prototype");
  }

  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_CONFIG_KEYS.has(key)) {
      throw new RouterError("invalid_route_config", "config-unknown-key");
    }
  }

  return {
    maxAttempts:
      record.maxAttempts === undefined
        ? MAX_ATTEMPTS_DEFAULT
        : parseBoundedInteger(
            record.maxAttempts,
            MAX_ATTEMPTS_MIN,
            MAX_ATTEMPTS_MAX,
            "config-max-attempts",
          ),
    requestTimeoutMs:
      record.requestTimeoutMs === undefined
        ? REQUEST_TIMEOUT_MS_DEFAULT
        : parseBoundedInteger(
            record.requestTimeoutMs,
            REQUEST_TIMEOUT_MS_MIN,
            REQUEST_TIMEOUT_MS_MAX,
            "config-request-timeout",
          ),
  };
}

/**
 * Decode a stored row, re-validating the model pattern and config.
 *
 * A row edited outside the repository must not be able to install a traversal
 * model name or an unbounded attempt count, so both are re-checked here rather
 * than trusted because they were valid once.
 */
function rowToRecord(row: Record<string, unknown>): RouteRecord {
  let model: string;
  try {
    model = assertModelPattern(String(row.model));
  } catch {
    throw new RouterError("invalid_route_config", "load-model");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(String(row.config_json));
  } catch {
    throw new RouterError("invalid_route_config", "load-config");
  }
  let config: RouteConfig;
  try {
    config = parseRouteConfig(raw);
  } catch {
    throw new RouterError("invalid_route_config", "load-config");
  }

  return {
    id: String(row.id),
    model,
    providerId: String(row.provider_id),
    proxyId:
      row.proxy_id === null || row.proxy_id === undefined
        ? undefined
        : String(row.proxy_id),
    forceDirect: Number(row.force_direct) === 1,
    // Anything other than an explicit 0 reads as free-only. The CHECK constraint makes
    // a third value impossible, and defaulting the unreadable case to "may spend" would
    // be the wrong direction to fail.
    freeOnly: Number(row.free_only) !== 0,
    priority: Number(row.priority),
    enabled: Number(row.enabled) === 1,
    config,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseEnabled(value: unknown, stage: string): boolean {
  if (typeof value !== "boolean") {
    throw new RouterError("invalid_route_config", stage);
  }
  return value;
}

export type CreateRouteRepositoryOptions = {
  now?: () => string;
};

export function createRouteRepository(
  db: SqlDatabase,
  options: CreateRouteRepositoryOptions = {},
): RouteRepository {
  const now = options.now ?? (() => new Date().toISOString());

  const selectOne = (id: string): Record<string, unknown> | undefined =>
    db.prepare("SELECT * FROM routes WHERE id = ?").get(id);

  const requireProviderExists = (providerId: unknown): string => {
    if (typeof providerId !== "string") {
      throw new RouterError("invalid_route_config", "provider-id-type");
    }
    const row = db
      .prepare("SELECT id FROM providers WHERE id = ?")
      .get(providerId);
    if (row === undefined) {
      // Checked before the insert so the operator gets a validation error rather
      // than a raw foreign-key failure from the driver.
      throw new RouterError("invalid_route_config", "unknown-provider");
    }
    return providerId;
  };

  const requireProxyExists = (proxyId: unknown): string => {
    if (typeof proxyId !== "string") {
      throw new RouterError("invalid_route_config", "proxy-id-type");
    }
    const row = db.prepare("SELECT id FROM proxies WHERE id = ?").get(proxyId);
    if (row === undefined) {
      throw new RouterError("invalid_route_config", "unknown-proxy");
    }
    return proxyId;
  };

  const repository: RouteRepository = {
    create(input: CreateRouteInput): RouteRecord {
      if (typeof input !== "object" || input === null) {
        throw new RouterError("invalid_route_config", "create-input");
      }
      const id = assertRouteId(input.id);
      let model: string;
      try {
        model = assertModelPattern(input.model);
      } catch {
        throw new RouterError("invalid_route_config", "create-model");
      }
      const providerId = requireProviderExists(input.providerId);
      const proxyId =
        input.proxyId === undefined ? undefined : requireProxyExists(input.proxyId);
      const forceDirect =
        input.forceDirect === undefined
          ? false
          : parseEnabled(input.forceDirect, "create-force-direct");
      // Absent means free-only. §25 rule 6: an older client that knows nothing about
      // this field must not thereby create a route that can spend money.
      const freeOnly =
        input.freeOnly === undefined
          ? true
          : parseEnabled(input.freeOnly, "create-free-only");
      if (forceDirect && proxyId !== undefined) {
        // Contradictory: "use this proxy" and "never use a proxy". Picking a winner
        // silently would make the stored config do something the operator did not ask
        // for.
        throw new RouterError("invalid_route_config", "proxy-and-force-direct");
      }
      const priority =
        input.priority === undefined
          ? PRIORITY_DEFAULT
          : parseBoundedInteger(
              input.priority,
              PRIORITY_MIN,
              PRIORITY_MAX,
              "create-priority",
            );
      const enabled =
        input.enabled === undefined
          ? true
          : parseEnabled(input.enabled, "create-enabled");
      const config = parseRouteConfig(input.config);

      if (selectOne(id) !== undefined) {
        throw new RouterError("route_already_exists", "create-route-id");
      }
      const pair = db
        .prepare("SELECT id FROM routes WHERE model = ? AND provider_id = ?")
        .get(model, providerId);
      if (pair !== undefined) {
        throw new RouterError("route_already_exists", "create-route-pair");
      }

      const timestamp = now();
      db.prepare(
        `INSERT INTO routes
           (id, model, provider_id, proxy_id, priority, enabled, config_json,
            force_direct, free_only, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        model,
        providerId,
        proxyId ?? null,
        priority,
        enabled ? 1 : 0,
        JSON.stringify(config),
        forceDirect ? 1 : 0,
        freeOnly ? 1 : 0,
        timestamp,
        timestamp,
      );

      return {
        id,
        model,
        providerId,
        proxyId,
        forceDirect,
        freeOnly,
        priority,
        enabled,
        config,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    },

    get(id: string): RouteRecord | undefined {
      const row = selectOne(assertRouteId(id));
      return row === undefined ? undefined : rowToRecord(row);
    },

    require(id: string): RouteRecord {
      const record = repository.get(id);
      if (record === undefined) {
        throw new RouterError("route_not_found", "require-route");
      }
      return record;
    },

    list(): RouteRecord[] {
      return db.prepare("SELECT * FROM routes ORDER BY id").all().map(rowToRecord);
    },

    update(id: string, patch: UpdateRouteInput): RouteRecord {
      const current = repository.require(id);
      if (typeof patch !== "object" || patch === null) {
        throw new RouterError("invalid_route_config", "update-input");
      }

      // `id`, `model`, and `providerId` are not patchable: together they are the
      // route's identity, and changing one in place would silently repoint an
      // existing binding instead of creating a new, reviewable one.
      const proxyId =
        patch.proxyId === undefined
          ? current.proxyId
          : patch.proxyId === null
            ? undefined
            : requireProxyExists(patch.proxyId);
      // Assigning a proxy clears force-direct: it is unambiguous intent, and refusing
      // would make the operator issue two calls to express one decision. An explicit
      // `forceDirect` in the same patch still wins, and is then checked for conflict.
      const forceDirect =
        patch.forceDirect !== undefined
          ? parseEnabled(patch.forceDirect, "update-force-direct")
          : patch.proxyId !== undefined && patch.proxyId !== null
            ? false
            : current.forceDirect;
      if (forceDirect && proxyId !== undefined) {
        throw new RouterError("invalid_route_config", "proxy-and-force-direct");
      }
      const freeOnly =
        patch.freeOnly === undefined
          ? current.freeOnly
          : parseEnabled(patch.freeOnly, "update-free-only");
      const priority =
        patch.priority === undefined
          ? current.priority
          : parseBoundedInteger(
              patch.priority,
              PRIORITY_MIN,
              PRIORITY_MAX,
              "update-priority",
            );
      const enabled =
        patch.enabled === undefined
          ? current.enabled
          : parseEnabled(patch.enabled, "update-enabled");
      const config =
        patch.config === undefined ? current.config : parseRouteConfig(patch.config);

      const timestamp = now();
      db.prepare(
        `UPDATE routes
            SET proxy_id = ?, priority = ?, enabled = ?, config_json = ?,
                force_direct = ?, free_only = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        proxyId ?? null,
        priority,
        enabled ? 1 : 0,
        JSON.stringify(config),
        forceDirect ? 1 : 0,
        freeOnly ? 1 : 0,
        timestamp,
        current.id,
      );

      return {
        ...current,
        proxyId,
        forceDirect,
        freeOnly,
        priority,
        enabled,
        config,
        updatedAt: timestamp,
      };
    },

    delete(id: string): boolean {
      const result = db
        .prepare("DELETE FROM routes WHERE id = ?")
        .run(assertRouteId(id));
      return result.changes > 0;
    },
  };

  return repository;
}
