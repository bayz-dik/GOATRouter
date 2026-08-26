import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createBayzRuntime, type BayzRuntime } from "../src/runtime.js";

const KEY = Buffer.alloc(32, 0x66).toString("hex");
const TOKEN = "providers-api-token-0123456789";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };
const CREDENTIAL = "sk-provider-api-secret-never-returned";

function harness(): { app: FastifyInstance; runtime: BayzRuntime } {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-providers-api-")), ".bayz");
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

async function startUpstream(
  body: unknown,
  status = 200,
): Promise<{ port: number; close(): Promise<void>; seen: Array<string | undefined> }> {
  const seen: Array<string | undefined> = [];
  const server = createHttpServer((request, response) => {
    seen.push(request.headers.authorization);
    request.on("data", () => {});
    request.on("end", () => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

const LOCAL = {
  id: "local",
  kind: "openai-compatible",
  displayName: "Local Llama",
  baseUrl: "http://127.0.0.1:11434/v1",
};

test("a provider can be created and listed through the API", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  const created = await app.inject({
    method: "POST",
    url: "/api/providers",
    headers: JSON_AUTH,
    payload: LOCAL,
  });
  assert.equal(created.statusCode, 201);
  const body = created.json();
  assert.equal(body.id, "local");
  assert.equal(body.credentialPresent, false);
  assert.equal(body.baseUrl, "http://127.0.0.1:11434/v1");

  const list = await app.inject({ method: "GET", url: "/api/providers", headers: AUTH });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(
    list.json().providers.map((provider: { id: string }) => provider.id),
    ["local"],
  );
});

test("a provider can be fetched, patched, and deleted", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  await app.inject({ method: "POST", url: "/api/providers", headers: JSON_AUTH, payload: LOCAL });

  const fetched = await app.inject({
    method: "GET",
    url: "/api/providers/local",
    headers: AUTH,
  });
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.json().displayName, "Local Llama");

  const patched = await app.inject({
    method: "PATCH",
    url: "/api/providers/local",
    headers: JSON_AUTH,
    payload: { enabled: false, displayName: "Renamed" },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().enabled, false);
  assert.equal(patched.json().displayName, "Renamed");

  const deleted = await app.inject({
    method: "DELETE",
    url: "/api/providers/local",
    headers: AUTH,
  });
  assert.equal(deleted.statusCode, 204);
  assert.equal(deleted.body, "");

  const gone = await app.inject({ method: "GET", url: "/api/providers/local", headers: AUTH });
  assert.equal(gone.statusCode, 404);
  assert.equal(gone.json().error.code, "provider_not_found");
});

test("the credential endpoint is write-only and reports presence only", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  await app.inject({ method: "POST", url: "/api/providers", headers: JSON_AUTH, payload: LOCAL });

  const set = await app.inject({
    method: "PUT",
    url: "/api/providers/local/credential",
    headers: JSON_AUTH,
    payload: { value: CREDENTIAL },
  });
  assert.equal(set.statusCode, 204);
  assert.equal(set.body, "", "a write must not echo the value");

  const fetched = await app.inject({
    method: "GET",
    url: "/api/providers/local",
    headers: AUTH,
  });
  assert.equal(fetched.json().credentialPresent, true);
  assert.equal(fetched.body.includes(CREDENTIAL), false);

  // There is no GET for a credential, at any path shape.
  for (const url of [
    "/api/providers/local/credential",
    "/api/providers/local/credential/value",
    "/api/providers/local/api_key",
  ]) {
    const attempt = await app.inject({ method: "GET", url, headers: AUTH });
    assert.equal(attempt.statusCode, 404, `${url} must not exist`);
    assert.equal(attempt.body.includes(CREDENTIAL), false);
  }

  const cleared = await app.inject({
    method: "DELETE",
    url: "/api/providers/local/credential",
    headers: AUTH,
  });
  assert.equal(cleared.statusCode, 204);
  const after = await app.inject({
    method: "GET",
    url: "/api/providers/local",
    headers: AUTH,
  });
  assert.equal(after.json().credentialPresent, false);
});

test("a blank credential value is refused", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  await app.inject({ method: "POST", url: "/api/providers", headers: JSON_AUTH, payload: LOCAL });
  for (const payload of [{ value: "" }, { value: "   " }, { value: 42 }, {}, { other: "x" }]) {
    const response = await app.inject({
      method: "PUT",
      url: "/api/providers/local/credential",
      headers: JSON_AUTH,
      payload,
    });
    assert.equal(
      response.statusCode,
      400,
      `payload must be refused: ${JSON.stringify(payload)}`,
    );
  }
});

test("discovery runs against a real upstream and forwards the credential", async (t) => {
  const upstream = await startUpstream({ data: [{ id: "llama3" }, { id: "mistral" }] });
  const { app, runtime } = harness();
  t.after(async () => {
    void app.close();
    runtime.close();
    await upstream.close();
  });

  await app.inject({
    method: "POST",
    url: "/api/providers",
    headers: JSON_AUTH,
    payload: { ...LOCAL, baseUrl: `http://127.0.0.1:${upstream.port}/v1` },
  });
  await app.inject({
    method: "PUT",
    url: "/api/providers/local/credential",
    headers: JSON_AUTH,
    payload: { value: CREDENTIAL },
  });

  const discovered = await app.inject({
    method: "POST",
    url: "/api/providers/local/discover",
    headers: AUTH,
  });
  assert.equal(discovered.statusCode, 200);
  assert.deepEqual(discovered.json(), { models: ["llama3", "mistral"] });
  assert.equal(upstream.seen[0], `Bearer ${CREDENTIAL}`);
  assert.equal(discovered.body.includes(CREDENTIAL), false);
});

test("an upstream auth failure maps to 502 without echoing the body", async (t) => {
  const upstream = await startUpstream({ error: CREDENTIAL }, 401);
  const { app, runtime } = harness();
  t.after(async () => {
    void app.close();
    runtime.close();
    await upstream.close();
  });

  await app.inject({
    method: "POST",
    url: "/api/providers",
    headers: JSON_AUTH,
    payload: { ...LOCAL, baseUrl: `http://127.0.0.1:${upstream.port}/v1` },
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/providers/local/discover",
    headers: AUTH,
  });
  assert.equal(response.statusCode, 502);
  assert.equal(response.json().error.code, "auth_failed");
  assert.equal(response.body.includes(CREDENTIAL), false);
});

test("codex-oauth credential storage reports not implemented", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  await app.inject({
    method: "POST",
    url: "/api/providers",
    headers: JSON_AUTH,
    payload: {
      id: "codex",
      kind: "codex-oauth",
      displayName: "Codex",
      baseUrl: "https://chatgpt.com/backend-api",
    },
  });
  const response = await app.inject({
    method: "PUT",
    url: "/api/providers/codex/credential",
    headers: JSON_AUTH,
    payload: { value: "token-value-here" },
  });
  assert.equal(response.statusCode, 501);
  assert.equal(response.json().error.code, "unsupported_operation");
});

