import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderError,
  discoverGeminiModels as discoverGeminiWithResolver,
  discoverOpenAiModels as discoverOpenAiWithResolver,
  type DiscoverGeminiOptions,
  type DiscoverOpenAiOptions,
  type Fetcher,
} from "../src/index.js";

/**
 * The resolver is stubbed so these tests do not depend on DNS. Without it the
 * pre-connect address check would really look up `generativelanguage.googleapis.com`,
 * making a unit test fail on an offline machine.
 */
const RESOLVES_PUBLIC = async () => ["142.250.72.106"];

function discoverGeminiModels(options: DiscoverGeminiOptions): Promise<string[]> {
  return discoverGeminiWithResolver({ resolve: RESOLVES_PUBLIC, ...options });
}

function discoverOpenAiModels(options: DiscoverOpenAiOptions): Promise<string[]> {
  return discoverOpenAiWithResolver({ resolve: RESOLVES_PUBLIC, ...options });
}

function jsonFetcher(payload: unknown, status = 200) {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fetcher: Fetcher = async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers as HeadersInit | undefined),
    });
    return new Response(
      typeof payload === "string" ? payload : JSON.stringify(payload),
      { status, headers: { "content-type": "application/json" } },
    );
  };
  return { fetcher, calls };
}

const GEMINI = {
  kind: "gemini" as const,
  baseUrl: "https://generativelanguage.googleapis.com",
  config: { timeoutMs: 5000, discoveryPath: "/v1beta/models", modelLimit: 100 },
};

const KEY = "AIza-test-credential-value";

test("the gemini models envelope is accepted and the models/ prefix stripped", async () => {
  const { fetcher, calls } = jsonFetcher({
    models: [
      { name: "models/gemini-2.0-flash" },
      { name: "models/gemini-1.5-pro" },
    ],
  });
  const models = await discoverGeminiModels({
    provider: GEMINI,
    credential: KEY,
    fetcher,
  });
  assert.deepEqual(models, ["gemini-2.0-flash", "gemini-1.5-pro"]);
  assert.equal(
    calls[0]?.url,
    "https://generativelanguage.googleapis.com/v1beta/models",
  );
});

test("a name without the prefix is still accepted", async () => {
  const { fetcher } = jsonFetcher({ models: [{ name: "gemini-2.0-flash" }] });
  assert.deepEqual(
    await discoverGeminiModels({ provider: GEMINI, credential: KEY, fetcher }),
    ["gemini-2.0-flash"],
  );
});

test("the credential travels in x-goog-api-key and never as a query parameter", async () => {
  const { fetcher, calls } = jsonFetcher({ models: [{ name: "models/m" }] });
  await discoverGeminiModels({ provider: GEMINI, credential: KEY, fetcher });

  const call = calls[0];
  assert.ok(call !== undefined);
  assert.equal(call.headers.get("x-goog-api-key"), KEY);
  assert.equal(call.headers.has("authorization"), false);
  assert.equal(call.url.includes(KEY), false, "no key may appear in the URL");
  assert.equal(call.url.includes("key="), false);
  assert.equal(call.url.includes("?"), false);
});

test("gemini refuses to run without a credential and makes no request", async () => {
  let called = false;
  const fetcher: Fetcher = async () => {
    called = true;
    return new Response("{}");
  };
  for (const credential of [undefined, "", "   "]) {
    await assert.rejects(
      discoverGeminiModels({ provider: GEMINI, credential, fetcher }),
      (error: unknown) =>
        error instanceof ProviderError && error.code === "credential_missing",
    );
  }
  assert.equal(called, false);
});

test("unusable gemini entries are skipped and duplicates collapse", async () => {
  const { fetcher } = jsonFetcher({
    models: [
      { name: "models/good-1" },
      { name: "models/" },
      { name: "models/has space" },
      { name: "models/../../etc/passwd" },
      { name: 42 },
      { displayName: "no name" },
      null,
      "models/string-entry",
      { name: "models/good-1" },
      { name: "models/good-2" },
    ],
  });
  assert.deepEqual(
    await discoverGeminiModels({ provider: GEMINI, credential: KEY, fetcher }),
    ["good-1", "good-2"],
  );
});

test("the gemini result honours the model limit and the absolute cap", async () => {
  const { fetcher } = jsonFetcher({
    models: Array.from({ length: 700 }, (_unused, index) => ({
      name: `models/m-${index}`,
    })),
  });
  assert.equal(
    (
      await discoverGeminiModels({
        provider: { ...GEMINI, config: { ...GEMINI.config, modelLimit: 5 } },
        credential: KEY,
        fetcher,
      })
    ).length,
    5,
  );
  assert.equal(
    (
      await discoverGeminiModels({
        provider: { ...GEMINI, config: { ...GEMINI.config, modelLimit: 500 } },
        credential: KEY,
        fetcher,
        maxBytes: 1024 * 1024,
      })
    ).length,
    500,
  );
});

test("structurally wrong gemini payloads fail as discovery_failed", async () => {
  for (const payload of [
    {},
    { models: {} },
    { data: [{ id: "gpt-4o" }] },
    [{ name: "models/x" }],
    "models/x",
    null,
    7,
  ]) {
    const { fetcher } = jsonFetcher(payload);
    await assert.rejects(
      discoverGeminiModels({ provider: GEMINI, credential: KEY, fetcher }),
      (error: unknown) =>
        error instanceof ProviderError && error.code === "discovery_failed",
      `payload must be rejected: ${JSON.stringify(payload)}`,
    );
  }
});

test("gemini upstream status failures map to the shared codes", async () => {
  for (const [status, code] of [
    [401, "auth_failed"],
    [403, "auth_failed"],
    [429, "rate_limited"],
    [500, "upstream_error"],
  ] as const) {
    const { fetcher } = jsonFetcher({ error: { message: KEY } }, status);
    await assert.rejects(
      discoverGeminiModels({ provider: GEMINI, credential: KEY, fetcher }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError && error.code === code);
        assert.equal(error.message.includes(KEY), false);
        return true;
      },
    );
  }
});

test("the gemini path refuses non-gemini kinds", async () => {
  for (const kind of ["openai-compatible", "openrouter", "codex-oauth"] as const) {
    await assert.rejects(
      discoverGeminiModels({
        provider: { ...GEMINI, kind },
        credential: KEY,
        fetcher: async () => new Response("{}"),
      }),
      (error: unknown) =>
        error instanceof ProviderError &&
        error.code === "unsupported_operation",
    );
  }
});

test("openrouter discovery uses the OpenAI wire format with a bearer token", async () => {
  const { fetcher, calls } = jsonFetcher({
    data: [{ id: "anthropic/claude-3.5-sonnet" }, { id: "google/gemini-flash-1.5" }],
  });
  const models = await discoverOpenAiModels({
    provider: {
      kind: "openrouter",
      baseUrl: "https://openrouter.ai/api",
      config: { timeoutMs: 5000, discoveryPath: "/v1/models", modelLimit: 100 },
    },
    credential: "sk-or-test",
    fetcher,
  });

  assert.deepEqual(models, [
    "anthropic/claude-3.5-sonnet",
    "google/gemini-flash-1.5",
  ]);
  assert.equal(calls[0]?.url, "https://openrouter.ai/api/v1/models");
  assert.equal(calls[0]?.headers.get("authorization"), "Bearer sk-or-test");
  assert.equal(calls[0]?.headers.has("x-goog-api-key"), false);
});
