import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createBayzRuntime, type BayzRuntime } from "../src/runtime.js";

const KEY = Buffer.alloc(32, 0x77).toString("hex");
const TOKEN = "proxies-api-token-0123456789";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };
const PASSWORD = "hunter2-proxy-api-never-returned";

function harness(): { app: FastifyInstance; runtime: BayzRuntime } {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-proxies-api-")), ".bayz");
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

/** A real CONNECT proxy that optionally requires Basic auth. */
async function startConnectProxy(
  expectedAuth?: string,
): Promise<{ port: number; close(): Promise<void>; requests: string[] }> {
  const requests: string[] = [];
  const accepted = new Set<Socket>();
  const server = createServer((socket) => {
    accepted.add(socket);
    socket.on("close", () => accepted.delete(socket));
    socket.on("error", () => {});
    let head = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      head = Buffer.concat([head, Buffer.from(chunk)]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        return;
      }
      const request = head.subarray(0, end).toString("utf8");
      requests.push(request);
      head = Buffer.alloc(0);
      if (expectedAuth !== undefined && !request.includes(expectedAuth)) {
        socket.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
        socket.end();
        return;
      }
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of accepted) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
  };
}

const SOCKS = {
  id: "tor",
  kind: "socks5",
  host: "127.0.0.1",
  port: 1080,
};

test("a proxy can be created, listed, fetched, patched, and deleted", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  const created = await app.inject({
    method: "POST",
    url: "/api/proxies",
    headers: JSON_AUTH,
    payload: SOCKS,
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().id, "tor");
  assert.equal(created.json().passwordPresent, false);

  const list = await app.inject({ method: "GET", url: "/api/proxies", headers: AUTH });
  assert.deepEqual(
    list.json().proxies.map((proxy: { id: string }) => proxy.id),
    ["tor"],
  );

  const patched = await app.inject({
    method: "PATCH",
    url: "/api/proxies/tor",
    headers: JSON_AUTH,
    payload: { port: 9050, enabled: false },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().port, 9050);
  assert.equal(patched.json().enabled, false);

  const deleted = await app.inject({
    method: "DELETE",
    url: "/api/proxies/tor",
    headers: AUTH,
  });
  assert.equal(deleted.statusCode, 204);
  const gone = await app.inject({ method: "GET", url: "/api/proxies/tor", headers: AUTH });
  assert.equal(gone.statusCode, 404);
  assert.equal(gone.json().error.code, "proxy_not_found");
});

test("the password endpoint is write-only with no read path at any shape", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  await app.inject({
    method: "POST",
    url: "/api/proxies",
    headers: JSON_AUTH,
    payload: { ...SOCKS, username: "bayz" },
  });

  const set = await app.inject({
    method: "PUT",
    url: "/api/proxies/tor/password",
    headers: JSON_AUTH,
    payload: { value: PASSWORD },
  });
  assert.equal(set.statusCode, 204);
  assert.equal(set.body, "");

  const fetched = await app.inject({ method: "GET", url: "/api/proxies/tor", headers: AUTH });
  assert.equal(fetched.json().passwordPresent, true);
  assert.equal(fetched.json().username, "bayz");
  assert.equal(fetched.body.includes(PASSWORD), false);

  for (const url of [
    "/api/proxies/tor/password",
    "/api/proxies/tor/password/value",
    "/api/proxies/tor/secret",
  ]) {
    const attempt = await app.inject({ method: "GET", url, headers: AUTH });
    assert.equal(attempt.statusCode, 404, `${url} must not exist`);
    assert.equal(attempt.body.includes(PASSWORD), false);
  }

  const cleared = await app.inject({
    method: "DELETE",
    url: "/api/proxies/tor/password",
    headers: AUTH,
  });
  assert.equal(cleared.statusCode, 204);
  const after = await app.inject({ method: "GET", url: "/api/proxies/tor", headers: AUTH });
  assert.equal(after.json().passwordPresent, false);
});

test("a password without a username is refused", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  await app.inject({ method: "POST", url: "/api/proxies", headers: JSON_AUTH, payload: SOCKS });
  const response = await app.inject({
    method: "PUT",
    url: "/api/proxies/tor/password",
    headers: JSON_AUTH,
    payload: { value: PASSWORD },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "invalid_proxy_config");
});

test("a blank password value is refused", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  await app.inject({
    method: "POST",
    url: "/api/proxies",
    headers: JSON_AUTH,
    payload: { ...SOCKS, username: "bayz" },
  });
  for (const payload of [{ value: "" }, { value: "  " }, { value: 1 }, {}, { v: "x" }]) {
    const response = await app.inject({
      method: "PUT",
      url: "/api/proxies/tor/password",
      headers: JSON_AUTH,
      payload,
    });
    assert.equal(response.statusCode, 400, `must refuse ${JSON.stringify(payload)}`);
  }
});

