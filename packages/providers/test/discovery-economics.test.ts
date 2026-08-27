import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openSecretStorage, type SecretStorage } from "@bayz/storage";
import {
  MODEL_ECONOMICS,
  ProviderError,
  createProviderManager,
  discoverOpenAiCatalogue,
  type Fetcher,
  type ModelCatalogueEntry,
  type ProviderManager,
} from "../src/index.js";

/**
 * Discovery with economics attached.
 *
 * The invariant that matters most: `discoverModels` and `discoverModelCatalogue` must
 * agree on which models exist. A divergence would let the dashboard offer a model
 * routing cannot reach, or hide one it can.
 */

const KEY = Buffer.alloc(32, 0x5d).toString("hex");
const CREDENTIAL = "sk-discovery-economics-credential";
const RESOLVES_PUBLIC = async () => ["93.184.216.34"];

function jsonFetcher(payload: unknown, status = 200): {
  fetcher: Fetcher;
  calls: Array<{ url: string }>;
} {
  const calls: Array<{ url: string }> = [];
  const fetcher: Fetcher = async (input) => {
    calls.push({ url: String(input) });
    return new Response(
      typeof payload === "string" ? payload : JSON.stringify(payload),
      { status, headers: { "content-type": "application/json" } },
    );
  };
  return { fetcher, calls };
}

const PROVIDER = {
  kind: "openrouter" as const,
  baseUrl: "https://openrouter.ai/api",
  config: { timeoutMs: 5000, discoveryPath: "/v1/models", modelLimit: 100 },
};

function zero() {
  return { prompt: "0", completion: "0", request: "0", image: "0" };
}

function priced() {
  return { prompt: "0.000015", completion: "0.00006", request: "0", image: "0" };
}

async function catalogue(
  payload: unknown,
  overrides: Partial<typeof PROVIDER> = {},
): Promise<ModelCatalogueEntry[]> {
  const { fetcher } = jsonFetcher(payload);
  return discoverOpenAiCatalogue({
    provider: { ...PROVIDER, ...overrides },
    credential: CREDENTIAL,
    fetcher,
    resolve: RESOLVES_PUBLIC,
  });
}

type Origin = { base: string; close(): Promise<void> };

async function startOrigin(payload: unknown): Promise<Origin> {
  const server: Server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function harness(): { storage: SecretStorage; manager: ProviderManager } {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-discovery-econ-")), ".bayz");
  const storage = openSecretStorage({ dataDir, env: { BAYZ_MASTER_KEY: KEY } });
  return { storage, manager: createProviderManager({ storage }) };
}

test("the catalogue returns one entry per model with its classification", async () => {
  const entries = await catalogue({
    data: [
      { id: "free-model", pricing: zero() },
      { id: "paid-model", pricing: priced() },
      { id: "mystery-model" },
      { id: "tier-model", free_tier: true },
    ],
  });

  assert.deepEqual(entries, [
    { id: "free-model", economics: "FREE_VERIFIED" },
    { id: "paid-model", economics: "PAID" },
    { id: "mystery-model", economics: "UNKNOWN" },
    { id: "tier-model", economics: "FREE_TIER" },
  ]);
});

test("the model id set is identical to discoverModels for one response", async (t) => {
  const payload = {
    data: [
      { id: "a", pricing: zero() },
      { id: "b", pricing: priced() },
      { id: "c" },
      // Skipped by the id filter, and it must be skipped by *both* paths.
      { id: "<script>x</script>" },
      // A duplicate, deduplicated by both paths.
      { id: "a", pricing: priced() },
      { id: "" },
      { name: "no-id" },
    ],
  };
  const origin = await startOrigin(payload);
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });

  manager.createProvider({
    id: "p",
    kind: "custom-openai",
    displayName: "P",
    baseUrl: origin.base,
    config: { allowLoopback: true, timeoutMs: 5000 },
  });

  const models = await manager.discoverModels("p");
  const rows = await manager.discoverModelCatalogue("p");
  // Asserted from one upstream response, because a divergence would let the UI offer a
  // model routing cannot reach.
  assert.deepEqual(rows.map((row) => row.id), models);
});

test("the cap applies identically to both paths", async (t) => {
  const many = Array.from({ length: 300 }, (_v, index) => ({
    id: `m-${index}`,
    pricing: zero(),
  }));
  const origin = await startOrigin({ data: many });
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });

  manager.createProvider({
    id: "p",
    kind: "custom-openai",
    displayName: "P",
    baseUrl: origin.base,
    config: { allowLoopback: true, timeoutMs: 5000, modelLimit: 50 },
  });

  const models = await manager.discoverModels("p");
  const rows = await manager.discoverModelCatalogue("p");
  assert.equal(models.length, 50);
  assert.equal(rows.length, 50);
  assert.deepEqual(rows.map((row) => row.id), models);
});

test("dedupe keeps the first-seen entry's classification", async () => {
  const entries = await catalogue({
    data: [
      { id: "dup", pricing: zero() },
      { id: "dup", pricing: priced() },
    ],
  });
  // First-seen wins, matching `discoverModels`. Letting a later duplicate overwrite
  // would mean the two paths disagreed about the same id.
  assert.deepEqual(entries, [{ id: "dup", economics: "FREE_VERIFIED" }]);
});

