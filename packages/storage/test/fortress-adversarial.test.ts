import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  EXPORT_MAGIC,
  MIGRATIONS,
  StorageError,
  databasePath,
  exportSecrets,
  importSecrets,
  keystoreSupport,
  masterKeyPath,
  migrationChain,
  openSecretStorage,
  type CorruptibleColumn,
} from "../src/index.js";

/**
 * The 9F fortress suite.
 *
 * Like `adversarial.test.ts` this attacks the stored artifacts directly rather than
 * going through the repository API, so it opens the database with a raw
 * `DatabaseSync` — a real attacker would not politely use the adapter, and the
 * driver-boundary test excludes test files for exactly this reason.
 *
 * Where `adversarial.test.ts` covers the Phase 2 envelope, this covers what 9F added:
 * OS keystore honesty, the export blob, the migration hash chain, and the root-key
 * detection path. Every claim here is measured on this device.
 */

const KEY = Buffer.alloc(32, 0xaa).toString("hex");
const OTHER_KEY = Buffer.alloc(32, 0xbb).toString("hex");
const SENTINEL = "«redacted:sk-…»";

function dataDir(): string {
  return join(mkdtempSync(join(tmpdir(), "bayz-fortress-")), ".bayz");
}

function open(dir: string, key = KEY) {
  return openSecretStorage({ dataDir: dir, env: { BAYZ_MASTER_KEY: key } });
}