test("a check runs against a real CONNECT proxy and reports latency", async (t) => {
  const proxy = await startConnectProxy();
  const { app, runtime } = harness();
  t.after(async () => {
    void app.close();
    runtime.close();
    await proxy.close();
  });

  await app.inject({
    method: "POST",
    url: "/api/proxies",
    headers: JSON_AUTH,
    payload: {
      id: "live",
      kind: "http",
      host: "127.0.0.1",
      port: proxy.port,
      config: {
        connectTimeoutMs: 3000,
        healthCheckHost: "api.example.com",
        healthCheckPort: 443,
      },
    },
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/proxies/live/check",
    headers: AUTH,
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(body.kind, "http");
  assert.equal(typeof body.latencyMs, "number");
  assert.ok(proxy.requests[0]?.startsWith("CONNECT api.example.com:443 "));
});

test("a check sends the stored password without exposing it", async (t) => {
  const expected = Buffer.from(`bayz:${PASSWORD}`, "utf8").toString("base64");
  const proxy = await startConnectProxy(expected);
  const { app, runtime } = harness();
  t.after(async () => {
    void app.close();
    runtime.close();
    await proxy.close();
  });

  await app.inject({
    method: "POST",
    url: "/api/proxies",
    headers: JSON_AUTH,
    payload: {
      id: "authed",
      kind: "http",
      host: "127.0.0.1",
      port: proxy.port,
      username: "bayz",
      config: {
        connectTimeoutMs: 3000,
        healthCheckHost: "api.example.com",
        healthCheckPort: 443,
      },
    },
  });
  await app.inject({
    method: "PUT",
    url: "/api/proxies/authed/password",
    headers: JSON_AUTH,
    payload: { value: PASSWORD },
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/proxies/authed/check",
    headers: AUTH,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.includes(PASSWORD), false);
  assert.equal(
    proxy.requests.some((entry) => entry.includes(expected)),
    true,
    "the proxy really received Basic auth",
  );
  assert.equal(
    proxy.requests.some((entry) => entry.includes(PASSWORD)),
    false,
    "the raw password must never appear on the wire",
  );
});

test("a check without a stored password fails closed as 400", async (t) => {
  const proxy = await startConnectProxy();
  const { app, runtime } = harness();
  t.after(async () => {
    void app.close();
    runtime.close();
    await proxy.close();
  });

  await app.inject({
    method: "POST",
    url: "/api/proxies",
    headers: JSON_AUTH,
    payload: {
      id: "needsauth",
      kind: "http",
      host: "127.0.0.1",
      port: proxy.port,
      username: "bayz",
    },
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/proxies/needsauth/check",
    headers: AUTH,
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "password_missing");
});

test("a disabled proxy check reports not implemented for that state", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  await app.inject({
    method: "POST",
    url: "/api/proxies",
    headers: JSON_AUTH,
    payload: { ...SOCKS, enabled: false },
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/proxies/tor/check",
    headers: AUTH,
  });
  assert.equal(response.statusCode, 501);
  assert.equal(response.json().error.code, "unsupported_operation");
});

test("a refused proxy maps to 502 without leaking the peer", async (t) => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const deadPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  await app.inject({
    method: "POST",
    url: "/api/proxies",
    headers: JSON_AUTH,
    payload: {
      id: "dead",
      kind: "http",
      host: "127.0.0.1",
      port: deadPort,
      config: {
        connectTimeoutMs: 2000,
        healthCheckHost: "api.example.com",
        healthCheckPort: 443,
      },
    },
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/proxies/dead/check",
    headers: AUTH,
  });
  assert.equal(response.statusCode, 502);
  assert.equal(response.json().error.code, "refused");
  assert.equal(response.body.includes(String(deadPort)), false);
});

test("invalid proxy bodies and ids are 400 and never reach storage", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  for (const payload of [
    { ...SOCKS, id: "Bad Id" },
    { ...SOCKS, host: "socks5://127.0.0.1" },
    { ...SOCKS, host: "127.0.0.1\r\nX: y" },
    { ...SOCKS, port: 0 },
    { ...SOCKS, port: 65536 },
    { ...SOCKS, kind: "socks4" },
    { ...SOCKS, config: { command: "curl evil.example.com" } },
    { ...SOCKS, username: "" },
    {},
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/proxies",
      headers: JSON_AUTH,
      payload,
    });
    assert.equal(
      response.statusCode,
      400,
      `payload must be refused: ${JSON.stringify(payload).slice(0, 70)}`,
    );
  }
  assert.equal(runtime.proxies.listProxies().length, 0);

  for (const id of ["Upper", "a..b", "a:b"]) {
    const response = await app.inject({
      method: "GET",
      url: `/api/proxies/${id}`,
      headers: AUTH,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "invalid_proxy_id");
  }
});

test("every proxy endpoint requires the token", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  const calls: Array<[string, string]> = [
    ["GET", "/api/proxies"],
    ["POST", "/api/proxies"],
    ["GET", "/api/proxies/tor"],
    ["PATCH", "/api/proxies/tor"],
    ["DELETE", "/api/proxies/tor"],
    ["PUT", "/api/proxies/tor/password"],
    ["DELETE", "/api/proxies/tor/password"],
    ["POST", "/api/proxies/tor/check"],
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