test("a duplicate id is 409 and an unknown id is 404", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  await app.inject({ method: "POST", url: "/api/providers", headers: JSON_AUTH, payload: LOCAL });
  const duplicate = await app.inject({
    method: "POST",
    url: "/api/providers",
    headers: JSON_AUTH,
    payload: LOCAL,
  });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.json().error.code, "provider_already_exists");

  // A missing id reads as 404, while DELETE is idempotent and reports 204
  // either way so a caller cannot enumerate ids through delete responses.
  for (const method of ["GET", "PATCH"] as const) {
    const response = await app.inject({
      method,
      url: "/api/providers/ghost",
      headers: JSON_AUTH,
      ...(method === "PATCH" ? { payload: { enabled: false } } : {}),
    });
    assert.equal(response.statusCode, 404, `${method} on a missing id must be 404`);
    assert.equal(response.json().error.code, "provider_not_found");
  }
  const removed = await app.inject({
    method: "DELETE",
    url: "/api/providers/ghost",
    headers: AUTH,
  });
  assert.equal(removed.statusCode, 204);
});

test("invalid bodies and ids are 400 and never reach storage", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  for (const payload of [
    { ...LOCAL, id: "Bad Id" },
    { ...LOCAL, id: "a'; DROP TABLE providers; --" },
    { ...LOCAL, baseUrl: "ftp://example.com" },
    { ...LOCAL, baseUrl: "https://user:pw@example.com" },
    { ...LOCAL, kind: "anthropic" },
    { ...LOCAL, config: { headers: { Authorization: "Bearer sk-attacker" } } },
    { ...LOCAL, displayName: "" },
    { id: "only-id" },
    {},
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/providers",
      headers: JSON_AUTH,
      payload,
    });
    assert.equal(
      response.statusCode,
      400,
      `payload must be refused: ${JSON.stringify(payload).slice(0, 70)}`,
    );
  }
  assert.equal(runtime.providers.listProviders().length, 0);
});

test("a traversal id in the path is rejected without touching storage", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  for (const id of ["Upper", "has%20space", "a..b", "a:b"]) {
    const response = await app.inject({
      method: "GET",
      url: `/api/providers/${id}`,
      headers: AUTH,
    });
    assert.equal(response.statusCode, 400, `id must be refused: ${id}`);
    assert.equal(response.json().error.code, "invalid_provider_id");
  }
});

test("a non-JSON content type is refused", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/providers",
    headers: { ...AUTH, "content-type": "text/plain" },
    payload: "id=local",
  });
  assert.equal(response.statusCode, 415);
});

test("every provider endpoint requires the token", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  const calls: Array<[string, string]> = [
    ["GET", "/api/providers"],
    ["POST", "/api/providers"],
    ["GET", "/api/providers/local"],
    ["PATCH", "/api/providers/local"],
    ["DELETE", "/api/providers/local"],
    ["PUT", "/api/providers/local/credential"],
    ["DELETE", "/api/providers/local/credential"],
    ["POST", "/api/providers/local/discover"],
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
