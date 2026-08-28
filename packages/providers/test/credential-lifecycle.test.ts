import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openSecretStorage, type SecretStorage } from "@bayz/storage";
import {
  ProviderError,
  createProviderManager,
  type ProviderManager,
} from "../src/index.js";

const KEY = Buffer.alloc(32, 0x6c).toString("hex");

const FIRST = "sk-lifecycle-first-credential";
const SECOND = "sk-lifecycle-second-credential";

type Ctx = {
  manager: ProviderManager;
  storage: SecretStorage;
  dataDir: string;
  close(): void;
};

function context(): Ctx {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-cred-life-")), ".bayz");
  const storage = openSecretStorage({ dataDir, env: { BAYZ_MASTER_KEY: KEY } });
  const manager = createProviderManager({ storage });
  return { manager, storage, dataDir, close: () => manager.close() };
}

function seed(manager: ProviderManager, id = "relay"): string {
  manager.createProvider({
    id,
    kind: "openai-compatible",
    displayName: "Relay",
    baseUrl: "https://relay.invalid/v1",
  });
  return id;
}

/** The physical secret name a provider credential lives under. */
function secretName(id: string): string {
  return `provider:${id}:api_key`;
}

test("replacing a credential produces a new DEK and a new IV", (t) => {
  const ctx = context();
  t.after(() => ctx.close());
  const id = seed(ctx.manager);

  ctx.manager.setCredential(id, FIRST);
  const before = ctx.storage.inspect(secretName(id));

  ctx.manager.setCredential(id, SECOND);
  const after = ctx.storage.inspect(secretName(id));

  // A fresh DEK per write is what makes one recovered DEK decrypt exactly one
  // version of one secret. Reusing either the DEK or the IV under AES-GCM would be
  // catastrophic: two ciphertexts under the same key and nonce leak their XOR.
  assert.notDeepEqual(after.wrappedDek, before.wrappedDek, "the wrapped DEK must change");
  assert.notDeepEqual(after.iv, before.iv, "the content IV must change");
  assert.notDeepEqual(after.wrapIv, before.wrapIv, "the wrap IV must change");
  assert.notDeepEqual(after.ciphertext, before.ciphertext);

  // Same root key, so the fingerprint is unchanged: this is credential rotation,
  // not root-key rotation, and conflating them would hide which one happened.
  assert.equal(after.keyId, before.keyId);
});

test("rotating a credential many times never repeats a DEK or an IV", (t) => {
  const ctx = context();
  t.after(() => ctx.close());
  const id = seed(ctx.manager);

  const deks = new Set<string>();
  const ivs = new Set<string>();
  for (let round = 0; round < 25; round += 1) {
    ctx.manager.setCredential(id, `sk-round-${round}`);
    const view = ctx.storage.inspect(secretName(id));
    deks.add(Buffer.from(view.wrappedDek).toString("hex"));
    ivs.add(Buffer.from(view.iv).toString("hex"));
  }
  assert.equal(deks.size, 25, "a repeated wrapped DEK means the DEK was reused");
  assert.equal(ivs.size, 25, "a repeated IV under one key would leak plaintext");
});

