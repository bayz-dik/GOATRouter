import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { databasePath } from "@bayz/storage";
import { buildApp } from "../src/app.js";
import { createBayzRuntime, type BayzRuntime } from "../src/runtime.js";

/**
 * Adversarial suite for the HTTP surface.
 *
 * The point of these tests is that a *newly added* endpoint cannot quietly break
 * an invariant: routes are enumerated from Fastify's own table rather than from a
 * hand-written list, and every response body from a full exercise is scanned for
 * secrets.
 */

const KEY = Buffer.alloc(32, 0xaa).toString("hex");
const TOKEN = "adversarial-api-token-0123456789";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };
const CREDENTIAL = "sk-adversarial-provider-credential";
const PASSWORD = "hunter2-adversarial-proxy-password";
const PROMPT = "ADVERSARIAL-API-PROMPT-must-never-persist";

type Harness = {
  app: FastifyInstance;
  runtime: BayzRuntime;
  dir: string;
  logs: string[];
};

function harness(): Harness {
  const dir = join(mkdtempSync(join(tmpdir(), "bayz-api-adv-")), ".bayz");
  const logs: string[] = [];
  const runtime = createBayzRuntime(
    { host: "127.0.0.1", port: 20128, dataDir: dir, dashboardRoot: "/nonexistent" },
    {
      env: { BAYZ_MASTER_KEY: KEY, BAYZ_API_TOKEN: TOKEN },
      notify: () => {},
      logger: (payload) => logs.push(JSON.stringify(payload)),
    },
  );
  const app = buildApp({
    logger: false,
    apiToken: TOKEN,
    runtime,
    rateLimit: { max: 100000, authMax: 100000 },
  });
  return { app, runtime, dir, logs };
}

function serverSources(): Array<{ name: string; text: string }> {
  const root = new URL("../src/", import.meta.url);
  const files: Array<{ name: string; text: string }> = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(new URL(relative, root), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(`${relative}${entry.name}/`);
      } else if (entry.name.endsWith(".ts")) {
        files.push({
          name: `${relative}${entry.name}`,
          text: readFileSync(new URL(`${relative}${entry.name}`, root), "utf8"),
        });
      }
    }
  };
  walk("");
  return files;
}

/** Every registered route, taken from Fastify rather than from a fixed list. */
function registeredRoutes(app: FastifyInstance): Array<{ method: string; url: string }> {
  const table = app
    .printRoutes({ commonPrefix: false })
    .split("\n")
    .map((line) => line.trim());
  const found: Array<{ method: string; url: string }> = [];
  for (const line of table) {
    const match = /^[├└│─\s]*(\/\S*)\s+\((.+)\)$/.exec(line);
    if (match === null) {
      continue;
    }
    for (const method of match[2]!.split(",").map((entry) => entry.trim())) {
      found.push({ method, url: match[1]! });
    }
  }
  return found;
}

test("no source file in the server exposes a credential or password getter", () => {
  const sources = serverSources();
  assert.ok(sources.length >= 10, "the scan must actually find the sources");
  for (const source of sources) {
    assert.equal(
      /getCredential|getPassword|revealCredential|revealPassword/.test(source.text),
      false,
      `${source.name} must not contain a secret accessor`,
    );
  }
});

test("no handler returns the API token", () => {
  for (const source of serverSources()) {
    if (source.name === "api-token.ts" || source.name === "runtime.ts") {
      continue;
    }
    assert.equal(
      /apiToken/.test(source.text) && /reply\s*\.\s*send/.test(source.text),
      false,
      `${source.name} must not be able to send the api token`,
    );
  }
});

test("every registered route except health requires the token", async (t) => {
  const h = harness();
  t.after(() => {
    void h.app.close();
    h.runtime.close();
  });
  await h.app.ready();

  const routes = registeredRoutes(h.app);
  assert.ok(routes.length >= 20, `expected the full route table, saw ${routes.length}`);

  for (const route of routes) {
    if (route.method === "HEAD" || route.method === "OPTIONS") {
      continue;
    }
    // Concrete values for parameterized segments; the guard runs before routing
    // anyway, so the value is irrelevant to the assertion.
    const url = route.url.replace(/:[A-Za-z]+/g, "probe").replace(/\*$/, "index.html");
    const bodyless = route.method === "GET" || route.method === "DELETE";
    const response = await h.app.inject({
      method: route.method as "GET",
      url,
      headers: { "content-type": "application/json" },
      ...(bodyless ? {} : { payload: {} }),
    });

    if (url === "/api/health") {
      assert.equal(response.statusCode, 200, "health must stay unauthenticated");
      continue;
    }
    if (!url.startsWith("/api/") && !url.startsWith("/v1/")) {
      // The static dashboard mount is not part of the guarded API surface.
      continue;
    }
    assert.equal(
      response.statusCode,
      401,
      `${route.method} ${url} must require the token (got ${response.statusCode})`,
    );
  }
});

