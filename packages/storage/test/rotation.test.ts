import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EnvKeyProvider,
  StorageError,
  computeKeyId,
  openSecretStorage,
} from "../src/index.js";

const OLD_KEY = Buffer.alloc(32, 0x1a);
const NEW_KEY = Buffer.alloc(32, 0x2b);

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bayz-rotate-"));
}

function openWith(dataDir: string, key: Buffer) {
  return openSecretStorage({
    dataDir,
    env: { BAYZ_MASTER_KEY: key.toString("hex") },
  });
}

test("rotation preserves readability of every secret under the new key", () => {
  const dataDir = tempDir();
  const storage = openWith(dataDir, OLD_KEY);
  try {
    storage.put("a", "value-a");
    storage.put("b", "value-b");
    storage.put("c", "value-c");

    const result = storage.rotateRootKey(
      new EnvKeyProvider({ BAYZ_MASTER_KEY: NEW_KEY.toString("hex") }),
    );

    assert.equal(result.rotated, 3);
    assert.equal(result.keyId, computeKeyId(NEW_KEY));
    assert.equal(storage.get("a"), "value-a");
    assert.equal(storage.get("b"), "value-b");
    assert.equal(storage.get("c"), "value-c");
  } finally {
    storage.close();
  }
});

test("rotation rewraps without re-encrypting the secret ciphertext", () => {
  const dataDir = tempDir();
  const storage = openWith(dataDir, OLD_KEY);
  try {
    storage.put("stable", "unchanged-plaintext");
    const before = storage.inspect("stable");

    storage.rotateRootKey(
      new EnvKeyProvider({ BAYZ_MASTER_KEY: NEW_KEY.toString("hex") }),
    );
    const after = storage.inspect("stable");

    // Rewrap-only: rotation costs O(rows) small wraps, never O(bytes)
    // re-encryption, and never materializes plaintext.
    assert.deepEqual(after.ciphertext, before.ciphertext);
    assert.deepEqual(after.iv, before.iv);
    assert.deepEqual(after.tag, before.tag);
    assert.notDeepEqual(after.wrappedDek, before.wrappedDek);
    assert.notDeepEqual(after.wrapIv, before.wrapIv);
    assert.equal(after.keyId, computeKeyId(NEW_KEY));
  } finally {
    storage.close();
  }
});

test("after rotation the database opens with the new key and rejects the old", () => {
  const dataDir = tempDir();
  const first = openWith(dataDir, OLD_KEY);
  first.put("bound", "rotated-value");
  first.rotateRootKey(
    new EnvKeyProvider({ BAYZ_MASTER_KEY: NEW_KEY.toString("hex") }),
  );
  first.close();

  const reopened = openWith(dataDir, NEW_KEY);
  try {
    assert.equal(reopened.get("bound"), "rotated-value");
    assert.equal(reopened.activeKeyId(), computeKeyId(NEW_KEY));
  } finally {
    reopened.close();
  }

  assert.throws(
    () => openWith(dataDir, OLD_KEY),
    (error: unknown) =>
      error instanceof StorageError && error.code === "master_key_mismatch",
    "the superseded key must no longer open the database",
  );
});

test("rotation updates the recorded active key id", () => {
  const dataDir = tempDir();
  const storage = openWith(dataDir, OLD_KEY);
  try {
    storage.put("x", "y");
    assert.equal(storage.activeKeyId(), computeKeyId(OLD_KEY));
    storage.rotateRootKey(
      new EnvKeyProvider({ BAYZ_MASTER_KEY: NEW_KEY.toString("hex") }),
    );
    assert.equal(storage.activeKeyId(), computeKeyId(NEW_KEY));
  } finally {
    storage.close();
  }
});

test("rotating on an empty database succeeds and rotates nothing", () => {
  const dataDir = tempDir();
  const storage = openWith(dataDir, OLD_KEY);
  try {
    const result = storage.rotateRootKey(
      new EnvKeyProvider({ BAYZ_MASTER_KEY: NEW_KEY.toString("hex") }),
    );
    assert.equal(result.rotated, 0);
    assert.equal(storage.activeKeyId(), computeKeyId(NEW_KEY));
  } finally {
    storage.close();
  }
});

test("a failed rotation leaves every secret readable under the old key", () => {
  const dataDir = tempDir();
  const storage = openWith(dataDir, OLD_KEY);
  try {
    storage.put("first", "value-first");
    storage.put("second", "value-second");
    storage.put("third", "value-third");

    // Corrupt one row so the rotation cannot complete part-way through.
    storage.corruptForTest("second", "wrapped_dek");

    assert.throws(
      () =>
        storage.rotateRootKey(
          new EnvKeyProvider({ BAYZ_MASTER_KEY: NEW_KEY.toString("hex") }),
        ),
      (error: unknown) => error instanceof StorageError,
    );

    // The transaction rolled back, so the un-corrupted rows are still wrapped by
    // the old key. A failed rotation degrades to "nothing happened".
    assert.equal(storage.activeKeyId(), computeKeyId(OLD_KEY));
    assert.equal(storage.get("first"), "value-first");
    assert.equal(storage.get("third"), "value-third");
    assert.equal(storage.inspect("first").keyId, computeKeyId(OLD_KEY));
    assert.equal(storage.inspect("third").keyId, computeKeyId(OLD_KEY));
  } finally {
    storage.close();
  }
});

test("a failed rotation is not partially applied to any row", () => {
  const dataDir = tempDir();
  const storage = openWith(dataDir, OLD_KEY);
  try {
    for (let index = 0; index < 6; index += 1) {
      storage.put(`row-${index}`, `value-${index}`);
    }
    storage.corruptForTest("row-4", "wrap_tag");

    assert.throws(() =>
      storage.rotateRootKey(
        new EnvKeyProvider({ BAYZ_MASTER_KEY: NEW_KEY.toString("hex") }),
      ),
    );

    const rotatedRows = storage
      .list()
      .filter((row) => row.keyId === computeKeyId(NEW_KEY));
    assert.equal(rotatedRows.length, 0, "no row may be left rewrapped");
  } finally {
    storage.close();
  }
});

test("rotation rejects an unusable replacement key", () => {
  const dataDir = tempDir();
  const storage = openWith(dataDir, OLD_KEY);
  try {
    storage.put("k", "v");
    assert.throws(
      () => storage.rotateRootKey(new EnvKeyProvider({ BAYZ_MASTER_KEY: "nope" })),
      (error: unknown) =>
        error instanceof StorageError && error.code === "master_key_invalid",
    );
    assert.equal(storage.get("k"), "v");
    assert.equal(storage.activeKeyId(), computeKeyId(OLD_KEY));
  } finally {
    storage.close();
  }
});

test("rotation can be repeated and remains reversible", () => {
  const dataDir = tempDir();
  const storage = openWith(dataDir, OLD_KEY);
  try {
    storage.put("k", "v");
    storage.rotateRootKey(
      new EnvKeyProvider({ BAYZ_MASTER_KEY: NEW_KEY.toString("hex") }),
    );
    storage.rotateRootKey(
      new EnvKeyProvider({ BAYZ_MASTER_KEY: OLD_KEY.toString("hex") }),
    );
    assert.equal(storage.get("k"), "v");
    assert.equal(storage.activeKeyId(), computeKeyId(OLD_KEY));
  } finally {
    storage.close();
  }
});
