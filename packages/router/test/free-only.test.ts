import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProviderManager } from "@bayz/providers";
import { createProxyManager } from "@bayz/proxy";
import { openSecretStorage, type SecretStorage } from "@bayz/storage";
import {
  RouterError,
  createRouter,
  filterFreeCandidates,
  isFreeCandidate,
  type Router,
} from "../src/index.js";
import type { RouteRecord } from "../src/repository.js";

/**
 * Free-only routing (spec §25).
 *
 * The assertion that carries the weight in this file is `origin.hits.length === 0` at a
 * paid origin: a test that only checks the error code would pass even if BAYZ had made
 * the request and then thrown. Money is spent at the socket, so that is where the
 * evidence has to come from.
 */

const KEY = Buffer.alloc(32, 0x62).toString("hex");
const CREDENTIAL = "sk-free-only-test-credential";

/**
 * A non-loopback address to bind test origins to.
 *
 * Loopback cannot be used for most of this file: `allowLoopback` is exactly what makes
 * the classifier return `LOCAL`, so a loopback origin can never exercise the pricing
 * evidence path. A private LAN address is reachable here, is classified `private`, and
 * needs a deliberate `allowPrivate` opt-in — which is the posture a real non-local
 * provider has.
 */
const PRIVATE_HOST = (() => {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }
  return undefined;
})();

type Ctx = {
  router: Router;
  storage: SecretStorage;
  events: Array<Record<string, unknown>>;
  close(): void;
};

function context(): Ctx {
  const dir = join(mkdtempSync(join(tmpdir(), "bayz-free-only-")), ".bayz");
  const events: Array<Record<string, unknown>> = [];
  const storage = openSecretStorage({ dataDir: dir, env: { BAYZ_MASTER_KEY: KEY } });
  const providers = createProviderManager({ storage });
  const proxies = createProxyManager({ storage });
  const router = createRouter({
    storage,
    providers,
    proxies,
    recorder: (event) => events.push(event),
  });
  return { router, storage, events, close: () => router.close() };
}

/**
 * An origin that serves both a catalogue and chat completions.
 *
 * `pricing` is what makes the classifier decide: real prices in the `/models` response
 * rather than a hand-set economics value, so the test exercises the same path a real
 * provider takes.
 */
