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
import { createRouter, type CircuitOptions, type Router } from "../src/index.js";

/*
 * Circuit-breaker integration tests through a real router and real local HTTP
 * upstreams. These complement the pure unit tests in circuit.test.ts: they prove
 * the router actually consults the breaker, skips a tripped provider, allows a
 * half-open probe, and never double-delivers or spins.
 */

const KEY = Buffer.alloc(32, 0x42).toString("hex");
const PROMPT = "CIRCUIT-INTEGRATION-must-never-be-persisted";

type Origin = { port: number; hits: number[]; close(): Promise<void> };

/** Real HTTP origin that answers every request with one scripted status/body. */
async function startOrigin(
  responses: Array<{ status: number; body: unknown }>,
): Promise<Origin> {
  const hits: number[] = [];
  const server = createHttpServer((request, response) => {
    request.resume();
    request.on("end", () => {
      hits.push(1);
      const step = responses[Math.min(hits.length - 1, responses.length - 1)]!;
      response.writeHead(step.status, { "content-type": "application/json" });
      if (step.status === 200) {
        response.end(JSON.stringify(step.body));
      } else {
        response.end(JSON.stringify({ error: "upstream" }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function completion(content: string): unknown {
  return {
    id: "chatcmpl-cb",
    model: "gpt-4o",
    choices: [
      { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
    ],
  };
}

const REQUEST = {
  model: "gpt-4o",
  messages: [{ role: "user" as const, content: PROMPT }],
};

type Ctx = { router: Router; storage: SecretStorage; close(): void };

function context(circuit?: CircuitOptions): Ctx {
  const dir = join(mkdtempSync(join(tmpdir(), "bayz-router-cb-")), ".bayz");
  const storage = openSecretStorage({ dataDir: dir, env: { BAYZ_MASTER_KEY: KEY } });
  const providers = createProviderManager({ storage });
  const proxies = createProxyManager({ storage });
  const router = createRouter({ storage, providers, proxies, circuit });
  return { router, storage, close: () => router.close() };
}

/** Register provider `id` -> origin `port` with the given routing priority. */
function seed(router: Router, id: string, port: number, priority: number): void {
  router.providers.createProvider({
    id,
    kind: "openai-compatible",
    displayName: id,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    config: { allowLoopback: true },
  });
  router.createRoute({
    freeOnly: false,
    id: `route-${id}`,
    model: "gpt-4o",
    providerId: id,
    priority,
  });
}

test("after three transient failures a provider's circuit opens and the next request skips it", async () => {
  const bad = await startOrigin([{ status: 503, body: {} }]);
  const good = await startOrigin([{ status: 200, body: completion("good") }]);
  const ctx = context({ threshold: 3 });
  try {
    seed(ctx.router, "bad", bad.port, 200);
    seed(ctx.router, "good", good.port, 100);

    // Three requests each fail over from bad to good.
    for (let i = 0; i < 3; i += 1) {
      const result = await ctx.router.chat(REQUEST);
      assert.equal(result.content, "good");
    }
    assert.equal(bad.hits.length, 3, "three transient failures expected");
    assert.equal(ctx.router.circuitState("bad"), "open");

    // Next request: bad is skipped entirely, good serves alone.
    const before = bad.hits.length;
    const result = await ctx.router.chat(REQUEST);
    assert.equal(result.content, "good");
    assert.equal(result.attempts, 1, "bad must not be attempted once tripped");
    assert.equal(bad.hits.length, before, "bad must receive no further request");
  } finally {
    ctx.close();
    await bad.close();
    await good.close();
  }
});

test("after the cooldown elapses a half-open probe reaches the provider and a clean success closes", async () => {
  let now = 1_000_000;
  // First two hits fail (trip), the third (half-open probe) succeeds.
  const bad = await startOrigin([
    { status: 503, body: {} },
    { status: 503, body: {} },
    { status: 200, body: completion("recovered") },
    { status: 200, body: completion("recovered") },
  ]);
  const good = await startOrigin([{ status: 200, body: completion("good") }]);
  const ctx = context({ threshold: 2, cooldownMs: 30_000, now: () => now });
  try {
    seed(ctx.router, "bad", bad.port, 200);
    seed(ctx.router, "good", good.port, 100);

    // Two failures trip the circuit (threshold 2).
    await ctx.router.chat(REQUEST);
    await ctx.router.chat(REQUEST);
    assert.equal(ctx.router.circuitState("bad"), "open");
    assert.equal(bad.hits.length, 2);

    // Within cooldown, bad is skipped.
    await ctx.router.chat(REQUEST);
    assert.equal(bad.hits.length, 2, "no probe before cooldown elapses");

    // Cooldown elapses; next request lets bad through as the half-open probe.
    now += 31_000;
    const result = await ctx.router.chat(REQUEST);
    assert.equal(result.content, "recovered", "half-open probe hits bad and succeeds");
    assert.equal(result.providerId, "bad");
    assert.equal(ctx.router.circuitState("bad"), "closed");
    assert.equal(bad.hits.length, 3);

    // Reset: bad serves normally again.
    await ctx.router.chat(REQUEST);
    assert.equal(bad.hits.length, 4, "circuit closed, bad is back in normal rotation");
  } finally {
    ctx.close();
    await bad.close();
    await good.close();
  }
});

test("a failed half-open probe re-opens the circuit", async () => {
  let now = 1_000_000;
  const bad = await startOrigin([{ status: 503, body: {} }]);
  const good = await startOrigin([{ status: 200, body: completion("good") }]);
  const ctx = context({ threshold: 2, cooldownMs: 30_000, now: () => now });
  try {
    seed(ctx.router, "bad", bad.port, 200);
    seed(ctx.router, "good", good.port, 100);

    await ctx.router.chat(REQUEST);
    await ctx.router.chat(REQUEST);
    assert.equal(ctx.router.circuitState("bad"), "open");

    now += 31_000; // cooldown elapses
    await ctx.router.chat(REQUEST); // probe reaches bad, fails -> re-open
    assert.equal(ctx.router.circuitState("bad"), "open");
    assert.equal(bad.hits.length, 3);

    // Fresh cooldown; bad skipped again.
    const before = bad.hits.length;
    await ctx.router.chat(REQUEST);
    assert.equal(bad.hits.length, before, "bad must be skipped after re-open");
  } finally {
    ctx.close();
    await bad.close();
    await good.close();
  }
});

test("a successful buffered call resets the transient streak", async () => {
  const bad = await startOrigin([
    { status: 503, body: {} },
    { status: 200, body: completion("ok-after-fail") },
  ]);
  const good = await startOrigin([{ status: 200, body: completion("good") }]);
  const ctx = context({ threshold: 3 });
  try {
    seed(ctx.router, "bad", bad.port, 200);
    seed(ctx.router, "good", good.port, 100);

    // One failure at bad -> fail over to good (success resets bad's streak via good? No —
    // here bad itself succeeds on the second request).
    // First request: bad 503 -> good.
    await ctx.router.chat(REQUEST);
    assert.equal(bad.hits.length, 1);
    // Now let bad themselves serve one success.
    // Force bad to succeed by sending its second scripted response... but the
    // router picks bad first by priority. After one failure the streak is 1; we
    // need bad to succeed next. It will, since its second response is 200.
    // But priority 200 means bad is tried first on every request.
    const result = await ctx.router.chat(REQUEST);
    // bad succeeds now (200) -> resets streak.
    assert.equal(result.providerId, "bad");
    assert.equal(result.content, "ok-after-fail");
    assert.equal(ctx.router.circuitState("bad"), "closed");
    // bad should not be tripped (fewer than threshold) and serves again.
    await ctx.router.chat(REQUEST);
    assert.equal(ctx.router.circuitState("bad"), "closed");
  } finally {
    ctx.close();
    await bad.close();
    await good.close();
  }
});

test("two bad candidates cannot spin: attempt budget is bounded by candidates", async () => {
  const first = await startOrigin([
    { status: 429, body: {} },
    { status: 429, body: {} },
    { status: 429, body: {} },
    { status: 429, body: {} },
  ]);
  const second = await startOrigin([
    { status: 503, body: {} },
    { status: 503, body: {} },
  ]);
  const ctx = context({ threshold: 3 });
  try {
    seed(ctx.router, "a", first.port, 200);
    seed(ctx.router, "b", second.port, 100);

    // One request: a fails (429, streak 1) then b fails (503, streak 1) -> all routes failed.
    await assert.rejects(ctx.router.chat(REQUEST));
    assert.equal(first.hits.length, 1);
    assert.equal(second.hits.length, 1);

    // Repeat. a fails (streak 2) -> b fails (streak 2) -> all failed. Still bounded.
    await assert.rejects(ctx.router.chat(REQUEST));
    assert.equal(first.hits.length, 2, "a must be bounded to one attempt per request");
    assert.equal(second.hits.length, 2, "b must be bounded to one attempt per request");
  } finally {
    ctx.close();
    await first.close();
    await second.close();
  }
});

test("an auth failure on the only candidate never trips the circuit", async () => {
  let now = 1_000_000;
  const denied = await startOrigin([{ status: 401, body: {} }]);
  const ctx = context({ threshold: 3, cooldownMs: 30_000, now: () => now });
  try {
    seed(ctx.router, "denied", denied.port, 100);

    for (let i = 0; i < 5; i += 1) {
      await assert.rejects(ctx.router.chat(REQUEST));
      // Auth failures do not open the circuit: they are not transient upstream
      // problems, they are credential/config problems that must surface.
      assert.equal(ctx.router.circuitState("denied"), "closed");
    }
    assert.equal(denied.hits.length, 5, "every auth failure reaches the upstream");
  } finally {
    ctx.close();
    await denied.close();
  }
});

/** Real SSE origin answering each stream request. */
async function startSseOrigin(deltas: string[]): Promise<Origin> {
  const hits: number[] = [];
  const server = createHttpServer((request, response) => {
    request.resume();
    request.on("end", () => {
      hits.push(1);
      if (!response.writableEnded) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const delta of deltas) {
          response.write(
            `data: ${JSON.stringify({ model: "gpt-4o", choices: [{ delta: { content: delta } }] })}\n\n`,
          );
        }
        response.write("data: [DONE]\n\n");
        response.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("a tripped provider is skipped by the streaming path and the healthy one serves", async () => {
  const bad = await startOrigin([{ status: 503, body: {} }]);
  const good = await startSseOrigin(["stream-good"]);
  const ctx = context({ threshold: 3 });
  try {
    // Seed ONLY bad first so warmup trips its circuit without touching good.
    seed(ctx.router, "bad", bad.port, 200);
    for (let i = 0; i < 3; i += 1) {
      try {
        await ctx.router.chat(REQUEST);
      } catch {
        // bad is the only candidate; each chat fails over nowhere (all failed)
        // but still counts the transient failure toward the circuit.
      }
    }
    assert.equal(ctx.router.circuitState("bad"), "open");

    // Now the healthy provider becomes the fallback.
    seed(ctx.router, "good", good.port, 100);

    // Streaming request must skip bad entirely and serve from good, attempts == 1.
    const before = bad.hits.length;
    let served = "";
    let attempts = 0;
    for await (const chunk of ctx.router.chatStream(REQUEST)) {
      served += chunk.contentDelta ?? "";
      attempts = chunk.attempts;
    }
    assert.equal(served, "stream-good");
    assert.equal(attempts, 1, "streaming must skip the tripped provider");
    assert.equal(bad.hits.length, before, "tripped provider must see no stream request");
  } finally {
    ctx.close();
    await bad.close();
    await good.close();
  }
});

test("a tool-call response survives failover onto another provider", async () => {
  const first = await startOrigin([{ status: 503, body: {} }]);
  const second = await startOrigin([
    {
      status: 200,
      body: {
        id: "chatcmpl-tools",
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "ping", arguments: '{"a":1}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    },
  ]);
  const ctx = context({ threshold: 3 });
  try {
    seed(ctx.router, "a", first.port, 200);
    seed(ctx.router, "b", second.port, 100);

    const result = await ctx.router.chat(REQUEST);
    assert.equal(result.finishReason, "tool_calls");
    assert.equal(result.providerId, "b");
    assert.deepEqual(result.toolCalls, [
      { id: "call_1", type: "function", function: { name: "ping", arguments: '{"a":1}' } },
    ]);
    assert.equal(result.routeId, "route-b");
  } finally {
    ctx.close();
    await first.close();
    await second.close();
  }
});
