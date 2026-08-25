import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { StorageError, databasePath, masterKeyPath, openSecretStorage } from "../src/index.js";

/**
 * Adversarial suite: attacks the stored artifacts directly rather than going
 * through the repository API, simulating an attacker who already has read/write
 * access to bayz.db or master.key.
 *
 * This file is the one permitted exception to the driver-boundary rule: it opens
 * the database with a raw DatabaseSync precisely because a real attacker would
 * not politely use our adapter. The boundary test excludes test files.
 */

const KEY = Buffer.alloc(32, 0xaa).toString("hex");
const SENTINEL = "sk-ADVERSARIAL-PLAINTEXT-must-never-surface";

function dataDir(): string {
  return join(mkdtempSync(join(tmpdir(), "bayz-adv-")), ".bayz");
}

function open(dir: string, key = KEY) {
  return openSecretStorage({ dataDir: dir, env: { BAYZ_MASTER_KEY: key } });
}

function allDatabaseBytes(dir: string): Buffer {
  let bytes = Buffer.alloc(0);
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      bytes = Buffer.concat([bytes, readFileSync(`${databasePath(dir)}${suffix}`)]);
    } catch {
      // Sidecar absent.
    }
  }
  return bytes;
}

test("an envelope copied onto another secret's row cannot be decrypted", () => {
  const dir = dataDir();
  let storage = open(dir);
  storage.put("victim", SENTINEL);
  storage.put("attacker", "attacker-known-value");
  storage.close();

  // The attacker copies their own complete, validly-authenticated envelope over
  // the victim's row, hoping the victim's secret now reads as a value they know.
  const raw = new DatabaseSync(databasePath(dir));
  const stolen = raw.prepare("SELECT * FROM secrets WHERE name = 'attacker'").get() as Record<
    string,
    Uint8Array
  >;
  raw
    .prepare(
      `UPDATE secrets
          SET wrapped_dek = ?, wrap_iv = ?, wrap_tag = ?, ciphertext = ?, iv = ?, tag = ?
        WHERE name = 'victim'`,
    )
    .run(
      stolen.wrapped_dek,
      stolen.wrap_iv,
      stolen.wrap_tag,
      stolen.ciphertext,
      stolen.iv,
      stolen.tag,
    );
  raw.close();

  storage = open(dir);
  try {
    let returned: unknown = Symbol("untouched");
    let code: string | undefined;
    try {
      returned = storage.get("victim");
    } catch (error) {
      code = error instanceof StorageError ? error.code : "unknown";
    }
    assert.equal(code, "secret_corrupt", "AAD name binding must reject relocation");
    assert.equal(typeof returned, "symbol", "no value may be returned");
    assert.notEqual(returned, "attacker-known-value");
  } finally {
    storage.close();
  }
});

test("stripping runtime_metadata does not enable decryption with a wrong key", () => {
  const dir = dataDir();
  let storage = open(dir);
  storage.put("k", SENTINEL);
  storage.close();

  // Deleting the key binding defeats the friendly up-front mismatch check, so the
  // cryptography itself has to be what stops the attacker.
  const raw = new DatabaseSync(databasePath(dir));
  raw.exec("DELETE FROM runtime_metadata");
  raw.close();

  storage = open(dir, Buffer.alloc(32, 0xbb).toString("hex"));
  try {
    let returned: unknown = Symbol("untouched");
    let code: string | undefined;
    try {
      returned = storage.get("k");
    } catch (error) {
      code = error instanceof StorageError ? error.code : "unknown";
    }
    assert.equal(code, "secret_corrupt");
    assert.equal(typeof returned, "symbol");
  } finally {
    storage.close();
  }
});

test("replacing master.key with an attacker key is detected", () => {
  const dir = dataDir();
  const storage = openSecretStorage({ dataDir: dir, env: {} });
  storage.put("k", SENTINEL);
  storage.close();

  writeFileSync(masterKeyPath(dir), Buffer.alloc(32, 0xcc), { mode: 0o600 });

  assert.throws(
    () => openSecretStorage({ dataDir: dir, env: {} }),
    (error: unknown) =>
      error instanceof StorageError && error.code === "master_key_mismatch",
  );
});

test("flipping a byte in any envelope column fails closed", () => {
  for (const column of [
    "ciphertext",
    "wrapped_dek",
    "tag",
    "wrap_tag",
    "iv",
    "wrap_iv",
  ] as const) {
    const storage = open(dataDir());
    try {
      storage.put("k", SENTINEL);
      storage.corruptForTest("k", column);

      let returned: unknown = Symbol("untouched");
      let code: string | undefined;
      try {
        returned = storage.get("k");
      } catch (error) {
        code = error instanceof StorageError ? error.code : "unknown";
      }
      assert.equal(code, "secret_corrupt", `${column} must fail closed`);
      assert.equal(typeof returned, "symbol", `${column} must return nothing`);
    } finally {
      storage.close();
    }
  }
});

test("no plaintext or key survives in a database holding many secrets", () => {
  const dir = dataDir();
  const storage = open(dir);
  for (let index = 0; index < 200; index += 1) {
    storage.put(`secret:${index}`, `${SENTINEL}-${index}`);
  }
  storage.close();

  const bytes = allDatabaseBytes(dir);
  assert.ok(bytes.byteLength > 0);
  assert.equal(bytes.includes(Buffer.from(SENTINEL, "utf8")), false);
  assert.equal(bytes.includes(Buffer.from(KEY, "hex")), false);
});

test("500 encryptions of identical plaintext never repeat an IV or DEK", () => {
  const storage = open(dataDir());
  try {
    const ivs = new Set<string>();
    const deks = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      storage.put("same", SENTINEL);
      const envelope = storage.inspect("same");
      ivs.add(Buffer.from(envelope.iv).toString("hex"));
      deks.add(Buffer.from(envelope.wrappedDek).toString("hex"));
    }
    assert.equal(ivs.size, 500, "every encryption must use a fresh IV");
    assert.equal(deks.size, 500, "every write must mint a fresh DEK");
  } finally {
    storage.close();
  }
});
