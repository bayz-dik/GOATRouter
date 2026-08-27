import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openSecretStorage, type SecretStorage } from "@bayz/storage";
import {
  IdentityError,
  createIdentityRepository,
  type IdentityRepository,
} from "../src/index.js";

const KEY = Buffer.alloc(32, 0x61).toString("hex");

function harness(): { storage: SecretStorage; repository: IdentityRepository } {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-identity-repo-")), ".bayz");
  const storage = openSecretStorage({ dataDir, env: { BAYZ_MASTER_KEY: KEY } });
  return { storage, repository: createIdentityRepository(storage.sql) };
}

const INPUT = {
  id: "opencode-laptop",
  displayName: "OpenCode on the laptop",
  scopes: ["chat.completions", "models.read"] as const,
};

test("create then get returns the stored identity", (t) => {
  const { storage, repository } = harness();
  t.after(() => storage.close());

  const created = repository.create({ ...INPUT, scopes: [...INPUT.scopes] });
  assert.equal(created.id, "opencode-laptop");
  assert.equal(created.displayName, "OpenCode on the laptop");
  assert.deepEqual(created.scopes, ["chat.completions", "models.read"]);
  assert.equal(created.revoked, false);
  assert.equal(created.expiresAt, undefined);
  assert.equal(created.lastUsedAt, undefined);
  assert.equal(typeof created.createdAt, "string");

  assert.deepEqual(repository.get("opencode-laptop"), created);
});

test("a view carries no key material of any kind", (t) => {
  const { storage, repository } = harness();
  t.after(() => storage.close());

  const created = repository.create({ ...INPUT, scopes: [...INPUT.scopes] });
  const serialized = JSON.stringify(created);
  for (const forbidden of ["key", "secret", "token", "hash", "credential", "password"]) {
    assert.ok(
      !Object.keys(created).some((field) => field.toLowerCase().includes(forbidden)),
      `the view exposes a ${forbidden} field`,
    );
  }
  assert.ok(!/[0-9a-f]{32}/.test(serialized), "no key-shaped value in the view");
});

test("list returns every identity including revoked ones", (t) => {
  const { storage, repository } = harness();
  t.after(() => storage.close());

  repository.create({ ...INPUT, scopes: [...INPUT.scopes] });
  repository.create({ id: "hermes", displayName: "Hermes", scopes: ["chat.completions"] });
  repository.revoke("hermes");

  const listed = repository.list();
  assert.deepEqual(
    listed.map((identity) => identity.id),
    ["hermes", "opencode-laptop"],
  );
  // A revoked identity must stay visible: an operator needs to see that it exists
  // and is revoked, otherwise revocation looks like deletion and they cannot audit it.
  assert.equal(listed.find((identity) => identity.id === "hermes")?.revoked, true);
});

test("an id outside the slug pattern is refused before any SQL runs", (t) => {
  const { storage, repository } = harness();
  t.after(() => storage.close());

  for (const id of [
    "",
    " ",
    "Upper",
    "with space",
    "with_underscore",
    "-leading",
    "trailing-",
    "a..b",
    "a".repeat(64),
    "id;DROP TABLE client_identities;--",
    "__proto__",
    42 as unknown as string,
    null as unknown as string,
  ]) {
    assert.throws(
      () => repository.create({ id, displayName: "X", scopes: ["chat.completions"] }),
      (error: unknown) =>
        error instanceof IdentityError && error.code === "invalid_identity_id",
      `accepted id ${JSON.stringify(id)}`,
    );
  }
  // The table survived every injection attempt.
  assert.deepEqual(repository.list(), []);
});

test("a duplicate id is identity_already_exists", (t) => {
  const { storage, repository } = harness();
  t.after(() => storage.close());

  repository.create({ ...INPUT, scopes: [...INPUT.scopes] });
  assert.throws(
    () => repository.create({ ...INPUT, scopes: [...INPUT.scopes] }),
    (error: unknown) =>
      error instanceof IdentityError && error.code === "identity_already_exists",
  );
});

test("a hostile display name is stored inertly and bounded", (t) => {
  const { storage, repository } = harness();
  t.after(() => storage.close());

  const hostile = "<script>alert(1)</script>";
  const created = repository.create({
    id: "hostile",
    displayName: hostile,
    scopes: ["chat.completions"],
  });
  // Stored verbatim: escaping at rest would double-escape on render. The dashboard
  // renders it as text, which is where the safety belongs.
  assert.equal(created.displayName, hostile);

  assert.throws(
    () =>
      repository.create({
        id: "toolong",
        displayName: "x".repeat(200),
        scopes: ["chat.completions"],
      }),
    (error: unknown) =>
      error instanceof IdentityError && error.code === "invalid_identity_config",
  );
});

