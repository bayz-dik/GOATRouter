import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, connect, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProviderManager } from "@bayz/providers";
import { createProxyManager } from "@bayz/proxy";
import { openSecretStorage, type SecretStorage } from "@bayz/storage";
import { createRouter, type Router } from "../src/index.js";

/**
 * Proxy resolution order: route override → provider default → direct.
 *
 * Everything here uses real CONNECT proxies and real origins, because the claim is
 * "the bytes went through that tunnel". A mocked agent could not distinguish a
 * resolution bug from a correct resolution, which is the whole question.
 */

const KEY = Buffer.alloc(32, 0x9f).toString("hex");
const CREDENTIAL = "sk-proxy-resolution-credential";
const PROMPT = "PROXY-RESOLUTION-PROMPT-must-never-be-persisted";

const sockets = new Set<Socket>();

function track(socket: Socket): Socket {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  return socket;
}

const COMPLETION = {
  model: "gpt-4o",
  choices: [
    { message: { role: "assistant", content: "resolved" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

type Origin = { port: number; hits: number; close(): Promise<void> };

async function startOrigin(): Promise<Origin> {
  const state = { hits: 0 };
  const server = createHttpServer((request, response) => {
    state.hits += 1;
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(COMPLETION));
    });
  });
  server.on("connection", track);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    get hits() {
      return state.hits;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

type Proxy = { port: number; connects: string[]; close(): Promise<void> };

/** A real HTTP CONNECT proxy that records every tunnel request head. */
async function startConnectProxy(originPort: number): Promise<Proxy> {
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
  return {
    port: (proxy.address() as AddressInfo).port,
    connects,
    close: () =>
      new Promise<void>((resolve) => {
        proxy.close(() => resolve());
      }),
  };
}

type Ctx = {
  router: Router;
  storage: SecretStorage;
  events: Array<Record<string, unknown>>;
  logs: Array<Record<string, unknown>>;
  close(): void;
};

function context(): Ctx {
  const dir = join(mkdtempSync(join(tmpdir(), "bayz-proxy-resolution-")), ".bayz");
  const storage = openSecretStorage({ dataDir: dir, env: { BAYZ_MASTER_KEY: KEY } });
  const events: Array<Record<string, unknown>> = [];
  const logs: Array<Record<string, unknown>> = [];
  const providers = createProviderManager({ storage });
  const proxies = createProxyManager({ storage });
  const router = createRouter({
    storage,
    providers,
    proxies,
    logger: (payload) => logs.push(payload),
    recorder: (event) => events.push(event),
  });
  return { router, storage, events, logs, close: () => router.close() };
}

const REQUEST = {
  model: "gpt-4o",
  messages: [{ role: "user", content: PROMPT }],
};

function seedProvider(ctx: Ctx, id: string, port: number, proxyId?: string): void {
  ctx.router.providers.createProvider({
    id,
    kind: "openai-compatible",
    displayName: id.toUpperCase(),
    baseUrl: `http://127.0.0.1:${port}/v1`,
    config: { allowLoopback: true },
    ...(proxyId === undefined ? {} : { proxyId }),
  });
  ctx.router.providers.setCredential(id, CREDENTIAL);
}

test("a route override beats the provider default", async (t) => {
  const origin = await startOrigin();
  const providerProxy = await startConnectProxy(origin.port);
  const routeProxy = await startConnectProxy(origin.port);
  const ctx = context();
  t.after(async () => {
    ctx.close();
    await Promise.all([origin.close(), providerProxy.close(), routeProxy.close()]);
  });

  ctx.router.proxies.createProxy({
    id: "provider-proxy",
    kind: "http",
    host: "127.0.0.1",
    port: providerProxy.port,
  });
  ctx.router.proxies.createProxy({
    id: "route-proxy",
    kind: "http",
    host: "127.0.0.1",
    port: routeProxy.port,
  });
  seedProvider(ctx, "p1", origin.port, "provider-proxy");
  ctx.router.createRoute({
    id: "r1",
    model: "gpt-4o",
    providerId: "p1",
    proxyId: "route-proxy",
  });

  const result = await ctx.router.chat(REQUEST);
  assert.equal(result.proxyId, "route-proxy");
  // The tunnel log is the only proof that matters: a resolution bug would report the
  // right id while sending the bytes somewhere else.
  assert.equal(routeProxy.connects.length, 1);
  assert.equal(providerProxy.connects.length, 0);
});

test("a route with no proxy inherits the provider default", async (t) => {
  const origin = await startOrigin();
  const providerProxy = await startConnectProxy(origin.port);
  const ctx = context();
  t.after(async () => {
    ctx.close();
    await Promise.all([origin.close(), providerProxy.close()]);
  });

  ctx.router.proxies.createProxy({
    id: "provider-proxy",
    kind: "http",
    host: "127.0.0.1",
    port: providerProxy.port,
  });
  seedProvider(ctx, "p1", origin.port, "provider-proxy");
  ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });

  const result = await ctx.router.chat(REQUEST);
  assert.equal(result.proxyId, "provider-proxy");
  assert.equal(providerProxy.connects.length, 1);
  assert.ok(providerProxy.connects[0]!.startsWith(`CONNECT 127.0.0.1:${origin.port}`));
});

test("neither set means direct", async (t) => {
  const origin = await startOrigin();
  const unusedProxy = await startConnectProxy(origin.port);
  const ctx = context();
  t.after(async () => {
    ctx.close();
    await Promise.all([origin.close(), unusedProxy.close()]);
  });

  ctx.router.proxies.createProxy({
    id: "unused",
    kind: "http",
    host: "127.0.0.1",
    port: unusedProxy.port,
  });
  seedProvider(ctx, "p1", origin.port);
  ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });

  const result = await ctx.router.chat(REQUEST);
  assert.equal(result.proxyId, undefined);
  assert.equal(unusedProxy.connects.length, 0);
  assert.equal(origin.hits, 1);
});

