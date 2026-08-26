import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, connect, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProviderError, createProviderManager } from "@bayz/providers";
import { createProxyManager } from "@bayz/proxy";
import { openSecretStorage, type SecretStorage } from "@bayz/storage";
import { RouterError, createRouter, type Router } from "../src/index.js";

const KEY = Buffer.alloc(32, 0x61).toString("hex");
const PROMPT = "PROMPT-SENTINEL-must-never-be-persisted-or-logged";
const CREDENTIAL = "sk-router-credential-must-never-leak";

const sockets = new Set<Socket>();

function track(socket: Socket): Socket {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  return socket;
}

type Ctx = {
  router: Router;
  storage: SecretStorage;
  logs: Array<Record<string, unknown>>;
  close(): void;
};

function context(): Ctx {
  const dir = join(mkdtempSync(join(tmpdir(), "bayz-router-")), ".bayz");
  const logs: Array<Record<string, unknown>> = [];
  const storage = openSecretStorage({ dataDir: dir, env: { BAYZ_MASTER_KEY: KEY } });
  const logger = (payload: Record<string, unknown>): void => {
    logs.push(payload);
  };
  const providers = createProviderManager({ storage, logger });
  const proxies = createProxyManager({ storage, logger });
  const router = createRouter({ storage, providers, proxies, logger });
  return { router, storage, logs, close: () => router.close() };
}

/** A real origin whose behaviour per-request is scripted by the test. */
async function startOrigin(
  script: Array<{ status: number; body: unknown }>,
): Promise<{ port: number; close(): Promise<void>; hits: string[] }> {
  const hits: string[] = [];
  let index = 0;
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      hits.push(Buffer.concat(chunks).toString("utf8"));
      const step = script[Math.min(index, script.length - 1)]!;
      index += 1;
      response.writeHead(step.status, { "content-type": "application/json" });
      response.end(
        typeof step.body === "string" ? step.body : JSON.stringify(step.body),
      );
    });
  });
  server.on("connection", track);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function startConnectProxy(
  originPort: number,
): Promise<{ port: number; connects: string[]; close(): Promise<void> }> {
  const connects: string[] = [];
  const proxy = createServer((client) => {
    track(client);
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
      const upstream = track(
        connect({ host: "127.0.0.1", port: originPort }, () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (rest.length > 0) {
            upstream.write(rest);
          }
          client.pipe(upstream);
          upstream.pipe(client);
        }),
      );
      upstream.on("error", () => client.destroy());
    };
    client.on("data", onData);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const { port } = proxy.address() as AddressInfo;
  return {
    port,
    connects,
    close: () => new Promise<void>((resolve) => proxy.close(() => resolve())),
  };
}

function completion(content: string): unknown {
  return {
    id: "chatcmpl-1",
    model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  };
}

const REQUEST = {
  model: "gpt-4o",
  messages: [{ role: "user" as const, content: PROMPT }],
};

test("a chat request completes end to end through a registered route", async () => {
  const origin = await startOrigin([{ status: 200, body: completion("Hello!") }]);
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "p1",
      kind: "openai-compatible",
      displayName: "P1",
      baseUrl: `http://127.0.0.1:${origin.port}/v1`,
    });
    const route = ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });
    assert.equal(route.providerId, "p1");

    const result = await ctx.router.chat(REQUEST);
    assert.equal(result.content, "Hello!");
    assert.equal(result.routeId, "r1");
    assert.equal(result.providerId, "p1");
    assert.equal(result.proxyId, undefined);
    assert.equal(result.attempts, 1);
    assert.equal(typeof result.latencyMs, "number");
    assert.deepEqual(result.usage, {
      promptTokens: 5,
      completionTokens: 2,
      totalTokens: 7,
    });
    assert.equal(origin.hits.length, 1);
  } finally {
    ctx.close();
    await origin.close();
  }
});

test("the stored credential is attached without ever being returned", async () => {
  const origin = await startOrigin([{ status: 200, body: completion("ok") }]);
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "p1",
      kind: "openai-compatible",
      displayName: "P1",
      baseUrl: `http://127.0.0.1:${origin.port}/v1`,
    });
    ctx.router.providers.setCredential("p1", CREDENTIAL);
    ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });

    const result = await ctx.router.chat(REQUEST);
    assert.equal(result.content, "ok");
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(CREDENTIAL), false);
    assert.equal("credential" in result, false);
  } finally {
    ctx.close();
    await origin.close();
  }
});

