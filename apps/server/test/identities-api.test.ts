import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createBayzRuntime, type BayzRuntime } from "../src/runtime.js";

const KEY = Buffer.alloc(32, 0xd1).toString("hex");
const TOKEN = "identities-api-token-0123456789";
const ADMIN = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

function harness(): { app: FastifyInstance; runtime: BayzRuntime } {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-identities-api-")), ".bayz");
  const runtime = createBayzRuntime(
    { host: "127.0.0.1", port: 20128, dataDir, dashboardRoot: "/nonexistent" },
    { env: { BAYZ_MASTER_KEY: KEY, BAYZ_API_TOKEN: TOKEN }, notify: () => {} },
  );
  const app = buildApp({
    logger: false,
    apiToken: TOKEN,
    runtime,
    rateLimit: { max: 100000, authMax: 100000 },
  });
  return { app, runtime };
}

const BODY = {
  id: "opencode",
  displayName: "OpenCode",
  scopes: ["chat.completions", "models.read"],
};

test("create returns the key exactly once and never again", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const created = await app.inject({
    method: "POST",
    url: "/api/identities",
    headers: ADMIN,
    payload: BODY,
  });
  assert.equal(created.statusCode, 201);
  const body = created.json() as {
    identity: { id: string; scopes: string[] };
    key: string;
    keyShownOnce: boolean;
  };
  assert.match(body.key, /^[0-9a-f]{64}$/);
  assert.equal(body.keyShownOnce, true);
  assert.equal(body.identity.id, "opencode");

  // Every subsequent read must be key-free. This is the whole custody guarantee.
  const listed = await app.inject({
    method: "GET",
    url: "/api/identities",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(listed.statusCode, 200);
  assert.ok(!listed.body.includes(body.key));
  assert.ok(!/[0-9a-f]{64}/.test(listed.body));

  const single = await app.inject({
    method: "GET",
    url: "/api/identities/opencode",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(single.statusCode, 200);
  assert.ok(!single.body.includes(body.key));
});

test("a listed identity reports presence and scopes but no key", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  await app.inject({ method: "POST", url: "/api/identities", headers: ADMIN, payload: BODY });
  const listed = await app.inject({
    method: "GET",
    url: "/api/identities",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const [identity] = (listed.json() as { identities: Record<string, unknown>[] }).identities;
  // `undefined` fields do not survive JSON, so an absent expiry or preset simply is
  // not present. What matters is that every field that *is* present is allowed, and
  // that no field could ever carry key material.
  const allowed = new Set([
    "createdAt",
    "displayName",
    "expiresAt",
    "id",
    "lastUsedAt",
    "preset",
    "revoked",
    "scopes",
    "updatedAt",
  ]);
  for (const field of Object.keys(identity!)) {
    assert.ok(allowed.has(field), `unexpected field ${field}`);
  }
  assert.ok(Object.keys(identity!).includes("id"));
  assert.ok(Object.keys(identity!).includes("scopes"));
});

test("rotate returns the new key once and invalidates the old", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const created = await app.inject({
    method: "POST",
    url: "/api/identities",
    headers: ADMIN,
    payload: BODY,
  });
  const original = (created.json() as { key: string }).key;

  const rotated = await app.inject({
    method: "POST",
    url: "/api/identities/opencode/rotate",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(rotated.statusCode, 200);
  const next = (rotated.json() as { key: string }).key;
  assert.notEqual(next, original);

  // Proven over the real auth path, not by inspecting the manager.
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: { authorization: `Bearer ${original}` },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: { authorization: `Bearer ${next}` },
      })
    ).statusCode,
    200,
  );
});

test("delete revokes rather than erasing, and the identity stays visible", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const created = await app.inject({
    method: "POST",
    url: "/api/identities",
    headers: ADMIN,
    payload: BODY,
  });
  const key = (created.json() as { key: string }).key;

  const deleted = await app.inject({
    method: "DELETE",
    url: "/api/identities/opencode",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(deleted.statusCode, 204);

  const single = await app.inject({
    method: "GET",
    url: "/api/identities/opencode",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  // Visible and marked revoked: an operator must be able to audit that it existed
  // and was switched off, rather than seeing it vanish.
  assert.equal(single.statusCode, 200);
  assert.equal((single.json() as { revoked: boolean }).revoked, true);

  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: { authorization: `Bearer ${key}` },
      })
    ).statusCode,
    401,
  );
});

test("every identity route requires admin", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  await app.inject({ method: "POST", url: "/api/identities", headers: ADMIN, payload: BODY });

  // Every non-admin scope, including the write scopes an operator might assume are
  // powerful enough. Minting a credential is strictly more powerful than any of them.
  for (const scope of [
    "chat.completions",
    "models.read",
    "usage.read",
    "providers.read",
    "providers.write",
    "proxies.read",
    "proxies.write",
    "routes.read",
    "routes.write",
  ]) {
    const { key } = runtime.identities.createIdentity({
      id: `probe-${scope.replace(/\./g, "-")}`,
      displayName: scope,
      scopes: [scope],
    });
    const auth = { authorization: `Bearer ${key}` };
    const cases: Array<[string, string, boolean]> = [
      ["GET", "/api/identities", false],
      ["POST", "/api/identities", true],
      ["GET", "/api/identities/opencode", false],
      ["PATCH", "/api/identities/opencode", true],
      ["DELETE", "/api/identities/opencode", false],
      ["POST", "/api/identities/opencode/rotate", false],
      ["GET", "/api/identities/audit", false],
    ];
    for (const [method, url, hasBody] of cases) {
      const response = await app.inject({
        method: method as "GET",
        url,
        headers: hasBody ? { ...auth, "content-type": "application/json" } : auth,
        ...(hasBody ? { payload: {} } : {}),
      });
      assert.equal(
        response.statusCode,
        403,
        `${scope} reached ${method} ${url} with ${response.statusCode}`,
      );
    }
  }
});

