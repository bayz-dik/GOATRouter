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
