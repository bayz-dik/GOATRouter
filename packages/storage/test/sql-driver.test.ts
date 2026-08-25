import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StorageError, selectDriver } from "../src/index.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bayz-driver-"));
}

test("selectDriver returns the node:sqlite adapter", () => {
  assert.equal(selectDriver().name, "node:sqlite");
});

test("driver executes DDL, parameterized writes, and reads", () => {
  const driver = selectDriver();
  const db = driver.open(join(tempDir(), "probe.db"));
  try {
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO t (name) VALUES (?)");
    const result = insert.run("alpha");
    assert.equal(result.changes, 1);
    assert.equal(Number(result.lastInsertRowid), 1);

    insert.run("beta");
    const row = db.prepare("SELECT name FROM t WHERE id = ?").get(1);
    assert.equal(row?.name, "alpha");
    assert.equal(db.prepare("SELECT name FROM t ORDER BY id").all().length, 2);
    assert.equal(db.prepare("SELECT name FROM t WHERE id = ?").get(99), undefined);
  } finally {
    db.close();
  }
});

test("driver round-trips blob bytes exactly", () => {
  const driver = selectDriver();
  const db = driver.open(join(tempDir(), "blob.db"));
  try {
    db.exec("CREATE TABLE b (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)");
    const payload = new Uint8Array([0, 1, 2, 250, 251, 255, 0, 128]);
    db.prepare("INSERT INTO b (payload) VALUES (?)").run(payload);

    const row = db.prepare("SELECT payload FROM b WHERE id = 1").get();
    const stored = row?.payload;
    assert.ok(stored instanceof Uint8Array, "blob must read back as bytes");
    assert.equal(stored.byteLength, payload.byteLength);
    assert.deepEqual(Array.from(stored), Array.from(payload));
  } finally {
    db.close();
  }
});

test("driver round-trips null, number, bigint, and text", () => {
  const driver = selectDriver();
  const db = driver.open(join(tempDir(), "types.db"));
  try {
    db.exec("CREATE TABLE v (k TEXT PRIMARY KEY, val)");
    const insert = db.prepare("INSERT INTO v (k, val) VALUES (?, ?)");
    insert.run("nothing", null);
    insert.run("number", 42);
    insert.run("bigint", 9007199254740991n);
    insert.run("text", "plain");

    const read = (k: string) =>
      db.prepare("SELECT val FROM v WHERE k = ?").get(k)?.val;
    assert.equal(read("nothing"), null);
    assert.equal(read("number"), 42);
    // Bindable as bigint, read back as a JS number while within safe range.
    assert.equal(read("bigint"), 9007199254740991);
    assert.equal(read("text"), "plain");
  } finally {
    db.close();
  }
});

test("driver fails closed on an integer too large for a JS number", () => {
  // node:sqlite raises ERR_OUT_OF_RANGE rather than silently truncating. That
  // loud failure is the contract Bayz relies on: a wrong number is worse than
  // an error. Every Bayz column holding an integer is a small id or version, so
  // this range is never reached in practice.
  const driver = selectDriver();
  const db = driver.open(join(tempDir(), "overflow.db"));
  try {
    db.exec("CREATE TABLE v (k TEXT PRIMARY KEY, val)");
    db.prepare("INSERT INTO v (k, val) VALUES (?, ?)").run(
      "huge",
      9007199254740993n,
    );

    assert.throws(
      () => db.prepare("SELECT val FROM v WHERE k = ?").get("huge"),
      (error: unknown) =>
        error instanceof StorageError && error.code === "storage_unavailable",
    );
  } finally {
    db.close();
  }
});

test("driver open failure raises a StorageError without leaking sqlite text", () => {
  const dir = tempDir();
  const blocker = join(dir, "not-a-directory");
  writeFileSync(blocker, "x");
  const target = join(blocker, "nested", "bayz.db");

  let thrown: unknown;
  try {
    selectDriver().open(target);
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof StorageError, "expected a StorageError");
  assert.equal(thrown.code, "storage_unavailable");
  assert.doesNotMatch(thrown.message, /unable to open database file/);
  assert.doesNotMatch(thrown.message, /not-a-directory/);
  assert.doesNotMatch(thrown.message, new RegExp(escapeRegExp(target)));
});

test("driver statement failure raises a StorageError", () => {
  const driver = selectDriver();
  const db = driver.open(join(tempDir(), "bad.db"));
  try {
    assert.throws(
      () => db.exec("THIS IS NOT SQL"),
      (error: unknown) =>
        error instanceof StorageError && error.code === "storage_unavailable",
    );
  } finally {
    db.close();
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
