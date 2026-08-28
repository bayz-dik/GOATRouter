import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ClientScope } from "@bayz/identity";
import { masterKeyPath, openSecretStorage } from "@bayz/storage";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createBayzRuntime, type BayzRuntime } from "../src/runtime.js";

const TOKEN = "key-rotation-token-0123456789";
const ADMIN = {
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
};

const ROTATE_URL = "/api/security/rotate-root-key";
const AUDIT_URL = "/api/security/audit";

type Harness = {
  app: FastifyInstance;
  runtime: BayzRuntime;
  dataDir: string;
};

/**
 * Secure-file custody, deliberately: rotation must persist a replacement key, and
 * only writable custody can do that. `BAYZ_MASTER_KEY` is therefore *absent* here —
 * the env-custody refusal has its own test below.
 */
function harness(env: Record<string, string | undefined> = {}): Harness {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-key-rotation-")), ".bayz");
  const runtime = createBayzRuntime(
    { host: "127.0.0.1", port: 20135, dataDir, dashboardRoot: "/nonexistent" },
    { env: { BAYZ_API_TOKEN: TOKEN, ...env }, notify: () => {} },
  );
  const app = buildApp({
    logger: false,
    apiToken: TOKEN,
    runtime,
    rateLimit: { max: 100000, authMax: 100000 },
  });
  return { app, runtime, dataDir };
}

/**
 * Two providers with credentials, so a rotation has real wrapped DEKs to rewrap.
 *
 * `createProvider` deliberately has no `credential` field — custody goes through
 * `setCredential`, which is the only path that reaches the encrypted store — so the
 * fixture uses the real two-step API rather than a shape the manager would reject.
 */
function seedSecrets(runtime: BayzRuntime): { p1: string; p2: string } {
  const p1 = "sk-rotation-fixture-one";
  const p2 = "sk-rotation-fixture-two";
  runtime.providers.createProvider({
    id: "prov-one",
    kind: "openai-compatible",
    displayName: "Provider One",
    baseUrl: "https://one.invalid",
  });
  runtime.providers.setCredential("prov-one", p1);
  runtime.providers.createProvider({
    id: "prov-two",
    kind: "openai-compatible",
    displayName: "Provider Two",
    baseUrl: "https://two.invalid",
  });
  runtime.providers.setCredential("prov-two", p2);
  return { p1, p2 };
}

function keyFor(runtime: BayzRuntime, id: string, scopes: ClientScope[]): string {
  return runtime.identities.createIdentity({ id, displayName: id, scopes }).key;
}

test("rotation requires admin and is refused for every lesser scope", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  for (const scopes of [
    ["chat.completions"],
    ["providers.write"],
    ["proxies.write"],
    ["routes.write"],
    ["usage.read"],
    ["models.read"],
  ] satisfies ClientScope[][]) {
    const key = keyFor(runtime, `client-${scopes[0]!.replace(/\W/g, "-")}`, scopes);
    const response = await app.inject({
      method: "POST",
      url: ROTATE_URL,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      payload: {},
    });
    assert.equal(
      response.statusCode,
      403,
      `${scopes[0]} reached rotation with ${response.statusCode}`,
    );
    const body = response.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, "forbidden");
    assert.equal(body.error.message, "This credential lacks the required scope: admin");
  }

  // The audit surface is admin-only for the same reason: it names key fingerprints
  // and rotation counts, which is deployment shape a chat client has no claim on.
  const reader = keyFor(runtime, "audit-reader", ["usage.read"]);
  const denied = await app.inject({
    method: "GET",
    url: AUDIT_URL,
    headers: { authorization: `Bearer ${reader}` },
  });
  assert.equal(denied.statusCode, 403);
});

test("rotation rewraps every secret and each one still decrypts", async (t) => {
  const { app, runtime, dataDir } = harness();
  const { p1, p2 } = seedSecrets(runtime);
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: "POST",
    url: ROTATE_URL,
    headers: ADMIN,
    payload: {},
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    rotated: number;
    keyId: string;
    previousKeyId: string;
    rotatedAt: string;
  };
  assert.ok(body.rotated >= 2, `expected at least the two credentials, got ${body.rotated}`);

  runtime.close();

  // Reopened through the *rotated* custody: every secret must still be readable,
  // which is the only proof that a rewrap did not silently strand a row.
  const storage = openSecretStorage({ dataDir, env: {} });
  try {
    const names = storage.list().map((entry) => entry.name);
    assert.ok(names.length >= 2);
    const plaintexts = names.map((name) => storage.get(name));
    for (const plaintext of plaintexts) {
      assert.equal(typeof plaintext, "string");
    }
    assert.ok(
      plaintexts.includes(p1) && plaintexts.includes(p2),
      "both seeded credentials must survive the rotation verbatim",
    );
    // Every envelope now names the new key; a row still on the old one would be a
    // partial rotation reported as a success.
    for (const name of names) {
      assert.equal(storage.inspect(name).keyId, body.keyId);
    }
    assert.equal(storage.activeKeyId(), body.keyId);
  } finally {
    storage.close();
  }
});

