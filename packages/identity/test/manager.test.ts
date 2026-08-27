import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openSecretStorage, type SecretStorage } from "@bayz/storage";
import {
  IdentityError,
  createIdentityManager,
  type IdentityManager,
} from "../src/index.js";

const KEY = Buffer.alloc(32, 0x3f).toString("hex");

function harness(): {
  storage: SecretStorage;
  manager: IdentityManager;
  dataDir: string;
} {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-identity-mgr-")), ".bayz");
  const storage = openSecretStorage({ dataDir, env: { BAYZ_MASTER_KEY: KEY } });
  return { storage, manager: createIdentityManager({ storage }), dataDir };
}

const INPUT = {
  id: "opencode",
  displayName: "OpenCode",
  scopes: ["chat.completions", "models.read"],
};

test("createIdentity returns a 64-hex key exactly once", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  const { identity, key } = manager.createIdentity({ ...INPUT });
  assert.equal(identity.id, "opencode");
  assert.match(key, /^[0-9a-f]{64}$/);
  // 32 bytes. A shorter key would be guessable against a local listener that has
  // no network latency to slow an attacker down.
  assert.equal(Buffer.from(key, "hex").byteLength, 32);
});

test("there is no method that returns an existing key", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  manager.createIdentity({ ...INPUT });
  for (const name of Object.keys(manager)) {
    assert.ok(
      !/^(get|read|reveal|export|fetch|show)Key$/i.test(name),
      `the manager exposes ${name}`,
    );
  }
  // The positive form: every method that could plausibly return one does not.
  const view = manager.get("opencode");
  assert.ok(view !== undefined);
  assert.ok(!JSON.stringify(view).match(/[0-9a-f]{64}/));
});

test("verifyKey matches the created key and rejects a wrong one", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  const { key } = manager.createIdentity({ ...INPUT });
  const verified = manager.verifyKey(key);
  assert.equal(verified?.id, "opencode");
  assert.deepEqual(verified?.scopes, ["chat.completions", "models.read"]);

  assert.equal(manager.verifyKey(`${key.slice(0, -1)}0`), undefined);
  assert.equal(manager.verifyKey("wrong"), undefined);
  assert.equal(manager.verifyKey(""), undefined);
  assert.equal(manager.verifyKey(undefined as unknown as string), undefined);
  assert.equal(manager.verifyKey(null as unknown as string), undefined);
  assert.equal(manager.verifyKey(42 as unknown as string), undefined);
});

test("length is not an oracle: a 1 MiB key is refused before hashing", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  manager.createIdentity({ ...INPUT });
  const started = process.hrtime.bigint();
  assert.equal(manager.verifyKey("x".repeat(1024 * 1024)), undefined);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  // Generous and documented as indicative: the point is that an oversized value is
  // rejected on shape rather than hashed and compared against every identity.
  assert.ok(elapsedMs < 100, `oversized key verification took ${elapsedMs}ms`);
});

test("a revoked identity's key stops verifying immediately", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  const { key } = manager.createIdentity({ ...INPUT });
  assert.ok(manager.verifyKey(key) !== undefined);
  manager.revoke("opencode");
  assert.equal(manager.verifyKey(key), undefined);
});

test("revocation survives a reopen", (t) => {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-identity-mgr-reopen-")), ".bayz");
  const first = openSecretStorage({ dataDir, env: { BAYZ_MASTER_KEY: KEY } });
  const firstManager = createIdentityManager({ storage: first });
  const { key } = firstManager.createIdentity({ ...INPUT });
  firstManager.revoke("opencode");
  first.close();

  const second = openSecretStorage({ dataDir, env: { BAYZ_MASTER_KEY: KEY } });
  t.after(() => second.close());
  assert.equal(createIdentityManager({ storage: second }).verifyKey(key), undefined);
});

test("an expired identity's key stops verifying", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  const { key } = manager.createIdentity({
    id: "expired",
    displayName: "Expired",
    scopes: ["chat.completions"],
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  assert.equal(manager.verifyKey(key), undefined);
});

test("rotateKey invalidates the old key and the new one works", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  const { key: original } = manager.createIdentity({ ...INPUT });
  const { key: rotated } = manager.rotateKey("opencode");

  assert.notEqual(original, rotated);
  assert.match(rotated, /^[0-9a-f]{64}$/);
  assert.equal(manager.verifyKey(original), undefined);
  assert.equal(manager.verifyKey(rotated)?.id, "opencode");
  // The identity itself survives rotation: an operator rotating a key does not
  // want to re-grant scopes or lose the audit history.
  assert.deepEqual(manager.get("opencode")?.scopes, [
    "chat.completions",
    "models.read",
  ]);
});

test("rotating a revoked identity is refused", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  manager.createIdentity({ ...INPUT });
  manager.revoke("opencode");
  // Rotation would hand out a working key for something the operator switched off.
  assert.throws(
    () => manager.rotateKey("opencode"),
    (error: unknown) => error instanceof IdentityError && error.code === "identity_revoked",
  );
});

test("two identities' keys are completely independent", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  const first = manager.createIdentity({ ...INPUT });
  const second = manager.createIdentity({
    id: "hermes",
    displayName: "Hermes",
    scopes: ["chat.completions"],
  });
  const third = manager.createIdentity({
    id: "antigravity",
    displayName: "Antigravity",
    scopes: ["chat.completions"],
  });

  assert.notEqual(first.key, second.key);
  assert.notEqual(second.key, third.key);

  // The blast-radius requirement: revoking one client leaves the others working.
  manager.revoke("opencode");
  assert.equal(manager.verifyKey(first.key), undefined);
  assert.equal(manager.verifyKey(second.key)?.id, "hermes");
  assert.equal(manager.verifyKey(third.key)?.id, "antigravity");
});

