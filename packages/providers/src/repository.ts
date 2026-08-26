import type { SqlDatabase } from "@bayz/storage";
import { parseProviderConfig, type ProviderConfig } from "./config.js";
import { ProviderError } from "./errors.js";
import { assertProviderId } from "./identity.js";
import {
  assertProviderKind,
  defaultBaseUrl,
  normalizeBaseUrl,
  type ProviderKind,
} from "./url.js";

const MAX_DISPLAY_NAME_LENGTH = 128;

export type ProviderRecord = {
  id: string;
  kind: ProviderKind;
  displayName: string;
  baseUrl: string;
  enabled: boolean;
  config: ProviderConfig;
  createdAt: string;
  updatedAt: string;
};

export type CreateProviderInput = {
  id: string;
  kind: ProviderKind;
  displayName: string;
  baseUrl?: string;
  enabled?: boolean;
  config?: unknown;
};

export type UpdateProviderInput = {
  displayName?: string;
  baseUrl?: string;
  enabled?: boolean;
  config?: unknown;
};

export interface ProviderRepository {
  create(input: CreateProviderInput): ProviderRecord;
  get(id: string): ProviderRecord | undefined;
  require(id: string): ProviderRecord;
  list(): ProviderRecord[];
  update(id: string, patch: UpdateProviderInput): ProviderRecord;
  delete(id: string): boolean;
}

function parseDisplayName(value: unknown): string {
  if (typeof value !== "string") {
    throw new ProviderError("invalid_provider_config", "display-name-type");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new ProviderError("invalid_provider_config", "display-name-length");
  }
  return trimmed;
}

function resolveBaseUrl(kind: ProviderKind, raw: unknown): string {
  if (raw === undefined) {
    const fallback = defaultBaseUrl(kind);
    if (fallback === undefined) {
      // Guessing an endpoint for a local runtime would silently point the
      // provider somewhere the operator never approved.
      throw new ProviderError("invalid_provider_config", "base-url-required");
    }
    return fallback;
  }
  return normalizeBaseUrl(raw);
}

function parseEnabled(value: unknown, stage: string): boolean {
  if (typeof value !== "boolean") {
    throw new ProviderError("invalid_provider_config", stage);
  }
  return value;
}

/**
 * Decode a stored row.
 *
 * `config_json` is re-validated rather than trusted: a row edited outside the
 * repository (or written by an older build) must not be able to install an
 * out-of-range timeout or a hostile discovery path.
 */
function rowToRecord(row: Record<string, unknown>): ProviderRecord {
  const kind = assertProviderKind(String(row.kind));
  let raw: unknown;
  try {
    raw = JSON.parse(String(row.config_json));
  } catch {
    throw new ProviderError("invalid_provider_config", "load-config");
  }
  let config: ProviderConfig;
  try {
    config = parseProviderConfig(raw, kind);
  } catch {
    throw new ProviderError("invalid_provider_config", "load-config");
  }

  return {
    id: String(row.id),
    kind,
    displayName: String(row.display_name),
    baseUrl: String(row.base_url),
    enabled: Number(row.enabled) === 1,
    config,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export type CreateProviderRepositoryOptions = {
  now?: () => string;
};

export function createProviderRepository(
  db: SqlDatabase,
  options: CreateProviderRepositoryOptions = {},
): ProviderRepository {
  const now = options.now ?? (() => new Date().toISOString());

  const selectOne = (id: string): Record<string, unknown> | undefined =>
    db.prepare("SELECT * FROM providers WHERE id = ?").get(id);

  const repository: ProviderRepository = {
    create(input: CreateProviderInput): ProviderRecord {
      if (typeof input !== "object" || input === null) {
        throw new ProviderError("invalid_provider_config", "create-input");
      }
      // Every field is validated before any statement runs, so the CHECK
      // constraints in migration v2 are a backstop rather than control flow.
      const id = assertProviderId(input.id);
      const kind = assertProviderKind(input.kind);
      const displayName = parseDisplayName(input.displayName);
      const baseUrl = resolveBaseUrl(kind, input.baseUrl);
      const enabled =
        input.enabled === undefined
          ? true
          : parseEnabled(input.enabled, "create-enabled");
      const config = parseProviderConfig(input.config, kind);

      if (selectOne(id) !== undefined) {
        throw new ProviderError("provider_already_exists", "create-provider");
      }

      const timestamp = now();
      db.prepare(
        `INSERT INTO providers
           (id, kind, display_name, base_url, enabled, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        kind,
        displayName,
        baseUrl,
        enabled ? 1 : 0,
        JSON.stringify(config),
        timestamp,
        timestamp,
      );

      return {
        id,
        kind,
        displayName,
        baseUrl,
        enabled,
        config,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    },

    get(id: string): ProviderRecord | undefined {
      const row = selectOne(assertProviderId(id));
      return row === undefined ? undefined : rowToRecord(row);
    },

    require(id: string): ProviderRecord {
      const record = repository.get(id);
      if (record === undefined) {
        throw new ProviderError("provider_not_found", "require-provider");
      }
      return record;
    },

    list(): ProviderRecord[] {
      return db
        .prepare("SELECT * FROM providers ORDER BY id")
        .all()
        .map(rowToRecord);
    },

    update(id: string, patch: UpdateProviderInput): ProviderRecord {
      const current = repository.require(id);
      if (typeof patch !== "object" || patch === null) {
        throw new ProviderError("invalid_provider_config", "update-input");
      }

      // `id` and `kind` are intentionally not patchable: the id is part of the
      // physical credential name, and the kind decides the auth scheme, so
      // changing either in place would silently rebind an existing credential.
      const displayName =
        patch.displayName === undefined
          ? current.displayName
          : parseDisplayName(patch.displayName);
      const baseUrl =
        patch.baseUrl === undefined
          ? current.baseUrl
          : normalizeBaseUrl(patch.baseUrl);
      const enabled =
        patch.enabled === undefined
          ? current.enabled
          : parseEnabled(patch.enabled, "update-enabled");
      const config =
        patch.config === undefined
          ? current.config
          : parseProviderConfig(patch.config, current.kind);

      const timestamp = now();
      db.prepare(
        `UPDATE providers
            SET display_name = ?, base_url = ?, enabled = ?, config_json = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        displayName,
        baseUrl,
        enabled ? 1 : 0,
        JSON.stringify(config),
        timestamp,
        current.id,
      );

      return {
        ...current,
        displayName,
        baseUrl,
        enabled,
        config,
        updatedAt: timestamp,
      };
    },

    delete(id: string): boolean {
      const result = db
        .prepare("DELETE FROM providers WHERE id = ?")
        .run(assertProviderId(id));
      return result.changes > 0;
    },
  };

  return repository;
}
