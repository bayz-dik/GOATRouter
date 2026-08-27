import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProviderManager } from "@bayz/providers";
import { createProxyManager } from "@bayz/proxy";
import { openSecretStorage, type SecretStorage } from "@bayz/storage";
import { createRouter, type Router } from "../src/index.js";

/**
 * Router telemetry emission.
 *
 * The recorder is observational: it sees metadata about what the router did, never
 * what the request contained. These tests seed sentinels into the prompt, the
 * completion, the credential, and the upstream error body, then assert none of them
 * reaches any emitted event.
 */

const KEY = Buffer.alloc(32, 0x71).toString("hex");
const PROMPT = "PROMPT-SENTINEL-router-telemetry";
const COMPLETION = "COMPLETION-SENTINEL-router-telemetry";
const CREDENTIAL = "sk-router-telemetry-credential";
const UPSTREAM_ERROR = "UPSTREAM-ERROR-BODY-SENTINEL";

type Recorded = Record<string, unknown>;

function context(): {
  router: Router;
  storage: SecretStorage;
  events: Recorded[];
  logs: string[];
  close(): void;
} {
  const dir = join(mkdtempSync(join(tmpdir(), "bayz-router-telemetry-")), ".bayz");
  const events: Recorded[] = [];
  const logs: string[] = [];
  const logger = (payload: Record<string, unknown>): void => {
    logs.push(JSON.stringify(payload));
  };
  const storage = openSecretStorage({ dataDir: dir, env: { BAYZ_MASTER_KEY: KEY } });
  const providers = createProviderManager({ storage, logger });
  const proxies = createProxyManager({ storage, logger });
  const router = createRouter({
    storage,
    providers,
    proxies,
    logger,
    recorder: (event) => {
      events.push(event as Recorded);
    },
  });
  return { router, storage, events, logs, close: () => router.close() };
}

async function startOrigin(
  script: Array<{ status: number; body: unknown }>,
): Promise<{ port: number; close(): Promise<void>; hits: number }> {
  const state = { hits: 0 };
  let index = 0;
  const server = createHttpServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      state.hits += 1;
      const step = script[Math.min(index, script.length - 1)]!;
      index += 1;
      response.writeHead(step.status, { "content-type": "application/json" });
      response.end(typeof step.body === "string" ? step.body : JSON.stringify(step.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    get hits() {
      return state.hits;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function completion(content: string, usage?: unknown): unknown {
  return {
    id: "chatcmpl-t",
    model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    ...(usage === undefined ? {} : { usage }),
  };
}

const REQUEST = {
  model: "gpt-4o",
  messages: [{ role: "user" as const, content: PROMPT }],
};

function seedProvider(ctx: ReturnType<typeof context>, id: string, port: number): void {
  ctx.router.providers.createProvider({
    id,
    kind: "openai-compatible",
    displayName: id.toUpperCase(),
    baseUrl: `http://127.0.0.1:${port}/v1`,
    config: { allowLoopback: true },
  });
}

test("a successful chat emits an attempt and a completion event", async (t) => {
  const origin = await startOrigin([
    {
      status: 200,
      body: completion(COMPLETION, {
        prompt_tokens: 11,
        completion_tokens: 4,
        total_tokens: 15,
      }),
    },
  ]);
  const ctx = context();
  t.after(async () => {
    ctx.close();
    await origin.close();
  });

  seedProvider(ctx, "p1", origin.port);
  ctx.router.providers.setCredential("p1", CREDENTIAL);
  ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });

  await ctx.router.chat(REQUEST);

  const kinds = ctx.events.map((event) => event.kind);
  assert.ok(kinds.includes("provider.attempted"), "an attempt must be observed");
  assert.ok(kinds.includes("request.completed"), "a completion must be observed");

  const completed = ctx.events.find((event) => event.kind === "request.completed")!;
  assert.equal(completed.providerId, "p1");
  assert.equal(completed.routeId, "r1");
  assert.equal(completed.model, "gpt-4o");
  assert.equal(completed.routingMode, "direct");
  assert.equal(completed.attempts, 1);
  assert.equal(typeof completed.latencyMs, "number");
  assert.equal(completed.promptTokens, 11);
  assert.equal(completed.completionTokens, 4);
});

test("no sentinel appears in any emitted event", async (t) => {
  const origin = await startOrigin([{ status: 200, body: completion(COMPLETION) }]);
  const ctx = context();
  t.after(async () => {
    ctx.close();
    await origin.close();
  });

  seedProvider(ctx, "p1", origin.port);
  ctx.router.providers.setCredential("p1", CREDENTIAL);
  ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });
  await ctx.router.chat(REQUEST);

  const serialized = JSON.stringify(ctx.events);
  assert.ok(serialized.length > 0, "events must have been emitted");
  for (const sentinel of [PROMPT, COMPLETION, CREDENTIAL, KEY]) {
    assert.equal(
      serialized.includes(sentinel),
      false,
      `${sentinel.slice(0, 20)} must not reach telemetry`,
    );
  }
});

