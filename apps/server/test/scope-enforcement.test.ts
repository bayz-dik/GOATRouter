import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CLIENT_SCOPES, type ClientScope } from "@bayz/identity";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createBayzRuntime, type BayzRuntime } from "../src/runtime.js";

const KEY = Buffer.alloc(32, 0xa4).toString("hex");
const TOKEN = "scope-enforcement-token-0123456789";

function harness(): { app: FastifyInstance; runtime: BayzRuntime } {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-scope-enforce-")), ".bayz");
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

/** Methods that carry no request body, so declaring one would be rejected. */
function bodyless(method: string): boolean {
  return method === "GET" || method === "DELETE" || method === "HEAD";
}

/**
 * Every registered route, reconstructed from Fastify's own table.
 *
 * `printRoutes` emits a *tree* whose child lines carry only their path segment, so
 * a naive per-line regex reports `/:id` and `/credential` as top-level routes and
 * silently under-reports the real surface. Indentation is the parent link: each
 * level is four columns, so the column where a path starts identifies its depth and
 * a stack of prefixes rebuilds the full URL.
 */
async function routeTable(
  app: FastifyInstance,
): Promise<Array<{ method: string; url: string }>> {
  await app.ready();
  const printed = app.printRoutes({ commonPrefix: false });
  const found: Array<{ method: string; url: string }> = [];
  const prefixes = new Map<number, string>();

  for (const line of printed.split("\n")) {
    const match = /^([^/]*)(\/\S*)\s+\(([^)]+)\)\s*$/.exec(line);
    if (match === null) {
      continue;
    }
    const column = match[1]!.length;
    const segment = match[2]!;
    let parent = "";
    for (const [depth, value] of [...prefixes.entries()].sort((a, b) => a[0] - b[0])) {
      if (depth < column) {
        parent = value;
      }
    }
    const url = `${parent}${segment}`;
    prefixes.set(column, url);
    // Anything deeper than this line belongs to a different branch now.
    for (const depth of [...prefixes.keys()]) {
      if (depth > column) {
        prefixes.delete(depth);
      }
    }
    for (const method of match[3]!.split(",").map((entry) => entry.trim())) {
      found.push({ method, url });
    }
  }
  return found;
}

const MANAGEMENT_ROUTES: Array<{ method: string; url: string; scope: ClientScope }> = [
  { method: "GET", url: "/api/status", scope: "providers.read" },
  { method: "GET", url: "/api/providers", scope: "providers.read" },
  { method: "POST", url: "/api/providers", scope: "providers.write" },
  { method: "GET", url: "/api/providers/p1", scope: "providers.read" },
  { method: "PATCH", url: "/api/providers/p1", scope: "providers.write" },
  { method: "DELETE", url: "/api/providers/p1", scope: "providers.write" },
  { method: "PUT", url: "/api/providers/p1/credential", scope: "providers.write" },
  { method: "DELETE", url: "/api/providers/p1/credential", scope: "providers.write" },
  { method: "POST", url: "/api/providers/p1/discover", scope: "providers.write" },
  { method: "GET", url: "/api/proxies", scope: "proxies.read" },
  { method: "POST", url: "/api/proxies", scope: "proxies.write" },
  { method: "GET", url: "/api/proxies/x1", scope: "proxies.read" },
  { method: "PATCH", url: "/api/proxies/x1", scope: "proxies.write" },
  { method: "DELETE", url: "/api/proxies/x1", scope: "proxies.write" },
  { method: "PUT", url: "/api/proxies/x1/password", scope: "proxies.write" },
  { method: "DELETE", url: "/api/proxies/x1/password", scope: "proxies.write" },
  { method: "POST", url: "/api/proxies/x1/check", scope: "proxies.write" },
  { method: "GET", url: "/api/routes", scope: "routes.read" },
  { method: "POST", url: "/api/routes", scope: "routes.write" },
  { method: "GET", url: "/api/routes/r1", scope: "routes.read" },
  { method: "PATCH", url: "/api/routes/r1", scope: "routes.write" },
  { method: "DELETE", url: "/api/routes/r1", scope: "routes.write" },
  { method: "GET", url: "/api/usage/summary", scope: "usage.read" },
  { method: "GET", url: "/api/usage/requests", scope: "usage.read" },
  { method: "GET", url: "/api/usage/providers", scope: "usage.read" },
  { method: "DELETE", url: "/api/usage/requests", scope: "admin" },
  // Identity management mints credentials and grants scopes, so every route is
  // admin-only without exception. A lesser scope here would be an escalation path.
  { method: "GET", url: "/api/identities", scope: "admin" },
  { method: "POST", url: "/api/identities", scope: "admin" },
  { method: "GET", url: "/api/identities/i1", scope: "admin" },
  { method: "PATCH", url: "/api/identities/i1", scope: "admin" },
  { method: "DELETE", url: "/api/identities/i1", scope: "admin" },
  { method: "POST", url: "/api/identities/i1/rotate", scope: "admin" },
  { method: "GET", url: "/api/identities/audit", scope: "admin" },
];

