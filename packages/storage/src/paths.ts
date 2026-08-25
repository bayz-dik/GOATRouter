import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { asStorageError } from "./errors.js";

export const DATABASE_FILENAME = "bayz.db";
export const MASTER_KEY_FILENAME = "master.key";

export function databasePath(dataDir: string): string {
  return join(dataDir, DATABASE_FILENAME);
}

export function masterKeyPath(dataDir: string): string {
  return join(dataDir, MASTER_KEY_FILENAME);
}

/**
 * Restrict a storage file to owner-only access.
 *
 * The enclosing data directory is already 0700, but the database itself must not
 * be world-readable on its own: a backup tool, a sync folder, or a file copied
 * out of the directory would otherwise carry loose permissions with it. WAL and
 * SHM sidecars are tightened too because they hold recently written pages.
 *
 * Best-effort for the same reason as the directory mode: some Android and
 * FAT-derived mounts cannot represent POSIX modes.
 */
export function restrictFileMode(file: string): void {
  try {
    chmodSync(file, 0o600);
  } catch {
    // Filesystem does not honor POSIX modes, or the file does not exist yet.
  }
}

export function restrictDatabaseFileModes(dataDir: string): void {
  const base = databasePath(dataDir);
  for (const suffix of ["", "-wal", "-shm"]) {
    restrictFileMode(`${base}${suffix}`);
  }
}

/**
 * Create the data directory with private permissions.
 *
 * The mode is defense in depth, not a correctness dependency: some Android and
 * FAT-derived mounts cannot represent POSIX modes, and hard-failing there would
 * make Bayz unusable on a first-class target. A chmod failure is therefore
 * tolerated, while a genuine inability to create the directory is fatal.
 */
export function ensureDataDir(dataDir: string): void {
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw asStorageError("storage_unavailable", "ensure-data-dir", error);
  }
  try {
    chmodSync(dataDir, 0o700);
  } catch {
    // Filesystem does not honor POSIX modes; continue.
  }
}
