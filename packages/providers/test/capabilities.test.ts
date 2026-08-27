import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openSecretStorage, type SecretStorage } from "@bayz/storage";
import {
  CONNECTION_FAILURE_CODES,
  ProviderError,
  createProviderManager,
  type ConnectionResult,
  type ProviderCapabilities,
  type ProviderManager,
} from "../src/index.js";

/**
 * Capability detection and connection testing.
 *
 * The design rule this file exists to pin: **`unknown` is a real value.** A model
 * discovery endpoint does not reveal whether a provider supports tool calling or
 * streaming, so reporting `yes` or `no` would be fabrication, and an operator who
 * trusted it would debug the wrong thing.
 */

const KEY = Buffer.alloc(32, 0x7b).toString("hex");
const CREDENTIAL = "sk-capabilities-credential";
const HOSTILE_BODY = "UPSTREAM-ERROR-SENTINEL-must-never-surface";

type Origin = {
  base: string;
  requests: number;
  close(): Promise<void>;
};

async function startOrigin(
  handler: (
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ) => void,
): Promise<Origin> {
  const state = { requests: 0 };
  const server: Server = createServer((request, response) => {
    state.requests += 1;
    request.resume();
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    get requests() {
      return state.requests;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function jsonOrigin(payload: unknown, status = 200) {
  return startOrigin((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
}

function harness(): { storage: SecretStorage; manager: ProviderManager } {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-capabilities-")), ".bayz");
  const storage = openSecretStorage({ dataDir, env: { BAYZ_MASTER_KEY: KEY } });
  return { storage, manager: createProviderManager({ storage }) };
}

function seed(manager: ProviderManager, base: string, id = "relay"): void {
  manager.createProvider({
    id,
    kind: "custom-openai",
    displayName: "Relay",
    baseUrl: base,
    config: { allowLoopback: true, timeoutMs: 5000 },
  });
}

test("detectCapabilities reports models true and the rest unknown", async (t) => {
  const origin = await jsonOrigin({ data: [{ id: "m1" }, { id: "m2" }] });
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });
  seed(manager, origin.base);

  const capabilities: ProviderCapabilities = await manager.detectCapabilities("relay");
  assert.equal(capabilities.models, true);
  // A discovery endpoint says nothing about tools or streaming. Guessing either way
  // would be a fabricated capability report, so both stay `unknown`.
  assert.equal(capabilities.tools, "unknown");
  assert.equal(capabilities.streaming, "unknown");
  assert.equal(capabilities.modelCount, 2);
  assert.equal(capabilities.capped, false);
});

test("an operator-declared tool capability is reported, not re-guessed", async (t) => {
  const origin = await jsonOrigin({ data: [{ id: "m1" }] });
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });

  manager.createProvider({
    id: "declared",
    kind: "custom-openai",
    displayName: "Declared",
    baseUrl: origin.base,
    config: { allowLoopback: true, timeoutMs: 5000, supportsTools: true },
  });
  const yes = await manager.detectCapabilities("declared");
  // The operator is the only authority that exists for this, so their declaration is
  // reported verbatim. It is still not *detected*.
  assert.equal(yes.tools, "yes");
  assert.equal(yes.toolsSource, "declared");
  assert.equal(yes.streaming, "unknown");

  manager.updateProvider("declared", {
    config: { allowLoopback: true, timeoutMs: 5000, supportsTools: false },
  });
  const no = await manager.detectCapabilities("declared");
  assert.equal(no.tools, "no");
  assert.equal(no.toolsSource, "declared");
});

test("an undeclared tool capability reports its source as undetermined", async (t) => {
  const origin = await jsonOrigin({ data: [{ id: "m1" }] });
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });
  seed(manager, origin.base);

  const capabilities = await manager.detectCapabilities("relay");
  assert.equal(capabilities.tools, "unknown");
  assert.equal(capabilities.toolsSource, "undetermined");
});

test("models is false when discovery fails, and the failure has a fixed code", async (t) => {
  const origin = await jsonOrigin({ nonsense: true });
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });
  seed(manager, origin.base);

  const capabilities = await manager.detectCapabilities("relay");
  assert.equal(capabilities.models, false);
  assert.equal(capabilities.modelCount, 0);
  // A failed probe is not an exception: the whole point is to report what is and is
  // not available, and a throw would deny the operator the rest of the report.
  assert.equal(capabilities.tools, "unknown");
  assert.equal(capabilities.streaming, "unknown");
  assert.ok(CONNECTION_FAILURE_CODES.includes(capabilities.failureCode!));
});

