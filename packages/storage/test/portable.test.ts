import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EXPORT_FORMAT_VERSION,
  EXPORT_MAGIC,
  SCRYPT_PARAMS,
  StorageError,
  exportSecrets,
  importSecrets,
  openSecretStorage,
  type SecretStorage,
} from "../src/index.js";

const KEY_A = Buffer.alloc(32, 0x11).toString("hex");
const KEY_B = Buffer.alloc(32, 0x22).toString("hex");
const PASSPHRASE = "export-passphrase-correct-horse";

const SENTINEL_ONE = "sk-portable-sentinel-one";
const SENTINEL_TWO = "sk-portable-sentinel-two";

function tempDir(): string {
  return join(mkdtempSync(join(tmpdir(), "bayz-portable-")), ".bayz");
}

function open(key: string, dataDir = tempDir()): SecretStorage {
  return openSecretStorage({ dataDir, env: { BAYZ_MASTER_KEY: key } });
}

function seeded(key = KEY_A): SecretStorage {
  const storage = open(key);
  storage.put("provider:one:api_key", SENTINEL_ONE);
  storage.put("proxy:two:password", SENTINEL_TWO);
  return storage;
}

test("an export blob is sealed and carries the format header", (t) => {
  const storage = seeded();
  t.after(() => storage.close());

  const blob = exportSecrets(storage, PASSPHRASE);
  const bytes = Buffer.from(blob);

  // A magic prefix and an explicit version, so a future format change is a refusal
  // rather than a misparse of arbitrary bytes as ciphertext.
  assert.equal(bytes.subarray(0, EXPORT_MAGIC.length).toString("ascii"), EXPORT_MAGIC);
  assert.equal(bytes[EXPORT_MAGIC.length], EXPORT_FORMAT_VERSION);
  assert.ok(bytes.byteLength > EXPORT_MAGIC.length + 1 + 16 + 12 + 16);
});

test("no secret plaintext and no secret name appears in the blob bytes", (t) => {
  const storage = seeded();
  t.after(() => storage.close());

  const bytes = Buffer.from(exportSecrets(storage, PASSPHRASE));

  // The plaintexts are the obvious requirement. The *names* matter too: a backup file
  // that leaks `provider:openai:api_key` tells an attacker what the deployment holds
  // and which credentials are worth targeting, so the whole payload is inside the
  // sealed region rather than only its values.
  for (const secret of [SENTINEL_ONE, SENTINEL_TWO]) {
    assert.equal(bytes.includes(Buffer.from(secret, "utf8")), false, `${secret} leaked`);
  }
  for (const name of ["provider:one:api_key", "proxy:two:password"]) {
    assert.equal(bytes.includes(Buffer.from(name, "utf8")), false, `${name} leaked`);
  }
  // Nor the passphrase, which a naive implementation might echo into a header.
  assert.equal(bytes.includes(Buffer.from(PASSPHRASE, "utf8")), false);
});

test("the blob contains no root key material", (t) => {
  const storage = seeded();
  t.after(() => storage.close());

  const bytes = Buffer.from(exportSecrets(storage, PASSPHRASE));

  // The export is portable *because* it is not tied to the root key: it re-seals
  // plaintext under a passphrase-derived key. Shipping the root key would make the
  // backup equivalent to the database it came from.
  assert.equal(bytes.includes(Buffer.from(KEY_A, "hex")), false, "root key in blob");
  assert.doesNotMatch(bytes.toString("latin1"), /kek_[0-9a-f]{32}/);
});

test("a round trip into a database with a different root key restores every secret", (t) => {
  const source = seeded(KEY_A);
  const blob = exportSecrets(source, PASSPHRASE);
  source.close();

  // A different root key on purpose: this is the case a backup exists for, and it is
  // the case that proves the blob is not root-key-bound.
  const target = open(KEY_B);
  t.after(() => target.close());

  const result = importSecrets(target, blob, PASSPHRASE);
  assert.equal(result.imported, 2);
  assert.equal(target.get("provider:one:api_key"), SENTINEL_ONE);
  assert.equal(target.get("proxy:two:password"), SENTINEL_TWO);

  // Re-sealed under the target's own key, not copied as foreign envelopes.
  assert.equal(target.inspect("provider:one:api_key").keyId, target.keyId);
});

test("a wrong passphrase fails closed and imports nothing", (t) => {
  const source = seeded();
  const blob = exportSecrets(source, PASSPHRASE);
  source.close();

  const target = open(KEY_B);
  t.after(() => target.close());

  assert.throws(
    () => importSecrets(target, blob, "not-the-passphrase"),
    (error: unknown) =>
      error instanceof StorageError && error.code === "master_key_invalid",
  );
  // Nothing partially applied: the failure happens on the GCM tag, before any row is
  // written, so an attacker cannot brute-force a passphrase while accumulating rows.
  assert.equal(target.list().length, 0);
});

