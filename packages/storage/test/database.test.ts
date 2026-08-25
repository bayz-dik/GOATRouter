import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  StorageError,
  TARGET_SCHEMA_VERSION,
  databasePath,
  openDatabase,
} from "../src/index.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "bayz-db-"));
}

test("openDatabase creates the database file inside the data directory", () => {
  const dataDir = join(tempRoot(), ".bayz");
  const handle = openDatabase({ dataDir });
  try {
    assert.ok(existsSync(databasePath(dataDir)));
    assert.equal(handle.path, databasePath(dataDir));
    assert.equal(handle.driver, "node:sqlite");
  } finally {
    handle.close();
  }
});

test("openDatabase migrates to the target schema version", () => {
  const handle = openDatabase({ dataDir: join(tempRoot(), ".bayz") });
  try {
    assert.equal(handle.schemaVersion, TARGET_SCHEMA_VERSION);
  } finally {
    handle.close();
  }
});

test("foreign keys are enabled and actually enforced", () => {
  const handle = openDatabase({ dataDir: join(tempRoot(), ".bayz") });
  try {
    assert.equal(
      Number(handle.db.prepare("PRAGMA foreign_keys").get()?.foreign_keys),
      1,
    );

    handle.db.exec("CREATE TABLE fk_parent (id INTEGER PRIMARY KEY)");
    handle.db.exec(
      "CREATE TABLE fk_child (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES fk_parent(id))",
    );
    assert.throws(
      () => handle.db.prepare("INSERT INTO fk_child (pid) VALUES (?)").run(999),
      (error: unknown) =>
        error instanceof StorageError && error.code === "storage_unavailable",
      "a foreign key violation must be rejected, not silently accepted",
    );
  } finally {
    handle.close();
  }
});

test("busy_timeout is configured", () => {
  const handle = openDatabase({ dataDir: join(tempRoot(), ".bayz") });
  try {
    assert.equal(
      Number(handle.db.prepare("PRAGMA busy_timeout").get()?.timeout),
      5000,
    );
  } finally {
    handle.close();
  }
});

test("journal mode is reported and is WAL where the filesystem supports it", () => {
  const handle = openDatabase({ dataDir: join(tempRoot(), ".bayz") });
  try {
    // WAL is best-effort by design: a filesystem that refuses it must not make
    // startup fail, so the resulting mode is reported rather than asserted equal.
    assert.ok(handle.journalMode.length > 0);
    const actual = String(
      handle.db.prepare("PRAGMA journal_mode").get()?.journal_mode,
    );
    assert.equal(handle.journalMode, actual);
    assert.equal(handle.journalMode, "wal");
  } finally {
    handle.close();
  }
});

test("synchronous is set to NORMAL", () => {
  const handle = openDatabase({ dataDir: join(tempRoot(), ".bayz") });
  try {
    assert.equal(
      Number(handle.db.prepare("PRAGMA synchronous").get()?.synchronous),
      1,
    );
  } finally {
    handle.close();
  }
});

test("reopening an existing database applies no further migrations", () => {
  const dataDir = join(tempRoot(), ".bayz");
  const first = openDatabase({ dataDir });
  first.close();

  const second = openDatabase({ dataDir });
  try {
    assert.equal(second.schemaVersion, TARGET_SCHEMA_VERSION);
    assert.equal(second.appliedMigrations, 0);
  } finally {
    second.close();
  }
});

test("the database file and its sidecars are not world-readable", () => {
  const dataDir = join(tempRoot(), ".bayz");
  const handle = openDatabase({ dataDir });
  try {
    // The 0700 directory is not enough on its own: a backup tool or sync folder
    // can copy the file out, carrying its own mode with it.
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = `${databasePath(dataDir)}${suffix}`;
      if (!existsSync(file)) {
        continue;
      }
      const mode = statSync(file).mode & 0o777;
      assert.equal(
        mode & 0o077,
        0,
        `${file} is group/world accessible with mode 0${mode.toString(8)}`,
      );
    }
  } finally {
    handle.close();
  }
});

test("an unusable data directory fails safely without leaking sqlite text", () => {
  const root = tempRoot();
  const blocker = join(root, "not-a-dir");
  writeFileSync(blocker, "x");
  const dataDir = join(blocker, ".bayz");

  let thrown: unknown;
  try {
    openDatabase({ dataDir });
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof StorageError, "expected a StorageError");
  assert.equal(thrown.code, "storage_unavailable");
  assert.doesNotMatch(thrown.message, /unable to open database file/);
  assert.doesNotMatch(thrown.message, /ENOTDIR/);
  assert.doesNotMatch(thrown.message, /not-a-dir/);
  assert.doesNotMatch(thrown.message, /\.bayz/);
});