test("a route forced to direct beats the provider default", async (t) => {
  const origin = await startOrigin();
  const providerProxy = await startConnectProxy(origin.port);
  const ctx = context();
  t.after(async () => {
    ctx.close();
    await Promise.all([origin.close(), providerProxy.close()]);
  });

  ctx.router.proxies.createProxy({
    id: "provider-proxy",
    kind: "http",
    host: "127.0.0.1",
    port: providerProxy.port,
  });
  seedProvider(ctx, "p1", origin.port, "provider-proxy");
  // `forceDirect` is what makes "opt this one route out" expressible. Without it,
  // clearing a route's `proxyId` would mean "inherit", so an operator could not opt a
  // single route out of a proxied provider at all.
  ctx.router.createRoute({
    id: "r1",
    model: "gpt-4o",
    providerId: "p1",
    forceDirect: true,
  });

  const result = await ctx.router.chat(REQUEST);
  assert.equal(result.proxyId, undefined);
  assert.equal(providerProxy.connects.length, 0, "force-direct must not tunnel");
  assert.equal(origin.hits, 1);
});

test("forceDirect and an inherited proxy are distinguishable on the record", (t) => {
  const ctx = context();
  t.after(() => ctx.close());

  ctx.router.proxies.createProxy({
    id: "tunnel",
    kind: "socks5",
    host: "127.0.0.1",
    port: 1080,
  });
  ctx.router.providers.createProvider({
    id: "p1",
    kind: "openai-compatible",
    displayName: "P1",
    baseUrl: "https://api.example.com/v1",
    proxyId: "tunnel",
  });

  const inheriting = ctx.router.createRoute({ id: "r1", model: "a", providerId: "p1" });
  const forced = ctx.router.createRoute({
    id: "r2",
    model: "b",
    providerId: "p1",
    forceDirect: true,
  });

  assert.equal(inheriting.proxyId, undefined);
  assert.equal(inheriting.forceDirect, false);
  assert.equal(forced.proxyId, undefined);
  assert.equal(forced.forceDirect, true);
  // Both have `proxyId: undefined`, so the flag is the only thing that separates
  // "inherit" from "never proxy". Collapsing them would silently proxy r2.
  assert.notEqual(inheriting.forceDirect, forced.forceDirect);
});

