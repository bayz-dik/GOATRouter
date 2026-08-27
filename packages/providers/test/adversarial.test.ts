import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  StorageError,
  databasePath,
  openSecretStorage,
  type SecretStorage,
} from "@bayz/storage";
import {
  ProviderError,
  createProviderManager,
  type Fetcher,
  type ProviderManager,
} from "../src/index.js";

/**
 * Adversarial suite for the Provider Manager.
 *
 * These tests attack the stored artifacts and the public surface directly rather
 * than exercising the happy path: a hostile upstream, an operator-supplied id
 * crafted for injection, and an attacker with write access to bayz.db.
 */

const KEY = Buffer.alloc(32, 0x77).toString("hex");
const CREDENTIAL = "sk-live-PROVIDER-ADVERSARIAL-must-never-surface";

function context(fetcher?: Fetcher): {
  manager: ProviderManager;
  storage: SecretStorage;
  dir: string;
  logs: Array<Record<string, unknown>>;
} {
  const dir = join(mkdtempSync(join(tmpdir(), "bayz-provider-adv-")), ".bayz");
  const logs: Array<Record<string, unknown>> = [];
  const storage = openSecretStorage({
    dataDir: dir,
    env: { BAYZ_MASTER_KEY: KEY },
  });
  return {
    manager: createProviderManager({
      storage,
      fetcher,
      logger: (payload) => logs.push(payload),
    }),
    storage,
    dir,
    logs,
  };
}

function sourceFiles(): string[] {
  const root = new URL("../src/", import.meta.url);
  const files: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(new URL(relative, root), {
      withFileTypes: true,
    })) {
      if (entry.isDirectory()) {
        walk(`${relative}${entry.name}/`);
      } else if (entry.name.endsWith(".ts")) {
        files.push(
          readFileSync(new URL(`${relative}${entry.name}`, root), "utf8"),
        );
      }
    }
  };
  walk("");
  return files;
}

test("no credential read path exists anywhere in the package source", () => {
  const sources = sourceFiles();
  assert.ok(sources.length >= 8, "the scan must actually find the sources");
  for (const source of sources) {
    assert.equal(
      /getCredential|revealCredential|exportCredential/.test(source),
      false,
      "a credential accessor would let plaintext leave the manager",
    );
  }
});

test("the manager surface exposes no credential accessor", () => {
  const ctx = context();
  try {
    const keys = Object.keys(ctx.manager);
    for (const forbidden of [
      "getCredential",
      "credential",
      "apiKey",
      "secrets",
      "storage",
      "sql",
    ]) {
      assert.equal(keys.includes(forbidden), false, `${forbidden} must not be public`);
    }
  } finally {
    ctx.manager.close();
  }
});

test("a credential lives at exactly one scoped physical name", () => {
  const ctx = context();
  try {
    ctx.manager.createProvider({
      id: "victim",
      kind: "openai-compatible",
      displayName: "Victim",
      baseUrl: "http://127.0.0.1:11434/v1",
      config: { allowLoopback: true },
    });
    ctx.manager.setCredential("victim", CREDENTIAL);

    const names = ctx.storage.list().map((meta) => meta.name);
    assert.deepEqual(names, ["provider:victim:api_key"]);
    // The envelope is real, and the plaintext is not in it.
    const view = ctx.storage.inspect("provider:victim:api_key");
    assert.equal(
      Buffer.from(view.ciphertext).includes(Buffer.from(CREDENTIAL, "utf8")),
      false,
    );
  } finally {
    ctx.manager.close();
  }
});

test("a tampered credential fails closed instead of reporting absence", () => {
  const ctx = context();
  try {
    ctx.manager.createProvider({
      id: "tampered",
      kind: "openai-compatible",
      displayName: "Tampered",
      baseUrl: "http://127.0.0.1:11434/v1",
      config: { allowLoopback: true },
    });
    ctx.manager.setCredential("tampered", CREDENTIAL);
    ctx.storage.corruptForTest("provider:tampered:api_key", "ciphertext");

    assert.throws(
      () => ctx.manager.hasCredential("tampered"),
      (error: unknown) =>
        error instanceof StorageError && error.code === "secret_corrupt",
      "a tampered credential must never read as false",
    );
    assert.throws(
      () => ctx.manager.getProvider("tampered"),
      (error: unknown) =>
        error instanceof StorageError && error.code === "secret_corrupt",
    );
  } finally {
    ctx.manager.close();
  }
});

