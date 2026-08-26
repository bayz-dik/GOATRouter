import assert from "node:assert/strict";
import test from "node:test";
import {
  MODEL_LIMIT_MAX,
  ProviderError,
  discoverOpenAiModels,
  type Fetcher,
} from "../src/index.js";

function jsonFetcher(payload: unknown, status = 200): { fetcher: Fetcher; calls: Array<{ url: string; headers: Headers }> } {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fetcher: Fetcher = async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers as HeadersInit | undefined),
    });
    return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetcher, calls };
}

const PROVIDER = {
  kind: "openai-compatible" as const,
  baseUrl: "https://api.example.com/v1",
  config: { timeoutMs: 5000, discoveryPath: "/models", modelLimit: 100 },
};

test("the OpenAI data envelope is accepted", async () => {
  const { fetcher, calls } = jsonFetcher({
    object: "list",
    data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }],
  });
  const models = await discoverOpenAiModels({ provider: PROVIDER, fetcher });
  assert.deepEqual(models, ["gpt-4o", "gpt-4o-mini"]);
  assert.equal(calls[0]?.url, "https://api.example.com/v1/models");
});

test("a bare array is accepted", async () => {
  const { fetcher } = jsonFetcher([{ id: "llama3" }, { id: "mistral" }]);
  assert.deepEqual(await discoverOpenAiModels({ provider: PROVIDER, fetcher }), [
    "llama3",
    "mistral",
  ]);
});

test("a credential is sent as a bearer token and never in the URL", async () => {
  const { fetcher, calls } = jsonFetcher({ data: [{ id: "m" }] });
  await discoverOpenAiModels({
    provider: PROVIDER,
    credential: "sk-secret-value",
    fetcher,
  });
  assert.equal(calls[0]?.headers.get("authorization"), "Bearer sk-secret-value");
  assert.equal(calls[0]?.url.includes("sk-secret-value"), false);
});

test("an openai-compatible provider may be queried without a credential", async () => {
  const { fetcher, calls } = jsonFetcher({ data: [{ id: "local" }] });
  assert.deepEqual(await discoverOpenAiModels({ provider: PROVIDER, fetcher }), [
    "local",
  ]);
  assert.equal(calls[0]?.headers.has("authorization"), false);
});

test("openrouter requires a credential before any network call", async () => {
  let called = false;
  const fetcher: Fetcher = async () => {
    called = true;
    return new Response("{}", { status: 200 });
  };
  await assert.rejects(
    discoverOpenAiModels({
      provider: { ...PROVIDER, kind: "openrouter", baseUrl: "https://openrouter.ai/api" },
      fetcher,
    }),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "credential_missing",
  );
  assert.equal(called, false, "no request may be made without the credential");
});

test("an empty or blank credential counts as missing", async () => {
  for (const credential of ["", "   "]) {
    await assert.rejects(
      discoverOpenAiModels({
        provider: { ...PROVIDER, kind: "openrouter" },
        credential,
        fetcher: async () => new Response("{}"),
      }),
      (error: unknown) =>
        error instanceof ProviderError && error.code === "credential_missing",
    );
  }
});

test("entries with unusable ids are skipped, not fatal", async () => {
  const { fetcher } = jsonFetcher({
    data: [
      { id: "good-model" },
      { id: "" },
      { id: "has space" },
      { id: "../../etc/passwd" },
      { id: "a".repeat(200) },
      { id: 42 },
      { id: null },
      "not-an-object",
      null,
      { noId: true },
      { id: "second-good.model_v2" },
    ],
  });
  assert.deepEqual(await discoverOpenAiModels({ provider: PROVIDER, fetcher }), [
    "good-model",
    "second-good.model_v2",
  ]);
});

test("duplicate ids collapse while preserving first-seen order", async () => {
  const { fetcher } = jsonFetcher({
    data: [{ id: "b" }, { id: "a" }, { id: "b" }, { id: "a" }, { id: "c" }],
  });
  assert.deepEqual(await discoverOpenAiModels({ provider: PROVIDER, fetcher }), [
    "b",
    "a",
    "c",
  ]);
});

test("the configured model limit caps the result", async () => {
  const { fetcher } = jsonFetcher({
    data: Array.from({ length: 50 }, (_unused, index) => ({ id: `m-${index}` })),
  });
  const models = await discoverOpenAiModels({
    provider: { ...PROVIDER, config: { ...PROVIDER.config, modelLimit: 3 } },
    fetcher,
  });
  assert.deepEqual(models, ["m-0", "m-1", "m-2"]);
});

test("a flood of entries is capped at the absolute maximum", async () => {
  const { fetcher } = jsonFetcher({
    data: Array.from({ length: 5000 }, (_unused, index) => ({ id: `m-${index}` })),
  });
  const models = await discoverOpenAiModels({
    provider: { ...PROVIDER, config: { ...PROVIDER.config, modelLimit: 500 } },
    fetcher,
    maxBytes: 1024 * 1024,
  });
  assert.equal(models.length, MODEL_LIMIT_MAX);
});

test("structurally wrong payloads fail as discovery_failed", async () => {
  for (const payload of [
    {},
    { data: {} },
    { data: "gpt-4o" },
    { models: [{ name: "models/x" }] },
    42,
    "gpt-4o",
    null,
    true,
  ]) {
    const { fetcher } = jsonFetcher(payload);
    await assert.rejects(
      discoverOpenAiModels({ provider: PROVIDER, fetcher }),
      (error: unknown) =>
        error instanceof ProviderError && error.code === "discovery_failed",
      `payload must be rejected: ${JSON.stringify(payload)}`,
    );
  }
});

test("a payload with only unusable entries fails rather than returning nothing", async () => {
  const { fetcher } = jsonFetcher({ data: [{ id: "has space" }, { id: "" }] });
  await assert.rejects(
    discoverOpenAiModels({ provider: PROVIDER, fetcher }),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "discovery_failed",
  );
});

test("an unparseable body is discovery_failed, not upstream_error", async () => {
  const { fetcher } = jsonFetcher("<html>gateway</html>");
  await assert.rejects(
    discoverOpenAiModels({ provider: PROVIDER, fetcher }),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "discovery_failed",
  );
});

test("upstream status failures keep their own codes", async () => {
  for (const [status, code] of [
    [401, "auth_failed"],
    [429, "rate_limited"],
    [500, "upstream_error"],
  ] as const) {
    const { fetcher } = jsonFetcher({ error: "sk-upstream-leak" }, status);
    await assert.rejects(
      discoverOpenAiModels({ provider: PROVIDER, fetcher }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError && error.code === code);
        assert.equal(error.message.includes("sk-upstream-leak"), false);
        return true;
      },
    );
  }
});

test("the discovery path is appended to the base url without doubling slashes", async () => {
  const { fetcher, calls } = jsonFetcher({ data: [{ id: "m" }] });
  await discoverOpenAiModels({
    provider: {
      ...PROVIDER,
      baseUrl: "http://127.0.0.1:11434",
      config: { ...PROVIDER.config, discoveryPath: "/v1/models" },
    },
    fetcher,
  });
  assert.equal(calls[0]?.url, "http://127.0.0.1:11434/v1/models");
});

test("codex-oauth discovery is refused as unsupported", async () => {
  await assert.rejects(
    discoverOpenAiModels({
      provider: { ...PROVIDER, kind: "codex-oauth" },
      credential: "token",
      fetcher: async () => new Response("{}"),
    }),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "unsupported_operation",
  );
});