test("every registered API route is covered by this suite", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const registered = (await routeTable(app)).filter(
    (route) =>
      (route.url.startsWith("/api/") || route.url.startsWith("/v1/")) &&
      route.method !== "HEAD" &&
      route.method !== "OPTIONS",
  );

  // The enumeration is the point: a route added later without a scope decision
  // fails here rather than shipping unguarded. `/api/health` is the one deliberate
  // anonymous exception and `/v1/*` is covered by its own cases below.
  const covered = new Set([
    "GET /api/health",
    "POST /v1/chat/completions",
    "GET /v1/models",
    ...MANAGEMENT_ROUTES.map(
      (route) => `${route.method} ${route.url.replace(/\b(p1|x1|r1|i1)\b/g, ":id")}`,
    ),
  ]);
  const uncovered = registered
    .map((route) => `${route.method} ${route.url}`)
    .filter((label) => !covered.has(label));

  assert.deepEqual(uncovered, [], `uncovered routes: ${uncovered.join(", ")}`);
  // 30 = 26 management + chat + models + health + the health HEAD Fastify adds.
  // Pinned as a floor so a route quietly disappearing is visible too.
  assert.ok(registered.length >= 26, `only ${registered.length} routes found`);
  assert.equal(
    registered.filter((route) => route.url.startsWith("/api/")).length,
    34,
    "the management surface changed size without a scope decision",
  );
});

test("a chat-scope identity is forbidden on every management route", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const key = keyFor(runtime, "chat-client", ["chat.completions"]);
  for (const route of MANAGEMENT_ROUTES) {
    const response = await app.inject({
      method: route.method as "GET",
      url: route.url,
      // No content-type on a bodyless method: the content-type guard rejects a
      // declared JSON body that never arrives, which would mask the 403 as a 400.
      headers: bodyless(route.method)
        ? { authorization: `Bearer ${key}` }
        : { authorization: `Bearer ${key}`, "content-type": "application/json" },
      ...(bodyless(route.method) ? {} : { payload: {} }),
    });
    assert.equal(
      response.statusCode,
      403,
      `${route.method} ${route.url} returned ${response.statusCode}`,
    );
    const body = response.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, "forbidden");
    assert.ok(
      body.error.message.includes(route.scope),
      `${route.method} ${route.url} did not name the missing scope`,
    );
  }
});

test("each management route accepts exactly its declared scope", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  for (const [index, route] of MANAGEMENT_ROUTES.entries()) {
    const key = keyFor(runtime, `scoped-${index}`, [route.scope]);
    const response = await app.inject({
      method: route.method as "GET",
      url: route.url,
      headers: bodyless(route.method)
        ? { authorization: `Bearer ${key}` }
        : { authorization: `Bearer ${key}`, "content-type": "application/json" },
      ...(bodyless(route.method) ? {} : { payload: {} }),
    });
    // Anything but 403 proves the scope was accepted. The specific status depends on
    // whether the resource exists and whether the body validates, which is not what
    // this test is about.
    assert.notEqual(
      response.statusCode,
      403,
      `${route.method} ${route.url} rejected its own scope ${route.scope}`,
    );
  }
});