test("testConnection reports ok, a bounded latency, and a model count", async (t) => {
  const origin = await jsonOrigin({ data: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] });
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });
  seed(manager, origin.base);

  const result: ConnectionResult = await manager.testConnection("relay");
  assert.equal(result.ok, true);
  assert.equal(result.modelCount, 3);
  assert.equal(typeof result.latencyMs, "number");
  assert.ok(result.latencyMs >= 0 && result.latencyMs < 60_000);
  assert.equal(result.failureCode, undefined);
});

test("a failing connection returns a fixed code and no upstream text", async (t) => {
  const origin = await startOrigin((_request, response) => {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end(HOSTILE_BODY);
  });
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });
  seed(manager, origin.base);

  const result = await manager.testConnection("relay");
  assert.equal(result.ok, false);
  assert.equal(result.modelCount, undefined);
  assert.ok(CONNECTION_FAILURE_CODES.includes(result.failureCode!));
  // The upstream body is where a rejected credential most often gets echoed back.
  assert.ok(!JSON.stringify(result).includes(HOSTILE_BODY));
});

test("every failure code is one of a fixed, non-empty set", () => {
  assert.ok(CONNECTION_FAILURE_CODES.length > 0);
  assert.deepEqual(
    [...CONNECTION_FAILURE_CODES],
    [...new Set(CONNECTION_FAILURE_CODES)],
    "codes must be unique",
  );
  assert.ok(Object.isFrozen(CONNECTION_FAILURE_CODES));
});

test("an auth failure is distinguishable from unreachable", async (t) => {
  const denied = await startOrigin((_request, response) => {
    response.writeHead(401, { "content-type": "text/plain" });
    response.end(HOSTILE_BODY);
  });
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await denied.close();
  });
  seed(manager, denied.base);

  const result = await manager.testConnection("relay");
  assert.equal(result.ok, false);
  // "Your key is wrong" and "nothing answered" call for completely different operator
  // action, so collapsing them into one code would waste the operator's time.
  assert.equal(result.failureCode, "auth_failed");
});

test("a 10,000-model discovery response is refused for its size, before any cap", async (t) => {
  const many = Array.from({ length: 10_000 }, (_v, index) => ({ id: `m-${index}` }));
  const origin = await jsonOrigin({ data: many });
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });

  manager.createProvider({
    id: "flood",
    kind: "custom-openai",
    displayName: "Flood",
    baseUrl: origin.base,
    config: { allowLoopback: true, timeoutMs: 5000, modelLimit: 500 },
  });

  // The byte cap fires first, and that is the correct order: a 10,000-entry catalogue
  // is roughly 160 KiB, well past the 64 KiB discovery budget, and refusing it while
  // streaming is strictly better than buffering it in order to then count and discard.
  // The model cap below is what handles a catalogue that is legitimately large.
  const capabilities = await manager.detectCapabilities("flood");
  assert.equal(capabilities.models, false);
  assert.equal(capabilities.failureCode, "discovery_failed");
});

test("a catalogue larger than the model cap is capped and reported as capped", async (t) => {
  // 2,000 entries: comfortably inside the byte budget, comfortably past the cap.
  const many = Array.from({ length: 2_000 }, (_v, index) => ({ id: `m-${index}` }));
  const origin = await jsonOrigin({ data: many });
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });

  manager.createProvider({
    id: "big",
    kind: "custom-openai",
    displayName: "Big",
    baseUrl: origin.base,
    config: { allowLoopback: true, timeoutMs: 5000, modelLimit: 100 },
  });

  const capabilities = await manager.detectCapabilities("big");
  assert.equal(capabilities.models, true);
  assert.equal(capabilities.modelCount, 100);
  // Silently truncating would tell the operator they have 100 models when the upstream
  // offered 2,000, and they would never learn the list was incomplete.
  assert.equal(capabilities.capped, true);
});

test("a catalogue inside the cap is not reported as capped", async (t) => {
  const origin = await jsonOrigin({ data: [{ id: "m1" }, { id: "m2" }] });
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });
  seed(manager, origin.base);

  const capabilities = await manager.detectCapabilities("relay");
  assert.equal(capabilities.capped, false);
});

