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
  proxyId: string | undefined;
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
  priority?: number;
  enabled?: boolean;
  config?: unknown;
};

export type UpdateRouteInput = {
  /** `null` clears a proxy binding; `undefined` leaves it unchanged. */
  proxyId?: string | null;
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
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        model,
        providerId,
        proxyId ?? null,
        priority,
        enabled ? 1 : 0,
        JSON.stringify(config),
        timestamp,
        timestamp,
      );

      return {
        id,
        model,
        providerId,
        proxyId,
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
            SET proxy_id = ?, priority = ?, enabled = ?, config_json = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        proxyId ?? null,
        priority,
        enabled ? 1 : 0,
        JSON.stringify(config),
        timestamp,
        current.id,
      );

      return { ...current, proxyId, priority, enabled, config, updatedAt: timestamp };
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
