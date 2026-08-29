import type { SqlDatabase } from "@bayz/storage";
import { parseProviderConfig, type ProviderConfig } from "./config.js";
import { ProviderError } from "./errors.js";
import { assertProviderId } from "./identity.js";
import { assertEgressAllowed, type EgressPolicy } from "./egress.js";
import {
  assertProviderKind,
  defaultBaseUrl,
  hostnameOfBaseUrl,
  normalizeBaseUrl,
  type ProviderKind,
} from "./url.js";

const MAX_DISPLAY_NAME_LENGTH = 128;

/**
 * Ceiling on one bulk proxy assignment.
 *
 * Bounded because the statement count is linear in the batch and an unbounded request
 * would hold the write lock for as long as the caller cared to make it. 200 is far
 * above any real provider count and far below a problem.
 */
export const MAX_PROXY_ASSIGN_BATCH = 200;

/**
 * The proxy id alphabet.
 *
 * Identical to the provider id alphabet, and to `@bayz/proxy`'s own `assertProxyId`.
 * Duplicated rather than imported because `@bayz/providers` does not depend on
 * `@bayz/proxy` and adding the dependency to reach one regex would invert the layering
 * — the router is what composes the two. A test in `@bayz/proxy` pins the alphabet, and
 * the foreign key is the backstop if the two ever drifted.
 */
const PROXY_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type ProviderRecord = {
  id: string;
  kind: ProviderKind;
  displayName: string;
  baseUrl: string;
  enabled: boolean;
  config: ProviderConfig;
  /**
   * The proxy every route to this provider uses unless the route overrides it.
   *
   * `undefined` means direct. There is deliberately no `""` alternative: a second way
   * to say "direct" would compare truthily somewhere before long.
   */
  proxyId?: string;
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
  proxyId?: string;
};

export type UpdateProviderInput = {
  displayName?: string;
  baseUrl?: string;
  enabled?: boolean;
  config?: unknown;
  /**
   * `null` sets the provider to direct; `undefined` leaves the assignment alone.
   *
   * The two must differ. A patch omits every field it is not changing, so if
   * `undefined` meant "direct" then renaming a provider would silently drop the
   * operator's proxy choice.
   */
  proxyId?: string | null;
};

