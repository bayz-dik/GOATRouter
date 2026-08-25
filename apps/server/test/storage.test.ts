import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HealthSchema } from "@bayz/contracts";
import { StorageError, TARGET_SCHEMA_VERSION, databasePath } from "@bayz/storage";
import { buildApp } from "../src/app.js";
import { initializeStorage } from "../src/storage.js";

const KEY = Buffer.alloc(32, 0x6d).toString("hex");
const SENTINEL = "sk-live-server-sentinel-1357924680";

function tempDataDir(): string {
  return join(mkdtempSync(join(tmpdir(), "bayz-server-storage-")), ".bayz");
}

function config(dataDir: string) {
  return {
    host: "127.0.0.1",
    port: 20128,
    dataDir,
    dashboardRoot: join(dataDir, "dashboard"),
  };
}

test("initializeStorage migrates and round-trips a secret", () => {
  const dataDir = tempDataDir();
  const handle = initializeStorage(config(dataDir), { env: { BAYZ_MASTER_KEY: KEY } });
  try {
    assert.equal(handle.schemaVersion, TARGET_SCHEMA_VERSION);
    assert.equal(handle.driver, "node:sqlite");
    assert.equal(handle.keyProvider, "environment");
    assert.ok(existsSync(databasePath(dataDir)));

    handle.secrets.put("provider:openai:api_key", SENTINEL);
    assert.equal(handle.secrets.get("provider:openai:api_key"), SENTINEL);
  } finally {
    handle.close();
  }
});

test("initializeStorage logs only non-secret diagnostics", () => {
  const captured: Record<string, unknown>[] = [];
  const handle = initializeStorage(config(tempDataDir()), {
    env: { BAYZ_MASTER_KEY: KEY },
    logger: (payload) => captured.push(payload),
  });
  try {
    handle.secrets.put("k", SENTINEL);
  } finally {
    handle.close();
  }

  const serialized = JSON.stringify(captured);
  assert.ok(captured.length > 0);
  assert.doesNotMatch(serialized, new RegExp(SENTINEL));
  assert.doesNotMatch(serialized, new RegExp(KEY));
  assert.doesNotMatch(serialized, /[0-9a-f]{64}/);
});

test("initializeStorage falls back to a generated key without configuration", () => {
  const handle = initializeStorage(config(tempDataDir()), { env: {} });
  try {
    assert.equal(handle.keyProvider, "secure-file");
    handle.secrets.put("k", SENTINEL);
    assert.equal(handle.secrets.get("k"), SENTINEL);
  } finally {
    handle.close();
  }
});

test("an unusable data directory fails safely without leaking paths", () => {
  const root = mkdtempSync(join(tmpdir(), "bayz-server-bad-"));
  const blocker = join(root, "not-a-dir");
  writeFileSync(blocker, "x");
  const dataDir = join(blocker, ".bayz");

  let thrown: unknown;
  try {
    initializeStorage(config(dataDir), { env: { BAYZ_MASTER_KEY: KEY } });
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof StorageError, "expected a StorageError");
  assert.equal(thrown.code, "storage_unavailable");
  assert.doesNotMatch(thrown.message, /unable to open database file/);
  assert.doesNotMatch(thrown.message, /not-a-dir/);
  assert.doesNotMatch(thrown.message, /\.bayz/);
});

test("a mismatched root key is reported as master_key_mismatch", () => {
  const dataDir = tempDataDir();
  const first = initializeStorage(config(dataDir), {
    env: { BAYZ_MASTER_KEY: KEY },
  });
  first.secrets.put("bound", SENTINEL);
  first.close();

  assert.throws(
    () =>
      initializeStorage(config(dataDir), {
        env: { BAYZ_MASTER_KEY: Buffer.alloc(32, 0x7e).toString("hex") },
      }),
    (error: unknown) =>
      error instanceof StorageError && error.code === "master_key_mismatch",
  );
});

test("GET /api/health keeps its Phase 1 contract with no storage field", async (t) => {
  // Regression guard: Phase 1 tests and the dashboard depend on this exact
  // shape. Phase 2 must not add a storage field to it.
  const app = buildApp({ version: "0.1.0", logger: false });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(response.statusCode, 200);

  const body = response.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["status", "uptimeSeconds", "version"]);
  HealthSchema.parse(body);

  for (const forbidden of ["storage", "schemaVersion", "keyId", "dataDir", "driver"]) {
    assert.equal(
      Object.hasOwn(body, forbidden),
      false,
      `/api/health must not expose ${forbidden}`,
    );
  }
});

test("no storage or secret route is exposed by the Core", async (t) => {
  const app = buildApp({ logger: false, dashboardRoot: tempDataDir() });
  t.after(() => app.close());
  await app.ready();

  for (const url of [
    "/api/storage",
    "/api/secrets",
    "/api/keys",
    "/api/master-key",
  ]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 404, `${url} must not exist in Phase 2`);
  }
});