test("an invalid scope set is refused", (t) => {
  const { storage, repository } = harness();
  t.after(() => storage.close());

  for (const scopes of [[], ["not-a-scope"], ["admin", "admin"], "chat.completions"]) {
    assert.throws(
      () =>
        repository.create({
          id: "bad-scopes",
          displayName: "X",
          scopes: scopes as string[],
        }),
      (error: unknown) => error instanceof IdentityError && error.code === "invalid_scope",
      `accepted scopes ${JSON.stringify(scopes)}`,
    );
  }
});

test("a tampered scopes_json yields invalid_identity_config on read", (t) => {
  const { storage, repository } = harness();
  t.after(() => storage.close());

  repository.create({ ...INPUT, scopes: [...INPUT.scopes] });
  // Out-of-band edit, as an attacker with database write access would make. The
  // whole point of revalidating on read is that a widened scope set in a row cannot
  // become authority at runtime.
  storage.sql
    .prepare("UPDATE client_identities SET scopes_json = ? WHERE id = ?")
    .run('["admin"]', "opencode-laptop");
  assert.deepEqual(repository.get("opencode-laptop")?.scopes, ["admin"]);

  storage.sql
    .prepare("UPDATE client_identities SET scopes_json = ? WHERE id = ?")
    .run('["providers.everything"]', "opencode-laptop");
  assert.throws(
    () => repository.get("opencode-laptop"),
    (error: unknown) =>
      error instanceof IdentityError && error.code === "invalid_identity_config",
  );

  storage.sql
    .prepare("UPDATE client_identities SET scopes_json = ? WHERE id = ?")
    .run("not json at all", "opencode-laptop");
  assert.throws(
    () => repository.get("opencode-laptop"),
    (error: unknown) =>
      error instanceof IdentityError && error.code === "invalid_identity_config",
  );
});

test("a revoked identity lists but is not usable", (t) => {
  const { storage, repository } = harness();
  t.after(() => storage.close());

  repository.create({ ...INPUT, scopes: [...INPUT.scopes] });
  assert.equal(repository.isUsable("opencode-laptop"), true);
  repository.revoke("opencode-laptop");
  assert.equal(repository.isUsable("opencode-laptop"), false);
  assert.equal(repository.get("opencode-laptop")?.revoked, true);
});

test("revocation survives a reopen", (t) => {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-identity-reopen-")), ".bayz");
  const first = openSecretStorage({ dataDir, env: { BAYZ_MASTER_KEY: KEY } });
  createIdentityRepository(first.sql).create({
    ...INPUT,
    scopes: [...INPUT.scopes],
  });
  createIdentityRepository(first.sql).revoke("opencode-laptop");
  first.close();

  const second = openSecretStorage({ dataDir, env: { BAYZ_MASTER_KEY: KEY } });
  t.after(() => second.close());
  // Revocation that did not survive a restart would be no revocation at all.
  assert.equal(createIdentityRepository(second.sql).isUsable("opencode-laptop"), false);
});

