import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { BOOTSTRAP_IDENTITY_ID } from "../src/principal.js";
import { createBayzRuntime, type BayzRuntime } from "../src/runtime.js";

const KEY = Buffer.alloc(32, 0x8b).toString("hex");
const TOKEN = "identity-auth-token-0123456789";

function harness(): { app: FastifyInstance; runtime: BayzRuntime } {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-identity-auth-")), ".bayz");
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

/** A client key created through the real manager, as an operator would. */
function clientKey(
  runtime: BayzRuntime,
  id: string,
  scopes: string[],
  extra: { expiresAt?: string } = {},
): string {
  return runtime.identities.createIdentity({
    id,
    displayName: id,
    scopes,
    ...extra,
  }).key;
}

test("the runtime exposes an identity manager", (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });
  assert.equal(typeof runtime.identities.createIdentity, "function");
  assert.deepEqual(runtime.identities.list(), []);
});

test("the Phase 6 api token still authenticates and carries admin", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  // Backward compatibility. An operator upgrading into Phase 9 must not find their
  // existing token suddenly unable to manage anything.
  const response = await app.inject({
    method: "GET",
    url: "/api/status",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.statusCode, 200);

  const providers = await app.inject({
    method: "GET",
    url: "/api/providers",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(providers.statusCode, 200);
});

test("a client key authenticates and carries only its granted scopes", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const key = clientKey(runtime, "chat-only", ["chat.completions"]);
  const allowed = await app.inject({
    method: "GET",
    url: "/api/health",
    headers: { authorization: `Bearer ${key}` },
  });
  assert.equal(allowed.statusCode, 200);

  const denied = await app.inject({
    method: "GET",
    url: "/api/providers",
    headers: { authorization: `Bearer ${key}` },
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, "forbidden");
});

test("a revoked key is 401, not 403", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const key = clientKey(runtime, "revoked", ["models.read"]);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: { authorization: `Bearer ${key}` },
      })
    ).statusCode,
    200,
  );

  runtime.identities.revoke("revoked");
  const after = await app.inject({
    method: "GET",
    url: "/v1/models",
    headers: { authorization: `Bearer ${key}` },
  });
  // 401 rather than 403: the credential is no longer valid at all, which is a
  // different remedy from "valid but insufficient".
  assert.equal(after.statusCode, 401);
  assert.equal(after.json().error.code, "unauthorized");
});

test("an expired key is 401", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const key = clientKey(runtime, "expired", ["models.read"], {
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  const response = await app.inject({
    method: "GET",
    url: "/v1/models",
    headers: { authorization: `Bearer ${key}` },
  });
  assert.equal(response.statusCode, 401);
});

test("a malformed bearer is 401 identically to a missing one", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const shapes = [
    undefined,
    "",
    "Bearer",
    "Bearer ",
    "bearer lowercase-scheme",
    "Basic dXNlcjpwYXNz",
    `Bearer ${TOKEN} extra`,
    `Bearer ${TOKEN},Bearer ${TOKEN}`,
    "Bearer not-a-real-key",
    `Bearer ${"a".repeat(64)}`,
  ];
  const bodies: string[] = [];
  for (const shape of shapes) {
    const response = await app.inject({
      method: "GET",
      url: "/api/status",
      ...(shape === undefined ? {} : { headers: { authorization: shape } }),
    });
    assert.equal(response.statusCode, 401, `shape ${JSON.stringify(shape)}`);
    bodies.push(response.json().error.code);
  }
  // Every failure mode reports the same code, so the response cannot be used to
  // distinguish "no such key" from "wrong key" from "malformed header".
  assert.equal(new Set(bodies).size, 1);
  assert.equal(bodies[0], "unauthorized");
});

test("a handler sees a principal but never the presented key", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const key = clientKey(runtime, "inspected", ["models.read"]);
  let seen: unknown;
  app.get("/__test/principal", async (request) => {
    seen = request.principal;
    return { ok: true };
  });

  await app.inject({
    method: "GET",
    url: "/__test/principal",
    headers: { authorization: `Bearer ${key}` },
  });
  // No key material of any kind on the request decoration.
  const serialized = JSON.stringify(seen, (_field, value) =>
    value instanceof Set ? [...value] : value,
  );
  assert.ok(serialized.includes("inspected"));
  assert.ok(!serialized.includes(key));
  assert.ok(!/[0-9a-f]{64}/.test(serialized));
});

test("the bootstrap principal has a stable non-secret id", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  let seen: { id?: string } | undefined;
  app.get("/__test/bootstrap", async (request) => {
    seen = request.principal;
    return { ok: true };
  });
  await app.inject({
    method: "GET",
    url: "/__test/bootstrap",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(seen?.id, BOOTSTRAP_IDENTITY_ID);
});

test("api health remains unauthenticated", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });
  const response = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(response.statusCode, 200);
});

test("failed identity lookups spend the same auth budget as a bad token", async (t) => {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-identity-rate-")), ".bayz");
  const runtime = createBayzRuntime(
    { host: "127.0.0.1", port: 20128, dataDir, dashboardRoot: "/nonexistent" },
    { env: { BAYZ_MASTER_KEY: KEY, BAYZ_API_TOKEN: TOKEN }, notify: () => {} },
  );
  const app = buildApp({
    logger: false,
    apiToken: TOKEN,
    runtime,
    rateLimit: { max: 1000, authMax: 3 },
  });
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  // Key guessing must be throttled exactly as token guessing is, or a client key
  // would be the softer target.
  const guess = `Bearer ${"b".repeat(64)}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { authorization: guess },
    });
    assert.equal(response.statusCode, 401);
  }
  const throttled = await app.inject({
    method: "GET",
    url: "/api/status",
    headers: { authorization: guess },
  });
  assert.equal(throttled.statusCode, 429);
  assert.equal(throttled.json().error.code, "rate_limited");
});

test("rotating a key invalidates the old one over HTTP", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const original = clientKey(runtime, "rotating", ["models.read"]);
  const { key: rotated } = runtime.identities.rotateKey("rotating");

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
        headers: { authorization: `Bearer ${rotated}` },
      })
    ).statusCode,
    200,
  );
});

test("revoking one client leaves the others authenticating", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const first = clientKey(runtime, "client-one", ["models.read"]);
  const second = clientKey(runtime, "client-two", ["models.read"]);
  const third = clientKey(runtime, "client-three", ["models.read"]);
  runtime.identities.revoke("client-one");

  const statuses = await Promise.all(
    [first, second, third].map(async (key) =>
      (
        await app.inject({
          method: "GET",
          url: "/v1/models",
          headers: { authorization: `Bearer ${key}` },
        })
      ).statusCode,
    ),
  );
  assert.deepEqual(statuses, [401, 200, 200]);
});

test("Host and Origin checks are unchanged for a client key", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const key = clientKey(runtime, "hostile-host", ["models.read"]);
  const response = await app.inject({
    method: "GET",
    url: "/v1/models",
    headers: { authorization: `Bearer ${key}`, host: "evil.example.com" },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "forbidden_host");
});