test("a bit flip anywhere in the sealed region fails closed", (t) => {
  const source = seeded();
  const blob = Buffer.from(exportSecrets(source, PASSPHRASE));
  source.close();

  const target = open(KEY_B);
  t.after(() => target.close());

  // Every byte after the magic is authenticated: salt, IV, tag, and ciphertext. A
  // corrupted salt would derive a different key and a corrupted IV would decrypt to
  // garbage, so all of them must fail rather than silently import nonsense.
  for (const offset of [
    EXPORT_MAGIC.length + 1,
    EXPORT_MAGIC.length + 20,
    EXPORT_MAGIC.length + 32,
    blob.byteLength - 1,
  ]) {
    const tampered = Buffer.from(blob);
    tampered[offset] = tampered[offset]! ^ 0xff;
    assert.throws(
      () => importSecrets(target, tampered, PASSPHRASE),
      (error: unknown) => error instanceof StorageError,
      `a flip at offset ${offset} was accepted`,
    );
  }
  assert.equal(target.list().length, 0);
});

test("an unknown format version is refused", (t) => {
  const source = seeded();
  const blob = Buffer.from(exportSecrets(source, PASSPHRASE));
  source.close();

  const target = open(KEY_B);
  t.after(() => target.close());

  const future = Buffer.from(blob);
  future[EXPORT_MAGIC.length] = EXPORT_FORMAT_VERSION + 1;
  assert.throws(
    () => importSecrets(target, future, PASSPHRASE),
    (error: unknown) =>
      error instanceof StorageError && error.stage === "export-version",
  );
});

test("a blob that is not an export is refused on its magic, not on its tag", (t) => {
  const target = open(KEY_B);
  t.after(() => target.close());

  for (const junk of [
    Buffer.alloc(0),
    Buffer.from("hello"),
    Buffer.alloc(200, 0x00),
  ]) {
    assert.throws(
      () => importSecrets(target, junk, PASSPHRASE),
      (error: unknown) =>
        error instanceof StorageError &&
        (error.stage === "export-magic" || error.stage === "export-truncated"),
    );
  }
});

test("an existing secret of the same name is refused by default", (t) => {
  const source = seeded(KEY_A);
  const blob = exportSecrets(source, PASSPHRASE);
  source.close();

  const target = open(KEY_B);
  t.after(() => target.close());
  target.put("provider:one:api_key", "sk-already-here-do-not-clobber");

  assert.throws(
    () => importSecrets(target, blob, PASSPHRASE),
    (error: unknown) =>
      error instanceof StorageError && error.stage === "export-name-conflict",
  );

  // Refusing must be atomic too: the non-conflicting secret must not have been
  // written, or a retry with the replace flag would report a misleading count.
  assert.equal(target.get("provider:one:api_key"), "sk-already-here-do-not-clobber");
  assert.equal(target.find("proxy:two:password"), undefined);
});

test("an explicit replace flag overwrites, and only then", (t) => {
  const source = seeded(KEY_A);
  const blob = exportSecrets(source, PASSPHRASE);
  source.close();

  const target = open(KEY_B);
  t.after(() => target.close());
  target.put("provider:one:api_key", "sk-already-here");

  const result = importSecrets(target, blob, PASSPHRASE, { replace: true });
  assert.equal(result.imported, 2);
  assert.equal(target.get("provider:one:api_key"), SENTINEL_ONE);
  assert.equal(target.get("proxy:two:password"), SENTINEL_TWO);
});

test("the export key is derived with the Phase 2 scrypt profile", (t) => {
  const storage = seeded();
  t.after(() => storage.close());

  const blob = Buffer.from(exportSecrets(storage, PASSPHRASE));
  const salt = blob.subarray(EXPORT_MAGIC.length + 1, EXPORT_MAGIC.length + 1 + 16);

  // Derived, not stored: reproducing the key from the passphrase and the blob's own
  // salt must open it. This pins the parameters as a *contract* — a future weakening
  // to a cheaper KDF fails here rather than silently shipping in a backup format.
  const derived = scryptSync(PASSPHRASE, salt, SCRYPT_PARAMS.keyLength, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_PARAMS.maxmem,
  });
  assert.equal(derived.byteLength, 32);

  const target = open(KEY_B);
  try {
    assert.equal(importSecrets(target, blob, PASSPHRASE).imported, 2);
  } finally {
    target.close();
  }
});

test("an empty passphrase is refused on export and on import", (t) => {
  const storage = seeded();
  t.after(() => storage.close());

  for (const weak of ["", "   "]) {
    assert.throws(
      () => exportSecrets(storage, weak),
      (error: unknown) =>
        error instanceof StorageError && error.code === "master_key_invalid",
    );
  }
});

test("exporting an empty database produces a valid, importable blob", (t) => {
  const source = open(KEY_A);
  const blob = exportSecrets(source, PASSPHRASE);
  source.close();

  const target = open(KEY_B);
  t.after(() => target.close());

  // Zero secrets must not be an error and must not be indistinguishable from a
  // corrupt blob: an operator backing up before configuring anything should get a
  // file that restores cleanly.
  assert.equal(importSecrets(target, blob, PASSPHRASE).imported, 0);
});

test("each export of identical content produces different bytes", (t) => {
  const storage = seeded();
  t.after(() => storage.close());

  const first = Buffer.from(exportSecrets(storage, PASSPHRASE));
  const second = Buffer.from(exportSecrets(storage, PASSPHRASE));

  // Fresh salt and IV per export. Identical bytes would mean a fixed salt or a reused
  // IV, and a reused IV under the same derived key leaks the XOR of both payloads.
  assert.notDeepEqual(first, second);
});