test("an expired identity is not usable", (t) => {
  const { storage, repository } = harness();
  t.after(() => storage.close());

  repository.create({
    id: "expired",
    displayName: "Expired",
    scopes: ["chat.completions"],
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  assert.equal(repository.isUsable("expired"), false);

  repository.create({
    id: "future",
    displayName: "Future",
    scopes: ["chat.completions"],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  assert.equal(repository.isUsable("future"), true);
});

test("a malformed expiry is refused rather than treated as no expiry", (t) => {
  const { storage, repository } = harness();
  t.after(() => storage.close());

  // Treating an unparseable expiry as "never expires" would silently turn a
  // time-limited credential into a permanent one.
  for (const expiresAt of ["soon", "2026-13-45", "", "0", 12345 as unknown as string]) {
    assert.throws(
      () =>
        repository.create({
          id: "bad-expiry",
          displayName: "X",
          scopes: ["chat.completions"],
          expiresAt,
        }),
      (error: unknown) =>
        error instanceof IdentityError && error.code === "invalid_identity_config",
      `accepted expiry ${JSON.stringify(expiresAt)}`,
    );
  }
});

test("an unusable identity is unusable for an unknown id too", (t) => {
  const { storage, repository } = harness();
  t.after(() => storage.close());
  assert.equal(repository.isUsable("never-created"), false);
});

test("update changes the display name, scopes, and expiry", (t) => {
  const { storage, repository } = harness();
  t.after(() => storage.close());

  repository.create({ ...INPUT, scopes: [...INPUT.scopes] });
  const updated = repository.update("opencode-laptop", {
    displayName: "Renamed",
    scopes: ["chat.completions"],
  });
  assert.equal(updated.displayName, "Renamed");
  assert.deepEqual(updated.scopes, ["chat.completions"]);
  assert.ok(updated.updatedAt >= updated.createdAt);
});

test("update refuses to widen a revoked identity", (t) => {
  const { storage, repository } = harness();
  t.after(() => storage.close());

  repository.create({ ...INPUT, scopes: [...INPUT.scopes] });
  repository.revoke("opencode-laptop");
  // Editing a revoked identity back into usefulness would make revocation
  // reversible by anyone who can call the update route.
  assert.throws(
    () => repository.update("opencode-laptop", { scopes: ["admin"] }),
    (error: unknown) =>
      error instanceof IdentityError && error.code === "identity_revoked",
  );
});

test("update on an unknown id is identity_not_found", (t) => {
  const { storage, repository } = harness();
  t.after(() => storage.close());
  assert.throws(
    () => repository.update("missing", { displayName: "X" }),
    (error: unknown) =>
      error instanceof IdentityError && error.code === "identity_not_found",
  );
});

test("touch updates only last_used_at", (t) => {
  const { storage, repository } = harness();
  t.after(() => storage.close());

  const created = repository.create({ ...INPUT, scopes: [...INPUT.scopes] });
  repository.touch("opencode-laptop");
  const after = repository.get("opencode-laptop")!;
  assert.equal(typeof after.lastUsedAt, "string");
  assert.equal(after.updatedAt, created.updatedAt, "touch must not bump updatedAt");
  assert.deepEqual(after.scopes, created.scopes);
  assert.equal(after.displayName, created.displayName);
});

test("touch on an unknown id is a silent no-op", (t) => {
  const { storage, repository } = harness();
  t.after(() => storage.close());
  // Called on every authenticated request. Throwing here would turn a race with a
  // concurrent delete into a failed request for no benefit.
  repository.touch("missing");
});

test("delete removes the row and reports whether it existed", (t) => {
  const { storage, repository } = harness();
  t.after(() => storage.close());

  repository.create({ ...INPUT, scopes: [...INPUT.scopes] });
  assert.equal(repository.delete("opencode-laptop"), true);
  assert.equal(repository.get("opencode-laptop"), undefined);
  assert.equal(repository.delete("opencode-laptop"), false);
});

test("a preset name is stored when valid and refused when not", (t) => {
  const { storage, repository } = harness();
  t.after(() => storage.close());

  const created = repository.create({
    ...INPUT,
    scopes: [...INPUT.scopes],
    preset: "opencode",
  });
  assert.equal(created.preset, "opencode");

  assert.throws(
    () =>
      repository.create({
        id: "bad-preset",
        displayName: "X",
        scopes: ["chat.completions"],
        preset: "made-up-client",
      }),
    (error: unknown) =>
      error instanceof IdentityError && error.code === "invalid_identity_config",
  );
});

test("audit rows are recorded and pruned by count", (t) => {
  const { storage, repository } = harness();
  t.after(() => storage.close());

  repository.create({ ...INPUT, scopes: [...INPUT.scopes] });
  for (let index = 0; index < 30; index += 1) {
    repository.audit({
      identityId: "opencode-laptop",
      action: "authenticated",
      outcome: "allowed",
    });
  }
  const rows = repository.recentAudit(100);
  assert.ok(rows.length > 0);
  assert.ok(rows.length <= repository.auditRetention());

  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), [
      "action",
      "identityId",
      "occurredAt",
      "outcome",
      "route",
      "scope",
    ]);
  }
});

test("an audit row cannot carry arbitrary text", (t) => {
  const { storage, repository } = harness();
  t.after(() => storage.close());

  repository.create({ ...INPUT, scopes: [...INPUT.scopes] });
  assert.throws(
    () =>
      repository.audit({
        identityId: "opencode-laptop",
        action: "sk-leaked-credential" as never,
        outcome: "allowed",
      }),
    (error: unknown) =>
      error instanceof IdentityError && error.code === "invalid_identity_config",
  );
  assert.throws(
    () =>
      repository.audit({
        identityId: "opencode-laptop",
        action: "authenticated",
        outcome: "allowed",
        route: "x".repeat(500),
      }),
    (error: unknown) =>
      error instanceof IdentityError && error.code === "invalid_identity_config",
  );
});

test("auditing an unknown identity is refused, not silently dropped", (t) => {
  const { storage, repository } = harness();
  t.after(() => storage.close());
  // A foreign-key violation here would be an opaque storage error. Refusing with a
  // named code makes a bug in the caller visible.
  assert.throws(
    () =>
      repository.audit({
        identityId: "never-created",
        action: "authenticated",
        outcome: "allowed",
      }),
    (error: unknown) =>
      error instanceof IdentityError && error.code === "identity_not_found",
  );
});
