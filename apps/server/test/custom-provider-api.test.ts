import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createBayzRuntime, type BayzRuntime } from "../src/runtime.js";

/**
 * Custom providers over the API.
 *
 * The surface has to be usable — a relay with a header, a local runtime, a test
 * button — without becoming a way to reach the operator's own network or to read back
 * configuration that has no business leaving the process.
 */

const KEY = Buffer.alloc(32, 0x3c).toString("hex");
const TOKEN = "custom-provider-api-token-0123456789";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };
const HEADER_VALUE = "relay-token-value-abc123";

function harness(): { app: FastifyInstance; runtime: BayzRuntime } {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-custom-provider-api-")), ".bayz");
  const runtime = createBayzRuntime(
    { host: "127.0.0.1", port: 20142, dataDir, dashboardRoot: "/nonexistent" },
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

type Origin = {
  port: number;
  base: string;
  headers: Array<Record<string, string | string[] | undefined>>;
  close(): Promise<void>;
};

async function startOrigin(payload: unknown, status = 200): Promise<Origin> {
  const headers: Array<Record<string, string | string[] | undefined>> = [];
  const server: Server = createHttpServer((request, response) => {
    headers.push({ ...request.headers });
    request.resume();
    request.on("end", () => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    headers,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

test("a custom-openai provider is created through the API", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  const created = await app.inject({
    method: "POST",
    url: "/api/providers",
    headers: JSON_AUTH,
    payload: {
      id: "relay",
      kind: "custom-openai",
      displayName: "Tabitoken Relay",
      baseUrl: "https://relay.example.com/v1",
      config: { headers: { "x-relay-token": HEADER_VALUE } },
    },
  });

  assert.equal(created.statusCode, 201);
  assert.equal(created.json().kind, "custom-openai");
});

test("the response never carries header values back", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  const created = await app.inject({
    method: "POST",
    url: "/api/providers",
    headers: JSON_AUTH,
    payload: {
      id: "relay",
      kind: "custom-openai",
      displayName: "Relay",
      baseUrl: "https://relay.example.com/v1",
      config: { headers: { "x-relay-token": HEADER_VALUE } },
    },
  });

  // Header values are config rather than secrets, but echoing them widens the surface
  // for no benefit: nothing in the dashboard needs to read one back.
  assert.ok(!created.payload.includes(HEADER_VALUE));
  const listed = await app.inject({ method: "GET", url: "/api/providers", headers: AUTH });
  assert.ok(!listed.payload.includes(HEADER_VALUE));

  // The *names* are safe and useful: an operator has to be able to see which headers
  // are configured without being told the values.
  assert.deepEqual(created.json().config.headerNames, ["x-relay-token"]);
});

test("a denied header is 400 and the response names the header", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  for (const name of ["authorization", "Authorization", "host", "proxy-authorization"]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/providers",
      headers: JSON_AUTH,
      payload: {
        id: "denied",
        kind: "custom-openai",
        displayName: "Denied",
        baseUrl: "https://relay.example.com/v1",
        config: { headers: { [name]: "value" } },
      },
    });
    assert.equal(response.statusCode, 400, name);
    // Naming the header is what makes this actionable: "invalid config" would leave
    // the operator guessing which of eight headers was the problem. The *name* is the
    // operator's own input and reveals nothing about BAYZ.
    assert.ok(
      response.payload.toLowerCase().includes(name.toLowerCase()),
      `the 400 for ${name} must name it`,
    );
    // And never the value.
    assert.ok(!response.payload.includes("value"));
  }
});

test("a metadata-endpoint base URL is 400", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  for (const baseUrl of [
    "http://169.254.169.254/latest/meta-data",
    "http://metadata.google.internal/v1",
    "http://127.0.0.1:11434/v1",
    "http://10.0.0.5/v1",
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/providers",
      headers: JSON_AUTH,
      payload: {
        id: "ssrf",
        kind: "custom-openai",
        displayName: "SSRF",
        baseUrl,
      },
    });
    assert.equal(response.statusCode, 400, baseUrl);
    assert.equal(response.json().error.code, "invalid_provider_config");
  }
});

