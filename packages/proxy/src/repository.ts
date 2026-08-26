import type { SqlDatabase } from "@bayz/storage";
import { parseProxyConfig, type ProxyConfig } from "./config.js";
import {
  assertProxyId,
  assertProxyKind,
  parseProxyHost,
  parseProxyPort,
  type ProxyKind,
} from "./endpoint.js";
import { ProxyError } from "./errors.js";

const MAX_USERNAME_LENGTH = 255;

export type ProxyRecord = {
  id: string;
  kind: ProxyKind;
  host: string;
  port: number;
  username: string | undefined;
  enabled: boolean;
  config: ProxyConfig;
  createdAt: string;
  updatedAt: string;
};

export type CreateProxyInput = {
  id: string;
  kind: ProxyKind;
  host: string;
  port: number;
  username?: string;
  enabled?: boolean;
  config?: unknown;
};

export type UpdateProxyInput = {
  host?: string;
  port?: number;
  /** `null` clears a stored username; `undefined` leaves it unchanged. */
  username?: string | null;
  enabled?: boolean;
  config?: unknown;
};

export interface ProxyRepository {
  create(input: CreateProxyInput): ProxyRecord;
  get(id: string): ProxyRecord | undefined;
  require(id: string): ProxyRecord;
  list(): ProxyRecord[];
  update(id: string, patch: UpdateProxyInput): ProxyRecord;
  delete(id: string): boolean;
}

/**
 * Validate a proxy username.
 *
 * RFC 1929 caps the field at 255 bytes, and control characters would corrupt both
 * the SOCKS5 sub-negotiation and an HTTP `CONNECT` header, so they are rejected
 * here rather than escaped later.
 */
export function parseProxyUsername(value: unknown): string {
  if (typeof value !== "string") {
    throw new ProxyError("invalid_proxy_config", "username-type");
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    Buffer.byteLength(trimmed, "utf8") > MAX_USERNAME_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    throw new ProxyError("invalid_proxy_config", "username-shape");
  }
  return trimmed;
}

function parseEnabled(value: unknown, stage: string): boolean {
  if (typeof value !== "boolean") {
    throw new ProxyError("invalid_proxy_config", stage);
  }
  return value;
}

/**
 * Decode a stored row, re-validating `config_json`.
 *
 * A row edited outside the repository must not be able to install an
 * out-of-range timeout or a health-check host that is really a URL.
 */
function rowToRecord(row: Record<string, unknown>): ProxyRecord {
  const kind = assertProxyKind(String(row.kind));
  let raw: unknown;
  try {
    raw = JSON.parse(String(row.config_json));
  } catch {
    throw new ProxyError("invalid_proxy_config", "load-config");
  }
  let config: ProxyConfig;
  try {
    config = parseProxyConfig(raw);
  } catch {
    throw new ProxyError("invalid_proxy_config", "load-config");
  }

  return {
    id: String(row.id),
    kind,
    host: String(row.host),
    port: Number(row.port),
    username:
      row.username === null || row.username === undefined
        ? undefined
        : String(row.username),
    enabled: Number(row.enabled) === 1,
    config,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export type CreateProxyRepositoryOptions = {
  now?: () => string;
};

export function createProxyRepository(
  db: SqlDatabase,
  options: CreateProxyRepositoryOptions = {},
): ProxyRepository {
  const now = options.now ?? (() => new Date().toISOString());

  const selectOne = (id: string): Record<string, unknown> | undefined =>
    db.prepare("SELECT * FROM proxies WHERE id = ?").get(id);

  const repository: ProxyRepository = {
    create(input: CreateProxyInput): ProxyRecord {
      if (typeof input !== "object" || input === null) {
        throw new ProxyError("invalid_proxy_config", "create-input");
      }
      // Everything is validated before a statement runs, so the CHECK constraints
      // in migration v3 are a backstop rather than control flow.
      const id = assertProxyId(input.id);
      const kind = assertProxyKind(input.kind);
      const host = parseProxyHost(input.host);
      const port = parseProxyPort(input.port);
      const username =
        input.username === undefined
          ? undefined
          : parseProxyUsername(input.username);
      const enabled =
        input.enabled === undefined
          ? true
          : parseEnabled(input.enabled, "create-enabled");
      const config = parseProxyConfig(input.config);

      if (selectOne(id) !== undefined) {
        throw new ProxyError("proxy_already_exists", "create-proxy");
      }

      const timestamp = now();
      db.prepare(
        `INSERT INTO proxies
           (id, kind, host, port, username, enabled, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        kind,
        host,
        port,
        username ?? null,
        enabled ? 1 : 0,
        JSON.stringify(config),
        timestamp,
        timestamp,
      );

      return {
        id,
        kind,
        host,
        port,
        username,
        enabled,
        config,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    },

    get(id: string): ProxyRecord | undefined {
      const row = selectOne(assertProxyId(id));
      return row === undefined ? undefined : rowToRecord(row);
    },

    require(id: string): ProxyRecord {
      const record = repository.get(id);
      if (record === undefined) {
        throw new ProxyError("proxy_not_found", "require-proxy");
      }
      return record;
    },

    list(): ProxyRecord[] {
      return db.prepare("SELECT * FROM proxies ORDER BY id").all().map(rowToRecord);
    },

    update(id: string, patch: UpdateProxyInput): ProxyRecord {
      const current = repository.require(id);
      if (typeof patch !== "object" || patch === null) {
        throw new ProxyError("invalid_proxy_config", "update-input");
      }

      // `id` and `kind` are not patchable: the id is part of the physical password
      // name and the kind decides the handshake, so changing either in place would
      // silently rebind an existing credential to a different protocol.
      const host = patch.host === undefined ? current.host : parseProxyHost(patch.host);
      const port = patch.port === undefined ? current.port : parseProxyPort(patch.port);
      const username =
        patch.username === undefined
          ? current.username
          : patch.username === null
            ? undefined
            : parseProxyUsername(patch.username);
      const enabled =
        patch.enabled === undefined
          ? current.enabled
          : parseEnabled(patch.enabled, "update-enabled");
      const config =
        patch.config === undefined ? current.config : parseProxyConfig(patch.config);

      const timestamp = now();
      db.prepare(
        `UPDATE proxies
            SET host = ?, port = ?, username = ?, enabled = ?, config_json = ?,
                updated_at = ?
          WHERE id = ?`,
      ).run(
        host,
        port,
        username ?? null,
        enabled ? 1 : 0,
        JSON.stringify(config),
        timestamp,
        current.id,
      );

      return { ...current, host, port, username, enabled, config, updatedAt: timestamp };
    },

    delete(id: string): boolean {
      const result = db
        .prepare("DELETE FROM proxies WHERE id = ?")
        .run(assertProxyId(id));
      return result.changes > 0;
    },
  };

  return repository;
}