async function startOrigin(options: {
  models: unknown[];
  chat?: { status: number; body: unknown };
  /** Bind loopback instead, for the one test that needs a LOCAL classification. */
  loopback?: boolean;
  /**
   * Awaited when a chat request arrives, before the response is written.
   *
   * This is how the mid-failover test reclassifies a provider *during* a request
   * rather than before one: the hook runs while the router is still inside its
   * attempt loop, which is the only way to exercise the per-attempt recheck.
   */
  onChat?: () => void | Promise<void>;
}): Promise<{
  port: number;
  host: string;
  hits: string[];
  chatHits: number;
  close(): Promise<void>;
}> {
  const hits: string[] = [];
  const state = { chatHits: 0 };
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      void (async () => {
        const url = request.url ?? "";
        hits.push(url);
        if (url.includes("/models")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ data: options.models }));
          return;
        }
        state.chatHits += 1;
        await options.onChat?.();
        const step = options.chat ?? {
          status: 200,
          body: {
            id: "chatcmpl-free",
            model: "m",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
          },
        };
        response.writeHead(step.status, { "content-type": "application/json" });
        response.end(JSON.stringify(step.body));
      })();
    });
  });
  const host =
    options.loopback === true ? "127.0.0.1" : (PRIVATE_HOST ?? "127.0.0.1");
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    host,
    hits,
    get chatHits() {
      return state.chatHits;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const FREE_PRICING = {
  prompt: "0",
  completion: "0",
  request: "0",
  image: "0",
};

const PAID_PRICING = {
  prompt: "0.0000015",
  completion: "0.000002",
  request: "0",
  image: "0",
};

const REQUEST = {
  model: "shared-model",
  messages: [{ role: "user" as const, content: "hello" }],
};

function route(overrides: Partial<RouteRecord> = {}): RouteRecord {
  return {
    id: "r1",
    model: "m",
    providerId: "p1",
    proxyId: undefined,
    forceDirect: false,
    freeOnly: true,
    priority: 100,
    enabled: true,
    config: { maxAttempts: 2, requestTimeoutMs: 1000 },
    createdAt: "t",
    updatedAt: "t",
    ...overrides,
  };
}

// --- The pure rule, asserted first and separately -------------------------------

test("an UNKNOWN candidate is not free", () => {
  // Asserted before anything else in this file, and separately, because it is the one
  // classification a lenient implementation would let through: "we could not determine
  // the price" reads like a maybe, and treating it as free is a real bill.
  assert.equal(isFreeCandidate("UNKNOWN"), false);
  assert.equal(isFreeCandidate(undefined), false);
});

test("PAID is not free and every proven-free classification is", () => {
  assert.equal(isFreeCandidate("PAID"), false);
  for (const economics of ["FREE_VERIFIED", "FREE_TIER", "FREE_PREVIEW", "LOCAL"] as const) {
    assert.equal(isFreeCandidate(economics), true, economics);
  }
});

test("filtering keeps every candidate when the route is not free-only", () => {
  const candidates = [route({ id: "r1", freeOnly: false })];
  const kept = filterFreeCandidates(candidates, () => "PAID");
  assert.equal(kept.length, 1);
});

test("the flag is per route, so two routes for one model can differ", () => {
  const candidates = [
    route({ id: "free", providerId: "pf", freeOnly: true }),
    route({ id: "paid", providerId: "pp", freeOnly: false }),
  ];
  // Same model, same economics lookup, different outcome — which is the point: an
  // operator can keep one paid escape hatch without weakening the other route.
  const kept = filterFreeCandidates(candidates, () => "PAID");
  assert.deepEqual(
    kept.map((entry) => entry.id),
    ["paid"],
  );
});

// --- End to end, against real origins ------------------------------------------

test("a free-only route reaches a provider whose catalogue proves zero pricing", async () => {
  const origin = await startOrigin({
    models: [{ id: "shared-model", pricing: FREE_PRICING }],
  });
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "free1",
      kind: "openai-compatible",
      displayName: "Free",
      baseUrl: `http://${origin.host}:${origin.port}/v1`,
      config: { allowPrivate: true },
    });
    ctx.router.providers.setCredential("free1", CREDENTIAL);
    await ctx.router.providers.refreshModelCatalogue("free1");
    ctx.router.createRoute({ id: "r1", model: "shared-model", providerId: "free1" });

    const result = await ctx.router.chat(REQUEST);
    assert.equal(result.content, "ok");
    assert.equal(origin.chatHits, 1);
  } finally {
    ctx.close();
    await origin.close();
  }
});

test("a free-only route refuses a PAID provider without touching its origin", async () => {
  const origin = await startOrigin({
    models: [{ id: "shared-model", pricing: PAID_PRICING }],
  });
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "paid1",
      kind: "openai-compatible",
      displayName: "Paid",
      baseUrl: `http://${origin.host}:${origin.port}/v1`,
      config: { allowPrivate: true },
    });
    ctx.router.providers.setCredential("paid1", CREDENTIAL);
    await ctx.router.providers.refreshModelCatalogue("paid1");
    const before = origin.chatHits;
    ctx.router.createRoute({ id: "r1", model: "shared-model", providerId: "paid1" });

    await assert.rejects(
      () => ctx.router.chat(REQUEST),
      (error: unknown) =>
        error instanceof RouterError && error.code === "no_free_route",
    );
    // The assertion that proves nothing was spent.
    assert.equal(origin.chatHits, before);
  } finally {
    ctx.close();
    await origin.close();
  }
});

test("a catalogue with no pricing is UNKNOWN and is refused", async () => {
  const origin = await startOrigin({
    // No pricing field at all: the upstream asserted nothing, so BAYZ knows nothing.
    models: [{ id: "shared-model" }],
  });
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "unknown1",
      kind: "openai-compatible",
      displayName: "Unknown",
      baseUrl: `http://${origin.host}:${origin.port}/v1`,
      config: { allowPrivate: true },
    });
    ctx.router.providers.setCredential("unknown1", CREDENTIAL);
    await ctx.router.providers.refreshModelCatalogue("unknown1");
    const before = origin.chatHits;
    ctx.router.createRoute({ id: "r1", model: "shared-model", providerId: "unknown1" });

    await assert.rejects(
      () => ctx.router.chat(REQUEST),
      (error: unknown) =>
        error instanceof RouterError && error.code === "no_free_route",
    );
    assert.equal(origin.chatHits, before);
  } finally {
    ctx.close();
    await origin.close();
  }
});

