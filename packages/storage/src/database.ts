import { StorageError, asStorageError } from "./errors.js";
import { selectDriver } from "./drivers/node-sqlite.js";
import { runMigrations, readSchemaVersion } from "./migrations.js";
import { databasePath, ensureDataDir } from "./paths.js";
import type { SqlDatabase, SqlDriver } from "./sql.js";

export type OpenDatabaseOptions = {
  dataDir: string;
  driver?: SqlDriver;
};

export type BayzDatabase = {
  db: SqlDatabase;
  path: string;
  driver: string;
  journalMode: string;
  schemaVersion: number;
  appliedMigrations: number;
  close(): void;
};

export function openDatabase(options: OpenDatabaseOptions): BayzDatabase {
  const driver = options.driver ?? selectDriver();
  ensureDataDir(options.dataDir);
  const path = databasePath(options.dataDir);
  const db = driver.open(path);

  try {
    // Foreign keys are required, not advisory: a silent loss of referential
    // integrity would be worse than refusing to start.
    db.exec("PRAGMA foreign_keys = ON");
    if (Number(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys) !== 1) {
      throw new StorageError("storage_unavailable", "enable-foreign-keys");
    }

    db.exec("PRAGMA busy_timeout = 5000");

    // WAL is best-effort. A filesystem that refuses it (some Android mounts,
    // network shares) keeps whatever mode SQLite fell back to; that is not a
    // startup failure.
    let journalMode: string;
    try {
      db.exec("PRAGMA journal_mode = WAL");
    } catch {
      // Fall through and report the mode actually in effect.
    }
    journalMode = String(
      db.prepare("PRAGMA journal_mode").get()?.journal_mode ?? "unknown",
    );

    db.exec("PRAGMA synchronous = NORMAL");

    const appliedMigrations = runMigrations(db);

    return {
      db,
      path,
      driver: driver.name,
      journalMode,
      schemaVersion: readSchemaVersion(db),
      appliedMigrations,
      close(): void {
        db.close();
      },
    };
  } catch (error) {
    try {
      db.close();
    } catch {
      // Already unusable; surface the original failure.
    }
    throw asStorageError("storage_unavailable", "open-database", error);
  }
}
