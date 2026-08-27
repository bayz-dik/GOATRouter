import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { BOOTSTRAP_IDENTITY_ID } from "../src/principal.js";
import { createBayzRuntime, type BayzRuntime } from "../src/runtime.js";

/*
 * Route fixtures in this file set `freeOnly: false`.
 *
 * These tests assert HTTP surface behaviour — status codes, headers, streaming frames,
 * error envelopes — against fixture origins that publish no pricing metadata. An
 * undiscovered model is not free (spec §25 rule 5), so the schema's free-only default
 * would refuse every chat below with `no_free_route` for a reason none of these tests is
 * about. Free-only enforcement has its own coverage in the router package and in
 * `economics-api.test.ts`.
 */

const KEY = Buffer.alloc(32, 0x5a).toString("hex");
const TOKEN = "gateway-token-0123456789abcdef";
const CHAT_KEY = "gateway-chat-key-0123456789";
const MODELS_KEY = "gateway-models-key-0123456789";
const CREDENTIAL = "sk-gateway-credential";

function harness(): { app: FastifyInstance; runtime: BayzRuntime } {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-gateway-")), ".bayz");
  const runtime = createBayzRuntime(
    { host: "127.0.0.1", port: 20128, dataDir, dashboardRoot: "/nonexistent" },
    { env: { BAYZ_MASTER_KEY: KEY, BAYZ_API_TOKEN: TOKEN }, notify: () => {} },
  );
  const app = buildApp({
    logger: false,
    apiToken: TOKEN,
    runtime,
    rateLimit: { max: 100000, authMax: 100000 },
    // The seam 9C fills with the real identity registry. Until then a test can
    // present a scoped principal so the gateway's scope logic is exercised for
    // real rather than only through the all-powerful bootstrap token.
    resolveIdentity: (presented) => {
      if (presented === CHAT_KEY) {
        return { id: "chat-client", scopes: new Set(["chat.completions"]) };
      }
      if (presented === MODELS_KEY) {
        return { id: "models-client", scopes: new Set(["models.read"]) };
      }
      return undefined;
    },
  });
  return { app, runtime };
}

async function startOrigin(): Promise<{ port: number; close(): Promise<void> }> {
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        model: "gw-model",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function seed(runtime: BayzRuntime, port: number): Promise<void> {
  runtime.providers.createProvider({
    id: "gw-provider",
    kind: "openai-compatible",
    displayName: "Gateway Origin",
    baseUrl: `http://127.0.0.1:${port}`,
    config: { allowLoopback: true },
  });
  runtime.providers.setCredential("gw-provider", CREDENTIAL);
  runtime.router.createRoute({
    freeOnly: false,
    id: "gw-route",
    model: "gw-model",
    providerId: "gw-provider",
  });
}

test("the bootstrap token authenticates and carries admin authority", async () => {
  const { app, runtime } = harness();
  const origin = await startOrigin();
  try {
    await seed(runtime, origin.port);
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      payload: { model: "gw-model", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(response.statusCode, 200);
  } finally {
    await origin.close();
    runtime.close();
    await app.close();
  }
});

test("a chat-scope identity can chat", async () => {
  const { app, runtime } = harness();
  const origin = await startOrigin();
  try {
    await seed(runtime, origin.port);
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${CHAT_KEY}`, "content-type": "application/json" },
      payload: { model: "gw-model", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(response.statusCode, 200);
  } finally {
    await origin.close();
    runtime.close();
    await app.close();
  }
});

test("a models-only identity is forbidden from chatting", async () => {
  const { app, runtime } = harness();
  const origin = await startOrigin();
  try {
    await seed(runtime, origin.port);
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${MODELS_KEY}`, "content-type": "application/json" },
      payload: { model: "gw-model", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(response.statusCode, 403);
    const body = response.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, "forbidden");
    // The message names the missing capability and nothing about what exists.
    assert.ok(!body.error.message.includes("gw-provider"));
    assert.ok(!body.error.message.includes(CREDENTIAL));
  } finally {
    await origin.close();
    runtime.close();
    await app.close();
  }
});

test("listing models requires models.read", async () => {
  const { app, runtime } = harness();
  const origin = await startOrigin();
  try {
    await seed(runtime, origin.port);
    const allowed = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: `Bearer ${MODELS_KEY}` },
    });
    assert.equal(allowed.statusCode, 200);

    const denied = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: `Bearer ${CHAT_KEY}` },
    });
    assert.equal(denied.statusCode, 403);
  } finally {
    await origin.close();
    runtime.close();
    await app.close();
  }
});

test("the chat response shape is byte-identical to the Phase 6 shape", async () => {
  const { app, runtime } = harness();
  const origin = await startOrigin();
  try {
    await seed(runtime, origin.port);
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      payload: { model: "gw-model", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as Record<string, unknown>;

    // Regression guard. Routing the handler through the gateway must not change a
    // single field name a client already parses.
    assert.deepEqual(Object.keys(body).sort(), [
      "choices",
      "created",
      "id",
      "model",
      "object",
      "usage",
    ]);
    assert.equal(body.object, "chat.completion");
    assert.match(String(body.id), /^chatcmpl-/);
    assert.equal(body.model, "gw-model");
    assert.deepEqual(body.choices, [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ]);
    assert.deepEqual(body.usage, {
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
    });
    assert.equal(response.headers["x-bayz-route"], "gw-route");
    assert.equal(response.headers["x-bayz-provider"], "gw-provider");
  } finally {
    await origin.close();
    runtime.close();
    await app.close();
  }
});

test("the models response shape is byte-identical to the Phase 6 shape", async () => {
  const { app, runtime } = harness();
  const origin = await startOrigin();
  try {
    await seed(runtime, origin.port);
    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      object: "list",
      data: [{ id: "gw-model", object: "model", owned_by: "bayz" }],
    });
  } finally {
    await origin.close();
    runtime.close();
    await app.close();
  }
});

test("snake_case sampling fields now reach the router", async () => {
  // Before the gateway, `max_tokens` was an unknown key and a compliant OpenAI
  // client got a 400. That was a real compatibility defect.
  const { app, runtime } = harness();
  const origin = await startOrigin();
  try {
    await seed(runtime, origin.port);
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      payload: {
        model: "gw-model",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 64,
        top_p: 0.8,
        temperature: 0.2,
        stop: "END",
      },
    });
    assert.equal(response.statusCode, 200);
  } finally {
    await origin.close();
    runtime.close();
    await app.close();
  }
});

test("an unknown request key is still a 400", async () => {
  const { app, runtime } = harness();
  const origin = await startOrigin();
  try {
    await seed(runtime, origin.port);
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      payload: {
        model: "gw-model",
        messages: [{ role: "user", content: "hi" }],
        provider: "gw-provider",
      },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(
      (response.json() as { error: { code: string } }).error.code,
      "invalid_request",
    );
  } finally {
    await origin.close();
    runtime.close();
    await app.close();
  }
});

test("the bootstrap identity id is stable and non-secret", () => {
  assert.equal(BOOTSTRAP_IDENTITY_ID, "bootstrap-admin");
  assert.ok(!/[0-9a-f]{32}/.test(BOOTSTRAP_IDENTITY_ID));
});

test("api health remains unauthenticated and unchanged", async () => {
  const { app, runtime } = harness();
  try {
    const response = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(Object.keys(response.json() as object).sort(), [
      "status",
      "uptimeSeconds",
      "version",
    ]);
  } finally {
    runtime.close();
    await app.close();
  }
});