test("no response body in a full exercise contains a stored secret", async (t) => {
  const origin = await new Promise<{ port: number; close(): Promise<void> }>((resolve) => {
    const server = createHttpServer((request, response) => {
      request.on("data", () => {});
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            data: [{ id: "gpt-4o" }],
            choices: [{ message: { role: "assistant", content: "reply" } }],
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      }),
    );
  });

  const h = harness();
  t.after(async () => {
    void h.app.close();
    h.runtime.close();
    await origin.close();
  });

  const bodies: string[] = [];
  const call = async (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    payload?: Record<string, unknown>,
  ): Promise<void> => {
    const response =
      payload === undefined
        ? await h.app.inject({ method, url, headers: JSON_AUTH })
        : await h.app.inject({ method, url, headers: JSON_AUTH, payload });
    bodies.push(response.body);
  };

  await call("POST", "/api/providers", {
    id: "p1",
    kind: "openai-compatible",
    displayName: "P1",
    baseUrl: `http://127.0.0.1:${origin.port}/v1`,
    config: { allowLoopback: true },
  });
  await call("PUT", "/api/providers/p1/credential", { value: CREDENTIAL });
  await call("POST", "/api/proxies", {
    id: "x1",
    kind: "http",
    host: "127.0.0.1",
    port: origin.port,
    username: "bayz",
  });
  await call("PUT", "/api/proxies/x1/password", { value: PASSWORD });
  await call("POST", "/api/routes", { id: "r1", model: "gpt-4o", providerId: "p1" });
  await call("GET", "/api/providers");
  await call("GET", "/api/providers/p1");
  await call("GET", "/api/proxies");
  await call("GET", "/api/proxies/x1");
  await call("GET", "/api/routes");
  await call("GET", "/api/routes/r1");
  await call("GET", "/api/status");
  await call("GET", "/v1/models");
  await call("POST", "/api/providers/p1/discover");
  await call("POST", "/v1/chat/completions", {
    model: "gpt-4o",
    messages: [{ role: "user", content: PROMPT }],
  });

  const combined = bodies.join("\n");
  assert.ok(combined.length > 0);
  for (const secret of [CREDENTIAL, PASSWORD, TOKEN, KEY]) {
    assert.equal(
      combined.includes(secret),
      false,
      `a response body leaked a secret starting ${secret.slice(0, 8)}`,
    );
  }
  // Base64 forms must not appear either.
  assert.equal(
    combined.includes(Buffer.from(`bayz:${PASSWORD}`, "utf8").toString("base64")),
    false,
  );
});

test("no prompt or secret reaches the database or the logs", async (t) => {
  const origin = await new Promise<{ port: number; close(): Promise<void> }>((resolve) => {
    const server = createHttpServer((request, response) => {
      request.on("data", () => {});
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "COMPLETION-ADV" } }],
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      }),
    );
  });

  const h = harness();
  await h.app.inject({
    method: "POST",
    url: "/api/providers",
    headers: JSON_AUTH,
    payload: {
      id: "p1",
      kind: "openai-compatible",
      displayName: "P1",
      baseUrl: `http://127.0.0.1:${origin.port}/v1`,
      config: { allowLoopback: true },
    },
  });
  await h.app.inject({
    method: "PUT",
    url: "/api/providers/p1/credential",
    headers: JSON_AUTH,
    payload: { value: CREDENTIAL },
  });
  await h.app.inject({
    method: "POST",
    url: "/api/routes",
    headers: JSON_AUTH,
    payload: { id: "r1", model: "gpt-4o", providerId: "p1" },
  });
  const chat = await h.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: JSON_AUTH,
    payload: { model: "gpt-4o", messages: [{ role: "user", content: PROMPT }] },
  });
  assert.equal(chat.statusCode, 200);

  void h.app.close();
  h.runtime.close();
  await origin.close();

  let bytes = Buffer.alloc(0);
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      bytes = Buffer.concat([bytes, readFileSync(`${databasePath(h.dir)}${suffix}`)]);
    } catch {
      // Sidecar absent.
    }
  }
  assert.ok(bytes.byteLength > 0, "the scan must read real bytes");
  for (const secret of [PROMPT, "COMPLETION-ADV", CREDENTIAL, TOKEN, KEY]) {
    assert.equal(
      bytes.includes(Buffer.from(secret, "utf8")),
      false,
      `${secret.slice(0, 12)} must not be on disk`,
    );
  }
  const logs = h.logs.join("\n");
  for (const secret of [PROMPT, "COMPLETION-ADV", CREDENTIAL, TOKEN, KEY]) {
    assert.equal(logs.includes(secret), false, `${secret.slice(0, 12)} must not be logged`);
  }
});