test("every emitted event carries only metadata keys", async (t) => {
  const origin = await startOrigin([{ status: 200, body: completion(COMPLETION) }]);
  const ctx = context();
  t.after(async () => {
    ctx.close();
    await origin.close();
  });

  seedProvider(ctx, "p1", origin.port);
  ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });
  await ctx.router.chat(REQUEST);

  const allowed = new Set([
    "kind",
    "requestId",
    "occurredAt",
    "routeId",
    "providerId",
    "proxyId",
    "model",
    "routingMode",
    "latencyMs",
    "attempts",
    "failureCategory",
    "promptTokens",
    "completionTokens",
    "cachedTokens",
  ]);
  for (const event of ctx.events) {
    for (const key of Object.keys(event)) {
      assert.ok(allowed.has(key), `unexpected telemetry key: ${key}`);
    }
  }
});

test("unknown token counts stay unknown rather than becoming zero", async (t) => {
  const origin = await startOrigin([{ status: 200, body: completion(COMPLETION) }]);
  const ctx = context();
  t.after(async () => {
    ctx.close();
    await origin.close();
  });

  seedProvider(ctx, "p1", origin.port);
  ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });
  await ctx.router.chat(REQUEST);

  const completed = ctx.events.find((event) => event.kind === "request.completed")!;
  assert.equal(completed.promptTokens, undefined, "must stay unknown");
  assert.equal(completed.completionTokens, undefined);
  assert.equal(completed.cachedTokens, undefined);
});

test("a malformed upstream usage block degrades to unknown, not zero", async (t) => {
  const origin = await startOrigin([
    {
      status: 200,
      body: completion(COMPLETION, { prompt_tokens: -5, completion_tokens: "many" }),
    },
  ]);
  const ctx = context();
  t.after(async () => {
    ctx.close();
    await origin.close();
  });

  seedProvider(ctx, "p1", origin.port);
  ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });
  await ctx.router.chat(REQUEST);

  const completed = ctx.events.find((event) => event.kind === "request.completed")!;
  assert.equal(completed.promptTokens, undefined);
  assert.equal(completed.completionTokens, undefined);
});

test("a genuine zero token count is reported as zero", async (t) => {
  const origin = await startOrigin([
    {
      status: 200,
      body: completion(COMPLETION, {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      }),
    },
  ]);
  const ctx = context();
  t.after(async () => {
    ctx.close();
    await origin.close();
  });

  seedProvider(ctx, "p1", origin.port);
  ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });
  await ctx.router.chat(REQUEST);

  const completed = ctx.events.find((event) => event.kind === "request.completed")!;
  assert.equal(completed.promptTokens, 0);
  assert.equal(completed.completionTokens, 0);
});

test("a total failure emits a normalized category and no upstream body", async (t) => {
  const origin = await startOrigin([
    { status: 500, body: { error: `${UPSTREAM_ERROR} ${CREDENTIAL}` } },
  ]);
  const ctx = context();
  t.after(async () => {
    ctx.close();
    await origin.close();
  });

  seedProvider(ctx, "p1", origin.port);
  ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });
  await assert.rejects(ctx.router.chat(REQUEST));

  const failed = ctx.events.find((event) => event.kind === "request.failed");
  assert.ok(failed, "a failed request must be observed");
  assert.equal(failed.failureCategory, "upstream_error");
  assert.equal(failed.outcome, undefined, "outcome is derived at the boundary");

  const serialized = JSON.stringify(ctx.events);
  assert.equal(serialized.includes(UPSTREAM_ERROR), false);
  assert.equal(serialized.includes(CREDENTIAL), false);
});

test("an auth failure is categorized without leaking the credential", async (t) => {
  const origin = await startOrigin([{ status: 401, body: { error: CREDENTIAL } }]);
  const ctx = context();
  t.after(async () => {
    ctx.close();
    await origin.close();
  });

  seedProvider(ctx, "p1", origin.port);
  ctx.router.providers.setCredential("p1", CREDENTIAL);
  ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });
  await assert.rejects(ctx.router.chat(REQUEST));

  const attempt = ctx.events.find((event) => event.kind === "provider.failed")!;
  assert.equal(attempt.failureCategory, "auth_failed");
  assert.equal(JSON.stringify(ctx.events).includes(CREDENTIAL), false);
});