test("forceDirect and an explicit route proxy cannot both be set", (t) => {
  const ctx = context();
  t.after(() => ctx.close());

  ctx.router.proxies.createProxy({
    id: "tunnel",
    kind: "socks5",
    host: "127.0.0.1",
    port: 1080,
  });
  ctx.router.providers.createProvider({
    id: "p1",
    kind: "openai-compatible",
    displayName: "P1",
    baseUrl: "https://api.example.com/v1",
  });

  // Contradictory intent. Picking a winner silently would mean the operator's config
  // does something they did not ask for.
  assert.throws(
    () =>
      ctx.router.createRoute({
        id: "r1",
        model: "a",
        providerId: "p1",
        proxyId: "tunnel",
        forceDirect: true,
      }),
    (error: unknown) =>
      error instanceof Error && String((error as { code?: unknown }).code) === "invalid_route_config",
  );
});

test("forceDirect can be set and cleared through update", (t) => {
  const ctx = context();
  t.after(() => ctx.close());

  ctx.router.providers.createProvider({
    id: "p1",
    kind: "openai-compatible",
    displayName: "P1",
    baseUrl: "https://api.example.com/v1",
  });
  ctx.router.createRoute({ id: "r1", model: "a", providerId: "p1" });

  assert.equal(ctx.router.updateRoute("r1", { forceDirect: true }).forceDirect, true);
  assert.equal(ctx.router.updateRoute("r1", { forceDirect: false }).forceDirect, false);
  // An omitted flag leaves it alone, like every other patch field.
  ctx.router.updateRoute("r1", { forceDirect: true });
  assert.equal(ctx.router.updateRoute("r1", { priority: 500 }).forceDirect, true);
});

test("setting a route proxy clears forceDirect rather than conflicting", (t) => {
  const ctx = context();
  t.after(() => ctx.close());

  ctx.router.proxies.createProxy({
    id: "tunnel",
    kind: "socks5",
    host: "127.0.0.1",
    port: 1080,
  });
  ctx.router.providers.createProvider({
    id: "p1",
    kind: "openai-compatible",
    displayName: "P1",
    baseUrl: "https://api.example.com/v1",
  });
  ctx.router.createRoute({ id: "r1", model: "a", providerId: "p1", forceDirect: true });

  // Assigning a proxy is unambiguous intent, so it wins and the flag goes. Refusing
  // here would make the operator issue two calls to express one decision.
  const updated = ctx.router.updateRoute("r1", { proxyId: "tunnel" });
  assert.equal(updated.proxyId, "tunnel");
  assert.equal(updated.forceDirect, false);
});

test("telemetry records the effective proxy, not the route's raw value", async (t) => {
  const origin = await startOrigin();
  const providerProxy = await startConnectProxy(origin.port);
  const ctx = context();
  t.after(async () => {
    ctx.close();
    await Promise.all([origin.close(), providerProxy.close()]);
  });

  ctx.router.proxies.createProxy({
    id: "provider-proxy",
    kind: "http",
    host: "127.0.0.1",
    port: providerProxy.port,
  });
  seedProvider(ctx, "p1", origin.port, "provider-proxy");
  ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });

  await ctx.router.chat(REQUEST);

  const completed = ctx.events.filter((event) => event.kind === "request.completed");
  assert.equal(completed.length, 1);
  // The route's own `proxyId` is undefined here. Recording that would tell an operator
  // reading telemetry that the request went direct when it went through a tunnel.
  assert.equal(completed[0]!.proxyId, "provider-proxy");

  // `proxied` is a log field rather than a telemetry field — the telemetry boundary
  // carries the id and derives the boolean — so it is asserted where it actually lives.
  const attempts = ctx.logs.filter((line) => line.event === "router_attempt");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]!.proxied, true);
});

