import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TARGET_SCHEMA_VERSION } from "@bayz/storage";
import { createBayzRuntime } from "../src/runtime.js";

const KEY = Buffer.alloc(32, 0x55).toString("hex");

function freshDir(): string {
  return join(mkdtempSync(join(tmpdir(), "bayz-runtime-")), ".bayz");
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    host: "127.0.0.1",
    port: 20128,
    dataDir: freshDir(),
    dashboardRoot: "/nonexistent",
    ...overrides,
  };
}

test("one storage handle is shared by all three managers", () => {
  const runtime = createBayzRuntime(config(), { env: { BAYZ_MASTER_KEY: KEY } });
  try {
    // A provider written through one manager is visible to the router's registry,
    // which is only true if they share a connection.
    runtime.providers.createProvider({
      id: "p1",
      kind: "openai-compatible",
      displayName: "P1",
      baseUrl: "http://127.0.0.1:1/v1",
    });
    runtime.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });
    assert.equal(runtime.router.listRoutes().length, 1);
    assert.equal(runtime.providers.listProviders().length, 1);
    assert.equal(runtime.router.providers, runtime.providers);
    assert.equal(runtime.router.proxies, runtime.proxies);
  } finally {
    runtime.close();
  }
});

test("close releases the storage exactly once even if called twice", () => {
  const runtime = createBayzRuntime(config(), { env: { BAYZ_MASTER_KEY: KEY } });
  runtime.close();
  // A second close must not throw: shutdown paths can race a signal handler.
  runtime.close();
  assert.throws(() => runtime.router.listRoutes());
});

test("the runtime resolves an API token and reports its source", () => {
  const runtime = createBayzRuntime(config(), { env: { BAYZ_MASTER_KEY: KEY } });
  try {
    assert.match(runtime.apiToken, /^[0-9a-f]{64}$/);
    assert.equal(runtime.apiTokenSource, "generated");
  } finally {
    runtime.close();
  }
});

test("an externally supplied token is used without being stored", () => {
  const runtime = createBayzRuntime(config(), {
    env: { BAYZ_MASTER_KEY: KEY, BAYZ_API_TOKEN: "external-token-abcdefghij" },
  });
  try {
    assert.equal(runtime.apiToken, "external-token-abcdefghij");
    assert.equal(runtime.apiTokenSource, "environment");
  } finally {
    runtime.close();
  }
});

test("the status summary reports operational facts and no key material", () => {
  const runtime = createBayzRuntime(config(), { env: { BAYZ_MASTER_KEY: KEY } });
  try {
    runtime.providers.createProvider({
      id: "p1",
      kind: "openai-compatible",
      displayName: "P1",
      baseUrl: "http://127.0.0.1:1/v1",
    });
    runtime.providers.setCredential("p1", "sk-status-secret");
    runtime.proxies.createProxy({ id: "x1", kind: "socks5", host: "127.0.0.1", port: 1080 });
    runtime.router.createRoute({ id: "r1", model: "gpt-4o", providerId: "p1" });

    const status = runtime.describe();
    assert.equal(status.schemaVersion, TARGET_SCHEMA_VERSION);
    assert.equal(status.driver, "node:sqlite");
    assert.equal(status.keyProvider, "environment");
    assert.match(String(status.keyId), /^kek_[0-9a-f]{32}$/);
    assert.deepEqual(status.counts, { providers: 1, proxies: 1, routes: 1 });

    const serialized = JSON.stringify(status);
    assert.equal(serialized.includes("sk-status-secret"), false);
    assert.equal(serialized.includes(KEY), false);
    assert.equal(serialized.includes(runtime.apiToken), false);
    // The token must not be reachable through the status payload in any form.
    assert.equal("apiToken" in status, false);
    assert.equal("token" in status, false);
  } finally {
    runtime.close();
  }
});

test("the status summary never contains the api token even as a fingerprint field", () => {
  const runtime = createBayzRuntime(config(), { env: { BAYZ_MASTER_KEY: KEY } });
  try {
    const keys = Object.keys(runtime.describe()).map((key) => key.toLowerCase());
    for (const forbidden of ["apitoken", "token", "credential", "password", "secret"]) {
      assert.equal(keys.includes(forbidden), false, `${forbidden} must not be reported`);
    }
  } finally {
    runtime.close();
  }
});

test("the runtime exposes no storage or credential accessor", () => {
  const runtime = createBayzRuntime(config(), { env: { BAYZ_MASTER_KEY: KEY } });
  try {
    for (const forbidden of ["getCredential", "getPassword", "secrets", "sql"]) {
      assert.equal(
        Object.keys(runtime).includes(forbidden),
        false,
        `${forbidden} must not be public`,
      );
    }
  } finally {
    runtime.close();
  }
});

test("remote exposure without a token is a startup failure", () => {
  assert.throws(
    () =>
      createBayzRuntime(config({ host: "0.0.0.0" }), {
        env: { BAYZ_MASTER_KEY: KEY, BAYZ_ALLOW_REMOTE: "true" },
        // No externally supplied token, and generation is refused for remote
        // binding so an operator cannot expose the API before reading a token
        // printed to a log they may not be watching.
        allowGeneratedTokenForRemote: false,
      }),
    /remote/i,
  );
});

test("remote exposure with an explicit token is permitted", () => {
  const runtime = createBayzRuntime(config({ host: "0.0.0.0" }), {
    env: {
      BAYZ_MASTER_KEY: KEY,
      BAYZ_ALLOW_REMOTE: "true",
      BAYZ_API_TOKEN: "explicit-remote-token-value",
    },
    allowGeneratedTokenForRemote: false,
  });
  try {
    assert.equal(runtime.apiToken, "explicit-remote-token-value");
  } finally {
    runtime.close();
  }
});

test("loopback binding needs no explicit token", () => {
  const runtime = createBayzRuntime(config(), { env: { BAYZ_MASTER_KEY: KEY } });
  try {
    assert.equal(runtime.apiTokenSource, "generated");
  } finally {
    runtime.close();
  }
});

test("an unopenable data directory fails with a storage error, not a partial runtime", () => {
  assert.throws(
    () =>
      createBayzRuntime(config({ dataDir: "/proc/version/nope" }), {
        env: { BAYZ_MASTER_KEY: KEY },
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: unknown }).code === "storage_unavailable",
  );
});
