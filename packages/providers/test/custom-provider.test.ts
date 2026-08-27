import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openSecretStorage, type SecretStorage } from "@bayz/storage";
import {
  PROVIDER_KINDS,
  ProviderError,
  createProviderManager,
  defaultBaseUrl,
  type ProviderManager,
} from "../src/index.js";

const KEY = Buffer.alloc(32, 0x9c).toString("hex");

function harness(): { storage: SecretStorage; manager: ProviderManager } {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-custom-provider-")), ".bayz");
  const storage = openSecretStorage({ dataDir, env: { BAYZ_MASTER_KEY: KEY } });
  return { storage, manager: createProviderManager({ storage }) };
}

test("PROVIDER_KINDS gains custom-openai and keeps the existing four", () => {
  assert.deepEqual(PROVIDER_KINDS, [
    "openai-compatible",
    "openrouter",
    "gemini",
    "codex-oauth",
    "custom-openai",
  ]);
});

test("custom-openai has no default base URL", () => {
  // A default would silently point a custom provider somewhere the operator never
  // chose. Only OpenRouter has a single well-known endpoint.
  assert.equal(defaultBaseUrl("custom-openai"), undefined);
  assert.equal(defaultBaseUrl("openrouter"), "https://openrouter.ai/api");
});

test("a custom-openai provider requires an explicit base URL", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  assert.throws(
    () =>
      manager.createProvider({
        id: "relay",
        kind: "custom-openai",
        displayName: "Relay",
      } as never),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "invalid_provider_config",
  );
});

test("a public custom-openai provider is created and persisted", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  const created = manager.createProvider({
    id: "relay",
    kind: "custom-openai",
    displayName: "Tabitoken Relay",
    baseUrl: "https://relay.example.com/v1",
    config: { headers: { "x-relay-token": "abc" } },
  });
  assert.equal(created.kind, "custom-openai");
  assert.equal(created.baseUrl, "https://relay.example.com/v1");
  // The view carries header *names*, not values: echoing a configured value back
  // widens the surface for no benefit. See `ProviderConfigView`.
  assert.deepEqual(created.config.headerNames, ["x-relay-token"]);
  assert.ok(!JSON.stringify(created).includes("abc"));

  // Survives a reopen, which is what proves the CHECK constraint accepts the kind.
  assert.equal(manager.getProvider("relay")?.kind, "custom-openai");
});

test("the base URL runs through the egress policy at creation", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  // A metadata-endpoint provider cannot be *stored* at all, so it can never be dialled
  // even by a future code path that forgets to check.
  for (const baseUrl of [
    "http://169.254.169.254/latest/meta-data",
    "http://metadata.google.internal/computeMetadata/v1",
    "http://127.0.0.1:11434/v1",
    "http://localhost:8080/v1",
    "http://10.0.0.5/v1",
    "http://[::1]:8080/v1",
    "http://2130706433/v1",
    "http://0177.0.0.1/v1",
  ]) {
    assert.throws(
      () =>
        manager.createProvider({
          id: "denied",
          kind: "custom-openai",
          displayName: "Denied",
          baseUrl,
        }),
      (error: unknown) =>
        error instanceof ProviderError && error.code === "invalid_provider_config",
      `accepted ${baseUrl}`,
    );
  }
  assert.deepEqual(manager.listProviders(), []);
});

test("allowLoopback permits a local runtime", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  const created = manager.createProvider({
    id: "ollama",
    kind: "custom-openai",
    displayName: "Local Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    config: { allowLoopback: true },
  });
  assert.equal(created.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(created.config.allowLoopback, true);
});

test("allowLoopback still does not permit metadata or a private address", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  for (const baseUrl of ["http://169.254.169.254/v1", "http://192.168.1.5/v1"]) {
    assert.throws(
      () =>
        manager.createProvider({
          id: "denied",
          kind: "custom-openai",
          displayName: "Denied",
          baseUrl,
          config: { allowLoopback: true },
        }),
      (error: unknown) => error instanceof ProviderError,
      `accepted ${baseUrl} with allowLoopback`,
    );
  }
});

