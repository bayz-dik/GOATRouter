import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  StorageError,
  databasePath,
  ensureDataDir,
  masterKeyPath,
} from "../src/index.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "bayz-paths-"));
}

test("creates a nested data directory", () => {
  const dataDir = join(tempRoot(), "deep", "nested", ".bayz");
  ensureDataDir(dataDir);
  assert.ok(existsSync(dataDir));
  assert.ok(statSync(dataDir).isDirectory());
});

test("creates the data directory with private permissions", () => {
  const dataDir = join(tempRoot(), ".bayz");
  ensureDataDir(dataDir);
  const mode = statSync(dataDir).mode & 0o777;
  assert.equal(
    mode,
    0o700,
    `expected 0700, got 0${mode.toString(8)}`,
  );
});

test("accepting an existing directory is idempotent", () => {
  const dataDir = join(tempRoot(), ".bayz");
  ensureDataDir(dataDir);
  ensureDataDir(dataDir);
  assert.equal(statSync(dataDir).mode & 0o777, 0o700);
});

test("derives the database and master key paths", () => {
  const dataDir = join(tempRoot(), ".bayz");
  assert.equal(databasePath(dataDir), join(dataDir, "bayz.db"));
  assert.equal(masterKeyPath(dataDir), join(dataDir, "master.key"));
});

test("fails safely when a path component is a regular file", () => {
  // ENOTDIR rather than chmod: this suite may run as uid 0, where a 0500
  // directory is still writable and a permission-based assertion would pass
  // vacuously. ENOTDIR fails for root too.
  const root = tempRoot();
  const blocker = join(root, "not-a-dir");
  writeFileSync(blocker, "x");

  let thrown: unknown;
  try {
    ensureDataDir(join(blocker, ".bayz"));
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof StorageError, "expected a StorageError");
  assert.equal(thrown.code, "storage_unavailable");
  assert.equal(thrown.stage, "ensure-data-dir");
  assert.doesNotMatch(thrown.message, /ENOTDIR/);
  assert.doesNotMatch(thrown.message, /not-a-dir/);
});