test("a route with no catalogue at all fails before any upstream request", async () => {
  const origin = await startOrigin({ models: [] });
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "never",
      kind: "openai-compatible",
      displayName: "Never discovered",
      baseUrl: `http://${origin.host}:${origin.port}/v1`,
      config: { allowPrivate: true },
    });
    ctx.router.createRoute({ id: "r1", model: "shared-model", providerId: "never" });

    await assert.rejects(
      () => ctx.router.chat(REQUEST),
      (error: unknown) => {
        if (!(error instanceof RouterError) || error.code !== "no_free_route") {
          return false;
        }
        // Names no model and no provider: this message reaches logs.
        assert.equal(error.message.includes("shared-model"), false);
        assert.equal(error.message.includes("never"), false);
        return true;
      },
    );
    // Not one request, not even a discovery call: the refusal is a pure read of cached
    // state.
    assert.equal(origin.hits.length, 0);

    const failures = ctx.events.filter((event) => event.kind === "request.failed");
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.failureCategory, "no_free_route");
    assert.equal(failures[0]?.attempts, 0);
    // No candidate list in telemetry.
    assert.equal("providerId" in (failures[0] ?? {}), false);
    assert.equal("routeId" in (failures[0] ?? {}), false);
  } finally {
    ctx.close();
    await origin.close();
  }
});

test("a loopback provider is LOCAL and routable on a free-only route", async () => {
  const origin = await startOrigin({
    // Priced in the catalogue, and irrelevant: a local runtime costs the operator
    // nothing per token whatever its catalogue claims.
    models: [{ id: "shared-model", pricing: PAID_PRICING }],
    loopback: true,
  });
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "local1",
      kind: "openai-compatible",
      displayName: "Local",
      baseUrl: `http://${origin.host}:${origin.port}/v1`,
      config: { allowLoopback: true },
    });
    await ctx.router.providers.refreshModelCatalogue("local1");
    assert.equal(ctx.router.providers.modelEconomics("local1", "shared-model"), "LOCAL");
    ctx.router.createRoute({ id: "r1", model: "shared-model", providerId: "local1" });

    const result = await ctx.router.chat(REQUEST);
    assert.equal(result.content, "ok");
  } finally {
    ctx.close();
    await origin.close();
  }
});

// --- The no-fallback rule, one test per plausible excuse ------------------------

for (const failure of [
  { label: "fails outright", status: 500 },
  { label: "is rate limited", status: 429 },
  { label: "returns a 5xx", status: 503 },
] as const) {
  test(`no paid fallback when the free candidate ${failure.label}`, async () => {
    const freeOrigin = await startOrigin({
      models: [{ id: "shared-model", pricing: FREE_PRICING }],
      chat: { status: failure.status, body: { error: "upstream" } },
    });
    const paidOrigin = await startOrigin({
      models: [{ id: "shared-model", pricing: PAID_PRICING }],
    });
    const ctx = context();
    try {
      ctx.router.providers.createProvider({
        id: "free1",
        kind: "openai-compatible",
        displayName: "Free",
        baseUrl: `http://${freeOrigin.host}:${freeOrigin.port}/v1`,
        config: { allowPrivate: true },
      });
      ctx.router.providers.createProvider({
        id: "paid1",
        kind: "openai-compatible",
        displayName: "Paid",
        baseUrl: `http://${paidOrigin.host}:${paidOrigin.port}/v1`,
        config: { allowPrivate: true },
      });
      ctx.router.providers.setCredential("free1", CREDENTIAL);
      ctx.router.providers.setCredential("paid1", CREDENTIAL);
      await ctx.router.providers.refreshModelCatalogue("free1");
      await ctx.router.providers.refreshModelCatalogue("paid1");
      const paidBefore = paidOrigin.chatHits;

      // Both routes free-only, both healthy in configuration terms. The paid one is
      // reachable and would answer — which is exactly why its silence is the proof.
      ctx.router.createRoute({
        id: "free",
        model: "shared-model",
        providerId: "free1",
        priority: 200,
      });
      ctx.router.createRoute({
        id: "paid",
        model: "shared-model",
        providerId: "paid1",
        priority: 100,
      });

      await assert.rejects(() => ctx.router.chat(REQUEST));
      // The free candidate was tried and failed; the paid one was never asked.
      assert.ok(freeOrigin.chatHits >= 1);
      assert.equal(paidOrigin.chatHits, paidBefore);
    } finally {
      ctx.close();
      await freeOrigin.close();
      await paidOrigin.close();
    }
  });
}