test("a proxy-bound route really traverses the proxy", async () => {
  const origin = await startOrigin([{ status: 200, body: completion("via-proxy") }]);
  const proxy = await startConnectProxy(origin.port);
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "p1",
      kind: "openai-compatible",
      displayName: "P1",
      baseUrl: `http://127.0.0.1:${origin.port}/v1`,
    });
    ctx.router.proxies.createProxy({
      id: "x1",
      kind: "http",
      host: "127.0.0.1",
      port: proxy.port,
      config: {
        connectTimeoutMs: 3000,
        healthCheckHost: "127.0.0.1",
        healthCheckPort: origin.port,
      },
    });
    ctx.router.createRoute({
      id: "r1",
      model: "gpt-4o",
      providerId: "p1",
      proxyId: "x1",
    });

    const result = await ctx.router.chat(REQUEST);
    assert.equal(result.content, "via-proxy");
    assert.equal(result.proxyId, "x1");
    assert.equal(proxy.connects.length, 1, "the proxy must have opened a tunnel");
    assert.match(proxy.connects[0] ?? "", /^CONNECT 127\.0\.0\.1:/);
  } finally {
    ctx.close();
    await proxy.close();
    await origin.close();
  }
});

test("failover advances past an unreachable provider to a working one", async () => {
  const good = await startOrigin([{ status: 200, body: completion("second-wins") }]);
  // A port nothing listens on.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const deadPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "dead",
      kind: "openai-compatible",
      displayName: "Dead",
      baseUrl: `http://127.0.0.1:${deadPort}/v1`,
    });
    ctx.router.providers.createProvider({
      id: "live",
      kind: "openai-compatible",
      displayName: "Live",
      baseUrl: `http://127.0.0.1:${good.port}/v1`,
    });
    ctx.router.createRoute({
      id: "r-dead",
      model: "gpt-4o",
      providerId: "dead",
      priority: 900,
    });
    ctx.router.createRoute({
      id: "r-live",
      model: "gpt-4o",
      providerId: "live",
      priority: 100,
    });

    const result = await ctx.router.chat(REQUEST);
    assert.equal(result.content, "second-wins");
    assert.equal(result.routeId, "r-live");
    assert.equal(result.attempts, 2, "the failed attempt must be counted");
  } finally {
    ctx.close();
    await good.close();
  }
});

test("failover advances on rate_limited and on upstream_error", async () => {
  for (const status of [429, 500]) {
    const first = await startOrigin([{ status, body: { error: "no" } }]);
    const second = await startOrigin([{ status: 200, body: completion("recovered") }]);
    const ctx = context();
    try {
      ctx.router.providers.createProvider({
        id: "a",
        kind: "openai-compatible",
        displayName: "A",
        baseUrl: `http://127.0.0.1:${first.port}/v1`,
      });
      ctx.router.providers.createProvider({
        id: "b",
        kind: "openai-compatible",
        displayName: "B",
        baseUrl: `http://127.0.0.1:${second.port}/v1`,
      });
      ctx.router.createRoute({ id: "ra", model: "gpt-4o", providerId: "a", priority: 900 });
      ctx.router.createRoute({ id: "rb", model: "gpt-4o", providerId: "b", priority: 100 });

      const result = await ctx.router.chat(REQUEST);
      assert.equal(result.content, "recovered", `status ${status} must fail over`);
      assert.equal(result.routeId, "rb");
    } finally {
      ctx.close();
      await first.close();
      await second.close();
    }
  }
});

test("auth_failed stops immediately instead of trying another provider", async () => {
  const denied = await startOrigin([{ status: 401, body: { error: "bad key" } }]);
  const backup = await startOrigin([{ status: 200, body: completion("never-used") }]);
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "denied",
      kind: "openai-compatible",
      displayName: "Denied",
      baseUrl: `http://127.0.0.1:${denied.port}/v1`,
    });
    ctx.router.providers.createProvider({
      id: "backup",
      kind: "openai-compatible",
      displayName: "Backup",
      baseUrl: `http://127.0.0.1:${backup.port}/v1`,
    });
    ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "denied", priority: 900 });
    ctx.router.createRoute({ id: "r2", model: "gpt-4o", providerId: "backup", priority: 100 });

    await assert.rejects(
      ctx.router.chat(REQUEST),
      (error: unknown) =>
        error instanceof ProviderError && error.code === "auth_failed",
    );
    assert.equal(
      backup.hits.length,
      0,
      "a credential problem must surface, not be masked by another provider",
    );
  } finally {
    ctx.close();
    await denied.close();
    await backup.close();
  }
});