test("a non-admin cannot escalate by minting an admin identity", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const { key } = runtime.identities.createIdentity({
    id: "escalator",
    displayName: "Escalator",
    scopes: ["providers.write", "routes.write", "proxies.write"],
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/identities",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    payload: { id: "minted-admin", displayName: "Minted", scopes: ["admin"] },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(runtime.identities.get("minted-admin"), undefined);
});

test("the audit records metadata only", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const created = await app.inject({
    method: "POST",
    url: "/api/identities",
    headers: ADMIN,
    payload: BODY,
  });
  const key = (created.json() as { key: string }).key;
  await app.inject({
    method: "GET",
    url: "/v1/models",
    headers: { authorization: `Bearer ${key}` },
  });
  await app.inject({
    method: "POST",
    url: "/api/identities/opencode/rotate",
    headers: { authorization: `Bearer ${TOKEN}` },
  });

  const audit = await app.inject({
    method: "GET",
    url: "/api/identities/audit",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(audit.statusCode, 200);
  const rows = (audit.json() as { audit: Record<string, unknown>[] }).audit;
  assert.ok(rows.length >= 3);
  const allowedAuditFields = new Set([
    "action",
    "identityId",
    "occurredAt",
    "outcome",
    "route",
    "scope",
  ]);
  for (const row of rows) {
    for (const field of Object.keys(row)) {
      assert.ok(allowedAuditFields.has(field), `unexpected audit field ${field}`);
    }
  }
  const actions = rows.map((row) => row.action);
  assert.ok(actions.includes("created"));
  assert.ok(actions.includes("authenticated"));
  assert.ok(actions.includes("rotated"));

  // No key, no body, nothing shaped like a credential.
  assert.ok(!audit.body.includes(key));
  assert.ok(!/[0-9a-f]{64}/.test(audit.body));
  assert.ok(!audit.body.includes(KEY));
});

test("the audit limit is validated", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  for (const limit of ["0", "-1", "1.5", "abc", "501", ""]) {
    const response = await app.inject({
      method: "GET",
      url: `/api/identities/audit?limit=${limit}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.statusCode, 400, `accepted limit ${JSON.stringify(limit)}`);
  }
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/api/identities/audit?limit=10",
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).statusCode,
    200,
  );
});

test("audit rows are bounded by count retention", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const created = await app.inject({
    method: "POST",
    url: "/api/identities",
    headers: ADMIN,
    payload: BODY,
  });
  const key = (created.json() as { key: string }).key;
  for (let index = 0; index < 40; index += 1) {
    await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: `Bearer ${key}` },
    });
  }
  const audit = await app.inject({
    method: "GET",
    url: "/api/identities/audit?limit=500",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const rows = (audit.json() as { audit: unknown[] }).audit;
  assert.ok(rows.length <= 500);
  assert.ok(rows.length >= 40);
});

test("an unknown identity is 404 and a hostile id is 400", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/api/identities/never-created",
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).statusCode,
    404,
  );
  for (const id of ["Upper", "a..b", "trailing-"]) {
    const response = await app.inject({
      method: "GET",
      url: `/api/identities/${id}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.statusCode, 400, `accepted id ${id}`);
  }
});

test("a duplicate id is 409", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  await app.inject({ method: "POST", url: "/api/identities", headers: ADMIN, payload: BODY });
  const again = await app.inject({
    method: "POST",
    url: "/api/identities",
    headers: ADMIN,
    payload: BODY,
  });
  assert.equal(again.statusCode, 409);
  assert.equal(
    (again.json() as { error: { code: string } }).error.code,
    "identity_already_exists",
  );
});

test("an unknown scope in a create body is 400", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/identities",
    headers: ADMIN,
    payload: { id: "bad", displayName: "Bad", scopes: ["providers.everything"] },
  });
  assert.equal(response.statusCode, 400);
  assert.equal((response.json() as { error: { code: string } }).error.code, "invalid_scope");
});

test("rotating a revoked identity is refused", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  await app.inject({ method: "POST", url: "/api/identities", headers: ADMIN, payload: BODY });
  await app.inject({
    method: "DELETE",
    url: "/api/identities/opencode",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const rotated = await app.inject({
    method: "POST",
    url: "/api/identities/opencode/rotate",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(rotated.statusCode, 403);
  assert.equal(
    (rotated.json() as { error: { code: string } }).error.code,
    "identity_revoked",
  );
});

test("a preset seeds scopes and is stored", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const created = await app.inject({
    method: "POST",
    url: "/api/identities",
    headers: ADMIN,
    payload: { ...BODY, preset: "opencode" },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(
    (created.json() as { identity: { preset: string } }).identity.preset,
    "opencode",
  );
});
