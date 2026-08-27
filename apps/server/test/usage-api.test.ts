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

/**
 * Usage API.
 *
 * Every endpoint is authenticated, metadata-only, and bounded. These tests drive a
 * real router against a real loopback origin so the rows under test are produced by
 * the real telemetry path rather than hand-inserted.
 */

const KEY = Buffer.alloc(32, 0x8c).toString("hex");
const TOKEN = "usage-api-token-0123456789abcdef";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };
const PROMPT = "PROMPT-SENTINEL-usage-api";
const COMPLETION = "COMPLETION-SENTINEL-usage-api";
const CREDENTIAL = "sk-usage-api-credential";
const UPSTREAM_ERROR = "UPSTREAM-ERROR-SENTINEL-usage-api";

function harness(): { app: FastifyInstance; runtime: BayzRuntime; logs: string[] } {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-usage-api-")), ".bayz");
  const logs: string[] = [];
  const runtime = createBayzRuntime(
    { host: "127.0.0.1", port: 20128, dataDir, dashboardRoot: "/nonexistent" },
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
  return { app, runtime, logs };
}

async function startOrigin(
  script: Array<{ status: number; body: unknown }>,
): Promise<{ port: number; close(): Promise<void> }> {
  let index = 0;
  const server = createHttpServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      const step = script[Math.min(index, script.length - 1)]!;
      index += 1;
      response.writeHead(step.status, { "content-type": "application/json" });
      response.end(JSON.stringify(step.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function completion(content: string, usage?: unknown): unknown {
  return {
    id: "chatcmpl-u",
    model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    ...(usage === undefined ? {} : { usage }),
  };
}

async function seed(
  app: FastifyInstance,
  port: number,
  options: { id?: string; credential?: boolean; routeId?: string; model?: string } = {},
): Promise<void> {
  const id = options.id ?? "p1";
  await app.inject({
    method: "POST",
    url: "/api/providers",
    headers: JSON_AUTH,
    payload: {
      id,
      kind: "openai-compatible",
      displayName: id.toUpperCase(),
      baseUrl: `http://127.0.0.1:${port}/v1`,
      config: { allowLoopback: true },
    },
  });
  if (options.credential === true) {
    await app.inject({
      method: "PUT",
      url: `/api/providers/${id}/credential`,
      headers: JSON_AUTH,
      payload: { value: CREDENTIAL },
    });
  }
  await app.inject({
    method: "POST",
    url: "/api/routes",
    headers: JSON_AUTH,
    payload: {
      id: options.routeId ?? "r1",
      model: options.model ?? "gpt-4o",
      providerId: id,
      /*
       * Not free-only.
       *
       * This file asserts usage accounting against fixture origins that publish no
       * pricing metadata, so every model here is undiscovered — and undiscovered is not
       * free (spec §25 rule 5). The schema's free-only default would refuse every chat
       * below with `no_free_route`, which is not what these tests measure.
       */
      freeOnly: false,
    },
  });
}

async function chat(app: FastifyInstance, model = "gpt-4o"): Promise<number> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: JSON_AUTH,
    payload: { model, messages: [{ role: "user", content: PROMPT }] },
  });
  return response.statusCode;
}

test("every usage endpoint requires the API token", async (t) => {
  const h = harness();
  t.after(() => {
    void h.app.close();
    h.runtime.close();
  });

  for (const url of [
    "/api/usage/summary",
    "/api/usage/requests",
    "/api/usage/providers",
  ]) {
    const response = await h.app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 401, `${url} must require auth`);
    assert.equal(response.json().error.code, "unauthorized");
  }
});

test("a wrong token is refused identically to a missing one", async (t) => {
  const h = harness();
  t.after(() => {
    void h.app.close();
    h.runtime.close();
  });

  const missing = await h.app.inject({
    method: "GET",
    url: "/api/usage/summary",
    headers: { "x-request-id": "req_fixed" },
  });
  const wrong = await h.app.inject({
    method: "GET",
    url: "/api/usage/summary",
    headers: { authorization: "Bearer nope-nope-nope-nope", "x-request-id": "req_fixed" },
  });
  assert.equal(missing.statusCode, wrong.statusCode);
  assert.deepEqual(missing.json(), wrong.json());
});

test("/api/health remains unauthenticated and unchanged", async (t) => {
  const h = harness();
  t.after(() => {
    void h.app.close();
    h.runtime.close();
  });

  const response = await h.app.inject({ method: "GET", url: "/api/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(Object.keys(response.json()).sort(), [
    "status",
    "uptimeSeconds",
    "version",
  ]);
});