test("a candidate reclassified PAID mid-failover is not attempted", async () => {
  /*
   * The per-attempt recheck, isolated.
   *
   * Both candidates are FREE_VERIFIED when the request starts, so the up-front filter
   * admits both. The first one's chat handler reclassifies the second — rediscovering it
   * against an origin that now reports a price — and *then* fails, which drops the router
   * into failover holding a stale classification for the remaining candidate.
   *
   * The load-bearing assertion is `paidSecond.chatHits === 0`. Without the per-attempt
   * recheck the second candidate is attempted, returns 200, and `chat()` resolves — so
   * this test fails loudly rather than subtly if the recheck is removed.
   *
   * The surfaced error is the first candidate's upstream failure, not `no_free_route`:
   * a free candidate really was tried and really did fail, and reporting a
   * free-only refusal instead would misattribute a provider outage to policy.
   */
  const freeSecond = await startOrigin({
    models: [{ id: "shared-model", pricing: FREE_PRICING }],
  });
  const paidSecond = await startOrigin({
    models: [{ id: "shared-model", pricing: PAID_PRICING }],
  });
  let reclassify: (() => Promise<void>) | undefined;
  const firstOrigin = await startOrigin({
    models: [{ id: "shared-model", pricing: FREE_PRICING }],
    chat: { status: 503, body: { error: "down" } },
    onChat: async () => {
      await reclassify?.();
    },
  });
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "first",
      kind: "openai-compatible",
      displayName: "First",
      baseUrl: `http://${firstOrigin.host}:${firstOrigin.port}/v1`,
      config: { allowPrivate: true },
    });
    ctx.router.providers.createProvider({
      id: "second",
      kind: "openai-compatible",
      displayName: "Second",
      baseUrl: `http://${freeSecond.host}:${freeSecond.port}/v1`,
      config: { allowPrivate: true },
    });
    ctx.router.providers.setCredential("first", CREDENTIAL);
    ctx.router.providers.setCredential("second", CREDENTIAL);
    await ctx.router.providers.refreshModelCatalogue("first");
    await ctx.router.providers.refreshModelCatalogue("second");
    assert.equal(
      ctx.router.providers.modelEconomics("second", "shared-model"),
      "FREE_VERIFIED",
    );

    ctx.router.createRoute({
      id: "a",
      model: "shared-model",
      providerId: "first",
      priority: 200,
    });
    ctx.router.createRoute({
      id: "b",
      model: "shared-model",
      providerId: "second",
      priority: 100,
    });

    reclassify = async () => {
      ctx.router.providers.updateProvider("second", {
        baseUrl: `http://${paidSecond.host}:${paidSecond.port}/v1`,
      });
      await ctx.router.providers.refreshModelCatalogue("second");
    };

    await assert.rejects(() => ctx.router.chat(REQUEST));

    assert.equal(ctx.router.providers.modelEconomics("second", "shared-model"), "PAID");
    assert.ok(firstOrigin.chatHits >= 1);
    assert.equal(paidSecond.chatHits, 0);
  } finally {
    ctx.close();
    await firstOrigin.close();
    await freeSecond.close();
    await paidSecond.close();
  }
});

test("disabling free-only lets the paid provider through", async () => {
  const origin = await startOrigin({
    models: [{ id: "shared-model", pricing: PAID_PRICING }],
  });
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "paid1",
      kind: "openai-compatible",
      displayName: "Paid",
      baseUrl: `http://${origin.host}:${origin.port}/v1`,
      config: { allowPrivate: true },
    });
    ctx.router.providers.setCredential("paid1", CREDENTIAL);
    await ctx.router.providers.refreshModelCatalogue("paid1");
    const created = ctx.router.createRoute({
      id: "r1",
      model: "shared-model",
      providerId: "paid1",
      freeOnly: false,
    });
    assert.equal(created.freeOnly, false);

    const result = await ctx.router.chat(REQUEST);
    assert.equal(result.content, "ok");
  } finally {
    ctx.close();
    await origin.close();
  }
});

test("a new route defaults to free-only", () => {
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "p1",
      kind: "openai-compatible",
      displayName: "P1",
      baseUrl: "https://api.example.com/v1",
      config: {},
    });
    const created = ctx.router.createRoute({ id: "r1", model: "m", providerId: "p1" });
    // Absent means on. An older client that knows nothing about this field must not be
    // able to create a route that can spend money.
    assert.equal(created.freeOnly, true);

    const patched = ctx.router.updateRoute("r1", { freeOnly: false });
    assert.equal(patched.freeOnly, false);
    assert.equal(ctx.router.requireRoute("r1").freeOnly, false);
  } finally {
    ctx.close();
  }
});