test("failover emits a failed attempt, a failover marker, and a completion", async (t) => {
  const bad = await startOrigin([{ status: 503, body: { error: UPSTREAM_ERROR } }]);
  const good = await startOrigin([{ status: 200, body: completion(COMPLETION) }]);
  const ctx = context();
  t.after(async () => {
    ctx.close();
    await bad.close();
    await good.close();
  });

  seedProvider(ctx, "bad", bad.port);
  seedProvider(ctx, "good", good.port);
  ctx.router.createRoute({ id: "r-bad", model: "gpt-4o", providerId: "bad", priority: 900 });
  ctx.router.createRoute({ id: "r-good", model: "gpt-4o", providerId: "good", priority: 100 });

  await ctx.router.chat(REQUEST);

  const failedAttempt = ctx.events.find(
    (event) => event.kind === "provider.failed" && event.providerId === "bad",
  );
  assert.ok(failedAttempt, "the failing provider must be observed by id");
  assert.equal(failedAttempt.failureCategory, "upstream_error");

  const failover = ctx.events.find((event) => event.kind === "failover.started");
  assert.ok(failover, "the handoff must be observable");
  assert.equal(failover.providerId, "good", "the promoted provider is named");

  const okAttempt = ctx.events.find(
    (event) => event.kind === "provider.attempted" && event.providerId === "good",
  );
  assert.ok(okAttempt);

  const completed = ctx.events.find((event) => event.kind === "request.completed")!;
  assert.equal(completed.providerId, "good");
  assert.equal(completed.attempts, 2, "the failed attempt is counted");
  assert.equal(completed.routingMode, "failover");
});

test("combo participation is emitted per provider by safe id", async (t) => {
  const origins = await Promise.all(
    Array.from({ length: 4 }, () => startOrigin([{ status: 503, body: { error: "down" } }])),
  );
  const good = await startOrigin([{ status: 200, body: completion(COMPLETION) }]);
  const ctx = context();
  t.after(async () => {
    ctx.close();
    for (const origin of origins) {
      await origin.close();
    }
    await good.close();
  });

  // Four failing candidates then a working one: five distinct attempts, all named.
  origins.forEach((origin, index) => {
    seedProvider(ctx, `p${index}`, origin.port);
    ctx.router.createRoute({
      id: `r${index}`,
      model: "gpt-4o",
      providerId: `p${index}`,
      priority: 900 - index,
    });
  });
  seedProvider(ctx, "p-final", good.port);
  ctx.router.createRoute({
    id: "r-final",
    model: "gpt-4o",
    providerId: "p-final",
    priority: 100,
  });

  await ctx.router.chat(REQUEST);

  const attemptedIds = ctx.events
    .filter((event) => event.kind === "provider.failed" || event.kind === "provider.attempted")
    .map((event) => event.providerId);
  for (let index = 0; index < 4; index += 1) {
    assert.ok(attemptedIds.includes(`p${index}`), `p${index} must be observed`);
  }
  assert.ok(attemptedIds.includes("p-final"));
  assert.equal(new Set(attemptedIds).size, 5, "every participant is individually named");
});

test("a proxy-bound route reports the proxy by safe id only", async (t) => {
  const origin = await startOrigin([{ status: 200, body: completion(COMPLETION) }]);
  const ctx = context();
  t.after(async () => {
    ctx.close();
    await origin.close();
  });

  seedProvider(ctx, "p1", origin.port);
  ctx.router.proxies.createProxy({
    id: "x1",
    kind: "http",
    host: "127.0.0.1",
    port: origin.port,
    username: "bayz",
  });
  ctx.router.proxies.setPassword("x1", "proxy-password-sentinel");
  ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1", proxyId: "x1" });

  // The dial will fail because the origin is not a CONNECT proxy; what matters is
  // that the emitted event names the proxy by id and carries no password.
  await assert.rejects(ctx.router.chat(REQUEST));

  const event = ctx.events.find((entry) => entry.proxyId !== undefined);
  assert.ok(event, "the proxy must be observable by id");
  assert.equal(event.proxyId, "x1");
  assert.equal(
    JSON.stringify(ctx.events).includes("proxy-password-sentinel"),
    false,
    "a proxy password must never reach telemetry",
  );
});

test("no route emits a request.failed with the no_route category", async (t) => {
  const origin = await startOrigin([{ status: 200, body: completion(COMPLETION) }]);
  const ctx = context();
  t.after(async () => {
    ctx.close();
    await origin.close();
  });

  seedProvider(ctx, "p1", origin.port);
  ctx.router.createRoute({ id: "r1", model: "claude-3", providerId: "p1" });
  await assert.rejects(ctx.router.chat(REQUEST));

  const failed = ctx.events.find((event) => event.kind === "request.failed");
  assert.ok(failed);
  assert.equal(failed.failureCategory, "no_route");
  assert.equal(origin.hits, 0);
});

