import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MIGRATIONS,
  StorageError,
  TARGET_SCHEMA_VERSION,
  readSchemaVersion,
  runMigrations,
  selectDriver,
  type SqlDatabase,
} from "../src/index.js";

function freshDb(): SqlDatabase {
  const dir = mkdtempSync(join(tmpdir(), "bayz-migrate-"));
  const db = selectDriver().open(join(dir, "bayz.db"));
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function tableNames(db: SqlDatabase): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(row.name))
    .filter((name) => !name.startsWith("sqlite_"));
}

test("migrations are ordered, start at 1, and increase strictly", () => {
  assert.ok(MIGRATIONS.length > 0);
  MIGRATIONS.forEach((migration, index) => {
    assert.equal(migration.version, index + 1, "versions must be 1..n with no gaps");
    assert.ok(migration.statements.length > 0);
  });
  assert.equal(TARGET_SCHEMA_VERSION, MIGRATIONS.length);
});

test("a fresh database migrates to the target version", () => {
  const db = freshDb();
  try {
    assert.equal(readSchemaVersion(db), 0);
    const applied = runMigrations(db);
    assert.equal(applied, MIGRATIONS.length);
    assert.equal(readSchemaVersion(db), TARGET_SCHEMA_VERSION);
  } finally {
    db.close();
  }
});

test("a fresh database gains exactly the Phase 2 tables", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    assert.deepEqual(tableNames(db), [
      "runtime_metadata",
      "schema_migrations",
      "secrets",
    ]);
  } finally {
    db.close();
  }
});

test("running migrations twice applies zero and changes nothing", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    const before = tableNames(db);
    const version = readSchemaVersion(db);
    const rows = db.prepare("SELECT version FROM schema_migrations").all().length;

    assert.equal(runMigrations(db), 0, "second run must apply no migrations");
    assert.equal(readSchemaVersion(db), version);
    assert.deepEqual(tableNames(db), before);
    assert.equal(
      db.prepare("SELECT version FROM schema_migrations").all().length,
      rows,
      "no duplicate audit rows",
    );
  } finally {
    db.close();
  }
});

test("running migrations a third time is still a no-op", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    runMigrations(db);
    assert.equal(runMigrations(db), 0);
    assert.equal(readSchemaVersion(db), TARGET_SCHEMA_VERSION);
  } finally {
    db.close();
  }
});

test("user_version agrees with the schema_migrations audit table", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    const maxAudited = Number(
      db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()?.v,
    );
    assert.equal(readSchemaVersion(db), maxAudited);
    assert.equal(maxAudited, TARGET_SCHEMA_VERSION);

    const applied = db
      .prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version")
      .all();
    assert.equal(applied.length, MIGRATIONS.length);
    for (const row of applied) {
      assert.match(String(row.applied_at), /^\d{4}-\d{2}-\d{2}T/);
    }
  } finally {
    db.close();
  }
});

test("secrets.name is unique", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    const insert = db.prepare(
      `INSERT INTO secrets
         (name, version, algorithm, kdf, key_id, wrapped_dek, wrap_iv, wrap_tag,
          ciphertext, iv, tag, created_at, updated_at)
       VALUES (?, 1, 'aes-256-gcm', 'none', 'kek_x', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const bytes = new Uint8Array([1, 2, 3]);
    const now = new Date().toISOString();
    insert.run("dup", bytes, bytes, bytes, bytes, bytes, bytes, now, now);

    assert.throws(
      () => insert.run("dup", bytes, bytes, bytes, bytes, bytes, bytes, now, now),
      (error: unknown) =>
        error instanceof StorageError && error.code === "storage_unavailable",
    );
  } finally {
    db.close();
  }
});

test("a failing migration is atomic and leaves the version untouched", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    const versionBefore = readSchemaVersion(db);
    const tablesBefore = tableNames(db);

    assert.throws(
      () =>
        runMigrations(db, [
          ...MIGRATIONS,
          {
            version: TARGET_SCHEMA_VERSION + 1,
            statements: [
              "CREATE TABLE partial_side_effect (id INTEGER PRIMARY KEY)",
              "THIS IS NOT VALID SQL",
            ],
          },
        ]),
      (error: unknown) =>
        error instanceof StorageError && error.code === "storage_unavailable",
    );

    assert.equal(readSchemaVersion(db), versionBefore, "version must not advance");
    assert.deepEqual(
      tableNames(db),
      tablesBefore,
      "the rolled-back migration must leave no table behind",
    );
    assert.equal(
      db
        .prepare("SELECT version FROM schema_migrations WHERE version = ?")
        .get(TARGET_SCHEMA_VERSION + 1),
      undefined,
      "no audit row for a failed migration",
    );
  } finally {
    db.close();
  }
});

test("no speculative provider, proxy, route, combo, or usage schema exists", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    const names = tableNames(db);
    for (const forbidden of [
      "providers",
      "provider",
      "proxies",
      "proxy",
      "routes",
      "routing",
      "combos",
      "usage",
      "requests",
      "logs",
      "clients",
    ]) {
      assert.equal(
        names.includes(forbidden),
        false,
        `Phase 2 must not create a ${forbidden} table`,
      );
    }
  } finally {
    db.close();
  }
});

test("the secrets table stores only an encrypted envelope and metadata", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('secrets')")
      .all()
      .map((row) => String(row.name))
      .sort();

    assert.deepEqual(columns, [
      "algorithm",
      "ciphertext",
      "created_at",
      "id",
      "iv",
      "kdf",
      "key_id",
      "name",
      "tag",
      "updated_at",
      "version",
      "wrap_iv",
      "wrap_tag",
      "wrapped_dek",
    ]);
    // No column may exist that could hold a plaintext secret or a bare DEK.
    for (const forbidden of ["plaintext", "value", "secret", "dek", "password"]) {
      assert.equal(columns.includes(forbidden), false);
    }
  } finally {
    db.close();
  }
});

test("readSchemaVersion rejects a non-integer target", () => {
  const db = freshDb();
  try {
    assert.throws(
      () => runMigrations(db, [{ version: 1.5, statements: ["SELECT 1"] }]),
      (error: unknown) =>
        error instanceof StorageError && error.code === "storage_unavailable",
    );
  } finally {
    db.close();
  }
});