test("allowLoopback is accepted and persisted", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  const created = await app.inject({
    method: "POST",
    url: "/api/providers",
    headers: JSON_AUTH,
    payload: {
      id: "ollama",
      kind: "custom-openai",
      displayName: "Local Ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      config: { allowLoopback: true },
    },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().config.allowLoopback, true);

  const fetched = await app.inject({
    method: "GET",
    url: "/api/providers/ollama",
    headers: AUTH,
  });
  assert.equal(fetched.json().config.allowLoopback, true);
});

test("POST /api/providers/:id/test returns the connection result", async (t) => {
  const origin = await startOrigin({ data: [{ id: "m1" }, { id: "m2" }] });
  const { app, runtime } = harness();
  t.after(async () => {
    void app.close();
    runtime.close();
    await origin.close();
  });

  await app.inject({
    method: "POST",
    url: "/api/providers",
    headers: JSON_AUTH,
    payload: {
      id: "relay",
      kind: "custom-openai",
      displayName: "Relay",
      baseUrl: origin.base,
      config: { allowLoopback: true, timeoutMs: 5000 },
    },
  });

  const tested = await app.inject({
    method: "POST",
    url: "/api/providers/relay/test",
    headers: AUTH,
  });
  assert.equal(tested.statusCode, 200);
  const body = tested.json();
  assert.equal(body.ok, true);
  assert.equal(body.modelCount, 2);
  assert.equal(typeof body.latencyMs, "number");
});

test("a failing test connection is 200 with ok false, not an HTTP error", async (t) => {
  const origin = await startOrigin("nope", 500);
  const { app, runtime } = harness();
  t.after(async () => {
    void app.close();
    runtime.close();
    await origin.close();
  });

  await app.inject({
    method: "POST",
    url: "/api/providers",
    headers: JSON_AUTH,
    payload: {
      id: "broken",
      kind: "custom-openai",
      displayName: "Broken",
      baseUrl: origin.base,
      config: { allowLoopback: true, timeoutMs: 5000 },
    },
  });

  const tested = await app.inject({
    method: "POST",
    url: "/api/providers/broken/test",
    headers: AUTH,
  });
  // The *test* succeeded; its subject failed. A 502 here would make "we could not
  // reach your provider" indistinguishable from "the test endpoint is broken".
  assert.equal(tested.statusCode, 200);
  const body = tested.json();
  assert.equal(body.ok, false);
  assert.equal(typeof body.failureCode, "string");
  assert.ok(!tested.payload.includes("nope"));
});

test("the test endpoint requires providers.write", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  const identity = runtime.identities.createIdentity({
    id: "reader",
    displayName: "Reader",
    scopes: ["providers.read"],
  });

  await app.inject({
    method: "POST",
    url: "/api/providers",
    headers: JSON_AUTH,
    payload: {
      id: "relay",
      kind: "custom-openai",
      displayName: "Relay",
      baseUrl: "https://relay.example.com/v1",
    },
  });

  const denied = await app.inject({
    method: "POST",
    url: "/api/providers/relay/test",
    headers: { authorization: `Bearer ${identity.key}` },
  });
  // A connection test dials an upstream. That is a write-shaped side effect even
  // though it stores nothing, so read scope must not authorize it.
  assert.equal(denied.statusCode, 403);
});

