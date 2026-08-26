import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openSecretStorage, type SecretStorage } from "@bayz/storage";
import {
  ProviderError,
  createProviderManager,
  type Fetcher,
  type ProviderManager,
} from "../src/index.js";

const KEY = Buffer.alloc(32, 0x5b).toString("hex");

type Ctx = {
  manager: ProviderManager;
  storage: SecretStorage;
  logs: Array<Record<string, unknown>>;
  close(): void;
};

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

function context(fetcher?: Fetcher): Ctx {
  const dir = join(mkdtempSync(join(tmpdir(), "bayz-provider-mgr-")), ".bayz");
  const logs: Array<Record<string, unknown>> = [];
  const storage = openSecretStorage({
    dataDir: dir,
    env: { BAYZ_MASTER_KEY: KEY },
  });
  const manager = createProviderManager({
    storage,
    fetcher,
    logger: (payload) => logs.push(payload),
  });
  return {
    manager,
    storage,
    logs,
    close: () => manager.close(),
  };
}

const LOCAL = {
  id: "local",
  kind: "openai-compatible" as const,
  displayName: "Local Llama",
  baseUrl: "http://127.0.0.1:11434/v1",
};

test("a provider can be created, listed, fetched, updated, and deleted", () => {
  const ctx = context();
  try {
    const created = ctx.manager.createProvider(LOCAL);
    assert.equal(created.id, "local");
    assert.equal(created.enabled, true);
    assert.equal(created.credentialPresent, false);

    assert.deepEqual(
      ctx.manager.listProviders().map((provider) => provider.id),
      ["local"],
    );
    assert.deepEqual(ctx.manager.getProvider("local"), created);

    const updated = ctx.manager.updateProvider("local", { enabled: false });
    assert.equal(updated.enabled, false);
    assert.equal(ctx.manager.getProvider("local")?.enabled, false);

    assert.equal(ctx.manager.deleteProvider("local"), true);
    assert.equal(ctx.manager.getProvider("local"), undefined);
    assert.equal(ctx.manager.deleteProvider("local"), false);
  } finally {
    ctx.close();
  }
});

test("a provider view reports credential presence without exposing the value", () => {
  const ctx = context();
  try {
    ctx.manager.createProvider(LOCAL);
    ctx.manager.setCredential("local", "sk-manager-secret");

    const view = ctx.manager.requireProvider("local");
    assert.equal(view.credentialPresent, true);
    const serialized = JSON.stringify(view);
    assert.equal(serialized.includes("sk-manager-secret"), false);
    assert.equal(Object.keys(view).includes("credential"), false);
    assert.equal(Object.keys(view).includes("apiKey"), false);
  } finally {
    ctx.close();
  }
});

test("credentials are stored, replaced, queried, and deleted", () => {
  const ctx = context();
  try {
    ctx.manager.createProvider(LOCAL);
    assert.equal(ctx.manager.hasCredential("local"), false);
    assert.equal(ctx.manager.deleteCredential("local"), false);

    ctx.manager.setCredential("local", "sk-first");
    assert.equal(ctx.manager.hasCredential("local"), true);
    ctx.manager.setCredential("local", "sk-second");
    assert.equal(ctx.manager.hasCredential("local"), true);

    assert.equal(ctx.manager.deleteCredential("local"), true);
    assert.equal(ctx.manager.hasCredential("local"), false);
  } finally {
    ctx.close();
  }
});

test("a blank credential is refused", () => {
  const ctx = context();
  try {
    ctx.manager.createProvider(LOCAL);
    for (const value of ["", "   ", 42 as unknown as string, undefined as unknown as string]) {
      assert.throws(
        () => ctx.manager.setCredential("local", value),
        (error: unknown) =>
          error instanceof ProviderError &&
          (error.code === "credential_missing" ||
            error.code === "invalid_provider_config"),
      );
    }
    assert.equal(ctx.manager.hasCredential("local"), false);
  } finally {
    ctx.close();
  }
});

test("credential operations on an unknown provider report provider_not_found", () => {
  const ctx = context();
  try {
    for (const call of [
      () => ctx.manager.setCredential("ghost", "sk-x"),
      () => ctx.manager.hasCredential("ghost"),
      () => ctx.manager.deleteCredential("ghost"),
      () => ctx.manager.requireProvider("ghost"),
    ]) {
      assert.throws(
        call,
        (error: unknown) =>
          error instanceof ProviderError && error.code === "provider_not_found",
      );
    }
  } finally {
    ctx.close();
  }
});

test("deleting a provider removes its credential too", () => {
  const ctx = context();
  try {
    ctx.manager.createProvider(LOCAL);
    ctx.manager.setCredential("local", "sk-doomed");
    assert.equal(ctx.storage.list().length, 1);

    ctx.manager.deleteProvider("local");
    assert.equal(
      ctx.storage.list().length,
      0,
      "an orphan credential would outlive its owner",
    );
  } finally {
    ctx.close();
  }
});