test("the old root key stops working after rotation", async (t) => {
  const { app, runtime, dataDir } = harness();
  seedSecrets(runtime);
  t.after(async () => {
    await app.close();
  });

  const previous = readFileSync(masterKeyPath(dataDir));

  const rotated = await app.inject({
    method: "POST",
    url: ROTATE_URL,
    headers: ADMIN,
    payload: {},
  });
  assert.equal(rotated.statusCode, 200);
  runtime.close();

  // The key file must actually have changed; a rotation that leaves custody alone
  // would report success while changing nothing an attacker cares about.
  assert.notDeepEqual(readFileSync(masterKeyPath(dataDir)), previous);

  assert.throws(
    () =>
      openSecretStorage({
        dataDir,
        env: { BAYZ_MASTER_KEY: previous.toString("hex") },
      }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "master_key_mismatch",
    "the superseded key must be refused, not merely fail to decrypt rows",
  );
});

test("the response carries the new fingerprint and no key material", async (t) => {
  const { app, runtime } = harness();
  seedSecrets(runtime);
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const before = (
    await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { authorization: `Bearer ${TOKEN}` },
    })
  ).json() as { keyId: string };

  const response = await app.inject({
    method: "POST",
    url: ROTATE_URL,
    headers: ADMIN,
    payload: {},
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    rotated: number;
    keyId: string;
    previousKeyId: string;
    rotatedAt: string;
  };

  assert.equal(body.previousKeyId, before.keyId);
  assert.notEqual(body.keyId, body.previousKeyId);
  assert.match(body.rotatedAt, /^\d{4}-\d{2}-\d{2}T/);

  // The fingerprint is a truncated one-way digest, so it is 32 hex characters. A
  // 64-character run would be a raw 32-byte key, which must never cross the wire.
  assert.doesNotMatch(response.body, /[0-9a-f]{64}/);
  assert.equal(Object.keys(body).sort().join(","), "keyId,previousKeyId,rotated,rotatedAt");

  // The live status must agree immediately; a stale fingerprint would tell an
  // operator the rotation had not happened.
  const after = (
    await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { authorization: `Bearer ${TOKEN}` },
    })
  ).json() as { keyId: string };
  assert.equal(after.keyId, body.keyId);
});