test("one provider's credential cannot be read through another provider", () => {
  const ctx = context();
  try {
    for (const id of ["alpha", "beta"]) {
      ctx.manager.createProvider({
        id,
        kind: "openai-compatible",
        displayName: id,
        baseUrl: "http://127.0.0.1:11434/v1",
        config: { allowLoopback: true },
      });
    }
    ctx.manager.setCredential("alpha", CREDENTIAL);
    assert.equal(ctx.manager.hasCredential("alpha"), true);
    assert.equal(ctx.manager.hasCredential("beta"), false);

    // Deleting beta must not disturb alpha's custody.
    ctx.manager.deleteProvider("beta");
    assert.equal(ctx.manager.hasCredential("alpha"), true);
    assert.deepEqual(
      ctx.storage.list().map((meta) => meta.name),
      ["provider:alpha:api_key"],
    );
  } finally {
    ctx.manager.close();
  }
});

test("plaintext credentials are absent from the database bytes and logs", () => {
  const ctx = context();
  try {
    ctx.manager.createProvider({
      id: "ondisk",
      kind: "openai-compatible",
      displayName: "On Disk",
      baseUrl: "http://127.0.0.1:11434/v1",
      config: { allowLoopback: true },
    });
    ctx.manager.setCredential("ondisk", CREDENTIAL);
  } finally {
    ctx.manager.close();
  }

  let bytes = Buffer.alloc(0);
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      bytes = Buffer.concat([
        bytes,
        readFileSync(`${databasePath(ctx.dir)}${suffix}`),
      ]);
    } catch {
      // Sidecar absent.
    }
  }
  assert.equal(bytes.includes(Buffer.from(CREDENTIAL, "utf8")), false);
  assert.equal(bytes.includes(Buffer.from(KEY, "utf8")), false);
  assert.equal(JSON.stringify(ctx.logs).includes(CREDENTIAL), false);
});

test("injection-shaped ids are rejected and the schema survives", () => {
  const ctx = context();
  try {
    for (const id of [
      "a'; DROP TABLE providers; --",
      'a" OR 1=1',
      "a`b",
      "provider:other",
      "../../etc/passwd",
      "a\u0000b",
      "a\nb",
    ]) {
      assert.throws(
        () =>
          ctx.manager.createProvider({
            id,
            kind: "openai-compatible",
            displayName: "X",
            baseUrl: "http://127.0.0.1:11434/v1",
            config: { allowLoopback: true },
          }),
        (error: unknown) =>
          error instanceof ProviderError && error.code === "invalid_provider_id",
      );
    }
    // Still fully functional afterwards.
    ctx.manager.createProvider({
      id: "survivor",
      kind: "openai-compatible",
      displayName: "Survivor",
      baseUrl: "http://127.0.0.1:11434/v1",
      config: { allowLoopback: true },
    });
    assert.deepEqual(
      ctx.manager.listProviders().map((provider) => provider.id),
      ["survivor"],
    );
  } finally {
    ctx.manager.close();
  }
});

test("a config that tries to smuggle headers or a proxy is refused", () => {
  const ctx = context();
  try {
    for (const config of [
      { headers: { Authorization: "Bearer sk-attacker" } },
      { authorization: "Bearer sk-attacker" },
      { proxy: "socks5://127.0.0.1:9050" },
      { discoveryPath: "https://evil.example.com/v1/models" },
      { discoveryPath: "//evil.example.com/v1/models" },
      { timeoutMs: 1 },
      { modelLimit: 100000 },
    ]) {
      assert.throws(
        () =>
          ctx.manager.createProvider({
            id: "cfg",
            kind: "openai-compatible",
            displayName: "Config",
            baseUrl: "http://127.0.0.1:11434/v1",
            // The hostile config under test carries no loopback opt-in, and must not
            // need one: it has to be refused for being malformed, before the base URL
            // is ever judged.
            config,
          }),
        (error: unknown) =>
          error instanceof ProviderError &&
          error.code === "invalid_provider_config",
      );
    }
    assert.equal(ctx.manager.listProviders().length, 0);
  } finally {
    ctx.manager.close();
  }
});

