import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProviderManager } from "@bayz/providers";
import { createProxyManager } from "@bayz/proxy";
import { openSecretStorage } from "@bayz/storage";
import { RouterError, createRouter, type ChatChunk, type Router } from "../src/index.js";

/*
 * Every route in this file sets `freeOnly: false`.
 *
 * These tests predate free-only routing and assert proxying, telemetry, failover, and
 * adversarial behaviour — not economics. Their fixture origins serve chat responses
 * without a catalogue, so every model here classifies as undiscovered, and an
 * undiscovered model is not free (spec §25 rule 5). Leaving the schema default of
 * free-only ON would make all of them fail `no_free_route` for a reason none of them is
 * about. Free-only enforcement itself is covered in `free-only.test.ts`.
 */

const KEY = Buffer.alloc(32, 0x31).toString("hex");
const PROMPT = "ROUTER-STREAM-PROMPT-must-never-be-recorded";
const CREDENTIAL = "sk-router-stream-credential";

type OriginController = {
  port: number;
  requests: number;
  close(): Promise<void>;
};

async function startOrigin(
  handler: (write: (text: string) => void, end: () => void, destroy: () => void) => void,
  status = 200,
): Promise<OriginController> {
  const state = { requests: 0 };
  const server: Server = createServer((request, response) => {
    state.requests += 1;
    request.resume();
    response.writeHead(status, { "content-type": "text/event-stream" });
    handler(
      (text) => {
        if (!response.writableEnded) {
          response.write(text);
        }
      },
      () => {
        if (!response.writableEnded) {
          response.end();
        }
      },
      () => response.socket?.destroy(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    get requests() {
      return state.requests;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function frame(content: string): string {
  return `data: ${JSON.stringify({
    model: "stream-model",
    choices: [{ delta: { content } }],
  })}\n\n`;
}

function harness(): { router: Router; events: Record<string, unknown>[] } {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-router-stream-")), ".bayz");
  const storage = openSecretStorage({ dataDir, env: { BAYZ_MASTER_KEY: KEY } });
  const providers = createProviderManager({ storage });
  const proxies = createProxyManager({ storage });
  const events: Record<string, unknown>[] = [];
  const router = createRouter({
    storage,
    providers,
    proxies,
    recorder: (event) => events.push(event),
  });
  return { router, events };
}

function seedProvider(
  router: Router,
  id: string,
  port: number,
  priority: number,
): void {
  router.providers.createProvider({
    id,
    kind: "openai-compatible",
    displayName: id,
    baseUrl: `http://127.0.0.1:${port}`,
    config: { allowLoopback: true },
  });
  router.providers.setCredential(id, CREDENTIAL);
  router.createRoute({
    freeOnly: false,
    id: `route-${id}`,
    model: "stream-model",
    providerId: id,
    priority,
  });
}

const REQUEST = {
  model: "stream-model",
  messages: [{ role: "user", content: PROMPT }],
};

async function collect(iterable: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  return chunks;
}

test("a healthy stream yields deltas and completes", async (t) => {
  const origin = await startOrigin((write, end) => {
    write(frame("a"));
    write(frame("b"));
    write("data: [DONE]\n\n");
    end();
  });
  const { router, events } = harness();
  t.after(async () => {
    router.close();
    await origin.close();
  });
  seedProvider(router, "p1", origin.port, 100);

  const chunks = await collect(router.chatStream(REQUEST));
  assert.deepEqual(
    chunks.map((chunk) => chunk.contentDelta),
    ["a", "b"],
  );
  const kinds = events.map((event) => event.kind);
  assert.ok(kinds.includes("provider.attempted"));
  assert.ok(kinds.includes("request.completed"));
});

test("a failing first candidate fails over before any byte is emitted", async (t) => {
  const dead = await startOrigin((_write, end) => end(), 503);
  const alive = await startOrigin((write, end) => {
    write(frame("recovered"));
    write("data: [DONE]\n\n");
    end();
  });
  const { router, events } = harness();
  t.after(async () => {
    router.close();
    await dead.close();
    await alive.close();
  });
  seedProvider(router, "dead", dead.port, 200);
  seedProvider(router, "alive", alive.port, 10);

  const chunks = await collect(router.chatStream(REQUEST));
  // The consumer sees only the successful stream. A partial failed stream leaking
  // through would be worse than a plain failure.
  assert.deepEqual(
    chunks.map((chunk) => chunk.contentDelta),
    ["recovered"],
  );
  assert.equal(dead.requests, 1);
  assert.equal(alive.requests, 1);
  const completed = events.find((event) => event.kind === "request.completed");
  assert.equal(completed?.attempts, 2);
  assert.equal(completed?.providerId, "alive");
  assert.equal(completed?.routingMode, "failover");
});

test("once the first chunk is emitted, no failover is attempted", async (t) => {
  // The honest boundary. After a byte reaches the consumer the response is
  // committed: BAYZ cannot un-send it, so retrying elsewhere would produce two
  // interleaved completions. The second origin must observe zero requests.
  const breaking = await startOrigin((write, _end, destroy) => {
    write(frame("partial"));
    setTimeout(destroy, 30);
  });
  const backup = await startOrigin((write, end) => {
    write(frame("should-never-be-used"));
    write("data: [DONE]\n\n");
    end();
  });
  const { router, events } = harness();
  t.after(async () => {
    router.close();
    await breaking.close();
    await backup.close();
  });
  seedProvider(router, "breaking", breaking.port, 200);
  seedProvider(router, "backup", backup.port, 10);

  const seen: (string | undefined)[] = [];
  await assert.rejects(async () => {
    for await (const chunk of router.chatStream(REQUEST)) {
      seen.push(chunk.contentDelta);
    }
  });
  assert.deepEqual(seen, ["partial"]);
  assert.equal(backup.requests, 0, "no failover may occur after the first byte");
  const failed = events.find((event) => event.kind === "request.failed");
  assert.ok(failed !== undefined);
  assert.equal(failed.attempts, 1);
});

test("a stream that ends without DONE records request.failed with invalid_response", async (t) => {
  const origin = await startOrigin((write, end) => {
    write(frame("truncated"));
    end();
  });
  const { router, events } = harness();
  t.after(async () => {
    router.close();
    await origin.close();
  });
  seedProvider(router, "p1", origin.port, 100);

  await assert.rejects(
    () => collect(router.chatStream(REQUEST)),
    (error: unknown) =>
      error instanceof RouterError && error.code === "invalid_response",
  );
  const failed = events.find((event) => event.kind === "request.failed");
  assert.equal(failed?.failureCategory, "invalid_response");
});

test("token counts from a terminal usage chunk are recorded", async (t) => {
  const origin = await startOrigin((write, end) => {
    write(frame("a"));
    write(
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      })}\n\n`,
    );
    write("data: [DONE]\n\n");
    end();
  });
  const { router, events } = harness();
  t.after(async () => {
    router.close();
    await origin.close();
  });
  seedProvider(router, "p1", origin.port, 100);

  await collect(router.chatStream(REQUEST));
  const completed = events.find((event) => event.kind === "request.completed");
  assert.equal(completed?.promptTokens, 7);
  assert.equal(completed?.completionTokens, 3);
});

test("absent usage stays undefined in telemetry, never zero", async (t) => {
  const origin = await startOrigin((write, end) => {
    write(frame("a"));
    write("data: [DONE]\n\n");
    end();
  });
  const { router, events } = harness();
  t.after(async () => {
    router.close();
    await origin.close();
  });
  seedProvider(router, "p1", origin.port, 100);

  await collect(router.chatStream(REQUEST));
  const completed = events.find((event) => event.kind === "request.completed");
  assert.equal("promptTokens" in (completed ?? {}), false);
  assert.equal("completionTokens" in (completed ?? {}), false);
});

test("the prompt appears in no emitted telemetry event", async (t) => {
  const origin = await startOrigin((write, end) => {
    write(frame("a"));
    write("data: [DONE]\n\n");
    end();
  });
  const { router, events } = harness();
  t.after(async () => {
    router.close();
    await origin.close();
  });
  seedProvider(router, "p1", origin.port, 100);

  await collect(router.chatStream(REQUEST));
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes(PROMPT));
  assert.ok(!serialized.includes(CREDENTIAL));
  assert.ok(serialized.length > 0);
});

test("no route yields no_route before any upstream call", async (t) => {
  const { router } = harness();
  t.after(() => router.close());

  await assert.rejects(
    () => collect(router.chatStream(REQUEST)),
    (error: unknown) => error instanceof RouterError && error.code === "no_route",
  );
});

test("a malformed request is refused before route selection", async (t) => {
  const { router, events } = harness();
  t.after(() => router.close());

  await assert.rejects(
    () => collect(router.chatStream({ model: "stream-model" })),
    (error: unknown) => error instanceof RouterError && error.code === "invalid_request",
  );
  assert.equal(events.length, 0, "a request that never entered routing emits nothing");
});

test("a client abort stops the upstream and does not fail over", async (t) => {
  const origin = await startOrigin((write) => {
    write(frame("a"));
  });
  const backup = await startOrigin((write, end) => {
    write(frame("unused"));
    write("data: [DONE]\n\n");
    end();
  });
  const { router } = harness();
  t.after(async () => {
    router.close();
    await origin.close();
    await backup.close();
  });
  seedProvider(router, "primary", origin.port, 200);
  seedProvider(router, "backup", backup.port, 10);

  const controller = new AbortController();
  await assert.rejects(async () => {
    for await (const chunk of router.chatStream(REQUEST, {
      signal: controller.signal,
    })) {
      assert.equal(chunk.contentDelta, "a");
      controller.abort();
    }
  });
  assert.equal(backup.requests, 0, "a client cancellation is not a provider failure");
});

test("a disabled provider is skipped without consuming an attempt", async (t) => {
  const origin = await startOrigin((write, end) => {
    write(frame("ok"));
    write("data: [DONE]\n\n");
    end();
  });
  const { router, events } = harness();
  t.after(async () => {
    router.close();
    await origin.close();
  });
  seedProvider(router, "disabled", origin.port, 200);
  seedProvider(router, "enabled", origin.port, 10);
  router.providers.updateProvider("disabled", { enabled: false });

  await collect(router.chatStream(REQUEST));
  const completed = events.find((event) => event.kind === "request.completed");
  assert.equal(completed?.attempts, 1);
  assert.equal(completed?.providerId, "enabled");
});

test("a non-failover error surfaces without trying another provider", async (t) => {
  // auth_failed is an operator problem. Silently succeeding elsewhere would hide a
  // broken credential indefinitely.
  const denied = await startOrigin((_write, end) => end(), 401);
  const backup = await startOrigin((write, end) => {
    write(frame("unused"));
    write("data: [DONE]\n\n");
    end();
  });
  const { router } = harness();
  t.after(async () => {
    router.close();
    await denied.close();
    await backup.close();
  });
  seedProvider(router, "denied", denied.port, 200);
  seedProvider(router, "backup", backup.port, 10);

  await assert.rejects(() => collect(router.chatStream(REQUEST)));
  assert.equal(backup.requests, 0);
});