test("allowPrivate permits a LAN relay", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  const created = manager.createProvider({
    id: "lan",
    kind: "custom-openai",
    displayName: "LAN Relay",
    baseUrl: "http://192.168.1.50:8000/v1",
    config: { allowPrivate: true },
  });
  assert.equal(created.config.allowPrivate, true);
});

test("the egress policy applies to every kind, not only custom-openai", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  // An `openai-compatible` provider pointed at the metadata endpoint is exactly as
  // dangerous, so the check is on the base URL rather than on the kind.
  assert.throws(
    () =>
      manager.createProvider({
        id: "sneaky",
        kind: "openai-compatible",
        displayName: "Sneaky",
        baseUrl: "http://169.254.169.254/v1",
      }),
    (error: unknown) => error instanceof ProviderError,
  );
});

test("updating a base URL re-runs the egress check", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  manager.createProvider({
    id: "relay",
    kind: "custom-openai",
    displayName: "Relay",
    baseUrl: "https://relay.example.com/v1",
  });
  // Otherwise an operator could create a legitimate provider and then move it to the
  // metadata endpoint, bypassing the creation-time check entirely.
  assert.throws(
    () => manager.updateProvider("relay", { baseUrl: "http://169.254.169.254/v1" }),
    (error: unknown) => error instanceof ProviderError,
  );
  assert.equal(manager.getProvider("relay")?.baseUrl, "https://relay.example.com/v1");
});

test("clearing allowLoopback on a loopback provider is refused", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  manager.createProvider({
    id: "ollama",
    kind: "custom-openai",
    displayName: "Local",
    baseUrl: "http://127.0.0.1:11434/v1",
    config: { allowLoopback: true },
  });
  // The config and the URL have to stay consistent: removing the opt-in while the URL
  // still points at loopback would leave a provider whose stored state the policy
  // forbids.
  assert.throws(
    () => manager.updateProvider("ollama", { config: { allowLoopback: false } }),
    (error: unknown) => error instanceof ProviderError,
  );
});

test("a provider stored before this change still loads", (t) => {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-custom-legacy-")), ".bayz");
  const storage = openSecretStorage({ dataDir, env: { BAYZ_MASTER_KEY: KEY } });
  t.after(() => storage.close());

  // Written directly, as a pre-9D row would be: no `headers`, no `allowLoopback`, and
  // a loopback base URL that the new policy would refuse at creation. It must still
  // load, because breaking an existing install on upgrade is worse than the risk.
  storage.sql
    .prepare(
      `INSERT INTO providers
         (id, kind, display_name, base_url, enabled, config_json, created_at, updated_at)
       VALUES ('legacy', 'openai-compatible', 'Legacy', 'http://127.0.0.1:8080/v1', 1,
               '{"timeoutMs":30000,"discoveryPath":"/v1/models","modelLimit":100}',
               '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
    )
    .run();

  const manager = createProviderManager({ storage });
  const loaded = manager.getProvider("legacy");
  assert.equal(loaded?.baseUrl, "http://127.0.0.1:8080/v1");
  assert.equal(loaded?.config.allowLoopback, undefined);
});

test("an unknown kind is still refused", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  for (const kind of ["anthropic", "custom", "CUSTOM-OPENAI", "", null]) {
    assert.throws(
      () =>
        manager.createProvider({
          id: "bad",
          kind: kind as never,
          displayName: "Bad",
          baseUrl: "https://example.com",
        }),
      (error: unknown) => error instanceof ProviderError,
      `accepted kind ${JSON.stringify(kind)}`,
    );
  }
});

test("a custom-openai provider accepts a credential and reports presence only", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  manager.createProvider({
    id: "relay",
    kind: "custom-openai",
    displayName: "Relay",
    baseUrl: "https://relay.example.com/v1",
  });
  manager.setCredential("relay", "sk-custom-relay-credential");
  const view = manager.getProvider("relay");
  assert.equal(view?.credentialPresent, true);
  assert.ok(!JSON.stringify(view).includes("sk-custom-relay-credential"));
});
