import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  StorageError,
  databasePath,
  masterKeyPath,
  openSecretStorage,
} from "../src/index.js";

const SENTINEL = "sk-live-PLAINTEXT-SENTINEL-do-not-persist-42";
const KEY = Buffer.alloc(32, 0x9f);

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bayz-persist-"));
}

function openWith(dataDir: string, key = KEY) {
  return openSecretStorage({
    dataDir,
    env: { BAYZ_MASTER_KEY: key.toString("hex") },
  });
}

function readAllDatabaseBytes(dataDir: string): Buffer {
  const base = databasePath(dataDir);
  const parts: Buffer[] = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${base}${suffix}`;
    if (existsSync(file)) {
      parts.push(readFileSync(file));
    }
  }
  assert.ok(parts.length > 0, "expected at least the main database file");
  return Buffer.concat(parts);
}

test("a secret survives close and reopen in the same data directory", () => {
  const dataDir = tempDir();
  const first = openWith(dataDir);
  first.put("provider:openai:api_key", SENTINEL);
  first.close();

  const second = openWith(dataDir);
  try {
    assert.equal(second.get("provider:openai:api_key"), SENTINEL);
  } finally {
    second.close();
  }
});

test("many secrets survive a reopen intact", () => {
  const dataDir = tempDir();
  const values = new Map<string, string>();
  const first = openWith(dataDir);
  for (let index = 0; index < 10; index += 1) {
    const name = `secret:${index}`;
    const value = `value-${index}-${SENTINEL}`;
    values.set(name, value);
    first.put(name, value);
  }
  first.close();

  const second = openWith(dataDir);
  try {
    for (const [name, value] of values) {
      assert.equal(second.get(name), value);
    }
    assert.equal(second.list().length, 10);
  } finally {
    second.close();
  }
});

test("the plaintext sentinel never appears in the database bytes", () => {
  const dataDir = tempDir();
  const storage = openWith(dataDir);
  storage.put("provider:openai:api_key", SENTINEL);
  storage.put("provider:anthropic:api_key", SENTINEL);
  storage.close();

  const bytes = readAllDatabaseBytes(dataDir);
  assert.equal(
    bytes.includes(Buffer.from(SENTINEL, "utf8")),
    false,
    "plaintext must never be written to the database",
  );
  assert.equal(bytes.includes(Buffer.from(SENTINEL, "utf16le")), false);
  assert.equal(
    bytes.includes(Buffer.from(SENTINEL).toString("base64")),
    false,
    "plaintext must not be base64-encoded into the database either",
  );
});

test("the root key never appears in the database bytes", () => {
  const dataDir = tempDir();
  const storage = openWith(dataDir);
  storage.put("k", SENTINEL);
  storage.close();

  const bytes = readAllDatabaseBytes(dataDir);
  assert.equal(bytes.includes(KEY), false, "raw KEK bytes must not be persisted");
  assert.equal(
    bytes.includes(Buffer.from(KEY.toString("hex"), "utf8")),
    false,
    "hex-encoded KEK must not be persisted",
  );
});

test("an environment key is never written to a key file", () => {
  const dataDir = tempDir();
  const storage = openWith(dataDir);
  storage.put("k", SENTINEL);
  storage.close();

  assert.equal(
    existsSync(masterKeyPath(dataDir)),
    false,
    "an explicitly supplied key must not be copied to disk",
  );
});

test("a generated key file holds the key but the database does not", () => {
  const dataDir = tempDir();
  const storage = openSecretStorage({ dataDir, env: {} });
  try {
    storage.put("k", SENTINEL);
    assert.equal(storage.keyProvider, "secure-file");
  } finally {
    storage.close();
  }

  const keyBytes = readFileSync(masterKeyPath(dataDir));
  assert.equal(keyBytes.byteLength, 32);

  const dbBytes = readAllDatabaseBytes(dataDir);
  assert.equal(
    dbBytes.includes(keyBytes),
    false,
    "the key must not be recoverable from the database alone",
  );
  assert.equal(dbBytes.includes(Buffer.from(SENTINEL, "utf8")), false);
});

test("reopening with a different root key fails closed instead of returning plaintext", () => {
  const dataDir = tempDir();
  const first = openWith(dataDir);
  first.put("bound", SENTINEL);
  first.close();

  let thrown: unknown;
  try {
    openWith(dataDir, Buffer.alloc(32, 0x11));
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof StorageError);
  assert.ok(
    thrown.code === "master_key_mismatch" || thrown.code === "secret_corrupt",
    `expected a fail-closed code, got ${thrown.code}`,
  );
  assert.doesNotMatch(thrown.message, new RegExp(SENTINEL));
});

test("a secret written before a reopen is still bound to its name", () => {
  const dataDir = tempDir();
  const first = openWith(dataDir);
  first.put("origin", SENTINEL);
  first.renameForTest("origin", "impostor");
  first.close();

  const second = openWith(dataDir);
  try {
    assert.throws(
      () => second.get("impostor"),
      (error: unknown) =>
        error instanceof StorageError && error.code === "secret_corrupt",
      "AAD binding must survive persistence",
    );
  } finally {
    second.close();
  }
});

test("schema version and key id persist across reopen", () => {
  const dataDir = tempDir();
  const first = openWith(dataDir);
  const version = first.schemaVersion;
  const keyId = first.keyId;
  first.put("k", SENTINEL);
  first.close();

  const second = openWith(dataDir);
  try {
    assert.equal(second.schemaVersion, version);
    assert.equal(second.keyId, keyId);
    assert.equal(second.activeKeyId(), keyId);
    assert.equal(second.appliedMigrations, 0, "reopen must not re-run migrations");
  } finally {
    second.close();
  }
});