export interface ProviderRepository {
  create(input: CreateProviderInput): ProviderRecord;
  get(id: string): ProviderRecord | undefined;
  /**
   * Whether a row with this id exists, without decoding it.
   *
   * Separate from `get` so a caller that only needs existence — deletion, most importantly — is not
   * defeated by a corrupt `config_json`.
   */
  exists(id: string): boolean;
  require(id: string): ProviderRecord;
  list(): ProviderRecord[];
  /**
   * Ids of rows `list` could not decode.
   *
   * Exists so tolerating a corrupt row is not the same as hiding it — see `list`.
   */
  listUnreadable(): string[];
  update(id: string, patch: UpdateProviderInput): ProviderRecord;
  delete(id: string): boolean;
  /** Provider ids currently defaulting to this proxy, sorted. Empty if unknown. */
  providersUsingProxy(proxyId: string): string[];
  /**
   * Point a batch of providers at one proxy, or at direct with `null`.
   *
   * Atomic: one bad id fails the whole call. A partial assignment would leave the
   * operator with a half-applied change and no way to tell which half.
   */
  assignProxy(proxyId: string | null, providerIds: readonly string[]): number;
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

function policyOf(config: ProviderConfig): EgressPolicy {
  return {
    allowLoopback: config.allowLoopback === true,
    allowPrivate: config.allowPrivate === true,
  };
}

/**
 * Refuse a base URL the egress policy forbids.
 *
 * Enforced at *write* time, so a provider targeting a cloud metadata endpoint cannot
 * be stored at all — and therefore cannot be dialled even by a future code path that
 * forgets to check. Applied on update as well as create, or an operator could store a
 * legitimate provider and then move it.
 *
 * Deliberately **not** applied when loading a row: an install created before 9D may
 * hold a loopback URL with no opt-in, and refusing to load it would brick that
 * install on upgrade. The connect-time check in the HTTP path is what protects the
 * request itself.
 */
function assertStorableBaseUrl(baseUrl: string, config: ProviderConfig): void {
  assertEgressAllowed(hostnameOfBaseUrl(baseUrl), policyOf(config));
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

  // A stored proxy id that no longer matches the alphabet is dropped to direct rather
  // than failing the load: the reference is not security-bearing (the foreign key
  // guarantees the proxy exists) and refusing to load the provider would take its
  // credential offline over a cosmetic problem.
  const storedProxy = row.proxy_id;
  const proxyId =
    typeof storedProxy === "string" && PROXY_ID_RE.test(storedProxy)
      ? storedProxy
      : undefined;

  return {
    id: String(row.id),
    kind,
    displayName: String(row.display_name),
    baseUrl: String(row.base_url),
    enabled: Number(row.enabled) === 1,
    config,
    ...(proxyId === undefined ? {} : { proxyId }),
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

  /** Validate a proxy id's shape. Pre-SQL, so the id never reaches a statement raw. */
  const assertProxyIdShape = (value: unknown): string => {
    if (
      typeof value !== "string" ||
      !PROXY_ID_RE.test(value) ||
      value.includes("..") ||
      value.endsWith("-")
    ) {
      throw new ProviderError("invalid_provider_config", "proxy-id");
    }
    return value;
  };

  /**
   * Resolve a requested proxy reference to what should be stored.
   *
   * Existence is checked here rather than left to the foreign key, so an unknown proxy
   * is a domain `invalid_provider_config` an API can turn into a 400 — a raw constraint
   * violation would surface as a driver error and a 500.
   */
  const resolveProxyId = (value: unknown): string | undefined => {
    if (value === undefined || value === null) {
      return undefined;
    }
    const proxyId = assertProxyIdShape(value);
    const exists = db.prepare("SELECT 1 FROM proxies WHERE id = ?").get(proxyId);
    if (exists === undefined) {
      throw new ProviderError("invalid_provider_config", "proxy-not-found");
    }
    return proxyId;
  };

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
      assertStorableBaseUrl(baseUrl, config);
      const proxyId = resolveProxyId(input.proxyId);

      if (selectOne(id) !== undefined) {
        throw new ProviderError("provider_already_exists", "create-provider");
      }

      const timestamp = now();
      db.prepare(
        `INSERT INTO providers
           (id, kind, display_name, base_url, enabled, config_json, proxy_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        kind,
        displayName,
        baseUrl,
        enabled ? 1 : 0,
        JSON.stringify(config),
        proxyId ?? null,
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
        ...(proxyId === undefined ? {} : { proxyId }),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    },

    get(id: string): ProviderRecord | undefined {
      const row = selectOne(assertProviderId(id));
      return row === undefined ? undefined : rowToRecord(row);
    },

    exists(id: string): boolean {
      // Deliberately does not decode the row; see the interface note.
      return selectOne(assertProviderId(id)) !== undefined;
    },

    require(id: string): ProviderRecord {
      const record = repository.get(id);
      if (record === undefined) {
        throw new ProviderError("provider_not_found", "require-provider");
      }
      return record;
    },

    list(): ProviderRecord[] {
      /*
       * **A single unreadable row must not take the whole install down.**
       *
       * Found by the 9J upgrade ladder against the installed artifact: `runtime.describe()` counts
       * providers through this method at startup, so one row with unparseable `config_json` made the
       * daemon exit before listening — taking every healthy provider and every stored credential
       * offline over one corrupt field.
       *
       * Unreadable rows are skipped here and reported by `listUnreadable`, never silently dropped.
       * Silence would be its own failure: an operator cannot repair a provider that nothing admits
       * exists, while its credential sits encrypted in the database attached to it.
       *
       * `get`/`require` still throw for the specific row, so nothing routes through a config that
       * failed validation.
       */
      const records: ProviderRecord[] = [];
      for (const row of db.prepare("SELECT * FROM providers ORDER BY id").all()) {
        try {
          records.push(rowToRecord(row));
        } catch {
          // Reported by `listUnreadable`, which reads the same rows.
        }
      }
      return records;
    },

    listUnreadable(): string[] {
      const ids: string[] = [];
      for (const row of db.prepare("SELECT * FROM providers ORDER BY id").all()) {
        try {
          rowToRecord(row);
        } catch {
          ids.push(String(row.id));
        }
      }
      return ids;
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
      // Re-checked against the *resulting* pair, so neither moving the URL nor
      // removing the opt-in can leave a stored state the policy forbids.
      assertStorableBaseUrl(baseUrl, config);
      // Three cases, and they are genuinely different: absent leaves the assignment
      // alone, `null` sets direct, a string reassigns.
      const proxyId =
        patch.proxyId === undefined
          ? current.proxyId
          : resolveProxyId(patch.proxyId);

      const timestamp = now();
      db.prepare(
        `UPDATE providers
            SET display_name = ?, base_url = ?, enabled = ?, config_json = ?,
                proxy_id = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        displayName,
        baseUrl,
        enabled ? 1 : 0,
        JSON.stringify(config),
        proxyId ?? null,
        timestamp,
        current.id,
      );

      return {
        id: current.id,
        kind: current.kind,
        displayName,
        baseUrl,
        enabled,
        config,
        // The key is omitted rather than set to `undefined`, matching `create` and
        // `rowToRecord`. A present-but-undefined key serializes differently and shows up
        // as a spurious field in anything that enumerates the record.
        ...(proxyId === undefined ? {} : { proxyId }),
        createdAt: current.createdAt,
        updatedAt: timestamp,
      };
    },

    delete(id: string): boolean {
      const result = db
        .prepare("DELETE FROM providers WHERE id = ?")
        .run(assertProviderId(id));
      return result.changes > 0;
    },

    providersUsingProxy(proxyId: string): string[] {
      return db
        .prepare("SELECT id FROM providers WHERE proxy_id = ? ORDER BY id")
        .all(assertProxyIdShape(proxyId))
        .map((row) => String(row.id));
    },

    assignProxy(proxyId: string | null, providerIds: readonly string[]): number {
      if (!Array.isArray(providerIds) || providerIds.length === 0) {
        // An empty batch is refused rather than reported as "0 changed": it is almost
        // always a caller bug, and a success response would hide it.
        throw new ProviderError("invalid_provider_config", "assign-batch-shape");
      }
      if (providerIds.length > MAX_PROXY_ASSIGN_BATCH) {
        throw new ProviderError("invalid_provider_config", "assign-batch-size");
      }

      // Validate everything before writing anything. Deduplicated first so a repeated
      // id is one change rather than N.
      const unique = [...new Set(providerIds.map((id) => assertProviderId(id)))];
      const resolved = resolveProxyId(proxyId);
      for (const id of unique) {
        if (selectOne(id) === undefined) {
          throw new ProviderError("provider_not_found", "assign-provider");
        }
      }

      const timestamp = now();
      const statement = db.prepare(
        "UPDATE providers SET proxy_id = ?, updated_at = ? WHERE id = ?",
      );
      // Wrapped so a failure mid-batch leaves no provider reassigned. The validation
      // above makes that unlikely; the transaction makes it impossible.
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const id of unique) {
          statement.run(resolved ?? null, timestamp, id);
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
      return unique.length;
    },
  };

  return repository;
}
