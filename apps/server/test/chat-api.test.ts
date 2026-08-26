import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, connect, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createBayzRuntime, type BayzRuntime } from "../src/runtime.js";

const KEY = Buffer.alloc(32, 0x99).toString("hex");
const TOKEN = "chat-api-token-0123456789";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };
const PROMPT = "CHAT-API-PROMPT-must-never-be-logged";
const CREDENTIAL = "sk-chat-api-credential";

const logLines: string[] = [];

function harness(): { app: FastifyInstance; runtime: BayzRuntime } {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-chat-api-")), ".bayz");
  const capture = (payload: Record<string, unknown>): void => {
    logLines.push(JSON.stringify(payload));
  };
  const runtime = createBayzRuntime(
    { host: "127.0.0.1", port: 20128, dataDir, dashboardRoot: "/nonexistent" },
    {
      env: { BAYZ_MASTER_KEY: KEY, BAYZ_API_TOKEN: TOKEN },
      notify: () => {},
      logger: capture,
    },
  );
  const app = buildApp({
    logger: false,
    apiToken: TOKEN,
    runtime,
    rateLimit: { max: 100000, authMax: 100000 },
  });
  return { app, runtime };
}

async function startOrigin(
  script: Array<{ status: number; body: unknown }>,
): Promise<{ port: number; close(): Promise<void>; seen: string[] }> {
  const seen: string[] = [];
  let index = 0;
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      seen.push(Buffer.concat(chunks).toString("utf8"));
      const step = script[Math.min(index, script.length - 1)]!;
      index += 1;
      response.writeHead(step.status, { "content-type": "application/json" });
      response.end(JSON.stringify(step.body));
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

async function startConnectProxy(
  originPort: number,
): Promise<{ port: number; connects: string[]; close(): Promise<void> }> {
  const connects: string[] = [];
  const accepted = new Set<Socket>();
  const server = createServer((client) => {
    accepted.add(client);
    client.on("close", () => accepted.delete(client));
    client.on("error", () => {});
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, Buffer.from(chunk)]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        return;
      }
      client.off("data", onData);
      connects.push(head.subarray(0, end).toString("utf8"));
      const rest = head.subarray(end + 4);
      const upstream = connect({ host: "127.0.0.1", port: originPort }, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length > 0) {
          upstream.write(rest);
        }
        client.pipe(upstream);
        upstream.pipe(client);
      });
      accepted.add(upstream);
      upstream.on("error", () => client.destroy());
    };
    client.on("data", onData);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    connects,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of accepted) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
  };
}

function completion(content: string): unknown {
  return {
    id: "chatcmpl-api",
    model: "gpt-4o",
    choices: [
      { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 },
  };
}

const REQUEST = {
  model: "gpt-4o",
  messages: [{ role: "user", content: PROMPT }],
};

async function seed(
  app: FastifyInstance,
  originPort: number,
  options: { credential?: boolean; proxyId?: string } = {},
): Promise<void> {
  await app.inject({
    method: "POST",
    url: "/api/providers",
    headers: JSON_AUTH,
    payload: {
      id: "p1",
      kind: "openai-compatible",
      displayName: "P1",
      baseUrl: `http://127.0.0.1:${originPort}/v1`,
    },
  });
  if (options.credential) {
    await app.inject({
      method: "PUT",
      url: "/api/providers/p1/credential",
      headers: JSON_AUTH,
      payload: { value: CREDENTIAL },
    });
  }
  await app.inject({
    method: "POST",
    url: "/api/routes",
    headers: JSON_AUTH,
    payload: {
      id: "r1",
      model: "gpt-4o",
      providerId: "p1",
      ...(options.proxyId === undefined ? {} : { proxyId: options.proxyId }),
    },
  });
}

test("a chat completion returns the OpenAI response shape", async (t) => {
  const origin = await startOrigin([{ status: 200, body: completion("Hello from Bayz") }]);
  const { app, runtime } = harness();
  t.after(async () => {
    void app.close();
    runtime.close();
    await origin.close();
  });
  await seed(app, origin.port, { credential: true });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: JSON_AUTH,
    payload: REQUEST,
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "gpt-4o");
  assert.equal(body.choices[0].index, 0);
  assert.equal(body.choices[0].message.role, "assistant");
  assert.equal(body.choices[0].message.content, "Hello from Bayz");
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.deepEqual(body.usage, {
    prompt_tokens: 6,
    completion_tokens: 3,
    total_tokens: 9,
  });
  assert.match(String(body.id), /^chatcmpl-/);
  assert.equal(typeof body.created, "number");

  // Routing metadata is reported in a header, not smuggled into the OpenAI body.
  assert.equal(response.headers["x-bayz-route"], "r1");
  assert.equal(response.headers["x-bayz-provider"], "p1");
  assert.equal(response.body.includes(CREDENTIAL), false);
});