test("one client's key never authenticates as another identity", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  const first = manager.createIdentity({ ...INPUT });
  const second = manager.createIdentity({
    id: "hermes",
    displayName: "Hermes",
    scopes: ["admin"],
  });

  // A cross-identity match would be catastrophic: a chat client would inherit
  // admin authority from a different identity's grant.
  assert.equal(manager.verifyKey(first.key)?.id, "opencode");
  assert.deepEqual(manager.verifyKey(first.key)?.scopes, [
    "chat.completions",
    "models.read",
  ]);
  assert.equal(manager.verifyKey(second.key)?.id, "hermes");
});

test("the key is stored under the client scope and nowhere else", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  manager.createIdentity({ ...INPUT });
  const names = storage.list().map((meta) => meta.name);
  assert.ok(names.includes("client:opencode:key"), "the key must be scoped by id");
  // The blast-radius boundary made concrete: the manager's storage view cannot name
  // a provider or proxy secret.
  assert.ok(
    !names.some((name) => name.startsWith("provider:") || name.startsWith("proxy:")),
    "the identity manager must not write outside its scope",
  );
});

test("the manager cannot read a provider credential or a proxy password", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  // Seeded directly so the secrets genuinely exist and the negative result is
  // meaningful rather than vacuous.
  storage.put("provider:p1:api_key", "sk-provider-secret");
  storage.put("proxy:x1:password", "proxy-secret");
  manager.createIdentity({ ...INPUT });

  // Every plausible spelling of an escape from the `client:<id>:` prefix.
  for (const attempt of [
    "provider:p1:api_key",
    "../provider:p1:api_key",
    "..:provider:p1:api_key",
    "p1:api_key",
    "key",
  ]) {
    assert.equal(
      manager.verifyKey(attempt),
      undefined,
      `verifyKey resolved ${attempt}`,
    );
  }
  assert.equal(manager.verifyKey("sk-provider-secret"), undefined);
  assert.equal(manager.verifyKey("proxy-secret"), undefined);
});

test("deleting an identity removes its key", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  const { key } = manager.createIdentity({ ...INPUT });
  assert.equal(manager.delete("opencode"), true);
  assert.equal(manager.verifyKey(key), undefined);
  assert.ok(
    !storage.list().some((meta) => meta.name === "client:opencode:key"),
    "a deleted identity must not leave an unreachable key behind",
  );
});

test("the key is absent from the database bytes", (t) => {
  const { storage, manager, dataDir } = harness();
  const { key } = manager.createIdentity({ ...INPUT });
  // Closed first so the WAL is checkpointed into the main file.
  storage.close();
  t.after(() => {});

  let bytes = Buffer.alloc(0);
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = join(dataDir, `bayz.db${suffix}`);
    if (existsSync(path)) {
      bytes = Buffer.concat([bytes, readFileSync(path)]);
    }
  }
  assert.ok(bytes.length > 0, "the database must exist");
  assert.ok(
    !bytes.includes(Buffer.from(key, "utf8")),
    "the client key must be envelope-encrypted, not stored as text",
  );
  assert.ok(
    !bytes.includes(Buffer.from(key, "hex")),
    "nor stored as raw bytes",
  );
});

test("verifyKey touches last_used_at on success only", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  const { key } = manager.createIdentity({ ...INPUT });
  assert.equal(manager.get("opencode")?.lastUsedAt, undefined);
  manager.verifyKey(key);
  assert.equal(typeof manager.get("opencode")?.lastUsedAt, "string");

  const afterSuccess = manager.get("opencode")?.lastUsedAt;
  manager.verifyKey("wrong-key-entirely");
  assert.equal(
    manager.get("opencode")?.lastUsedAt,
    afterSuccess,
    "a failed attempt must not update a use timestamp",
  );
});

test("createIdentity refuses a duplicate id and leaves no orphan key", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  manager.createIdentity({ ...INPUT });
  assert.throws(
    () => manager.createIdentity({ ...INPUT }),
    (error: unknown) =>
      error instanceof IdentityError && error.code === "identity_already_exists",
  );
  // Exactly one key: a failed create that had already written its secret would
  // leave a working credential for an identity that does not exist.
  assert.equal(
    storage.list().filter((meta) => meta.name.startsWith("client:")).length,
    1,
  );
});

test("an audit trail records creation, use, rotation, and revocation", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  const { key } = manager.createIdentity({ ...INPUT });
  manager.verifyKey(key);
  manager.verifyKey("wrong");
  const { key: rotated } = manager.rotateKey("opencode");
  manager.verifyKey(rotated);
  manager.revoke("opencode");

  const audit = manager.recentAudit(50);
  const actions = audit.map((row) => row.action);
  assert.ok(actions.includes("created"));
  assert.ok(actions.includes("authenticated"));
  assert.ok(actions.includes("rotated"));
  assert.ok(actions.includes("revoked"));

  // Metadata only: no key, in either form, anywhere in the audit.
  const serialized = JSON.stringify(audit);
  assert.ok(!serialized.includes(key));
  assert.ok(!serialized.includes(rotated));
  assert.ok(!/[0-9a-f]{64}/.test(serialized));
});

test("a failed verification is not attributed to any identity", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  manager.createIdentity({ ...INPUT });
  manager.verifyKey("some-guess");
  // Recording a rejection against an identity would require guessing which one was
  // being targeted, and a wrong guess would pollute that identity's history.
  const rejected = manager.recentAudit(50).filter((row) => row.action === "rejected");
  assert.equal(rejected.length, 0);
});