test("an injection-shaped model name is skipped and never stored", async (t) => {
  const origin = await jsonOrigin({
    data: [
      { id: "good-model" },
      { id: "<script>alert(1)</script>" },
      { id: "../../etc/passwd" },
      { id: "drop table providers;--" },
      { id: "also-good" },
    ],
  });
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });
  seed(manager, origin.base);

  const capabilities = await manager.detectCapabilities("relay");
  assert.equal(capabilities.modelCount, 2);
  const bytes = JSON.stringify(capabilities);
  assert.ok(!bytes.includes("<script>"));
  assert.ok(!bytes.includes("drop table"));

  // Nothing about a capability probe writes to the database. Asserted rather than
  // assumed, because a cached probe result would be a new place for hostile upstream
  // text to land.
  const rows = storage.sql
    .prepare("SELECT config_json FROM providers WHERE id = 'relay'")
    .all() as Array<{ config_json: string }>;
  assert.ok(!rows[0]!.config_json.includes("<script>"));
});

test("results are not cached across a config change", async (t) => {
  const origin = await jsonOrigin({ data: [{ id: "m1" }] });
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });
  seed(manager, origin.base);

  await manager.detectCapabilities("relay");
  const before = origin.requests;
  manager.updateProvider("relay", {
    config: { allowLoopback: true, timeoutMs: 5000, supportsTools: true },
  });
  const after = await manager.detectCapabilities("relay");

  // A cache keyed only on the provider id would report the old answer after the
  // operator changed the endpoint, which is the exact moment they need the new one.
  assert.ok(origin.requests > before);
  assert.equal(after.tools, "yes");
});

test("a disabled provider is refused rather than probed", async (t) => {
  const origin = await jsonOrigin({ data: [{ id: "m1" }] });
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });
  seed(manager, origin.base);
  manager.updateProvider("relay", { enabled: false });

  const before = origin.requests;
  await assert.rejects(
    manager.detectCapabilities("relay"),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "unsupported_operation",
  );
  assert.equal(origin.requests, before);
});

test("an unknown provider is provider_not_found on both entry points", async (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  for (const call of [
    () => manager.detectCapabilities("absent"),
    () => manager.testConnection("absent"),
  ]) {
    await assert.rejects(
      call(),
      (error: unknown) =>
        error instanceof ProviderError && error.code === "provider_not_found",
    );
  }
});

test("a provider whose base URL the policy forbids fails without connecting", async (t) => {
  const origin = await jsonOrigin({ data: [{ id: "m1" }] });
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });

  // Stored as a pre-9D row: loadable, but not dialable.
  storage.sql
    .prepare(
      `INSERT INTO providers
         (id, kind, display_name, base_url, enabled, config_json, created_at, updated_at)
       VALUES ('legacy', 'openai-compatible', 'Legacy', ?, 1,
               '{"timeoutMs":5000,"discoveryPath":"/v1/models","modelLimit":100}',
               't', 't')`,
    )
    .run(origin.base);

  const before = origin.requests;
  const result = await manager.testConnection("legacy");
  assert.equal(result.ok, false);
  assert.equal(result.failureCode, "invalid_provider_config");
  assert.equal(origin.requests, before);
});

test("a codex-oauth provider reports unsupported rather than pretending", async (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  manager.createProvider({
    id: "codex",
    kind: "codex-oauth",
    displayName: "Codex",
    baseUrl: "https://chatgpt.com/backend-api",
  });

  const result = await manager.testConnection("codex");
  assert.equal(result.ok, false);
  assert.equal(result.failureCode, "unsupported_operation");

  const capabilities = await manager.detectCapabilities("codex");
  assert.equal(capabilities.models, false);
  assert.equal(capabilities.failureCode, "unsupported_operation");
});

test("no probe result contains the stored credential", async (t) => {
  const origin = await jsonOrigin({ data: [{ id: "m1" }] });
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });
  seed(manager, origin.base);
  manager.setCredential("relay", CREDENTIAL);

  const capabilities = await manager.detectCapabilities("relay");
  const result = await manager.testConnection("relay");
  for (const value of [capabilities, result]) {
    assert.ok(!JSON.stringify(value).includes(CREDENTIAL));
  }
});

test("a hostile 500 body reaches no log line either", async (t) => {
  const origin = await startOrigin((_request, response) => {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end(HOSTILE_BODY);
  });
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-capabilities-log-")), ".bayz");
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
  seed(manager, origin.base);

  await manager.testConnection("relay");
  assert.ok(lines.length > 0, "the probe must be observable at all");
  assert.ok(!JSON.stringify(lines).includes(HOSTILE_BODY));
});