test("the upstream really received the prompt and the credential", async (t) => {
  const origin = await startOrigin([{ status: 200, body: completion("ok") }]);
  const { app, runtime } = harness();
  t.after(async () => {
    void app.close();
    runtime.close();
    await origin.close();
  });
  await seed(app, origin.port, { credential: true });

  await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: JSON_AUTH,
    payload: REQUEST,
  });
  const sent = JSON.parse(origin.seen[0] ?? "{}");
  assert.equal(sent.model, "gpt-4o");
  assert.equal(sent.messages[0].content, PROMPT);
  assert.equal("stream" in sent, false, "streaming must never be requested upstream");
});

test("a proxy-bound route traverses the proxy for a chat request", async (t) => {
  const origin = await startOrigin([{ status: 200, body: completion("via proxy") }]);
  const proxy = await startConnectProxy(origin.port);
  const { app, runtime } = harness();
  t.after(async () => {
    void app.close();
    runtime.close();
    await proxy.close();
    await origin.close();
  });

  await app.inject({
    method: "POST",
    url: "/api/proxies",
    headers: JSON_AUTH,
    payload: {
      id: "tunnel",
      kind: "http",
      host: "127.0.0.1",
      port: proxy.port,
      config: {
        connectTimeoutMs: 3000,
        healthCheckHost: "127.0.0.1",
        healthCheckPort: origin.port,
      },
    },
  });
  await seed(app, origin.port, { credential: true, proxyId: "tunnel" });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: JSON_AUTH,
    payload: REQUEST,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().choices[0].message.content, "via proxy");
  assert.equal(response.headers["x-bayz-proxy"], "tunnel");
  assert.equal(proxy.connects.length, 1, "the proxy must have opened a tunnel");
  assert.equal(
    proxy.connects.some((entry) => entry.includes(CREDENTIAL)),
    false,
  );
});

test("streaming is explicitly rejected rather than silently ignored", async (t) => {
  const origin = await startOrigin([{ status: 200, body: completion("unused") }]);
  const { app, runtime } = harness();
  t.after(async () => {
    void app.close();
    runtime.close();
    await origin.close();
  });
  await seed(app, origin.port);

  for (const stream of [true, false]) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: JSON_AUTH,
      payload: { ...REQUEST, stream },
    });
    assert.equal(response.statusCode, 400, `stream: ${stream} must be refused`);
    assert.equal(response.json().error.code, "streaming_unsupported");
    assert.match(response.json().error.message, /stream/i);
  }
  assert.equal(origin.seen.length, 0, "no upstream call may be made");
});

test("an unbound model is 400 no_route", async (t) => {
  const origin = await startOrigin([{ status: 200, body: completion("unused") }]);
  const { app, runtime } = harness();
  t.after(async () => {
    void app.close();
    runtime.close();
    await origin.close();
  });
  await seed(app, origin.port);

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: JSON_AUTH,
    payload: { ...REQUEST, model: "claude-3.5-sonnet" },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "no_route");
  assert.equal(origin.seen.length, 0);
});

test("an invalid chat body is 400 and never reaches an upstream", async (t) => {
  const origin = await startOrigin([{ status: 200, body: completion("unused") }]);
  const { app, runtime } = harness();
  t.after(async () => {
    void app.close();
    runtime.close();
    await origin.close();
  });
  await seed(app, origin.port);

  for (const payload of [
    {},
    { model: "gpt-4o" },
    { model: "gpt-4o", messages: [] },
    { model: "gpt-4o", messages: [{ role: "root", content: "x" }] },
    { model: "../../etc/passwd", messages: REQUEST.messages },
    { model: "gpt-4o", messages: REQUEST.messages, temperature: 5 },
    { model: "gpt-4o", messages: REQUEST.messages, n: 4 },
    { model: "gpt-4o", messages: REQUEST.messages, tools: [] },
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: JSON_AUTH,
      payload,
    });
    assert.equal(
      response.statusCode,
      400,
      `payload must be refused: ${JSON.stringify(payload).slice(0, 70)}`,
    );
  }
  assert.equal(origin.seen.length, 0);
});

