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
 * provider registry, v3 the proxy registry, and v4 the route registry. None of
 * them holds a credential column, and `routes` deliberately has no column able to
 * hold a prompt or a completion: the router persists neither. Provider keys live
 * in `secrets` under `provider:<id>:api_key` and proxy passwords under
 * `proxy:<id>:password`. There is still no combo or usage table: those belong to
 * their own phases and would be speculative here.
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
