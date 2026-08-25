import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  StorageError,
  TARGET_SCHEMA_VERSION,
  openSecretStorage,
  type SecretStorage,
} from "../src/index.js";

const KEY_A = Buffer.alloc(32, 0xa1).toString("hex");
const PLAINTEXT = "sk-live-repo-sentinel-9876543210";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bayz-repo-"));
}

function open(dataDir = tempDir(), key = KEY_A): SecretStorage {
  return openSecretStorage({ dataDir, env: { BAYZ_MASTER_KEY: key } });
}

test("put and get round-trip a secret", () => {
  const storage = open();
  try {
    storage.put("provider:openai:api_key", PLAINTEXT);
    assert.equal(storage.get("provider:openai:api_key"), PLAINTEXT);
  } finally {
    storage.close();
  }
});

test("storage reports schema version, journal mode, driver, and key metadata", () => {
  const storage = open();
  try {
    assert.equal(storage.schemaVersion, TARGET_SCHEMA_VERSION);
    assert.equal(storage.journalMode, "wal");
    assert.equal(storage.driver, "node:sqlite");
    assert.equal(storage.keyProvider, "environment");
    assert.match(storage.keyId, /^kek_[0-9a-f]{32}$/);
  } finally {
    storage.close();
  }
});

test("put twice upserts without duplicating and re-encrypts with a fresh DEK", () => {
  const storage = open();
  try {
    storage.put("dup", "first-value");
    const before = storage.inspect("dup");
    storage.put("dup", "second-value");
    const after = storage.inspect("dup");

    assert.equal(storage.get("dup"), "second-value");
    assert.equal(storage.list().filter((row) => row.name === "dup").length, 1);
    assert.notDeepEqual(after.wrappedDek, before.wrappedDek, "DEK must be replaced");
    assert.notDeepEqual(after.iv, before.iv, "IV must never be reused");
    assert.notDeepEqual(after.ciphertext, before.ciphertext);
    assert.equal(after.createdAt, before.createdAt, "created_at must be preserved");
    assert.ok(after.updatedAt >= before.updatedAt);
  } finally {
    storage.close();
  }
});

test("two different secrets use different DEKs", () => {
  const storage = open();
  try {
    storage.put("secret:one", "value-one");
    storage.put("secret:two", "value-two");

    const one = storage.inspect("secret:one");
    const two = storage.inspect("secret:two");
    assert.notDeepEqual(one.wrappedDek, two.wrappedDek);
    assert.notDeepEqual(one.iv, two.iv);
    assert.notDeepEqual(one.wrapIv, two.wrapIv);
  } finally {
    storage.close();
  }
});

test("identical plaintext under two names produces different ciphertext", () => {
  const storage = open();
  try {
    storage.put("same:a", PLAINTEXT);
    storage.put("same:b", PLAINTEXT);
    assert.notDeepEqual(
      storage.inspect("same:a").ciphertext,
      storage.inspect("same:b").ciphertext,
    );
  } finally {
    storage.close();
  }
});

test("get throws secret_not_found while find returns undefined", () => {
  const storage = open();
  try {
    assert.equal(storage.find("absent"), undefined);
    assert.throws(
      () => storage.get("absent"),
      (error: unknown) =>
        error instanceof StorageError && error.code === "secret_not_found",
      "get must not confuse absent with empty",
    );
  } finally {
    storage.close();
  }
});

test("an empty-string secret is distinguishable from an absent one", () => {
  const storage = open();
  try {
    storage.put("empty", "");
    assert.equal(storage.get("empty"), "");
    assert.equal(storage.find("empty"), "");
    assert.equal(storage.find("never-written"), undefined);
  } finally {
    storage.close();
  }
});

test("list returns metadata and never any plaintext", () => {
  const storage = open();
  try {
    storage.put("provider:openai:api_key", PLAINTEXT);
    storage.put("provider:anthropic:api_key", "sk-ant-other-value");

    const rows = storage.list();
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.name).sort(),
      ["provider:anthropic:api_key", "provider:openai:api_key"],
    );

    const serialized = JSON.stringify(rows);
    assert.doesNotMatch(serialized, new RegExp(PLAINTEXT));
    assert.doesNotMatch(serialized, /sk-ant-other-value/);
    for (const row of rows) {
      assert.equal(row.version, 1);
      assert.equal(row.algorithm, "aes-256-gcm");
      assert.match(row.keyId, /^kek_[0-9a-f]{32}$/);
      assert.equal(Object.hasOwn(row, "ciphertext"), false);
      assert.equal(Object.hasOwn(row, "wrappedDek"), false);
    }
  } finally {
    storage.close();
  }
});

test("delete removes a secret and reports whether it existed", () => {
  const storage = open();
  try {
    storage.put("temporary", "value");
    assert.equal(storage.delete("temporary"), true);
    assert.equal(storage.delete("temporary"), false);
    assert.equal(storage.find("temporary"), undefined);
  } finally {
    storage.close();
  }
});