test("discovery dispatches to the OpenAI path and forwards the credential", async () => {
  const { fetcher, calls } = jsonFetcher({ data: [{ id: "llama3" }] });
  const ctx = context(fetcher);
  try {
    ctx.manager.createProvider(LOCAL);
    ctx.manager.setCredential("local", "sk-dispatch");

    assert.deepEqual(await ctx.manager.discoverModels("local"), ["llama3"]);
    assert.equal(calls[0]?.url, "http://127.0.0.1:11434/v1/v1/models");
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer sk-dispatch");
  } finally {
    ctx.close();
  }
});

test("discovery dispatches to the gemini path with the google header", async () => {
  const { fetcher, calls } = jsonFetcher({ models: [{ name: "models/flash" }] });
  const ctx = context(fetcher);
  try {
    ctx.manager.createProvider({
      id: "gem",
      kind: "gemini",
      displayName: "Gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
    });
    ctx.manager.setCredential("gem", "AIza-dispatch");

    assert.deepEqual(await ctx.manager.discoverModels("gem"), ["flash"]);
    assert.equal(calls[0]?.headers.get("x-goog-api-key"), "AIza-dispatch");
    assert.equal(calls[0]?.url.includes("AIza-dispatch"), false);
  } finally {
    ctx.close();
  }
});

test("discovery dispatches openrouter through the OpenAI wire format", async () => {
  const { fetcher, calls } = jsonFetcher({ data: [{ id: "vendor/model" }] });
  const ctx = context(fetcher);
  try {
    ctx.manager.createProvider({
      id: "or",
      kind: "openrouter",
      displayName: "OpenRouter",
    });
    ctx.manager.setCredential("or", "sk-or-dispatch");
    assert.deepEqual(await ctx.manager.discoverModels("or"), ["vendor/model"]);
    assert.equal(calls[0]?.url, "https://openrouter.ai/api/v1/models");
  } finally {
    ctx.close();
  }
});

test("discovery for a missing provider fails before any request", async () => {
  let called = false;
  const ctx = context(async () => {
    called = true;
    return new Response("{}");
  });
  try {
    await assert.rejects(
      ctx.manager.discoverModels("ghost"),
      (error: unknown) =>
        error instanceof ProviderError && error.code === "provider_not_found",
    );
    assert.equal(called, false);
  } finally {
    ctx.close();
  }
});

test("a disabled provider is not discovered", async () => {
  let called = false;
  const ctx = context(async () => {
    called = true;
    return new Response("{}");
  });
  try {
    ctx.manager.createProvider({ ...LOCAL, enabled: false });
    await assert.rejects(
      ctx.manager.discoverModels("local"),
      (error: unknown) =>
        error instanceof ProviderError &&
        error.code === "unsupported_operation",
    );
    assert.equal(called, false);
  } finally {
    ctx.close();
  }
});

test("codex-oauth is registrable but refuses credential and discovery work", async () => {
  const ctx = context();
  try {
    const created = ctx.manager.createProvider({
      id: "codex",
      kind: "codex-oauth",
      displayName: "Codex",
      baseUrl: "https://chatgpt.com/backend-api",
    });
    assert.equal(created.kind, "codex-oauth");

    assert.throws(
      () => ctx.manager.setCredential("codex", "token"),
      (error: unknown) =>
        error instanceof ProviderError &&
        error.code === "unsupported_operation",
    );
    await assert.rejects(
      ctx.manager.discoverModels("codex"),
      (error: unknown) =>
        error instanceof ProviderError &&
        error.code === "unsupported_operation",
    );
    // Storage queries stay honest rather than throwing.
    assert.equal(ctx.manager.hasCredential("codex"), false);
    assert.equal(ctx.manager.deleteCredential("codex"), false);
  } finally {
    ctx.close();
  }
});

test("manager logs carry ids and counts but never a credential", async () => {
  const { fetcher } = jsonFetcher({ data: [{ id: "m1" }, { id: "m2" }] });
  const ctx = context(fetcher);
  try {
    ctx.manager.createProvider(LOCAL);
    ctx.manager.setCredential("local", "sk-log-sentinel");
    await ctx.manager.discoverModels("local");
    ctx.manager.updateProvider("local", { displayName: "Renamed" });
    ctx.manager.deleteCredential("local");
    ctx.manager.deleteProvider("local");

    const serialized = JSON.stringify(ctx.logs);
    assert.equal(serialized.includes("sk-log-sentinel"), false);
    assert.equal(serialized.includes(KEY), false);
    assert.ok(ctx.logs.some((entry) => entry.event === "provider_created"));
    assert.ok(
      ctx.logs.some(
        (entry) => entry.event === "provider_models_discovered" && entry.count === 2,
      ),
    );
  } finally {
    ctx.close();
  }
});

test("close releases the underlying storage", () => {
  const ctx = context();
  ctx.manager.createProvider(LOCAL);
  ctx.manager.close();
  assert.throws(() => ctx.manager.listProviders());
});