function allBytes(dir: string): Buffer {
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

/* ------------------------------------------------------------------ *
 * Root key custody
 * ------------------------------------------------------------------ */

test("a swapped master.key is detected before any ciphertext is touched", () => {
  const dir = dataDir();
  const first = openSecretStorage({ dataDir: dir, env: {} });
  first.put("k", SENTINEL);
  const originalKeyId = first.keyId;
  first.close();

  // The attacker replaces the key file wholesale, which is the realistic version of
  // this attack: they cannot read the old key, so they substitute one they control.
  //
  // Written as 32 **raw** bytes, the on-disk format `SecureFileKeyProvider` expects.
  // A 64-char hex string would be caught earlier by the length check as
  // `master_key_invalid`, which is a different (also correct) refusal and would have
  // let this test pass without ever exercising the fingerprint comparison.
  writeFileSync(masterKeyPath(dir), randomBytes(32), { mode: 0o600 });

  let code: string | undefined;
  let stage: string | undefined;
  try {
    openSecretStorage({ dataDir: dir, env: {} }).close();
  } catch (error) {
    code = error instanceof StorageError ? error.code : "unknown";
    stage = error instanceof StorageError ? error.stage : undefined;
  }
  assert.equal(code, "master_key_mismatch");
  // The point of the up-front check: the mismatch is caught at open, so no
  // decryption is attempted with the wrong key and no partial read can occur.
  assert.ok(stage !== undefined, "the failure must name where it was caught");
  assert.match(originalKeyId, /^kek_[0-9a-f]{32}$/);
});

test("a wrong-length master.key is refused as invalid, not as a mismatch", () => {
  const dir = dataDir();
  const first = openSecretStorage({ dataDir: dir, env: {} });
  first.put("k", SENTINEL);
  first.close();

  // The two failures are worth distinguishing because the operator's remedy differs:
  // a malformed file is a bad restore, a fingerprint mismatch is the wrong key.
  writeFileSync(masterKeyPath(dir), randomBytes(16), { mode: 0o600 });
  assert.throws(
    () => openSecretStorage({ dataDir: dir, env: {} }).close(),
    (error: unknown) =>
      error instanceof StorageError && error.code === "master_key_invalid",
  );
});

test("the recorded key fingerprint is a one-way digest, not the key", () => {
  const dir = dataDir();
  const storage = open(dir);
  storage.put("k", SENTINEL);
  const keyId = storage.keyId;
  storage.close();

  assert.match(keyId, /^kek_[0-9a-f]{32}$/);
  // The fingerprint is stored in the clear and is therefore readable by anyone who
  // has the file. It must not be the key, nor a prefix of it, nor recoverable from it.
  assert.equal(keyId.includes(KEY.slice(0, 8)), false);
  assert.equal(allBytes(dir).includes(Buffer.from(KEY, "hex")), false, "raw KEK in files");
  assert.equal(allBytes(dir).toString("latin1").includes(KEY), false, "hex KEK in files");
});

/* ------------------------------------------------------------------ *
 * Envelope integrity, every column
 * ------------------------------------------------------------------ */

test("a bit flip in each of the six envelope columns fails closed", () => {
  const columns: CorruptibleColumn[] = [
    "ciphertext",
    "wrapped_dek",
    "tag",
    "wrap_tag",
    "iv",
    "wrap_iv",
  ];

  for (const column of columns) {
    const dir = dataDir();
    let storage = open(dir);
    storage.put("k", SENTINEL);
    storage.corruptForTest("k", column);
    storage.close();

    // Reopened, so the failure cannot be an artefact of in-memory state.
    storage = open(dir);
    try {
      let returned: unknown = Symbol("untouched");
      let code: string | undefined;
      try {
        returned = storage.get("k");
      } catch (error) {
        code = error instanceof StorageError ? error.code : "unknown";
      }
      assert.equal(code, "secret_corrupt", `${column} did not fail closed`);
      // Fails *closed*, not open: no plaintext, and not an empty string either,
      // which a caller would read as "no credential configured".
      assert.equal(typeof returned, "symbol", `${column} returned a value`);
    } finally {
      storage.close();
    }
  }
});

test("a truncated column is refused rather than read short", () => {
  for (const column of ["ciphertext", "wrapped_dek", "iv"] as CorruptibleColumn[]) {
    const dir = dataDir();
    let storage = open(dir);
    storage.put("k", SENTINEL);
    storage.truncateForTest("k", column);
    storage.close();

    storage = open(dir);
    try {
      assert.throws(
        () => storage.get("k"),
        (error: unknown) => error instanceof StorageError,
        `${column} truncation was accepted`,
      );
    } finally {
      storage.close();
    }
  }
});

/* ------------------------------------------------------------------ *
 * The export blob
 * ------------------------------------------------------------------ */

test("an export blob cannot be imported into a different database without the passphrase", () => {
  const source = dataDir();
  const target = dataDir();

  let storage = open(source);
  storage.put("provider:openai:api_key", SENTINEL);
  const blob = exportSecrets(storage, "correct horse battery staple");
  storage.close();

  // A *different* root key: the blob re-seals plaintext under the passphrase, so it
  // is portable across databases by design. The passphrase is the only gate.
  const destination = open(target, OTHER_KEY);
  try {
    assert.throws(
      () => importSecrets(destination, blob, "wrong passphrase"),
      (error: unknown) => {
        assert.ok(error instanceof StorageError);
        // A wrong passphrase and a tampered blob are indistinguishable at the GCM
        // tag, so both are `master_key_invalid`: nothing stored is corrupt, the
        // supplied key is wrong.
        assert.equal(error.code, "master_key_invalid");
        return true;
      },
    );
    assert.equal(destination.list().length, 0, "a failed import must write nothing");

    // With the passphrase it restores, which is what proves the refusal above was
    // about the passphrase and not about the differing root key.
    const result = importSecrets(destination, blob, "correct horse battery staple");
    assert.equal(result.imported, 1);
    assert.equal(destination.get("provider:openai:api_key"), SENTINEL);
  } finally {
    destination.close();
  }
});

test("a bit flip anywhere in the blob fails closed and imports nothing", () => {
  const source = dataDir();
  let storage = open(source);
  storage.put("k", SENTINEL);
  const blob = exportSecrets(storage, "passphrase");
  storage.close();

  // Sampled across the whole blob rather than one byte: the header is AAD, the salt
  // and IV steer derivation, and the tag authenticates. Every region must matter.
  const offsets = [
    EXPORT_MAGIC.length, // the version byte
    EXPORT_MAGIC.length + 2, // inside the salt
    EXPORT_MAGIC.length + 20, // inside the IV
    EXPORT_MAGIC.length + 30, // inside the tag
    blob.length - 1, // last ciphertext byte
  ];

  for (const offset of offsets) {
    const tampered = Buffer.from(blob);
    tampered[offset] = tampered[offset]! ^ 0x01;

    const target = dataDir();
    const destination = open(target);
    try {
      assert.throws(
        () => importSecrets(destination, tampered, "passphrase"),
        (error: unknown) => error instanceof StorageError,
        `offset ${offset} was accepted`,
      );
      assert.equal(destination.list().length, 0, `offset ${offset} wrote a row`);
    } finally {
      destination.close();
    }
  }
});

test("the blob leaks neither secret values nor secret names", () => {
  const dir = dataDir();
  const storage = open(dir);
  storage.put("provider:openai:api_key", SENTINEL);
  storage.put("proxy:home:password", "hunter2-proxy-password");
  const blob = exportSecrets(storage, "passphrase");
  storage.close();

  // `exportSecrets` returns `Uint8Array`, whose `toString` takes no arguments — the
  // runtime value happens to be a Buffer, so wrapping it is what makes the encoding
  // explicit rather than relying on that coincidence.
  const text = Buffer.from(blob).toString("latin1");
  for (const leak of [
    SENTINEL,
    "hunter2-proxy-password",
    // Names too. A backup whose header announced `provider:openai:api_key` would
    // tell an attacker what the deployment holds and what is worth targeting.
    "provider:openai:api_key",
    "proxy:home:password",
  ]) {
    assert.equal(text.includes(leak), false, `the blob leaked ${leak.slice(0, 12)}`);
  }
});

/* ------------------------------------------------------------------ *
 * The migration hash chain
 * ------------------------------------------------------------------ */

test("a forged schema_migrations row is detected at open", () => {
  const dir = dataDir();
  const storage = open(dir);
  storage.put("k", SENTINEL);
  storage.close();

  // The attacker adds a migration that never ran, hoping to make a tampered build's
  // schema look like the legitimate one.
  //
  // `schema_migrations` is `(version, applied_at)` — there is no `name` column, and
  // the forgery has to be written in the real shape or the insert fails on the schema
  // instead of being caught by the integrity check, which would pass this test for
  // the wrong reason.
  const raw = new DatabaseSync(databasePath(dir));
  raw
    .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
    .run(9999, new Date().toISOString());
  raw.close();

  assert.throws(
    () => openSecretStorage({ dataDir: dir, env: { BAYZ_MASTER_KEY: KEY } }).close(),
    (error: unknown) => {
      assert.ok(error instanceof StorageError);
      assert.equal(error.code, "storage_unavailable");
      return true;
    },
  );
});

test("a deleted schema_migrations row is detected too", () => {
  const dir = dataDir();
  const storage = open(dir);
  storage.put("k", SENTINEL);
  storage.close();

  // Deletion is the mirror attack: make an applied migration look unapplied so it
  // re-runs, or so a downgrade appears legitimate.
  const raw = new DatabaseSync(databasePath(dir));
  raw.prepare("DELETE FROM schema_migrations WHERE version = ?").run(2);
  raw.close();

  assert.throws(
    () => openSecretStorage({ dataDir: dir, env: { BAYZ_MASTER_KEY: KEY } }).close(),
    (error: unknown) => error instanceof StorageError,
  );
});

test("the chain covers migration statements, not just version numbers", () => {
  // A tampered build that altered a migration's SQL while keeping its number is the
  // attack a version-only digest would miss entirely. Asserted at the pure-function
  // level because it is a property of the chain, not of a database.
  const original = MIGRATIONS[0]!;
  const sameNumber = {
    ...original,
    statements: [...original.statements, "CREATE TABLE injected (x TEXT)"],
  };

  const digestOf = (migrations: readonly (typeof original)[]): string => {
    // Recomputed independently of `migrationChain` so a rewrite of the scheme cannot
    // silently pass this test. `Migration` carries a version and its statements —
    // there is no `name` field — so those are what a faithful independent digest
    // covers.
    const hash = createHash("sha256");
    for (const migration of migrations) {
      hash.update(String(migration.version));
      for (const statement of migration.statements) {
        hash.update(statement);
      }
    }
    return hash.digest("hex");
  };

  assert.notEqual(
    digestOf([sameNumber]),
    digestOf([original]),
    "altering a migration's SQL must change the chain",
  );

  // And the property must hold for the function that actually ships, not only for the
  // independent recompute above — otherwise this test would pass while
  // `migrationChain` hashed version numbers alone.
  assert.notEqual(
    migrationChain([sameNumber], original.version),
    migrationChain([original], original.version),
    "the shipped chain must cover statements",
  );
});

/* ------------------------------------------------------------------ *
 * OS keystore honesty
 * ------------------------------------------------------------------ */

test("keystoreSupport reports UNVERIFIED on this device rather than claiming success", () => {
  const support = keystoreSupport();
  assert.ok(Array.isArray(support) || typeof support === "object");

  const entries = Array.isArray(support) ? support : Object.values(support);
  assert.ok(entries.length >= 3, "all three platform backends must be reported");

  // The honest claim: this is a Termux/Android ARM64 device with no DPAPI, no
  // Keychain, and no Secret Service. Asserting UNVERIFIED is the point — a suite
  // that expected `IMPLEMENTED` here would be asserting a platform we cannot test,
  // and one that skipped would hide the gap.
  for (const entry of entries as Array<{ status: string; backend?: string }>) {
    assert.ok(
      ["IMPLEMENTED", "UNVERIFIED", "N/A"].includes(entry.status),
      `unexpected status ${entry.status}`,
    );
  }
  const statuses = new Set(
    (entries as Array<{ status: string }>).map((entry) => entry.status),
  );
  assert.ok(
    statuses.has("UNVERIFIED"),
    "on this device at least one backend must be UNVERIFIED, never silently IMPLEMENTED",
  );
});

/* ------------------------------------------------------------------ *
 * The Phase 2 suite is still the Phase 2 suite
 * ------------------------------------------------------------------ */

test("the Phase 2 adversarial guarantees still hold unchanged", () => {
  // Not a re-run of that file — a re-assertion of its two load-bearing properties
  // against 9F's storage, so a 9F change that weakened either is caught here even if
  // the Phase 2 file were ever edited.
  const dir = dataDir();
  let storage = open(dir);
  storage.put("victim", SENTINEL);
  storage.put("attacker", "attacker-known-value");
  storage.close();

  // 1. AAD name binding: a whole valid envelope relocated onto another name fails.
  const raw = new DatabaseSync(databasePath(dir));
  const stolen = raw
    .prepare("SELECT * FROM secrets WHERE name = 'attacker'")
    .get() as Record<string, Uint8Array>;
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
    assert.throws(
      () => storage.get("victim"),
      (error: unknown) => error instanceof StorageError && error.code === "secret_corrupt",
    );
  } finally {
    storage.close();
  }

  // 2. No plaintext in any file, including the sidecars.
  assert.equal(
    allBytes(dir).toString("latin1").includes(SENTINEL),
    false,
    "plaintext reached the database files",
  );
});
