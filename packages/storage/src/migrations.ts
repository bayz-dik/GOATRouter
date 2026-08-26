import { StorageError, asStorageError } from "./errors.js";
import type { SqlDatabase } from "./sql.js";

export type Migration = {
  version: number;
  statements: string[];
};

/**
 * Ordered, hand-rolled migrations. Versions are 1..n with no gaps.
 *
 * v1 stores only an encrypted envelope plus non-secret metadata. v2 adds the
 * provider registry, v3 the proxy registry, v4 the route registry, and v5 usage
 * telemetry. None of them holds a credential column, and neither `routes` nor the
 * usage tables have any column able to hold a prompt, a completion, a request or
 * response body, or an arbitrary upstream error string. Provider keys live in
 * `secrets` under `provider:<id>:api_key` and proxy passwords under
 * `proxy:<id>:password`. There is still no combo table: that belongs to its own
 * phase and would be speculative here.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE schema_migrations (
         version    INTEGER PRIMARY KEY,
         applied_at TEXT NOT NULL
       )`,
      `CREATE TABLE secrets (
         id             INTEGER PRIMARY KEY AUTOINCREMENT,
         name           TEXT    NOT NULL UNIQUE,
         version        INTEGER NOT NULL,
         algorithm      TEXT    NOT NULL,
         kdf            TEXT    NOT NULL,
         key_id         TEXT    NOT NULL,
         wrapped_dek    BLOB    NOT NULL,
         wrap_iv        BLOB    NOT NULL,
         wrap_tag       BLOB    NOT NULL,
         ciphertext     BLOB    NOT NULL,
         iv             BLOB    NOT NULL,
         tag            BLOB    NOT NULL,
         created_at     TEXT    NOT NULL,
         updated_at     TEXT    NOT NULL
       )`,
      `CREATE TABLE runtime_metadata (
         key   TEXT PRIMARY KEY,
         value TEXT NOT NULL
       )`,
    ],
  },
  {
    version: 2,
    statements: [
      `CREATE TABLE providers (
         id           TEXT    PRIMARY KEY,
         kind         TEXT    NOT NULL CHECK (kind IN
                      ('openai-compatible','openrouter','gemini','codex-oauth')),
         display_name TEXT    NOT NULL,
         base_url     TEXT    NOT NULL,
         enabled      INTEGER NOT NULL CHECK (enabled IN (0, 1)),
         config_json  TEXT    NOT NULL,
         created_at   TEXT    NOT NULL,
         updated_at   TEXT    NOT NULL
       )`,
    ],
  },
  {
    version: 3,
    statements: [
      // `username` is cleartext on purpose: it is not a secret, and the SOCKS5
      // greeting has to name it before any credential is exchanged. The password
      // lives only in `secrets`, under `proxy:<id>:password`.
      `CREATE TABLE proxies (
         id          TEXT    PRIMARY KEY,
         kind        TEXT    NOT NULL CHECK (kind IN ('socks5', 'http')),
         host        TEXT    NOT NULL,
         port        INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
         username    TEXT,
         enabled     INTEGER NOT NULL CHECK (enabled IN (0, 1)),
         config_json TEXT    NOT NULL,
         created_at  TEXT    NOT NULL,
         updated_at  TEXT    NOT NULL
       )`,
    ],
  },
  {
    version: 4,
    statements: [
      // ON DELETE CASCADE for the provider: a route to a deleted provider is
      // meaningless, so it goes with it rather than dangling.
      // ON DELETE SET NULL for the proxy: removing a proxy should degrade a route
      // to a direct connection, not silently break it.
      `CREATE TABLE routes (
         id          TEXT    PRIMARY KEY,
         model       TEXT    NOT NULL,
         provider_id TEXT    NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
         proxy_id    TEXT             REFERENCES proxies(id) ON DELETE SET NULL,
         priority    INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 1000),
         enabled     INTEGER NOT NULL CHECK (enabled IN (0, 1)),
         config_json TEXT    NOT NULL,
         created_at  TEXT    NOT NULL,
         updated_at  TEXT    NOT NULL
       )`,
      `CREATE UNIQUE INDEX routes_model_provider_idx
         ON routes (model, provider_id)`,
    ],
  },
  {
    version: 5,
    statements: [
      /*
       * Usage telemetry: metadata only.
       *
       * There is deliberately no TEXT column able to hold a prompt, a completion, a
       * message, a request or response body, an Authorization header, or an
       * arbitrary upstream error string. `failure_category` is enum-constrained so
       * error text cannot be smuggled through it, which is a schema-level backstop
       * behind the telemetry boundary that already refuses it.
       *
       * No foreign key to `providers`/`routes`/`proxies`: a usage row is a
       * historical fact and must survive the deletion of what it refers to.
       */
      `CREATE TABLE usage_requests (
         request_id        TEXT    PRIMARY KEY,
         occurred_at       TEXT    NOT NULL,
         route_id          TEXT,
         provider_id       TEXT,
         proxy_id          TEXT,
         model             TEXT    NOT NULL,
         routing_mode      TEXT    NOT NULL CHECK (routing_mode IN ('direct','combo','failover')),
         outcome           TEXT    NOT NULL CHECK (outcome IN ('ok','failed')),
         failure_category  TEXT    CHECK (failure_category IS NULL OR failure_category IN (
                             'auth_failed','rate_limited','unreachable','timeout',
                             'upstream_error','invalid_response','response_too_large',
                             'credential_missing','no_route','all_routes_failed',
                             'unsupported_operation','proxy_error','forbidden','refused',
                             'protocol_error','unknown_error')),
         latency_ms        INTEGER NOT NULL CHECK (latency_ms >= 0),
         attempts          INTEGER NOT NULL CHECK (attempts >= 0),
         prompt_tokens     INTEGER CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
         completion_tokens INTEGER CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
         cached_tokens     INTEGER CHECK (cached_tokens IS NULL OR cached_tokens >= 0)
       )`,
      `CREATE INDEX usage_requests_occurred_idx ON usage_requests (occurred_at)`,
      `CREATE TABLE usage_attempts (
         id               INTEGER PRIMARY KEY AUTOINCREMENT,
         request_id       TEXT    NOT NULL,
         occurred_at      TEXT    NOT NULL,
         route_id         TEXT,
         provider_id      TEXT    NOT NULL,
         outcome          TEXT    NOT NULL CHECK (outcome IN ('ok','failed')),
         failure_category TEXT    CHECK (failure_category IS NULL OR failure_category IN (
                            'auth_failed','rate_limited','unreachable','timeout',
                            'upstream_error','invalid_response','response_too_large',
                            'credential_missing','no_route','all_routes_failed',
                            'unsupported_operation','proxy_error','forbidden','refused',
                            'protocol_error','unknown_error')),
         latency_ms       INTEGER NOT NULL CHECK (latency_ms >= 0)
       )`,
      `CREATE INDEX usage_attempts_occurred_idx ON usage_attempts (occurred_at)`,
      `CREATE INDEX usage_attempts_provider_idx ON usage_attempts (provider_id)`,
    ],
  },
];