test("a base url carrying a credential is refused at registration", () => {
  const ctx = context();
  try {
    assert.throws(
      () =>
        ctx.manager.createProvider({
          id: "inline",
          kind: "openai-compatible",
          displayName: "Inline",
          baseUrl: `https://user:${CREDENTIAL}@api.example.com/v1`,
        }),
      (error: unknown) =>
        error instanceof ProviderError &&
        error.code === "invalid_provider_config",
    );
    // A query-string key is stripped rather than stored.
    const created = ctx.manager.createProvider({
      id: "query",
      kind: "openai-compatible",
      displayName: "Query",
      baseUrl: `https://api.example.com/v1?key=${CREDENTIAL}`,
    });
    assert.equal(created.baseUrl, "https://api.example.com/v1");
    assert.equal(created.baseUrl.includes(CREDENTIAL), false);
  } finally {
    ctx.manager.close();
  }
});

test("a hostile model feed is capped and cannot flood the caller", async () => {
  const payload = JSON.stringify({
    data: Array.from({ length: 700 }, (_unused, index) => ({ id: `m-${index}` })),
  });
  const ctx = context(
    async () =>
      new Response(payload, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  try {
    ctx.manager.createProvider({
      id: "flood",
      kind: "openai-compatible",
      displayName: "Flood",
      baseUrl: "http://127.0.0.1:11434/v1",
      config: { allowLoopback: true, modelLimit: 500 },
    });
    const models = await ctx.manager.discoverModels("flood");
    assert.equal(models.length, 500);
  } finally {
    ctx.manager.close();
  }
});

test("an enormous discovery body is refused rather than buffered", async () => {
  const huge = `{"data":[${Array.from(
    { length: 40_000 },
    (_unused, index) => `{"id":"model-${index}"}`,
  ).join(",")}]}`;
  const ctx = context(
    async () =>
      new Response(huge, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  try {
    ctx.manager.createProvider({
      id: "huge",
      kind: "openai-compatible",
      displayName: "Huge",
      baseUrl: "http://127.0.0.1:11434/v1",
      config: { allowLoopback: true },
    });
    await assert.rejects(
      ctx.manager.discoverModels("huge"),
      (error: unknown) =>
        error instanceof ProviderError && error.code === "discovery_failed",
    );
  } finally {
    ctx.manager.close();
  }
});

test("an upstream error body never reaches the raised error", async () => {
  const ctx = context(
    async () =>
      new Response(JSON.stringify({ error: CREDENTIAL, stack: "/root/secret/path" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
  );
  try {
    ctx.manager.createProvider({
      id: "leaky",
      kind: "openai-compatible",
      displayName: "Leaky",
      baseUrl: "http://127.0.0.1:11434/v1",
      config: { allowLoopback: true },
    });
    await assert.rejects(ctx.manager.discoverModels("leaky"), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "upstream_error");
      assert.equal(error.message.includes(CREDENTIAL), false);
      assert.equal(error.message.includes("/root/secret/path"), false);
      return true;
    });
  } finally {
    ctx.manager.close();
  }
});

test("discovery never places the credential in the request URL", async () => {
  const urls: string[] = [];
  const ctx = context(async (input) => {
    urls.push(String(input));
    return new Response('{"data":[{"id":"m"}]}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  try {
    ctx.manager.createProvider({
      id: "urlcheck",
      kind: "openai-compatible",
      displayName: "URL Check",
      baseUrl: "http://127.0.0.1:11434/v1",
      config: { allowLoopback: true },
    });
    ctx.manager.setCredential("urlcheck", CREDENTIAL);
    await ctx.manager.discoverModels("urlcheck");

    assert.equal(urls.length, 1);
    assert.equal(urls[0]?.includes(CREDENTIAL), false);
    assert.equal(urls[0]?.includes("?"), false);
  } finally {
    ctx.manager.close();
  }
});

test("a provider row rewritten with a hostile config fails closed on read", () => {
  const ctx = context();
  try {
    ctx.manager.createProvider({
      id: "rewritten",
      kind: "openai-compatible",
      displayName: "Rewritten",
      baseUrl: "http://127.0.0.1:11434/v1",
      config: { allowLoopback: true },
    });
    ctx.storage.sql
      .prepare("UPDATE providers SET config_json = ? WHERE id = ?")
      .run('{"discoveryPath":"https://evil.example.com/v1/models"}', "rewritten");

    assert.throws(
      () => ctx.manager.requireProvider("rewritten"),
      (error: unknown) =>
        error instanceof ProviderError &&
        error.code === "invalid_provider_config",
      "a row edited outside the repository must not install a hostile path",
    );
  } finally {
    ctx.manager.close();
  }
});