test("telemetry reports direct for a force-direct route on a proxied provider", async (t) => {
  const origin = await startOrigin();
  const providerProxy = await startConnectProxy(origin.port);
  const ctx = context();
  t.after(async () => {
    ctx.close();
    await Promise.all([origin.close(), providerProxy.close()]);
  });

  ctx.router.proxies.createProxy({
    id: "provider-proxy",
    kind: "http",
    host: "127.0.0.1",
    port: providerProxy.port,
  });
  seedProvider(ctx, "p1", origin.port, "provider-proxy");
  ctx.router.createRoute({
    id: "r1",
    model: "gpt-4o",
    providerId: "p1",
    forceDirect: true,
  });

  await ctx.router.chat(REQUEST);
  const completed = ctx.events.filter((event) => event.kind === "request.completed");
  // Absent, not `null`: the telemetry boundary omits an unset id rather than recording
  // a placeholder, so "direct" and "proxied through something unnamed" stay distinct.
  assert.equal(completed[0]!.proxyId, undefined);
  assert.ok(!Object.hasOwn(completed[0]!, "proxyId"));

  const attempts = ctx.logs.filter((line) => line.event === "router_attempt");
  assert.equal(attempts[0]!.proxied, false);
});

test("the streaming path resolves the same way", async (t) => {
  const origin = await startOrigin();
  const providerProxy = await startConnectProxy(origin.port);
  const ctx = context();
  t.after(async () => {
    ctx.close();
    await Promise.all([origin.close(), providerProxy.close()]);
  });

  ctx.router.proxies.createProxy({
    id: "provider-proxy",
    kind: "http",
    host: "127.0.0.1",
    port: providerProxy.port,
  });
  seedProvider(ctx, "p1", origin.port, "provider-proxy");
  ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });

  // The origin here answers JSON rather than SSE, so the stream fails — but it fails
  // *after* dialling, which is what this asserts. Two resolution implementations, one
  // per path, would be the obvious way to get this wrong.
  await assert.rejects(async () => {
    for await (const chunk of ctx.router.chatStream(REQUEST)) {
      void chunk;
    }
  });
  assert.equal(providerProxy.connects.length, 1);
});

test("a provider default applies to every route to that provider", async (t) => {
  const origin = await startOrigin();
  const providerProxy = await startConnectProxy(origin.port);
  const ctx = context();
  t.after(async () => {
    ctx.close();
    await Promise.all([origin.close(), providerProxy.close()]);
  });

  ctx.router.proxies.createProxy({
    id: "provider-proxy",
    kind: "http",
    host: "127.0.0.1",
    port: providerProxy.port,
  });
  seedProvider(ctx, "p1", origin.port, "provider-proxy");
  ctx.router.createRoute({ id: "r1", model: "model-a", providerId: "p1" });
  ctx.router.createRoute({ id: "r2", model: "model-b", providerId: "p1" });

  // This is the whole point of a provider-level default: one decision, every route.
  for (const model of ["model-a", "model-b"]) {
    const result = await ctx.router.chat({ ...REQUEST, model });
    assert.equal(result.proxyId, "provider-proxy");
  }
  assert.equal(providerProxy.connects.length, 2);
});

