import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ClientScope } from "@bayz/identity";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createBayzRuntime, type BayzRuntime } from "../src/runtime.js";

const KEY = Buffer.alloc(32, 0x5b).toString("hex");
const TOKEN = "proxy-bulk-api-token-0123456789";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };
const PASSWORD = "hunter2-bulk-never-returned";

function harness(): { app: FastifyInstance; runtime: BayzRuntime } {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-proxy-bulk-")), ".bayz");
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

function keyFor(runtime: BayzRuntime, id: string, scopes: ClientScope[]): string {
  return runtime.identities.createIdentity({ id, displayName: id, scopes }).key;
}

/** Create a proxy directly on the runtime: this suite is about the bulk routes. */
function seedProxy(runtime: BayzRuntime, id: string, enabled = true): void {
  runtime.proxies.createProxy({
    id,
    kind: "socks5",
    host: "127.0.0.1",
    port: 1080,
    enabled,
  });
}

function seedProviders(runtime: BayzRuntime, ids: readonly string[]): void {
  for (const id of ids) {
    runtime.providers.createProvider({
      id,
      kind: "openai-compatible",
      displayName: id,
      baseUrl: `https://${id}.example.com/v1`,
    });
  }
}

async function usageOf(
  app: FastifyInstance,
  proxyId: string,
): Promise<{ providerCount: number; routeCount: number; providerIds: string[] }> {
  const response = await app.inject({
    method: "GET",
    url: `/api/proxies/${proxyId}/usage`,
    headers: AUTH,
  });
  assert.equal(response.statusCode, 200);
  return response.json();
}

test("assign attaches many providers in one atomic call", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  seedProxy(runtime, "tunnel");
  const ids = ["p1", "p2", "p3", "p4"];
  seedProviders(runtime, ids);

  const assigned = await app.inject({
    method: "POST",
    url: "/api/proxies/tunnel/assign",
    headers: JSON_AUTH,
    payload: { providerIds: ids },
  });
  assert.equal(assigned.statusCode, 200);
  const body = assigned.json();
  assert.equal(body.proxyId, "tunnel");
  assert.equal(body.providerCount, 4);
  assert.equal(body.proxyEnabled, true);
  assert.deepEqual(body.notes, []);

  // Read back through the API, not the manager: the point is that the write landed.
  const usage = await usageOf(app, "tunnel");
  assert.equal(usage.providerCount, 4);
  assert.deepEqual(usage.providerIds, ids);
});

test("assign is bounded at 200 ids", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  seedProxy(runtime, "tunnel");
  const ids = Array.from({ length: 201 }, (_, index) => `p${index + 1}`);

  const refused = await app.inject({
    method: "POST",
    url: "/api/proxies/tunnel/assign",
    headers: JSON_AUTH,
    payload: { providerIds: ids },
  });
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.json().error.code, "invalid_provider_config");

  // 200 exactly is accepted, so the bound is inclusive rather than off by one.
  const accepted = ids.slice(0, 200);
  seedProviders(runtime, accepted);
  const ok = await app.inject({
    method: "POST",
    url: "/api/proxies/tunnel/assign",
    headers: JSON_AUTH,
    payload: { providerIds: accepted },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().providerCount, 200);
});

test("one unknown provider fails the whole assignment with no partial write", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  seedProxy(runtime, "tunnel");
  seedProviders(runtime, ["p1", "p2"]);

  const response = await app.inject({
    method: "POST",
    url: "/api/proxies/tunnel/assign",
    headers: JSON_AUTH,
    payload: { providerIds: ["p1", "absent", "p2"] },
  });
  // 400, not 404: on this URL a 404 means the *proxy* is missing, and the operator's
  // remedy here is to fix the body.
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "invalid_request");

  const usage = await usageOf(app, "tunnel");
  assert.equal(usage.providerCount, 0);
  assert.deepEqual(usage.providerIds, []);
});