test("an invalid request emits no telemetry at all", async (t) => {
  const origin = await startOrigin([{ status: 200, body: completion(COMPLETION) }]);
  const ctx = context();
  t.after(async () => {
    ctx.close();
    await origin.close();
  });

  seedProvider(ctx, "p1", origin.port);
  ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });
  await assert.rejects(ctx.router.chat({ ...REQUEST, stream: true } as never));

  // A request that never entered routing produced no routing facts to observe.
  assert.deepEqual(ctx.events, []);
});

test("a throwing recorder never breaks the chat request", async (t) => {
  const origin = await startOrigin([{ status: 200, body: completion(COMPLETION) }]);
  const dir = join(mkdtempSync(join(tmpdir(), "bayz-router-rec-throw-")), ".bayz");
  const storage = openSecretStorage({ dataDir: dir, env: { BAYZ_MASTER_KEY: KEY } });
  const providers = createProviderManager({ storage });
  const proxies = createProxyManager({ storage });
  let calls = 0;
  const router = createRouter({
    storage,
    providers,
    proxies,
    recorder: () => {
      calls += 1;
      throw new Error("recorder exploded");
    },
  });
  t.after(async () => {
    router.close();
    await origin.close();
  });

  providers.createProvider({
    id: "p1",
    kind: "openai-compatible",
    displayName: "P1",
    baseUrl: `http://127.0.0.1:${origin.port}/v1`,
    config: { allowLoopback: true },
  });
  router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });

  // Telemetry is observational: it must never become part of routing correctness.
  const result = await router.chat(REQUEST);
  assert.equal(result.content, COMPLETION);
  assert.ok(calls > 0, "the recorder was in fact called");
});

test("a router with no recorder behaves exactly as before", async (t) => {
  const origin = await startOrigin([{ status: 200, body: completion(COMPLETION) }]);
  const dir = join(mkdtempSync(join(tmpdir(), "bayz-router-no-rec-")), ".bayz");
  const storage = openSecretStorage({ dataDir: dir, env: { BAYZ_MASTER_KEY: KEY } });
  const providers = createProviderManager({ storage });
  const proxies = createProxyManager({ storage });
  const router = createRouter({ storage, providers, proxies });
  t.after(async () => {
    router.close();
    await origin.close();
  });

  providers.createProvider({
    id: "p1",
    kind: "openai-compatible",
    displayName: "P1",
    baseUrl: `http://127.0.0.1:${origin.port}/v1`,
    config: { allowLoopback: true },
  });
  router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });

  const result = await router.chat(REQUEST);
  assert.equal(result.content, COMPLETION);
});

test("logs remain free of prompt, completion, and credential", async (t) => {
  const origin = await startOrigin([{ status: 200, body: completion(COMPLETION) }]);
  const ctx = context();
  t.after(async () => {
    ctx.close();
    await origin.close();
  });

  seedProvider(ctx, "p1", origin.port);
  ctx.router.providers.setCredential("p1", CREDENTIAL);
  ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });
  await ctx.router.chat(REQUEST);

  const logs = ctx.logs.join("\n");
  for (const sentinel of [PROMPT, COMPLETION, CREDENTIAL, KEY]) {
    assert.equal(logs.includes(sentinel), false, `${sentinel.slice(0, 18)} leaked into logs`);
  }
});

test("every event shares the request id of its chat call", async (t) => {
  const origin = await startOrigin([{ status: 200, body: completion(COMPLETION) }]);
  const ctx = context();
  t.after(async () => {
    ctx.close();
    await origin.close();
  });

  seedProvider(ctx, "p1", origin.port);
  ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });
  await ctx.router.chat(REQUEST, { requestId: "req_supplied_1" });

  assert.ok(ctx.events.length >= 2);
  for (const event of ctx.events) {
    assert.equal(event.requestId, "req_supplied_1", "events must correlate");
  }
});

test("a hostile supplied request id is refused rather than recorded", async (t) => {
  const origin = await startOrigin([{ status: 200, body: completion(COMPLETION) }]);
  const ctx = context();
  t.after(async () => {
    ctx.close();
    await origin.close();
  });

  seedProvider(ctx, "p1", origin.port);
  ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });
  await ctx.router.chat(REQUEST, { requestId: `req ${PROMPT}` } as never);

  // A caller-supplied id that is not a safe slug is replaced, never stored.
  const serialized = JSON.stringify(ctx.events);
  assert.equal(serialized.includes(PROMPT), false);
  for (const event of ctx.events) {
    assert.match(String(event.requestId), /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/);
  }
});
