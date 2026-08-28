import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openSecretStorage, type SecretStorage } from "@bayz/storage";
import { ProxyError, createProxyManager, type ProxyManager } from "../src/index.js";

const KEY = Buffer.alloc(32, 0x4d).toString("hex");

const FIRST = "proxy-lifecycle-first-password";
const SECOND = "proxy-lifecycle-second-password";

type Ctx = {
  manager: ProxyManager;
  storage: SecretStorage;
  dataDir: string;
  close(): void;
};

function context(): Ctx {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-proxy-life-")), ".bayz");
  const storage = openSecretStorage({ dataDir, env: { BAYZ_MASTER_KEY: KEY } });
  const manager = createProxyManager({ storage });
  return { manager, storage, dataDir, close: () => manager.close() };
}

/** A proxy with a username, which is what makes a password storable at all. */
function seed(manager: ProxyManager, id = "gate"): string {
  manager.createProxy({
    id,
    kind: "socks5",
    host: "127.0.0.1",
    port: 1080,
    username: "operator",
  });
  return id;
}

function secretName(id: string): string {
  return `proxy:${id}:password`;
}

test("replacing a proxy password produces a new DEK and a new IV", (t) => {
  const ctx = context();
  t.after(() => ctx.close());
  const id = seed(ctx.manager);

  ctx.manager.setPassword(id, FIRST);
  const before = ctx.storage.inspect(secretName(id));

  ctx.manager.setPassword(id, SECOND);
  const after = ctx.storage.inspect(secretName(id));

  // Identical reasoning to a provider credential: a reused IV under one key leaks the
  // XOR of both plaintexts, so neither the DEK nor either IV may survive a rewrite.
  assert.notDeepEqual(after.wrappedDek, before.wrappedDek);
  assert.notDeepEqual(after.iv, before.iv);
  assert.notDeepEqual(after.wrapIv, before.wrapIv);
  assert.equal(after.keyId, before.keyId);
});

test("deleting a proxy password removes the row and is idempotent", (t) => {
  const ctx = context();
  t.after(() => ctx.close());
  const id = seed(ctx.manager);
  ctx.manager.setPassword(id, FIRST);

  assert.equal(ctx.manager.hasPassword(id), true);
  assert.equal(ctx.manager.deletePassword(id), true);
  assert.equal(ctx.manager.hasPassword(id), false);
  assert.equal(ctx.manager.deletePassword(id), false);

  assert.throws(
    () => ctx.storage.inspect(secretName(id)),
    (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === "secret_not_found",
  );
});

test("a revoked proxy password fails the next dial before a socket is opened", (t) => {
  const ctx = context();
  t.after(() => ctx.close());
  const id = seed(ctx.manager);
  ctx.manager.setPassword(id, FIRST);

  // Proves the credential resolves before revocation, so the failure below is about
  // the revocation rather than about the proxy being unusable all along.
  assert.doesNotThrow(() => ctx.manager.agentFor(id));

  ctx.manager.deletePassword(id);

  // `password_missing`, not a silent unauthenticated dial. A SOCKS5 greeting that
  // offers username/password and then cannot supply one would either hang or
  // downgrade to no-auth, and downgrading is the dangerous outcome.
  assert.throws(
    () => ctx.manager.agentFor(id),
    (error: unknown) => error instanceof ProxyError && error.code === "password_missing",
  );
});

test("a rejected proxy password write leaves the previous password intact", (t) => {
  const ctx = context();
  t.after(() => ctx.close());
  const id = seed(ctx.manager);
  ctx.manager.setPassword(id, FIRST);
  const before = ctx.storage.inspect(secretName(id));

  for (const rejected of ["", "   ", undefined, null, 7, {}]) {
    assert.throws(
      () => ctx.manager.setPassword(id, rejected as never),
      (error: unknown) => error instanceof ProxyError,
      `${JSON.stringify(rejected)} was accepted as a password`,
    );
  }

  const after = ctx.storage.inspect(secretName(id));
  assert.deepEqual(after.ciphertext, before.ciphertext);
  assert.deepEqual(after.wrappedDek, before.wrappedDek);
});

test("a password without a username is refused rather than stored unusable", (t) => {
  const ctx = context();
  t.after(() => ctx.close());
  ctx.manager.createProxy({ id: "anon", kind: "http", host: "127.0.0.1", port: 3128 });

  // Neither RFC 1929 nor Basic proxy auth can send a password alone, so a stored one
  // would be dead state that looks like configuration.
  assert.throws(
    () => ctx.manager.setPassword("anon", FIRST),
    (error: unknown) =>
      error instanceof ProxyError && error.code === "invalid_proxy_config",
  );
  assert.equal(ctx.manager.hasPassword("anon"), false);
});

test("deleting a proxy erases its password with it", (t) => {
  const ctx = context();
  t.after(() => ctx.close());
  const id = seed(ctx.manager);
  ctx.manager.setPassword(id, FIRST);

  assert.equal(ctx.manager.deleteProxy(id), true);
  assert.equal(
    ctx.storage.list().some((entry) => entry.name === secretName(id)),
    false,
    "an orphaned password would be undeletable through any API",
  );
});

test("a deleted proxy password does not survive a checkpoint on disk", (t) => {
  const ctx = context();
  t.after(() => ctx.close());
  const id = seed(ctx.manager);
  ctx.manager.setPassword(id, FIRST);

  const ciphertext = Buffer.from(ctx.storage.inspect(secretName(id)).ciphertext);
  const dbFile = join(ctx.dataDir, "bayz.db");
  const walFile = `${dbFile}-wal`;
  const inFile = (path: string): boolean =>
    existsSync(path) ? readFileSync(path).includes(ciphertext) : false;

  ctx.manager.deletePassword(id);
  ctx.storage.sql.exec("PRAGMA wal_checkpoint(TRUNCATE)");

  // `secure_delete` is enabled at open, so the freed page is zeroed rather than
  // checkpointed into the main database file. Cryptographic erasure is still the
  // guarantee; this only removes a needless forensic exposure.
  assert.equal(inFile(dbFile), false);
  assert.equal(inFile(walFile), false);

  // The plaintext was never written to any file in the first place.
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${dbFile}${suffix}`;
    if (existsSync(path)) {
      assert.equal(readFileSync(path).includes(Buffer.from(FIRST, "utf8")), false);
    }
  }
});