test("a read scope cannot write and a write scope cannot read", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const readKey = keyFor(runtime, "reader", ["providers.read"]);
  const writeKey = keyFor(runtime, "writer", ["providers.write"]);

  const write = await app.inject({
    method: "POST",
    url: "/api/providers",
    headers: { authorization: `Bearer ${readKey}`, "content-type": "application/json" },
    payload: { id: "p2", kind: "openai-compatible", displayName: "P2", baseUrl: "http://127.0.0.1:1" },
  });
  assert.equal(write.statusCode, 403);

  // No implication in either direction. `providers.write` granted for a create form
  // must not silently also grant enumeration of every configured provider.
  const read = await app.inject({
    method: "GET",
    url: "/api/providers",
    headers: { authorization: `Bearer ${writeKey}` },
  });
  assert.equal(read.statusCode, 403);
});

test("usage.read cannot purge the usage history", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const key = keyFor(runtime, "usage-reader", ["usage.read"]);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/api/usage/requests",
        headers: { authorization: `Bearer ${key}` },
      })
    ).statusCode,
    200,
  );
  // Purging is destruction of an operator's audit trail, not a read.
  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: "/api/usage/requests",
        headers: { authorization: `Bearer ${key}` },
      })
    ).statusCode,
    403,
  );
});

test("admin satisfies every route", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const key = keyFor(runtime, "admin-client", ["admin"]);
  for (const route of MANAGEMENT_ROUTES) {
    const response = await app.inject({
      method: route.method as "GET",
      url: route.url,
      headers: bodyless(route.method)
        ? { authorization: `Bearer ${key}` }
        : { authorization: `Bearer ${key}`, "content-type": "application/json" },
      ...(bodyless(route.method) ? {} : { payload: {} }),
    });
    assert.notEqual(
      response.statusCode,
      403,
      `admin was refused ${route.method} ${route.url}`,
    );
  }
});

test("a 403 body names the missing scope and nothing about what exists", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  // Seed real configuration so a leak would have something to leak.
  runtime.providers.createProvider({
    id: "secret-provider",
    kind: "openai-compatible",
    displayName: "Confidential Name",
    baseUrl: "http://127.0.0.1:1",
  });
  runtime.providers.setCredential("secret-provider", "sk-scope-enforcement-secret");

  const key = keyFor(runtime, "nosy", ["chat.completions"]);
  const response = await app.inject({
    method: "GET",
    url: "/api/providers",
    headers: { authorization: `Bearer ${key}` },
  });
  assert.equal(response.statusCode, 403);
  const raw = response.body;
  assert.ok(raw.includes("providers.read"));
  assert.ok(!raw.includes("secret-provider"));
  assert.ok(!raw.includes("Confidential Name"));
  assert.ok(!raw.includes("sk-scope-enforcement-secret"));
  assert.ok(!raw.includes(KEY));
});

test("a credential read attempt is 404, and a write attempt is 403", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const key = keyFor(runtime, "credential-hunter", ["chat.completions"]);

  // There is no GET on this path, so Fastify answers 404 on method mismatch. That
  // is the right answer: confirming a path exists is itself information.
  const read = await app.inject({
    method: "GET",
    url: "/api/providers/p1/credential",
    headers: { authorization: `Bearer ${key}` },
  });
  assert.equal(read.statusCode, 404);

  // The routes that do exist are the ones an attacker would actually reach, so they
  // are asserted too.
  for (const method of ["PUT", "DELETE"] as const) {
    const response = await app.inject({
      method,
      url: "/api/providers/p1/credential",
      headers:
        method === "PUT"
          ? { authorization: `Bearer ${key}`, "content-type": "application/json" }
          : { authorization: `Bearer ${key}` },
      ...(method === "PUT" ? { payload: { value: "sk-attempt" } } : {}),
    });
    assert.equal(response.statusCode, 403, `${method} credential returned ${response.statusCode}`);
  }
});

test("no route requires a scope outside the declared vocabulary", () => {
  for (const route of MANAGEMENT_ROUTES) {
    assert.ok(
      (CLIENT_SCOPES as readonly string[]).includes(route.scope),
      `${route.url} requires unknown scope ${route.scope}`,
    );
  }
});

test("chat and models each require their own scope", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const chatKey = keyFor(runtime, "chat-scoped", ["chat.completions"]);
  const modelsKey = keyFor(runtime, "models-scoped", ["models.read"]);

  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: { authorization: `Bearer ${chatKey}` },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: { authorization: `Bearer ${modelsKey}` },
      })
    ).statusCode,
    200,
  );

  const chatDenied = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${modelsKey}`, "content-type": "application/json" },
    payload: { model: "m", messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(chatDenied.statusCode, 403);
});