test("an audit row records the rotation as metadata with no key material", async (t) => {
  const { app, runtime } = harness();
  seedSecrets(runtime);
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const rotated = (
    await app.inject({ method: "POST", url: ROTATE_URL, headers: ADMIN, payload: {} })
  ).json() as { rotated: number; keyId: string; previousKeyId: string };

  const audit = await app.inject({
    method: "GET",
    url: AUDIT_URL,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(audit.statusCode, 200);
  const rows = (audit.json() as { audit: Record<string, unknown>[] }).audit;
  assert.equal(rows.length, 1);

  const row = rows[0]!;
  // Pinned as an exact key set: a later change that adds a content-bearing field
  // fails here instead of quietly widening what an audit row can hold.
  assert.deepEqual(
    Object.keys(row).sort(),
    ["action", "actor", "keyId", "occurredAt", "outcome", "previousKeyId", "subjectCount"],
  );
  assert.equal(row.action, "root_key_rotated");
  assert.equal(row.outcome, "ok");
  assert.equal(row.subjectCount, rotated.rotated);
  assert.equal(row.keyId, rotated.keyId);
  assert.equal(row.previousKeyId, rotated.previousKeyId);
  assert.match(String(row.occurredAt), /^\d{4}-\d{2}-\d{2}T/);

  assert.doesNotMatch(audit.body, /[0-9a-f]{64}/);
  assert.doesNotMatch(audit.body, /sk-rotation-fixture/);
});

test("rotating twice in a row works and chains the fingerprints", async (t) => {
  const { app, runtime, dataDir } = harness();
  const { p1 } = seedSecrets(runtime);
  t.after(async () => {
    await app.close();
  });

  const first = (
    await app.inject({ method: "POST", url: ROTATE_URL, headers: ADMIN, payload: {} })
  ).json() as { keyId: string; previousKeyId: string };
  const second = (
    await app.inject({ method: "POST", url: ROTATE_URL, headers: ADMIN, payload: {} })
  ).json() as { keyId: string; previousKeyId: string };

  assert.equal(second.previousKeyId, first.keyId);
  assert.notEqual(second.keyId, first.keyId);

  const audit = (
    (
      await app.inject({
        method: "GET",
        url: AUDIT_URL,
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).json() as { audit: { keyId: string; previousKeyId: string }[] }
  ).audit;
  assert.equal(audit.length, 2);

  runtime.close();
  const storage = openSecretStorage({ dataDir, env: {} });
  try {
    assert.equal(storage.activeKeyId(), second.keyId);
    assert.ok(storage.list().map((entry) => storage.get(entry.name)).includes(p1));
  } finally {
    storage.close();
  }
});

test("custody that cannot persist a replacement refuses instead of half-rotating", async (t) => {
  // Environment custody: BAYZ cannot rewrite the operator's environment, so a
  // rotation here would leave a database whose key nothing holds. Refusing is the
  // only honest answer, and it must happen before any row is touched.
  const key = Buffer.alloc(32, 0x71).toString("hex");
  const { app, runtime, dataDir } = harness({ BAYZ_MASTER_KEY: key });
  seedSecrets(runtime);
  t.after(async () => {
    await app.close();
  });

  const before = (
    await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { authorization: `Bearer ${TOKEN}` },
    })
  ).json() as { keyId: string };

  const response = await app.inject({
    method: "POST",
    url: ROTATE_URL,
    headers: ADMIN,
    payload: {},
  });
  assert.equal(response.statusCode, 409);
  const body = response.json() as { error: { code: string; message: string } };
  assert.equal(body.error.code, "rotation_unsupported");
  assert.doesNotMatch(response.body, /[0-9a-f]{64}/);

  // A refused rotation is not an event worth an audit row; there is nothing to
  // reconstruct later. Read *before* closing the runtime: the audit route runs
  // against the same connection, so querying it afterwards would fail on a closed
  // database and prove nothing about what was recorded.
  const audit = (
    (
      await app.inject({
        method: "GET",
        url: AUDIT_URL,
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).json() as { audit: unknown[] }
  ).audit;
  assert.equal(audit.length, 0);

  runtime.close();

  // Nothing moved: the same key still opens the database and every secret reads.
  const storage = openSecretStorage({ dataDir, env: { BAYZ_MASTER_KEY: key } });
  try {
    assert.equal(storage.activeKeyId(), before.keyId);
    for (const entry of storage.list()) {
      assert.equal(typeof storage.get(entry.name), "string");
    }
  } finally {
    storage.close();
  }
});

test("a stale key is detected at open before any ciphertext is touched", async (t) => {
  // Pins the Phase 2 behaviour at this layer: `active_key_id` disagreeing with the
  // provider's key must surface as one clear signal, not a cascade of
  // secret_corrupt failures from individual rows.
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-stale-key-")), ".bayz");
  const original = Buffer.alloc(32, 0x33).toString("hex");
  const seeded = openSecretStorage({ dataDir, env: { BAYZ_MASTER_KEY: original } });
  seeded.put("provider:stale:credential", "sk-stale-fixture");
  const recorded = seeded.activeKeyId();
  seeded.close();

  const wrong = Buffer.alloc(32, 0x34).toString("hex");
  assert.throws(
    () => openSecretStorage({ dataDir, env: { BAYZ_MASTER_KEY: wrong } }),
    (error: unknown) => {
      const typed = error as { code?: string; stage?: string; message?: string };
      assert.equal(typed.code, "master_key_mismatch");
      assert.equal(typed.stage, "verify-active-key");
      // The failure names neither key.
      assert.doesNotMatch(String(typed.message), /[0-9a-f]{64}/);
      return true;
    },
  );

  // The failed open must not have rewritten the recorded id.
  const reopened = openSecretStorage({ dataDir, env: { BAYZ_MASTER_KEY: original } });
  try {
    assert.equal(reopened.activeKeyId(), recorded);
    assert.equal(reopened.get("provider:stale:credential"), "sk-stale-fixture");
  } finally {
    reopened.close();
  }
  t.diagnostic("stale-key detection verified at the storage boundary");
});