test("reassigning the provider's proxy takes effect on the next request", async (t) => {
  const origin = await startOrigin();
  const first = await startConnectProxy(origin.port);
  const second = await startConnectProxy(origin.port);
  const ctx = context();
  t.after(async () => {
    ctx.close();
    await Promise.all([origin.close(), first.close(), second.close()]);
  });

  ctx.router.proxies.createProxy({
    id: "first",
    kind: "http",
    host: "127.0.0.1",
    port: first.port,
  });
  ctx.router.proxies.createProxy({
    id: "second",
    kind: "http",
    host: "127.0.0.1",
    port: second.port,
  });
  seedProvider(ctx, "p1", origin.port, "first");
  ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });

  await ctx.router.chat(REQUEST);
  ctx.router.providers.assignProxy("second", ["p1"]);
  await ctx.router.chat(REQUEST);

  // Read per attempt rather than cached, so a bulk reassignment is live immediately
  // instead of after a restart.
  assert.equal(first.connects.length, 1);
  assert.equal(second.connects.length, 1);
});

test("deleting the provider's proxy degrades to direct rather than failing", async (t) => {
  const origin = await startOrigin();
  const providerProxy = await startConnectProxy(origin.port);
  const ctx = context();
  t.after(async () => {
    ctx.close();
    await Promise.all([origin.close(), providerProxy.close()]);
  });

  ctx.router.proxies.createProxy({
    id: "provider-proxy",
    kind: "http",
    host: "127.0.0.1",
    port: providerProxy.port,
  });
  seedProvider(ctx, "p1", origin.port, "provider-proxy");
  ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });

  ctx.router.proxies.deleteProxy("provider-proxy");
  const result = await ctx.router.chat(REQUEST);
  // Degrade, never break: an operator removing a proxy has not asked to take their
  // providers offline.
  assert.equal(result.proxyId, undefined);
  assert.equal(origin.hits, 1);
});

test("a disabled provider proxy fails the attempt rather than silently going direct", async (t) => {
  const origin = await startOrigin();
  const providerProxy = await startConnectProxy(origin.port);
  const ctx = context();
  t.after(async () => {
    ctx.close();
    await Promise.all([origin.close(), providerProxy.close()]);
  });

  ctx.router.proxies.createProxy({
    id: "provider-proxy",
    kind: "http",
    host: "127.0.0.1",
    port: providerProxy.port,
  });
  seedProvider(ctx, "p1", origin.port, "provider-proxy");
  ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });
  ctx.router.proxies.updateProxy("provider-proxy", { enabled: false });

  // An operator who disabled a proxy has *not* consented to their traffic leaving
  // directly. That would be an unannounced deanonymisation, so the attempt fails
  // instead — the same rule a route-level proxy already followed.
  await assert.rejects(ctx.router.chat(REQUEST));
  assert.equal(origin.hits, 0, "no direct request may be made");
  assert.equal(providerProxy.connects.length, 0);
});

test("the effective proxy rides on every streamed chunk", async (t) => {
  const sse = createHttpServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({
        model: "gpt-4o",
        choices: [{ delta: { content: "hi" } }],
      })}\n\n`,
    );
    response.write("data: [DONE]\n\n");
    response.end();
  });
  sse.on("connection", track);
  await new Promise<void>((resolve) => sse.listen(0, "127.0.0.1", resolve));
  const ssePort = (sse.address() as AddressInfo).port;
  const providerProxy = await startConnectProxy(ssePort);
  const ctx = context();
  t.after(async () => {
    ctx.close();
    await providerProxy.close();
    await new Promise<void>((resolve) => {
      sse.closeAllConnections();
      sse.close(() => resolve());
    });
  });

  ctx.router.proxies.createProxy({
    id: "provider-proxy",
    kind: "http",
    host: "127.0.0.1",
    port: providerProxy.port,
  });
  seedProvider(ctx, "p1", ssePort, "provider-proxy");
  ctx.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });

  const seen: Array<string | undefined> = [];
  for await (const chunk of ctx.router.chatStream(REQUEST)) {
    seen.push(chunk.proxyId);
  }
  assert.ok(seen.length > 0);
  // The server writes `x-bayz-proxy` from the first chunk before any body byte, so the
  // chunk has to carry the *effective* value or the header would lie.
  assert.ok(seen.every((value) => value === "provider-proxy"));
});