test("path traversal and encoded separators in an id are refused", async (t) => {
  const h = harness();
  t.after(() => {
    void h.app.close();
    h.runtime.close();
  });

  for (const id of [
    "..",
    "%2e%2e",
    "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    "a%00b",
    "a%2Fb",
    "UPPER",
  ]) {
    for (const base of ["/api/providers", "/api/proxies", "/api/routes"]) {
      const response = await h.app.inject({
        method: "GET",
        url: `${base}/${id}`,
        headers: AUTH,
      });
      assert.ok(
        response.statusCode === 400 || response.statusCode === 404,
        `${base}/${id} must fail safely (got ${response.statusCode})`,
      );
    }
  }
  assert.equal(h.runtime.providers.listProviders().length, 0);
});

test("a prototype-pollution payload cannot poison the process", async (t) => {
  const h = harness();
  t.after(() => {
    void h.app.close();
    h.runtime.close();
  });

  for (const raw of [
    '{"id":"p1","kind":"openai-compatible","displayName":"P","baseUrl":"http://127.0.0.1:1/v1","__proto__":{"polluted":true}}',
    '{"id":"p1","kind":"openai-compatible","displayName":"P","baseUrl":"http://127.0.0.1:1/v1","constructor":{"prototype":{"polluted":true}}}',
    '{"__proto__":{"enabled":false}}',
  ]) {
    const response = await h.app.inject({
      method: "POST",
      url: "/api/providers",
      headers: JSON_AUTH,
      payload: raw,
    });
    assert.ok(
      response.statusCode === 201 || response.statusCode === 400 || response.statusCode === 409,
      `unexpected status ${response.statusCode}`,
    );
  }
  assert.equal(
    ({} as unknown as Record<string, unknown>).polluted,
    undefined,
    "Object.prototype must be untouched",
  );
});

test("an oversized body is refused before it is parsed", async (t) => {
  const h = harness();
  t.after(() => {
    void h.app.close();
    h.runtime.close();
  });

  const huge = JSON.stringify({
    model: "gpt-4o",
    messages: [{ role: "user", content: "x".repeat(2 * 1024 * 1024) }],
  });
  const response = await h.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: JSON_AUTH,
    payload: huge,
  });
  assert.equal(response.statusCode, 413);
  assert.equal(h.runtime.router.listRoutes().length, 0);
});

test("malformed JSON is a clean 400, not a stack trace", async (t) => {
  const h = harness();
  t.after(() => {
    void h.app.close();
    h.runtime.close();
  });

  const response = await h.app.inject({
    method: "POST",
    url: "/api/providers",
    headers: JSON_AUTH,
    payload: '{"id":"p1",,,}',
  });
  assert.equal(response.statusCode, 400);
  assert.equal(/at .*\.ts:/.test(response.body), false, "no stack may be returned");
});

test("a cross-site POST is refused even with a valid token", async (t) => {
  const h = harness();
  t.after(() => {
    void h.app.close();
    h.runtime.close();
  });

  const response = await h.app.inject({
    method: "POST",
    url: "/api/providers",
    headers: {
      ...JSON_AUTH,
      origin: "https://evil.example.com",
    },
    payload: {
      id: "csrf",
      kind: "openai-compatible",
      displayName: "CSRF",
      baseUrl: "http://127.0.0.1:1/v1",
      config: { allowLoopback: true },
    },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(h.runtime.providers.listProviders().length, 0);
});

test("a rebinding Host is refused on every API path", async (t) => {
  const h = harness();
  t.after(() => {
    void h.app.close();
    h.runtime.close();
  });

  for (const url of ["/api/status", "/api/providers", "/v1/models", "/api/health"]) {
    const response = await h.app.inject({
      method: "GET",
      url,
      headers: { ...AUTH, host: "bayz.attacker.test" },
    });
    assert.equal(response.statusCode, 403, `${url} must refuse a foreign Host`);
  }
});

test("one provider's credential is never used for another provider", async (t) => {
  const seen: Array<string | undefined> = [];
  const origin = await new Promise<{ port: number; close(): Promise<void> }>((resolve) => {
    const server = createHttpServer((request, response) => {
      seen.push(request.headers.authorization);
      request.on("data", () => {});
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "m" }] }));
      });
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      }),
    );
  });

  const h = harness();
  t.after(async () => {
    void h.app.close();
    h.runtime.close();
    await origin.close();
  });

  for (const id of ["with-key", "no-key"]) {
    await h.app.inject({
      method: "POST",
      url: "/api/providers",
      headers: JSON_AUTH,
      payload: {
        id,
        kind: "openai-compatible",
        displayName: id,
        baseUrl: `http://127.0.0.1:${origin.port}/v1`,
        config: { allowLoopback: true },
      },
    });
  }
  await h.app.inject({
    method: "PUT",
    url: "/api/providers/with-key/credential",
    headers: JSON_AUTH,
    payload: { value: CREDENTIAL },
  });

  await h.app.inject({
    method: "POST",
    url: "/api/providers/with-key/discover",
    headers: AUTH,
  });
  await h.app.inject({
    method: "POST",
    url: "/api/providers/no-key/discover",
    headers: AUTH,
  });

  assert.equal(seen[0], `Bearer ${CREDENTIAL}`);
  assert.equal(seen[1], undefined, "the second provider must be unauthenticated");
});