test("an invalid response stops immediately rather than failing over", async () => {
  const broken = await startOrigin([{ status: 200, body: { choices: [] } }]);
  const backup = await startOrigin([{ status: 200, body: completion("never-used") }]);
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "broken",
      kind: "openai-compatible",
      displayName: "Broken",
      baseUrl: `http://127.0.0.1:${broken.port}/v1`,
    });
    ctx.router.providers.createProvider({
      id: "backup",
      kind: "openai-compatible",
      displayName: "Backup",
      baseUrl: `http://127.0.0.1:${backup.port}/v1`,
    });
    ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "broken", priority: 900 });
    ctx.router.createRoute({ id: "r2", model: "gpt-4o", providerId: "backup", priority: 100 });

    await assert.rejects(
      ctx.router.chat(REQUEST),
      (error: unknown) =>
        error instanceof RouterError && error.code === "invalid_response",
    );
    assert.equal(backup.hits.length, 0);
  } finally {
    ctx.close();
    await broken.close();
    await backup.close();
  }
});

test("when every candidate fails the last real failure is raised", async () => {
  const first = await startOrigin([{ status: 500, body: { error: "a" } }]);
  const second = await startOrigin([{ status: 429, body: { error: "b" } }]);
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "a",
      kind: "openai-compatible",
      displayName: "A",
      baseUrl: `http://127.0.0.1:${first.port}/v1`,
    });
    ctx.router.providers.createProvider({
      id: "b",
      kind: "openai-compatible",
      displayName: "B",
      baseUrl: `http://127.0.0.1:${second.port}/v1`,
    });
    ctx.router.createRoute({ id: "ra", model: "gpt-4o", providerId: "a", priority: 900 });
    ctx.router.createRoute({ id: "rb", model: "gpt-4o", providerId: "b", priority: 100 });

    await assert.rejects(ctx.router.chat(REQUEST), (error: unknown) => {
      // The real upstream code is preserved instead of being flattened into a
      // generic "everything failed".
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "rate_limited");
      return true;
    });
  } finally {
    ctx.close();
    await first.close();
    await second.close();
  }
});

test("a model with no route is no_route and makes no request", async () => {
  const origin = await startOrigin([{ status: 200, body: completion("unused") }]);
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "p1",
      kind: "openai-compatible",
      displayName: "P1",
      baseUrl: `http://127.0.0.1:${origin.port}/v1`,
    });
    ctx.router.createRoute({ id: "r1", model: "claude-3*", providerId: "p1" });

    await assert.rejects(
      ctx.router.chat(REQUEST),
      (error: unknown) => error instanceof RouterError && error.code === "no_route",
    );
    assert.equal(origin.hits.length, 0);
  } finally {
    ctx.close();
    await origin.close();
  }
});

test("a disabled route is skipped", async () => {
  const origin = await startOrigin([{ status: 200, body: completion("unused") }]);
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "p1",
      kind: "openai-compatible",
      displayName: "P1",
      baseUrl: `http://127.0.0.1:${origin.port}/v1`,
    });
    ctx.router.createRoute({
      id: "r1",
      model: "gpt-4o",
      providerId: "p1",
      enabled: false,
    });
    await assert.rejects(
      ctx.router.chat(REQUEST),
      (error: unknown) => error instanceof RouterError && error.code === "no_route",
    );
    assert.equal(origin.hits.length, 0);
  } finally {
    ctx.close();
    await origin.close();
  }
});

test("a route whose provider is disabled is skipped", async () => {
  const origin = await startOrigin([{ status: 200, body: completion("unused") }]);
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "p1",
      kind: "openai-compatible",
      displayName: "P1",
      baseUrl: `http://127.0.0.1:${origin.port}/v1`,
      enabled: false,
    });
    ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });

    await assert.rejects(
      ctx.router.chat(REQUEST),
      (error: unknown) =>
        error instanceof RouterError && error.code === "all_routes_failed",
    );
    assert.equal(origin.hits.length, 0, "a disabled provider must not be dialled");
  } finally {
    ctx.close();
    await origin.close();
  }
});