export const TARGET_SCHEMA_VERSION = MIGRATIONS.length;

export function readSchemaVersion(db: SqlDatabase): number {
  const row = db.prepare("PRAGMA user_version").get();
  return Number(row?.user_version ?? 0);
}

/**
 * Apply every migration newer than the recorded version.
 *
 * Each migration runs inside BEGIN IMMEDIATE and sets `user_version` in the same
 * transaction, which is what makes it atomic: a failure rolls back both the
 * schema change and the version bump, so no partial schema can survive.
 *
 * Re-running is a no-op, which the test suite asserts.
 */
export function runMigrations(
  db: SqlDatabase,
  migrations: readonly Migration[] = MIGRATIONS,
): number {
  const current = readSchemaVersion(db);
  let applied = 0;

  for (const migration of migrations) {
    if (migration.version <= current) {
      continue;
    }
    // `PRAGMA user_version` cannot be parameterized, so the value is guarded
    // before interpolation. No external input reaches this path.
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new StorageError("storage_unavailable", "migration-version");
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of migration.statements) {
        db.exec(statement);
      }
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(migration.version, new Date().toISOString());
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
      applied += 1;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The transaction is already unwound; the original failure is what matters.
      }
      throw asStorageError(
        "storage_unavailable",
        `migrate:${migration.version}`,
        error,
      );
    }
  }

  return applied;
}