test("the capabilities endpoint reports unknown honestly", async (t) => {
  const origin = await startOrigin({ data: [{ id: "m1" }] });
  const { app, runtime } = harness();
  t.after(async () => {
    void app.close();
    runtime.close();
    await origin.close();
  });

  await app.inject({
    method: "POST",
    url: "/api/providers",
    headers: JSON_AUTH,
    payload: {
      id: "relay",
      kind: "custom-openai",
      displayName: "Relay",
      baseUrl: origin.base,
      config: { allowLoopback: true, timeoutMs: 5000 },
    },
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/providers/relay/capabilities",
    headers: AUTH,
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.models, true);
  assert.equal(body.tools, "unknown");
  assert.equal(body.streaming, "unknown");
});

test("the catalogue endpoint returns economics and never a price", async (t) => {
  const origin = await startOrigin({
    data: [
      { id: "free-one", pricing: { prompt: "0", completion: "0", request: "0", image: "0" } },
      { id: "paid-one", pricing: { prompt: "0.000015", completion: "0.00006", request: "0", image: "0" } },
      { id: "mystery" },
    ],
  });
  const { app, runtime } = harness();
  t.after(async () => {
    void app.close();
    runtime.close();
    await origin.close();
  });

  await app.inject({
    method: "POST",
    url: "/api/providers",
    headers: JSON_AUTH,
    payload: {
      id: "relay",
      kind: "custom-openai",
      displayName: "Relay",
      baseUrl: origin.base,
      config: { allowLoopback: true, timeoutMs: 5000 },
    },
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/providers/relay/catalogue",
    headers: AUTH,
  });
  assert.equal(response.statusCode, 200);
  // Every entry is LOCAL, and that is correct rather than a shortcut: the provider is
  // loopback-opted-in, so it is a local runtime with no per-token cost to the operator,
  // and the classifier says so regardless of what the catalogue claims to charge. The
  // pricing-driven classifications are covered against a non-local provider in
  // `packages/providers/test/discovery-economics.test.ts`, which is where they belong —
  // a server test cannot reach a public origin.
  assert.deepEqual(response.json().models, [
    { id: "free-one", economics: "LOCAL" },
    { id: "paid-one", economics: "LOCAL" },
    { id: "mystery", economics: "LOCAL" },
  ]);
  // The classification is the useful part; the price is upstream metadata BAYZ has no
  // reason to republish.
  assert.ok(!response.payload.includes("0.000015"));
});

test("an unknown provider is 404 on every new endpoint", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  for (const path of ["test", "capabilities", "catalogue"]) {
    const response = await app.inject({
      method: "POST",
      url: `/api/providers/absent/${path}`,
      headers: AUTH,
    });
    assert.equal(response.statusCode, 404, path);
    assert.equal(response.json().error.code, "provider_not_found");
  }
});

test("an injection-shaped id is refused before any storage work", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  for (const id of ["a'b", "../x", "a b", "A".repeat(80)]) {
    const response = await app.inject({
      method: "POST",
      url: `/api/providers/${encodeURIComponent(id)}/test`,
      headers: AUTH,
    });
    assert.equal(response.statusCode, 400, id);
    assert.equal(response.json().error.code, "invalid_provider_id");
  }

  // A genuinely enormous id is refused earlier still, by the URL length limit, before
  // any route handler runs. Asserted separately rather than folded into the loop above,
  // because the *status* differs and pretending otherwise would hide which guard fired.
  const enormous = await app.inject({
    method: "POST",
    url: `/api/providers/${"A".repeat(200)}/test`,
    headers: AUTH,
  });
  assert.equal(enormous.statusCode, 414);
});

test("the new endpoints refuse an unauthenticated caller", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  for (const path of ["test", "capabilities", "catalogue"]) {
    const response = await app.inject({
      method: "POST",
      url: `/api/providers/relay/${path}`,
    });
    assert.equal(response.statusCode, 401, path);
  }
});

test("a custom header actually reaches the upstream through the API path", async (t) => {
  const origin = await startOrigin({ data: [{ id: "m1" }] });
  const { app, runtime } = harness();
  t.after(async () => {
    void app.close();
    runtime.close();
    await origin.close();
  });

  await app.inject({
    method: "POST",
    url: "/api/providers",
    headers: JSON_AUTH,
    payload: {
      id: "relay",
      kind: "custom-openai",
      displayName: "Relay",
      baseUrl: origin.base,
      config: {
        allowLoopback: true,
        timeoutMs: 5000,
        headers: { "x-relay-token": HEADER_VALUE },
      },
    },
  });

  await app.inject({
    method: "POST",
    url: "/api/providers/relay/discover",
    headers: AUTH,
  });

  assert.equal(origin.headers[0]?.["x-relay-token"], HEADER_VALUE);
});

test("more than eight headers is refused with a 400", async (t) => {
  const { app, runtime } = harness();
  t.after(() => {
    void app.close();
    runtime.close();
  });

  const headers: Record<string, string> = {};
  for (let index = 0; index < 9; index += 1) {
    headers[`x-h${index}`] = "v";
  }

  const response = await app.inject({
    method: "POST",
    url: "/api/providers",
    headers: JSON_AUTH,
    payload: {
      id: "toomany",
      kind: "custom-openai",
      displayName: "Too Many",
      baseUrl: "https://relay.example.com/v1",
      config: { headers },
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "invalid_provider_config");
});