test("a failed put leaves the previous row intact and adds no partial row", () => {
  const storage = open();
  try {
    storage.put("stable", "original-value");
    const before = storage.inspect("stable");

    assert.throws(() => storage.put("stable", null as unknown as string));

    assert.equal(storage.get("stable"), "original-value");
    assert.deepEqual(storage.inspect("stable").ciphertext, before.ciphertext);
    assert.equal(storage.list().filter((row) => row.name === "stable").length, 1);
  } finally {
    storage.close();
  }
});

test("a rejected put for a brand-new name creates no row at all", () => {
  const storage = open();
  try {
    assert.throws(() => storage.put("never", undefined as unknown as string));
    assert.equal(storage.find("never"), undefined);
    assert.equal(storage.list().length, 0);
  } finally {
    storage.close();
  }
});

test("tampering with the ciphertext in SQL makes get fail closed", () => {
  const storage = open();
  try {
    storage.put("tampered", PLAINTEXT);
    storage.corruptForTest("tampered", "ciphertext");

    assert.throws(
      () => storage.get("tampered"),
      (error: unknown) =>
        error instanceof StorageError && error.code === "secret_corrupt",
    );
    assert.throws(
      () => storage.find("tampered"),
      (error: unknown) =>
        error instanceof StorageError && error.code === "secret_corrupt",
      "find must fail closed too, not swallow corruption as undefined",
    );
  } finally {
    storage.close();
  }
});

test("tampering with the wrapped DEK makes get fail closed", () => {
  const storage = open();
  try {
    storage.put("tampered-dek", PLAINTEXT);
    storage.corruptForTest("tampered-dek", "wrapped_dek");
    assert.throws(
      () => storage.get("tampered-dek"),
      (error: unknown) =>
        error instanceof StorageError && error.code === "secret_corrupt",
    );
  } finally {
    storage.close();
  }
});

test("tampering with either auth tag makes get fail closed", () => {
  for (const column of ["tag", "wrap_tag"] as const) {
    const storage = open();
    try {
      storage.put("tagged", PLAINTEXT);
      storage.corruptForTest("tagged", column);
      assert.throws(
        () => storage.get("tagged"),
        (error: unknown) =>
          error instanceof StorageError && error.code === "secret_corrupt",
        `tampering with ${column} must fail closed`,
      );
    } finally {
      storage.close();
    }
  }
});

test("a malformed envelope with truncated fields fails closed", () => {
  const storage = open();
  try {
    storage.put("malformed", PLAINTEXT);
    storage.truncateForTest("malformed", "iv");
    assert.throws(
      () => storage.get("malformed"),
      (error: unknown) =>
        error instanceof StorageError && error.code === "secret_corrupt",
    );
  } finally {
    storage.close();
  }
});

test("an unsupported stored envelope version fails closed", () => {
  const storage = open();
  try {
    storage.put("future", PLAINTEXT);
    storage.setVersionForTest("future", 99);
    assert.throws(
      () => storage.get("future"),
      (error: unknown) =>
        error instanceof StorageError && error.code === "secret_corrupt",
    );
  } finally {
    storage.close();
  }
});

test("a secret name relocated in SQL fails closed thanks to AAD binding", () => {
  const storage = open();
  try {
    storage.put("origin", PLAINTEXT);
    storage.renameForTest("origin", "impostor");

    assert.throws(
      () => storage.get("impostor"),
      (error: unknown) =>
        error instanceof StorageError && error.code === "secret_corrupt",
      "an envelope moved to another name must not decrypt",
    );
  } finally {
    storage.close();
  }
});

test("no repository method returns an envelope, DEK, or KEK to a caller", () => {
  const storage = open();
  try {
    storage.put("boundary", PLAINTEXT);
    const surface = storage.get("boundary");
    assert.equal(typeof surface, "string");

    const listed = storage.list()[0]!;
    for (const forbidden of [
      "wrappedDek",
      "wrapIv",
      "wrapTag",
      "ciphertext",
      "iv",
      "tag",
      "dek",
      "kek",
    ]) {
      assert.equal(
        Object.hasOwn(listed, forbidden),
        false,
        `list() must not expose ${forbidden}`,
      );
    }
  } finally {
    storage.close();
  }
});

test("opening with a mismatched root key is rejected before any decryption", () => {
  const dataDir = tempDir();
  const first = open(dataDir, KEY_A);
  first.put("bound", PLAINTEXT);
  first.close();

  const wrongKey = Buffer.alloc(32, 0xb2).toString("hex");
  assert.throws(
    () => open(dataDir, wrongKey),
    (error: unknown) =>
      error instanceof StorageError && error.code === "master_key_mismatch",
    "a wrong key must be reported clearly, not as a cascade of corrupt secrets",
  );
});

test("an empty database accepts any root key and records its id", () => {
  const dataDir = tempDir();
  const storage = open(dataDir, Buffer.alloc(32, 0xc3).toString("hex"));
  try {
    assert.match(storage.keyId, /^kek_[0-9a-f]{32}$/);
    assert.equal(storage.activeKeyId(), storage.keyId);
  } finally {
    storage.close();
  }
});