test("a hostile provider id is refused pre-SQL and nothing is written", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  seedProxy(runtime, "tunnel");
  seedProviders(runtime, ["p1"]);

  for (const hostile of ["p1'; DROP TABLE providers;--", "../../etc", "P1", "", "p-"]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/proxies/tunnel/assign",
      headers: JSON_AUTH,
      payload: { providerIds: ["p1", hostile] },
    });
    assert.equal(response.statusCode, 400, `${hostile} was not refused`);
  }

  const list = await app.inject({ method: "GET", url: "/api/providers", headers: AUTH });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(
    list.json().providers.map((provider: { id: string }) => provider.id),
    ["p1"],
  );
  const usage = await usageOf(app, "tunnel");
  assert.equal(usage.providerCount, 0);
});

test("a duplicated id is deduplicated rather than applied twice", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  seedProxy(runtime, "tunnel");
  seedProviders(runtime, ["p1"]);

  const response = await app.inject({
    method: "POST",
    url: "/api/proxies/tunnel/assign",
    headers: JSON_AUTH,
    payload: { providerIds: ["p1", "p1", "p1"] },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().providerCount, 1);
  assert.deepEqual((await usageOf(app, "tunnel")).providerIds, ["p1"]);
});

test("assigning a disabled proxy is allowed and the response says so", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  seedProxy(runtime, "staged", false);
  seedProviders(runtime, ["p1"]);

  const response = await app.inject({
    method: "POST",
    url: "/api/proxies/staged/assign",
    headers: JSON_AUTH,
    payload: { providerIds: ["p1"] },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.providerCount, 1);
  assert.equal(body.proxyEnabled, false);
  assert.deepEqual(body.notes, ["proxy_disabled"]);
});

test("unassign sets the listed providers to direct", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  seedProxy(runtime, "tunnel");
  seedProviders(runtime, ["p1", "p2", "p3"]);
  await app.inject({
    method: "POST",
    url: "/api/proxies/tunnel/assign",
    headers: JSON_AUTH,
    payload: { providerIds: ["p1", "p2", "p3"] },
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/proxies/tunnel/unassign",
    headers: JSON_AUTH,
    payload: { providerIds: ["p1", "p3"] },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.providerCount, 2);
  // Reported rather than inferred: the operator learns how many of the batch were
  // actually attached to this proxy.
  assert.equal(body.detachedFromProxy, 2);

  const usage = await usageOf(app, "tunnel");
  assert.deepEqual(usage.providerIds, ["p2"]);

  const p1 = await app.inject({ method: "GET", url: "/api/providers/p1", headers: AUTH });
  assert.equal(p1.json().proxyId, undefined);
});

test("unassign reports how many of the batch were on this proxy", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  seedProxy(runtime, "tunnel");
  seedProxy(runtime, "other");
  seedProviders(runtime, ["p1", "p2"]);
  await app.inject({
    method: "POST",
    url: "/api/proxies/tunnel/assign",
    headers: JSON_AUTH,
    payload: { providerIds: ["p1"] },
  });
  await app.inject({
    method: "POST",
    url: "/api/proxies/other/assign",
    headers: JSON_AUTH,
    payload: { providerIds: ["p2"] },
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/proxies/tunnel/unassign",
    headers: JSON_AUTH,
    payload: { providerIds: ["p1", "p2"] },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().providerCount, 2);
  assert.equal(response.json().detachedFromProxy, 1);
  // Both are direct now: the endpoint means "set these to direct", so a mixed
  // selection cannot be half-applied.
  assert.equal((await usageOf(app, "tunnel")).providerCount, 0);
  assert.equal((await usageOf(app, "other")).providerCount, 0);
});