test("a real request produces a summary computed from real telemetry", async (t) => {
  const origin = await startOrigin([
    {
      status: 200,
      body: completion(COMPLETION, {
        prompt_tokens: 21,
        completion_tokens: 7,
        total_tokens: 28,
      }),
    },
  ]);
  const h = harness();
  t.after(async () => {
    void h.app.close();
    h.runtime.close();
    await origin.close();
  });

  await seed(h.app, origin.port, { credential: true });
  assert.equal(await chat(h.app), 200);

  const response = await h.app.inject({
    method: "GET",
    url: "/api/usage/summary",
    headers: AUTH,
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.totalRequests, 1);
  assert.equal(body.okRequests, 1);
  assert.equal(body.failedRequests, 0);
  assert.equal(body.promptTokens, 21);
  assert.equal(body.completionTokens, 7);
  assert.equal(body.tokenReports, 1);
  assert.equal(typeof body.averageLatencyMs, "number");
  // Cost is stated unavailable, never invented.
  assert.equal(body.costAvailable, false);
  assert.equal(typeof body.costReason, "string");
  assert.equal(body.period, "today");
});

test("the summary contains no prompt, completion, or credential", async (t) => {
  const origin = await startOrigin([{ status: 200, body: completion(COMPLETION) }]);
  const h = harness();
  t.after(async () => {
    void h.app.close();
    h.runtime.close();
    await origin.close();
  });

  await seed(h.app, origin.port, { credential: true });
  await chat(h.app);

  for (const url of [
    "/api/usage/summary",
    "/api/usage/requests",
    "/api/usage/providers",
  ]) {
    const response = await h.app.inject({ method: "GET", url, headers: AUTH });
    for (const sentinel of [PROMPT, COMPLETION, CREDENTIAL, TOKEN, KEY]) {
      assert.equal(
        response.body.includes(sentinel),
        false,
        `${url} leaked ${sentinel.slice(0, 18)}`,
      );
    }
  }
});

test("unknown token counts stay null in the summary", async (t) => {
  const origin = await startOrigin([{ status: 200, body: completion(COMPLETION) }]);
  const h = harness();
  t.after(async () => {
    void h.app.close();
    h.runtime.close();
    await origin.close();
  });

  await seed(h.app, origin.port);
  await chat(h.app);

  const body = (
    await h.app.inject({ method: "GET", url: "/api/usage/summary", headers: AUTH })
  ).json();
  assert.equal(body.promptTokens, null, "unknown must be null, never 0");
  assert.equal(body.completionTokens, null);
  assert.equal(body.tokenReports, 0);
});

test("the requests list carries metadata only", async (t) => {
  const origin = await startOrigin([
    { status: 200, body: completion(COMPLETION, { prompt_tokens: 5, completion_tokens: 2 }) },
  ]);
  const h = harness();
  t.after(async () => {
    void h.app.close();
    h.runtime.close();
    await origin.close();
  });

  await seed(h.app, origin.port, { credential: true });
  await chat(h.app);

  const body = (
    await h.app.inject({ method: "GET", url: "/api/usage/requests", headers: AUTH })
  ).json();
  assert.equal(Array.isArray(body.requests), true);
  assert.equal(body.requests.length, 1);
  const row = body.requests[0];
  // The exact metadata field set: a new key here would be a privacy review item.
  assert.deepEqual(Object.keys(row).sort(), [
    "attempts",
    "cachedTokens",
    "completionTokens",
    "failureCategory",
    "latencyMs",
    "model",
    "occurredAt",
    "outcome",
    "promptTokens",
    "providerId",
    "proxyId",
    "requestId",
    "routeId",
    "routingMode",
  ]);
  assert.equal(row.model, "gpt-4o");
  assert.equal(row.providerId, "p1");
  assert.equal(row.outcome, "ok");
});

test("a failed request is recorded with a normalized category and no upstream body", async (t) => {
  const origin = await startOrigin([
    { status: 500, body: { error: `${UPSTREAM_ERROR} ${CREDENTIAL}` } },
  ]);
  const h = harness();
  t.after(async () => {
    void h.app.close();
    h.runtime.close();
    await origin.close();
  });

  await seed(h.app, origin.port, { credential: true });
  assert.equal(await chat(h.app), 502);

  const response = await h.app.inject({
    method: "GET",
    url: "/api/usage/requests",
    headers: AUTH,
  });
  const row = response.json().requests[0];
  assert.equal(row.outcome, "failed");
  assert.equal(row.failureCategory, "upstream_error");
  assert.equal(response.body.includes(UPSTREAM_ERROR), false);
  assert.equal(response.body.includes(CREDENTIAL), false);
});

test("failover is visible as attempts and provider participation", async (t) => {
  const bad = await startOrigin([{ status: 503, body: { error: "down" } }]);
  const good = await startOrigin([{ status: 200, body: completion(COMPLETION) }]);
  const h = harness();
  t.after(async () => {
    void h.app.close();
    h.runtime.close();
    await bad.close();
    await good.close();
  });

  await seed(h.app, bad.port, { id: "bad", routeId: "r-bad" });
  await seed(h.app, good.port, { id: "good", routeId: "r-good" });
  await h.app.inject({
    method: "PATCH",
    url: "/api/routes/r-bad",
    headers: JSON_AUTH,
    payload: { priority: 900 },
  });
  assert.equal(await chat(h.app), 200);

  const summary = (
    await h.app.inject({ method: "GET", url: "/api/usage/summary", headers: AUTH })
  ).json();
  assert.equal(summary.okRequests, 1);

  const providers = (
    await h.app.inject({ method: "GET", url: "/api/usage/providers", headers: AUTH })
  ).json();
  type ProviderRow = { providerId: string; attempts: number; failures: number };
  const byId = new Map<string, ProviderRow>(
    (providers.providers as ProviderRow[]).map((entry) => [entry.providerId, entry]),
  );
  // Both participants are individually named, with the failure attributed exactly
  // once: `failover.started` is a marker and is not stored as a second attempt.
  assert.equal(byId.get("bad")?.failures, 1);
  assert.equal(byId.get("bad")?.attempts, 1);
  assert.equal(byId.get("good")?.attempts, 1);
  assert.equal(byId.get("good")?.failures, 0);
});

test("period is strictly validated", async (t) => {
  const h = harness();
  t.after(() => {
    void h.app.close();
    h.runtime.close();
  });

  for (const period of ["today", "24h", "7d", "30d"]) {
    const response = await h.app.inject({
      method: "GET",
      url: `/api/usage/summary?period=${period}`,
      headers: AUTH,
    });
    assert.equal(response.statusCode, 200, `${period} must be accepted`);
    assert.equal(response.json().period, period);
  }

  for (const period of ["", "forever", "1y", "TODAY", "../../etc", "7d;drop", "0"]) {
    const response = await h.app.inject({
      method: "GET",
      url: `/api/usage/summary?period=${encodeURIComponent(period)}`,
      headers: AUTH,
    });
    assert.equal(response.statusCode, 400, `${period} must be refused`);
    assert.equal(response.json().error.code, "invalid_request");
  }
});

test("limit is strictly validated and bounded", async (t) => {
  const h = harness();
  t.after(() => {
    void h.app.close();
    h.runtime.close();
  });

  const ok = await h.app.inject({
    method: "GET",
    url: "/api/usage/requests?limit=10",
    headers: AUTH,
  });
  assert.equal(ok.statusCode, 200);

  for (const limit of ["0", "-1", "1.5", "abc", "999999", ""]) {
    const response = await h.app.inject({
      method: "GET",
      url: `/api/usage/requests?limit=${encodeURIComponent(limit)}`,
      headers: AUTH,
    });
    assert.equal(response.statusCode, 400, `limit ${limit} must be refused`);
  }
});

test("an unknown usage subpath is 404 and reveals nothing", async (t) => {
  const h = harness();
  t.after(() => {
    void h.app.close();
    h.runtime.close();
  });

  for (const url of [
    "/api/usage",
    "/api/usage/prompts",
    "/api/usage/bodies",
    "/api/usage/requests/req_1",
  ]) {
    const response = await h.app.inject({ method: "GET", url, headers: AUTH });
    assert.equal(response.statusCode, 404, `${url} must not exist`);
  }
});

test("there is no endpoint that could return request content", async (t) => {
  const h = harness();
  t.after(() => {
    void h.app.close();
    h.runtime.close();
  });

  for (const url of [
    "/api/usage/requests/req_1/prompt",
    "/api/usage/requests/req_1/body",
    "/api/usage/content",
    "/api/usage/raw",
  ]) {
    const response = await h.app.inject({ method: "GET", url, headers: AUTH });
    assert.equal(response.statusCode, 404);
  }
});

test("provider activity reports derived state without secrets", async (t) => {
  const origin = await startOrigin([{ status: 200, body: completion(COMPLETION) }]);
  const h = harness();
  t.after(async () => {
    void h.app.close();
    h.runtime.close();
    await origin.close();
  });

  await seed(h.app, origin.port, { credential: true });
  await chat(h.app);

  const response = await h.app.inject({
    method: "GET",
    url: "/api/usage/providers",
    headers: AUTH,
  });
  assert.equal(response.statusCode, 200);
  const entry = response.json().providers[0];
  assert.equal(entry.providerId, "p1");
  assert.equal(entry.attempts, 1);
  assert.equal(entry.failures, 0);
  assert.equal(entry.lastOutcome, "ok");
  // Presence only; never the value.
  assert.equal(entry.credentialPresent, true);
  assert.equal(response.body.includes(CREDENTIAL), false);
  for (const key of Object.keys(entry)) {
    assert.equal(
      /credential$|password|token|secret|authorization|apikey/i.test(key),
      false,
      `${key} must not be a secret-bearing field`,
    );
  }
});

test("a retention purge affects usage only and is idempotent", async (t) => {
  const origin = await startOrigin([{ status: 200, body: completion(COMPLETION) }]);
  const h = harness();
  t.after(async () => {
    void h.app.close();
    h.runtime.close();
    await origin.close();
  });

  await seed(h.app, origin.port, { credential: true });
  await chat(h.app);

  const first = await h.app.inject({
    method: "DELETE",
    url: "/api/usage/requests",
    headers: AUTH,
  });
  assert.equal(first.statusCode, 204);
  // Idempotent, and identical the second time, so it reveals nothing about state.
  const second = await h.app.inject({
    method: "DELETE",
    url: "/api/usage/requests",
    headers: AUTH,
  });
  assert.equal(second.statusCode, 204);
  assert.equal(second.body, first.body);

  const summary = (
    await h.app.inject({ method: "GET", url: "/api/usage/summary", headers: AUTH })
  ).json();
  assert.equal(summary.totalRequests, 0);

  // The domain survived the purge untouched.
  const providers = (
    await h.app.inject({ method: "GET", url: "/api/providers", headers: AUTH })
  ).json();
  assert.equal(providers.providers.length, 1);
  const routes = (
    await h.app.inject({ method: "GET", url: "/api/routes", headers: AUTH })
  ).json();
  assert.equal(routes.routes.length, 1);
  assert.equal(
    (await h.app.inject({ method: "GET", url: "/api/providers/p1", headers: AUTH })).json()
      .credentialPresent,
    true,
    "a usage purge must never touch a credential",
  );
});

test("the purge endpoint requires the token", async (t) => {
  const h = harness();
  t.after(() => {
    void h.app.close();
    h.runtime.close();
  });
  const response = await h.app.inject({ method: "DELETE", url: "/api/usage/requests" });
  assert.equal(response.statusCode, 401);
});

test("logs stay free of prompt, completion, and credential across the usage flow", async (t) => {
  const origin = await startOrigin([{ status: 200, body: completion(COMPLETION) }]);
  const h = harness();
  t.after(async () => {
    void h.app.close();
    h.runtime.close();
    await origin.close();
  });

  await seed(h.app, origin.port, { credential: true });
  await chat(h.app);
  await h.app.inject({ method: "GET", url: "/api/usage/summary", headers: AUTH });

  const logs = h.logs.join("\n");
  for (const sentinel of [PROMPT, COMPLETION, CREDENTIAL, TOKEN, KEY]) {
    assert.equal(logs.includes(sentinel), false, `${sentinel.slice(0, 18)} leaked into logs`);
  }
});

test("the response is bounded even with many recorded requests", async (t) => {
  const origin = await startOrigin([{ status: 200, body: completion(COMPLETION) }]);
  const h = harness();
  t.after(async () => {
    void h.app.close();
    h.runtime.close();
    await origin.close();
  });

  await seed(h.app, origin.port);
  for (let index = 0; index < 12; index += 1) {
    await chat(h.app);
  }

  const body = (
    await h.app.inject({
      method: "GET",
      url: "/api/usage/requests?limit=200",
      headers: AUTH,
    })
  ).json();
  assert.ok(body.requests.length <= 200);
  assert.ok(body.requests.length >= 1);
});
