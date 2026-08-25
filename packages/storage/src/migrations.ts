import { StorageError, asStorageError } from "./errors.js";
import type { SqlDatabase } from "./sql.js";

export type Migration = {
  version: number;
  statements: string[];
};

/**
 * Ordered, hand-rolled migrations. Versions are 1..n with no gaps.
 *
 * Phase 2 stores only an encrypted envelope plus non-secret metadata. There is
 * deliberately no provider, proxy, route, combo, or usage table: those belong to
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