test("an empty or malformed batch is refused", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  seedProxy(runtime, "tunnel");
  seedProviders(runtime, ["p1"]);

  for (const payload of [
    {},
    { providerIds: [] },
    { providerIds: "p1" },
    { providerIds: [1] },
    { providerIds: ["p1"], extra: true },
    { providerIds: [null] },
  ]) {
    for (const action of ["assign", "unassign"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/proxies/tunnel/${action}`,
        headers: JSON_AUTH,
        payload,
      });
      assert.equal(
        response.statusCode,
        400,
        `${action} accepted ${JSON.stringify(payload)}`,
      );
    }
  }
});

test("an unknown proxy is 404 on all three routes", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  seedProviders(runtime, ["p1"]);

  for (const action of ["assign", "unassign"]) {
    const response = await app.inject({
      method: "POST",
      url: `/api/proxies/absent/${action}`,
      headers: JSON_AUTH,
      payload: { providerIds: ["p1"] },
    });
    assert.equal(response.statusCode, 404, action);
    assert.equal(response.json().error.code, "proxy_not_found");
  }

  const usage = await app.inject({
    method: "GET",
    url: "/api/proxies/absent/usage",
    headers: AUTH,
  });
  assert.equal(usage.statusCode, 404);
  assert.equal(usage.json().error.code, "proxy_not_found");
});

test("usage counts providers and routes and leaks no secret", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  seedProxy(runtime, "tunnel");
  runtime.proxies.updateProxy("tunnel", { username: "bayz" });
  runtime.proxies.setPassword("tunnel", PASSWORD);
  seedProviders(runtime, ["p1", "p2"]);
  runtime.providers.setCredential("p1", "sk-bulk-api-credential-never-returned");
  await app.inject({
    method: "POST",
    url: "/api/proxies/tunnel/assign",
    headers: JSON_AUTH,
    payload: { providerIds: ["p1", "p2"] },
  });

  // Two routes pinned to this proxy, one inheriting: only the pinned ones count as
  // route usage, because an inheriting route follows its provider.
  runtime.router.createRoute({
    id: "r1",
    model: "gpt-4o",
    providerId: "p1",
    proxyId: "tunnel",
  });
  runtime.router.createRoute({
    id: "r2",
    model: "gpt-4o-mini",
    providerId: "p2",
    proxyId: "tunnel",
  });
  runtime.router.createRoute({ id: "r3", model: "llama3", providerId: "p1" });

  const response = await app.inject({
    method: "GET",
    url: "/api/proxies/tunnel/usage",
    headers: AUTH,
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    proxyId: "tunnel",
    providerCount: 2,
    routeCount: 2,
    providerIds: ["p1", "p2"],
  });
  assert.equal(response.body.includes(PASSWORD), false);
  assert.equal(response.body.includes("sk-"), false);
  assert.equal(/password|credential|secret/i.test(response.body), false);
});

test("the bulk routes require the right scope", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  seedProxy(runtime, "tunnel");
  seedProviders(runtime, ["p1"]);

  const readKey = keyFor(runtime, "reader", ["proxies.read"]);
  const writeKey = keyFor(runtime, "writer", ["proxies.write"]);
  const chatKey = keyFor(runtime, "chatter", ["chat.completions"]);

  for (const action of ["assign", "unassign"]) {
    const denied = await app.inject({
      method: "POST",
      url: `/api/proxies/tunnel/${action}`,
      headers: { authorization: `Bearer ${readKey}`, "content-type": "application/json" },
      payload: { providerIds: ["p1"] },
    });
    assert.equal(denied.statusCode, 403, `${action} accepted proxies.read`);
    assert.equal(denied.json().error.code, "forbidden");
    assert.ok(denied.json().error.message.includes("proxies.write"));

    const allowed = await app.inject({
      method: "POST",
      url: `/api/proxies/tunnel/${action}`,
      headers: { authorization: `Bearer ${writeKey}`, "content-type": "application/json" },
      payload: { providerIds: ["p1"] },
    });
    assert.equal(allowed.statusCode, 200, `${action} rejected proxies.write`);
  }

  const usageDenied = await app.inject({
    method: "GET",
    url: "/api/proxies/tunnel/usage",
    headers: { authorization: `Bearer ${chatKey}` },
  });
  assert.equal(usageDenied.statusCode, 403);
  assert.ok(usageDenied.json().error.message.includes("proxies.read"));

  const usageAllowed = await app.inject({
    method: "GET",
    url: "/api/proxies/tunnel/usage",
    headers: { authorization: `Bearer ${readKey}` },
  });
  assert.equal(usageAllowed.statusCode, 200);
});