test("an upstream auth failure is 502 with no body echo", async (t) => {
  const origin = await startOrigin([{ status: 401, body: { error: CREDENTIAL } }]);
  const { app, runtime } = harness();
  t.after(async () => {
    void app.close();
    runtime.close();
    await origin.close();
  });
  await seed(app, origin.port, { credential: true });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: JSON_AUTH,
    payload: REQUEST,
  });
  assert.equal(response.statusCode, 502);
  assert.equal(response.json().error.code, "auth_failed");
  assert.equal(response.body.includes(CREDENTIAL), false);
});

test("an upstream rate limit surfaces as 429", async (t) => {
  const origin = await startOrigin([{ status: 429, body: { error: "slow down" } }]);
  const { app, runtime } = harness();
  t.after(async () => {
    void app.close();
    runtime.close();
    await origin.close();
  });
  await seed(app, origin.port);

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: JSON_AUTH,
    payload: REQUEST,
  });
  assert.equal(response.statusCode, 429);
  assert.equal(response.json().error.code, "rate_limited");
});

test("GET /v1/models lists models from enabled routes only", async (t) => {
  const origin = await startOrigin([{ status: 200, body: completion("unused") }]);
  const { app, runtime } = harness();
  t.after(async () => {
    void app.close();
    runtime.close();
    await origin.close();
  });
  await seed(app, origin.port);
  await app.inject({
    method: "POST",
    url: "/api/routes",
    headers: JSON_AUTH,
    payload: { id: "r2", model: "gpt-4o-mini", providerId: "p1" },
  });
  await app.inject({
    method: "POST",
    url: "/api/routes",
    headers: JSON_AUTH,
    payload: { id: "r3", model: "disabled-model", providerId: "p1", enabled: false },
  });
  await app.inject({
    method: "POST",
    url: "/api/routes",
    headers: JSON_AUTH,
    payload: { id: "r4", model: "wildcard-*", providerId: "p1" },
  });

  const response = await app.inject({ method: "GET", url: "/v1/models", headers: AUTH });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.object, "list");
  const ids = body.data.map((entry: { id: string }) => entry.id);
  assert.deepEqual(ids, ["gpt-4o", "gpt-4o-mini"]);
  assert.equal(
    ids.includes("disabled-model"),
    false,
    "a disabled route must not advertise its model",
  );
  assert.equal(
    ids.some((id: string) => id.includes("*")),
    false,
    "a wildcard pattern is not a usable model id",
  );
  for (const entry of body.data) {
    assert.equal(entry.object, "model");
    assert.equal(entry.owned_by, "bayz");
  }
});

test("chat and models endpoints require the token", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  const chat = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    payload: REQUEST,
  });
  assert.equal(chat.statusCode, 401);
  assert.equal(chat.body.includes(PROMPT), false, "an unauthenticated prompt is not echoed");

  const models = await app.inject({ method: "GET", url: "/v1/models" });
  assert.equal(models.statusCode, 401);
});

test("no prompt or completion appears in any captured log line", async (t) => {
  logLines.length = 0;
  const origin = await startOrigin([
    { status: 200, body: completion("LOGGED-COMPLETION-SENTINEL") },
  ]);
  const { app, runtime } = harness();
  t.after(async () => {
    void app.close();
    runtime.close();
    await origin.close();
  });
  await seed(app, origin.port, { credential: true });

  await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: JSON_AUTH,
    payload: REQUEST,
  });

  const serialized = logLines.join("\n");
  assert.ok(serialized.length > 0, "the capture must have seen log activity");
  assert.equal(serialized.includes(PROMPT), false);
  assert.equal(serialized.includes("LOGGED-COMPLETION-SENTINEL"), false);
  assert.equal(serialized.includes(CREDENTIAL), false);
  assert.equal(serialized.includes(TOKEN), false);
  assert.equal(serialized.includes(KEY), false);
});