test("an entry whose economics cannot be determined appears as UNKNOWN, not dropped", async () => {
  const entries = await catalogue({
    data: [{ id: "a", pricing: zero() }, { id: "b" }, { id: "c", pricing: null }],
  });
  // Hiding it would be a silent capability loss: the model exists and routing can
  // reach it, the operator just has no cost proof.
  assert.deepEqual(entries.map((entry) => entry.economics), [
    "FREE_VERIFIED",
    "UNKNOWN",
    "UNKNOWN",
  ]);
});

test("a gemini provider is UNKNOWN without loopback and LOCAL with it", async (t) => {
  const payload = { models: [{ name: "models/gemini-flash" }] };
  const origin = await startOrigin(payload);
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });

  // Written directly: a public Gemini base URL cannot be reached from a test, and the
  // classification is what is under test rather than the transport.
  manager.createProvider({
    id: "gem-local",
    kind: "gemini",
    displayName: "Gemini Local",
    baseUrl: origin.base,
    config: { allowLoopback: true, timeoutMs: 5000 },
  });
  manager.setCredential("gem-local", CREDENTIAL);
  assert.deepEqual(await manager.discoverModelCatalogue("gem-local"), [
    { id: "gemini-flash", economics: "LOCAL" },
  ]);

  // And without the opt-in the same catalogue is UNKNOWN. Google's free tier is real
  // but it is not machine-provable from this response, so asserting FREE_TIER here
  // would be BAYZ inventing a fact.
  const { fetcher } = jsonFetcher(payload);
  const { discoverGeminiCatalogue } = await import("../src/index.js");
  assert.deepEqual(
    await discoverGeminiCatalogue({
      provider: {
        kind: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com",
        config: { timeoutMs: 5000, discoveryPath: "/v1beta/models", modelLimit: 100 },
      },
      credential: CREDENTIAL,
      fetcher,
      resolve: RESOLVES_PUBLIC,
    }),
    [{ id: "gemini-flash", economics: "UNKNOWN" }],
  );
});

test("the raw catalogue entry never reaches the returned value", async () => {
  const entries = await catalogue({
    data: [
      {
        id: "leaky",
        pricing: zero(),
        description: "DESCRIPTION-SENTINEL",
        context_length: 128000,
        nested: { deep: { secret: "NESTED-SENTINEL" } },
        top_provider: { name: "SOMEONE" },
      },
    ],
  });

  assert.deepEqual(Object.keys(entries[0]!).sort(), ["economics", "id"]);
  const serialized = JSON.stringify(entries);
  for (const sentinel of ["DESCRIPTION-SENTINEL", "NESTED-SENTINEL", "SOMEONE", "128000"]) {
    assert.ok(!serialized.includes(sentinel), sentinel);
  }
});

test("every returned economics value is a member of the enum", async () => {
  const entries = await catalogue({
    data: [
      { id: "a", pricing: zero() },
      { id: "b", pricing: priced() },
      { id: "c" },
      { id: "d", free_tier: true },
      { id: "e", free_preview: true },
    ],
  });
  for (const entry of entries) {
    assert.ok((MODEL_ECONOMICS as readonly string[]).includes(entry.economics), entry.id);
  }
});

test("no pricing value or catalogue body appears in a log line", async (t) => {
  const origin = await startOrigin({
    data: [{ id: "m", pricing: { prompt: "0.000015", completion: "0.00006" }, description: "BODY-SENTINEL" }],
  });
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-discovery-econ-log-")), ".bayz");
  const storage = openSecretStorage({ dataDir, env: { BAYZ_MASTER_KEY: KEY } });
  const lines: Record<string, unknown>[] = [];
  const manager = createProviderManager({
    storage,
    logger: (payload) => lines.push(payload),
  });
  t.after(async () => {
    storage.close();
    await origin.close();
  });

  manager.createProvider({
    id: "p",
    kind: "custom-openai",
    displayName: "P",
    baseUrl: origin.base,
    config: { allowLoopback: true, timeoutMs: 5000 },
  });
  await manager.discoverModelCatalogue("p");

  assert.ok(lines.length > 0, "the discovery must be observable");
  const serialized = JSON.stringify(lines);
  assert.ok(!serialized.includes("BODY-SENTINEL"));
  assert.ok(!serialized.includes("0.000015"));
});

test("the catalogue path enforces the egress policy like every other request", async (t) => {
  const origin = await startOrigin({ data: [{ id: "m" }] });
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });

  storage.sql
    .prepare(
      `INSERT INTO providers
         (id, kind, display_name, base_url, enabled, config_json, created_at, updated_at)
       VALUES ('legacy', 'openai-compatible', 'Legacy', ?, 1,
               '{"timeoutMs":5000,"discoveryPath":"/v1/models","modelLimit":100}',
               't', 't')`,
    )
    .run(origin.base);

  await assert.rejects(
    manager.discoverModelCatalogue("legacy"),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "invalid_provider_config",
  );
});

test("a structurally broken response fails the same way on both paths", async (t) => {
  const origin = await startOrigin({ nonsense: true });
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });

  manager.createProvider({
    id: "p",
    kind: "custom-openai",
    displayName: "P",
    baseUrl: origin.base,
    config: { allowLoopback: true, timeoutMs: 5000 },
  });

  for (const call of [
    () => manager.discoverModels("p"),
    () => manager.discoverModelCatalogue("p"),
  ]) {
    await assert.rejects(
      call(),
      (error: unknown) =>
        error instanceof ProviderError && error.code === "discovery_failed",
    );
  }
});

test("a catalogue with no usable entry fails rather than returning nothing", async () => {
  await assert.rejects(
    catalogue({ data: [{ id: "<script>" }, { id: "" }, {}] }),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "discovery_failed",
  );
});