test("an invalid request is refused before any route is consulted", async () => {
  const origin = await startOrigin([{ status: 200, body: completion("unused") }]);
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "p1",
      kind: "openai-compatible",
      displayName: "P1",
      baseUrl: `http://127.0.0.1:${origin.port}/v1`,
    });
    ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });

    for (const bad of [
      { ...REQUEST, stream: true },
      { ...REQUEST, messages: [] },
      { model: "../../etc/passwd", messages: REQUEST.messages },
      null,
    ]) {
      await assert.rejects(
        ctx.router.chat(bad as never),
        (error: unknown) =>
          error instanceof RouterError &&
          (error.code === "invalid_request" || error.code === "invalid_model"),
      );
    }
    assert.equal(origin.hits.length, 0);
  } finally {
    ctx.close();
    await origin.close();
  }
});

test("logs record routing metadata but never the prompt or completion", async () => {
  const origin = await startOrigin([
    { status: 200, body: completion("COMPLETION-SENTINEL") },
  ]);
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "p1",
      kind: "openai-compatible",
      displayName: "P1",
      baseUrl: `http://127.0.0.1:${origin.port}/v1`,
    });
    ctx.router.providers.setCredential("p1", CREDENTIAL);
    ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });
    await ctx.router.chat(REQUEST);

    const serialized = JSON.stringify(ctx.logs);
    assert.equal(serialized.includes(PROMPT), false, "no prompt may be logged");
    assert.equal(
      serialized.includes("COMPLETION-SENTINEL"),
      false,
      "no completion may be logged",
    );
    assert.equal(serialized.includes(CREDENTIAL), false);
    assert.equal(serialized.includes(KEY), false);

    const attempt = ctx.logs.find((entry) => entry.event === "router_attempt");
    assert.ok(attempt, "an attempt must be logged");
    assert.equal(attempt.routeId, "r1");
    assert.equal(attempt.providerId, "p1");
    assert.equal(attempt.proxied, false);
    assert.equal(attempt.outcome, "ok");
    assert.equal(typeof attempt.latencyMs, "number");
    assert.equal("prompt" in attempt, false);
    assert.equal("messages" in attempt, false);
    assert.equal("content" in attempt, false);
  } finally {
    ctx.close();
    await origin.close();
  }
});

test("a failed attempt is logged with its code and no body", async () => {
  const origin = await startOrigin([{ status: 500, body: { error: PROMPT } }]);
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "p1",
      kind: "openai-compatible",
      displayName: "P1",
      baseUrl: `http://127.0.0.1:${origin.port}/v1`,
    });
    ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });
    await assert.rejects(ctx.router.chat(REQUEST));

    const attempt = ctx.logs.find(
      (entry) => entry.event === "router_attempt" && entry.outcome === "failed",
    );
    assert.ok(attempt);
    assert.equal(attempt.code, "upstream_error");
    assert.equal(JSON.stringify(ctx.logs).includes(PROMPT), false);
  } finally {
    ctx.close();
    await origin.close();
  }
});

test("the prompt is absent from the database after a completed request", async () => {
  const origin = await startOrigin([{ status: 200, body: completion("done") }]);
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "p1",
      kind: "openai-compatible",
      displayName: "P1",
      baseUrl: `http://127.0.0.1:${origin.port}/v1`,
    });
    ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });
    await ctx.router.chat(REQUEST);

    // Nothing anywhere in the schema may hold the prompt.
    const tables = ctx.storage.sql
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name))
      .filter((name) => !name.startsWith("sqlite_"));
    for (const table of tables) {
      const rows = ctx.storage.sql.prepare(`SELECT * FROM ${table}`).all();
      const serialized = JSON.stringify(rows);
      assert.equal(
        serialized.includes(PROMPT),
        false,
        `${table} must not contain the prompt`,
      );
    }
  } finally {
    ctx.close();
    await origin.close();
  }
});

test("route management is exposed and delegates to the repository", () => {
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "p1",
      kind: "openai-compatible",
      displayName: "P1",
      baseUrl: "http://127.0.0.1:1/v1",
    });
    ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });
    assert.deepEqual(
      ctx.router.listRoutes().map((route) => route.id),
      ["r1"],
    );
    assert.equal(ctx.router.getRoute("r1")?.model, "gpt-4o");
    assert.equal(ctx.router.updateRoute("r1", { priority: 5 }).priority, 5);
    assert.equal(ctx.router.deleteRoute("r1"), true);
    assert.equal(ctx.router.getRoute("r1"), undefined);
  } finally {
    ctx.close();
  }
});

test("close releases the underlying storage exactly once", () => {
  const ctx = context();
  ctx.router.providers.createProvider({
    id: "p1",
    kind: "openai-compatible",
    displayName: "P1",
    baseUrl: "http://127.0.0.1:1/v1",
  });
  ctx.router.close();
  assert.throws(() => ctx.router.listRoutes());
});
