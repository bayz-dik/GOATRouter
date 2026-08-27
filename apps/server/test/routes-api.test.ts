import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TARGET_SCHEMA_VERSION } from "@bayz/storage";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createBayzRuntime, type BayzRuntime } from "../src/runtime.js";

const KEY = Buffer.alloc(32, 0x88).toString("hex");
const TOKEN = "routes-api-token-0123456789";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };

function harness(): { app: FastifyInstance; runtime: BayzRuntime } {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-routes-api-")), ".bayz");
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

async function seedProvider(app: FastifyInstance, id = "p1"): Promise<void> {
  await app.inject({
    method: "POST",
    url: "/api/providers",
    headers: JSON_AUTH,
    payload: {
      id,
      kind: "openai-compatible",
      displayName: id.toUpperCase(),
      baseUrl: "http://127.0.0.1:11434/v1",
    },
  });
}

test("a route can be created, listed, fetched, patched, and deleted", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });
  await seedProvider(app);

  const created = await app.inject({
    method: "POST",
    url: "/api/routes",
    headers: JSON_AUTH,
    payload: { id: "r1", model: "gpt-4o", providerId: "p1" },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().model, "gpt-4o");
  assert.equal(created.json().priority, 100);
  assert.equal(created.json().enabled, true);

  const list = await app.inject({ method: "GET", url: "/api/routes", headers: AUTH });
  assert.deepEqual(
    list.json().routes.map((route: { id: string }) => route.id),
    ["r1"],
  );

  const patched = await app.inject({
    method: "PATCH",
    url: "/api/routes/r1",
    headers: JSON_AUTH,
    payload: { priority: 900, enabled: false },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().priority, 900);
  assert.equal(patched.json().enabled, false);

  const deleted = await app.inject({
    method: "DELETE",
    url: "/api/routes/r1",
    headers: AUTH,
  });
  assert.equal(deleted.statusCode, 204);
  const gone = await app.inject({ method: "GET", url: "/api/routes/r1", headers: AUTH });
  assert.equal(gone.statusCode, 404);
  assert.equal(gone.json().error.code, "route_not_found");
});

test("a wildcard model pattern is accepted", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });
  await seedProvider(app);

  const created = await app.inject({
    method: "POST",
    url: "/api/routes",
    headers: JSON_AUTH,
    payload: { id: "wild", model: "gpt-4*", providerId: "p1" },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().model, "gpt-4*");
});

test("a route naming an unknown provider is 400, not 500", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/routes",
    headers: JSON_AUTH,
    payload: { id: "orphan", model: "gpt-4o", providerId: "ghost" },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "invalid_route_config");
  assert.equal(runtime.router.listRoutes().length, 0);
});

test("a route naming an unknown proxy is 400", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });
  await seedProvider(app);

  const response = await app.inject({
    method: "POST",
    url: "/api/routes",
    headers: JSON_AUTH,
    payload: { id: "orphan", model: "gpt-4o", providerId: "p1", proxyId: "ghost" },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "invalid_route_config");
});

test("a duplicate route id or model/provider pair is 409", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });
  await seedProvider(app);

  await app.inject({
    method: "POST",
    url: "/api/routes",
    headers: JSON_AUTH,
    payload: { id: "r1", model: "gpt-4o", providerId: "p1" },
  });
  for (const payload of [
    { id: "r1", model: "other-model", providerId: "p1" },
    { id: "r2", model: "gpt-4o", providerId: "p1" },
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/routes",
      headers: JSON_AUTH,
      payload,
    });
    assert.equal(response.statusCode, 409, JSON.stringify(payload));
    assert.equal(response.json().error.code, "route_already_exists");
  }
});

test("invalid route bodies and ids are 400 and never reach storage", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });
  await seedProvider(app);

  for (const payload of [
    { id: "Bad Id", model: "gpt-4o", providerId: "p1" },
    { id: "r1", model: "*", providerId: "p1" },
    { id: "r1", model: "gpt*4", providerId: "p1" },
    { id: "r1", model: "../../etc/passwd", providerId: "p1" },
    { id: "r1", model: "gpt-4o", providerId: "p1", priority: 1001 },
    { id: "r1", model: "gpt-4o", providerId: "p1", priority: -1 },
    { id: "r1", model: "gpt-4o", providerId: "p1", config: { stream: true } },
    { id: "r1", model: "gpt-4o", providerId: "p1", config: { maxAttempts: 99 } },
    { id: "r1", model: "gpt-4o" },
    {},
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/routes",
      headers: JSON_AUTH,
      payload,
    });
    assert.equal(
      response.statusCode,
      400,
      `payload must be refused: ${JSON.stringify(payload).slice(0, 70)}`,
    );
  }
  assert.equal(runtime.router.listRoutes().length, 0);

  for (const id of ["Upper", "a..b", "a:b"]) {
    const response = await app.inject({
      method: "GET",
      url: `/api/routes/${id}`,
      headers: AUTH,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "invalid_route_id");
  }
});

test("deleting a provider through the API removes its routes", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });
  await seedProvider(app);
  await app.inject({
    method: "POST",
    url: "/api/routes",
    headers: JSON_AUTH,
    payload: { id: "r1", model: "gpt-4o", providerId: "p1" },
  });

  await app.inject({ method: "DELETE", url: "/api/providers/p1", headers: AUTH });
  const list = await app.inject({ method: "GET", url: "/api/routes", headers: AUTH });
  assert.deepEqual(list.json().routes, [], "no dangling route may survive");
});

test("the status endpoint reports counts and no key material", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });
  await seedProvider(app);
  await app.inject({
    method: "PUT",
    url: "/api/providers/p1/credential",
    headers: JSON_AUTH,
    payload: { value: "sk-status-endpoint-secret" },
  });
  await app.inject({
    method: "POST",
    url: "/api/routes",
    headers: JSON_AUTH,
    payload: { id: "r1", model: "gpt-4o", providerId: "p1" },
  });

  const response = await app.inject({ method: "GET", url: "/api/status", headers: AUTH });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.schemaVersion, TARGET_SCHEMA_VERSION);
  // `identities` added in 9C. A count is operational shape, not credential data.
  assert.deepEqual(body.counts, { providers: 1, proxies: 0, routes: 1, identities: 0 });
  assert.equal(response.body.includes("sk-status-endpoint-secret"), false);
  assert.equal(response.body.includes(KEY), false);
  assert.equal(response.body.includes(TOKEN), false);
});

test("the status endpoint requires the token", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });
  const response = await app.inject({ method: "GET", url: "/api/status" });
  assert.equal(response.statusCode, 401);
});

test("every route endpoint requires the token", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  const calls: Array<[string, string]> = [
    ["GET", "/api/routes"],
    ["POST", "/api/routes"],
    ["GET", "/api/routes/r1"],
    ["PATCH", "/api/routes/r1"],
    ["DELETE", "/api/routes/r1"],
  ];
  for (const [method, url] of calls) {
    const response = await app.inject({
      method: method as "GET",
      url,
      headers: { "content-type": "application/json" },
      payload: {},
    });
    assert.equal(response.statusCode, 401, `${method} ${url} must require auth`);
  }
});