test("deleting a credential removes the row, so the ciphertext is unrecoverable", (t) => {
  const ctx = context();
  t.after(() => ctx.close());
  const id = seed(ctx.manager);
  ctx.manager.setCredential(id, FIRST);

  assert.equal(ctx.manager.hasCredential(id), true);
  assert.equal(ctx.manager.deleteCredential(id), true);

  // This is the honest erasure guarantee: the wrapped DEK is gone with the row, and
  // without it the ciphertext cannot be decrypted by anyone — including us. Nothing
  // here claims the bytes were overwritten.
  assert.equal(ctx.manager.hasCredential(id), false);
  assert.throws(
    () => ctx.storage.inspect(secretName(id)),
    (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === "secret_not_found",
  );
  // Idempotent: a second delete is not an error, and it does not claim to have
  // removed something.
  assert.equal(ctx.manager.deleteCredential(id), false);
});

test("a deleted credential is refused on the next use, never served stale", (t) => {
  const ctx = context();
  t.after(() => ctx.close());
  const id = seed(ctx.manager);
  ctx.manager.setCredential(id, FIRST);

  const seen: string[] = [];
  ctx.manager.withCredential(id, (credential) => seen.push(credential));
  assert.deepEqual(seen, [FIRST]);

  ctx.manager.deleteCredential(id);

  // The callback must not run at all. Running it with a stale value would let a
  // caller sign a request with a credential the operator has revoked, and running it
  // with an empty string would send an unauthenticated request that looks signed.
  assert.throws(
    () => ctx.manager.withCredential(id, (credential) => seen.push(credential)),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "credential_missing",
  );
  assert.deepEqual(seen, [FIRST], "the callback ran after revocation");
});

test("a rotated credential is visible to the very next use", (t) => {
  const ctx = context();
  t.after(() => ctx.close());
  const id = seed(ctx.manager);

  ctx.manager.setCredential(id, FIRST);
  const first = ctx.manager.withCredential(id, (credential) => credential);
  ctx.manager.setCredential(id, SECOND);
  const second = ctx.manager.withCredential(id, (credential) => credential);

  // No caching anywhere on this path: a cached credential would keep signing with a
  // rotated-away key, which is the failure rotation exists to prevent.
  assert.equal(first, FIRST);
  assert.equal(second, SECOND);
});

test("a rejected credential write leaves the previous credential intact", (t) => {
  const ctx = context();
  t.after(() => ctx.close());
  const id = seed(ctx.manager);
  ctx.manager.setCredential(id, FIRST);
  const before = ctx.storage.inspect(secretName(id));

  for (const rejected of ["", "   ", undefined, null, 42, {}]) {
    assert.throws(
      () => ctx.manager.setCredential(id, rejected as never),
      (error: unknown) => error instanceof ProviderError,
      `${JSON.stringify(rejected)} was accepted as a credential`,
    );
  }

  // Validated before the transaction opens, so a bad call cannot leave a half-written
  // envelope: the operator's working credential is byte-identical afterwards.
  const after = ctx.storage.inspect(secretName(id));
  assert.deepEqual(after.ciphertext, before.ciphertext);
  assert.deepEqual(after.wrappedDek, before.wrappedDek);
  assert.equal(ctx.manager.withCredential(id, (credential) => credential), FIRST);
});

test("deleting a provider erases its credential with it", (t) => {
  const ctx = context();
  t.after(() => ctx.close());
  const id = seed(ctx.manager);
  ctx.manager.setCredential(id, FIRST);

  assert.equal(ctx.manager.deleteProvider(id), true);

  // A row removed while its secret survived would leave an unreachable credential in
  // the database forever — undeletable through any API, because the provider it was
  // scoped to no longer exists.
  assert.throws(
    () => ctx.storage.inspect(secretName(id)),
    (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === "secret_not_found",
  );
  assert.equal(
    ctx.storage.list().some((entry) => entry.name === secretName(id)),
    false,
  );
});

test("a credential is never recoverable from the database once deleted", (t) => {
  const ctx = context();
  t.after(() => ctx.close());
  const id = seed(ctx.manager);
  ctx.manager.setCredential(id, FIRST);
  ctx.manager.deleteCredential(id);

  // Belt and braces on the erasure claim: not only is the row gone, the plaintext was
  // never in the file to begin with, so a raw byte scan finds nothing either.
  const dbFile = join(ctx.dataDir, "bayz.db");
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${dbFile}${suffix}`;
    if (!existsSync(path)) {
      continue;
    }
    assert.equal(
      readFileSync(path).includes(Buffer.from(FIRST, "utf8")),
      false,
      `${suffix || "db"} contains the plaintext credential`,
    );
  }
});

/**
 * The WAL caveat, asserted as a measured fact rather than waved away.
 *
 * A deleted row's *ciphertext* is not necessarily gone from the files on disk the
 * instant `delete` returns: SQLite writes the change to the write-ahead log, and the
 * superseded pages persist there until a checkpoint. This test measures where those
 * bytes actually are at each step instead of claiming a guarantee.
 *
 * What BAYZ can honestly promise is cryptographic erasure — the wrapped DEK is gone,
 * so surviving ciphertext bytes cannot be decrypted. What it cannot promise is secure
 * overwrite: `PRAGMA secure_delete` makes SQLite zero the freed pages it manages, but
 * on flash storage the *physical* NAND page is not rewritten in place by any of this,
 * and Node has no interface that would let it be. That limitation is stated, not
 * engineered around.
 */
test("deleted ciphertext does not survive a checkpoint in the database file", (t) => {
  const ctx = context();
  t.after(() => ctx.close());
  const id = seed(ctx.manager);
  ctx.manager.setCredential(id, FIRST);

  const ciphertext = Buffer.from(ctx.storage.inspect(secretName(id)).ciphertext);
  const dbFile = join(ctx.dataDir, "bayz.db");
  const walFile = `${dbFile}-wal`;
  const inFile = (path: string): boolean =>
    existsSync(path) ? readFileSync(path).includes(ciphertext) : false;

  // Measured starting point: in WAL mode a fresh write lives in the log, not yet in
  // the main file.
  assert.equal(ctx.storage.journalMode, "wal");
  assert.equal(inFile(walFile), true, "the fresh write should be in the WAL");

  ctx.manager.deleteCredential(id);

  // Honest intermediate state: the ciphertext is still in the WAL right after the
  // delete. Asserted rather than hidden, because an operator reasoning about disk
  // forensics needs to know this window exists.
  assert.equal(inFile(walFile), true, "the superseded page is still in the WAL");

  ctx.storage.sql.exec("PRAGMA wal_checkpoint(TRUNCATE)");

  // After the checkpoint the bytes must not have simply migrated into the main
  // database file. With SQLite's default `secure_delete = 0` they do exactly that,
  // which is the defect this asserts against.
  assert.equal(
    inFile(dbFile),
    false,
    "deleted ciphertext was checkpointed into the database file",
  );
  assert.equal(inFile(walFile), false);
});

test("secure_delete is enabled, so freed pages are zeroed rather than left behind", (t) => {
  const ctx = context();
  t.after(() => ctx.close());

  // Pinned as configuration, not inferred from the behaviour above: a future change
  // that turns this off would otherwise only surface as a subtle forensic regression.
  const row = ctx.storage.sql.prepare("PRAGMA secure_delete").get();
  assert.equal(Number(row?.secure_delete), 1);
});
