import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openSecretStorage, type SecretStorage } from "@bayz/storage";
import {
  ProviderError,
  createProviderManager,
  type ProviderManager,
} from "../src/index.js";

/**
 * The provider-level proxy default.
 *
 * The gap this closes: before 9E, `proxy_id` lived only on `routes`, so pointing one
 * proxy at forty providers meant editing forty routes. A provider-level default makes it
 * one decision per provider, and a route override stays available for the exception.
 */

const KEY = Buffer.alloc(32, 0x8e).toString("hex");
const PROXY_PASSWORD = "hunter2-provider-proxy-test";

function harness(): { storage: SecretStorage; manager: ProviderManager } {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-provider-proxy-")), ".bayz");
  const storage = openSecretStorage({ dataDir, env: { BAYZ_MASTER_KEY: KEY } });
  return { storage, manager: createProviderManager({ storage }) };
}

/**
 * Insert a proxy row directly.
 *
 * `@bayz/providers` deliberately does not depend on `@bayz/proxy` — the dependency
 * would exist only to reach a validator and an id alphabet the two already share. The
 * repository checks existence with a query against the shared database instead.
 */
function seedProxy(storage: SecretStorage, id: string, kind = "socks5"): void {
  storage.sql
    .prepare(
      `INSERT INTO proxies
         (id, kind, host, port, username, enabled, config_json, created_at, updated_at)
       VALUES (?, ?, '127.0.0.1', 1080, 'user', 1, '{}', 't', 't')`,
    )
    .run(id, kind);
}

const BASE = {
  kind: "openai-compatible" as const,
  displayName: "P1",
  baseUrl: "https://api.example.com/v1",
};

test("a provider can be created with a proxy default", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());
  seedProxy(storage, "tunnel");

  const created = manager.createProvider({ id: "p1", ...BASE, proxyId: "tunnel" });
  assert.equal(created.proxyId, "tunnel");
  assert.equal(manager.getProvider("p1")?.proxyId, "tunnel");
});

test("a provider with no proxy reports undefined, not an empty string", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  const created = manager.createProvider({ id: "p1", ...BASE });
  // `""` would be a second way to say "direct" and would compare truthily in at least
  // one place before long.
  assert.equal(created.proxyId, undefined);
  assert.equal(manager.getProvider("p1")?.proxyId, undefined);
  assert.ok(!Object.hasOwn(created, "proxyId") || created.proxyId === undefined);
});

test("an unknown proxy is refused before any row is written", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  assert.throws(
    () => manager.createProvider({ id: "p1", ...BASE, proxyId: "absent" }),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "invalid_provider_config",
  );
  // A dangling reference would be caught by the foreign key, but as a driver error
  // rather than a domain one — and the provider row must not exist either way.
  assert.deepEqual(manager.listProviders(), []);
});

test("an injection-shaped proxy id is refused pre-SQL", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());
  seedProxy(storage, "tunnel");

  for (const proxyId of [
    "a'; DROP TABLE providers;--",
    "../tunnel",
    "TUNNEL",
    "tunnel-",
    "a b",
    "",
    "x".repeat(200),
    42 as never,
    {} as never,
    [] as never,
    true as never,
  ]) {
    assert.throws(
      () => manager.createProvider({ id: "p1", ...BASE, proxyId }),
      (error: unknown) => error instanceof ProviderError,
      `accepted ${JSON.stringify(proxyId)}`,
    );
  }
  assert.deepEqual(manager.listProviders(), []);
});

test("update can set a proxy on a direct provider", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());
  seedProxy(storage, "tunnel");

  manager.createProvider({ id: "p1", ...BASE });
  const updated = manager.updateProvider("p1", { proxyId: "tunnel" });
  assert.equal(updated.proxyId, "tunnel");
  assert.equal(manager.getProvider("p1")?.proxyId, "tunnel");
});

test("update can clear a proxy with null, meaning direct", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());
  seedProxy(storage, "tunnel");

  manager.createProvider({ id: "p1", ...BASE, proxyId: "tunnel" });
  const cleared = manager.updateProvider("p1", { proxyId: null });
  // `null` is the explicit "set to direct". `undefined` cannot mean that, because a
  // patch omits every field it is not changing.
  assert.equal(cleared.proxyId, undefined);
  assert.equal(manager.getProvider("p1")?.proxyId, undefined);
});

test("an omitted proxyId leaves the existing assignment alone", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());
  seedProxy(storage, "tunnel");

  manager.createProvider({ id: "p1", ...BASE, proxyId: "tunnel" });
  const renamed = manager.updateProvider("p1", { displayName: "Renamed" });
  assert.equal(renamed.displayName, "Renamed");
  // Otherwise every unrelated edit would silently drop the operator's proxy choice.
  assert.equal(renamed.proxyId, "tunnel");
});

test("update to an unknown proxy is refused and leaves the row unchanged", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());
  seedProxy(storage, "tunnel");

  manager.createProvider({ id: "p1", ...BASE, proxyId: "tunnel" });
  assert.throws(
    () => manager.updateProvider("p1", { proxyId: "absent" }),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "invalid_provider_config",
  );
  assert.equal(manager.getProvider("p1")?.proxyId, "tunnel");
});

test("deleting a proxy degrades its providers to direct", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());
  seedProxy(storage, "tunnel");

  for (const id of ["p1", "p2"]) {
    manager.createProvider({
      id,
      ...BASE,
      baseUrl: `https://${id}.example.com/v1`,
      proxyId: "tunnel",
    });
  }
  storage.sql.prepare("DELETE FROM proxies WHERE id = 'tunnel'").run();

  // Removing a proxy must never remove a provider — that would take the operator's
  // stored credentials with it.
  assert.deepEqual(
    manager.listProviders().map((provider) => provider.id),
    ["p1", "p2"],
  );
  for (const provider of manager.listProviders()) {
    assert.equal(provider.proxyId, undefined);
  }
});

test("the view never exposes a proxy password", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());
  seedProxy(storage, "tunnel");
  // Stored where a proxy password belongs, under the proxy's own scope.
  storage.put("proxy:tunnel:password", PROXY_PASSWORD);

  manager.createProvider({ id: "p1", ...BASE, proxyId: "tunnel" });
  const surfaces = [
    manager.getProvider("p1"),
    manager.listProviders(),
    manager.requireProvider("p1"),
  ];
  for (const surface of surfaces) {
    const serialized = JSON.stringify(surface);
    assert.ok(!serialized.includes(PROXY_PASSWORD));
    assert.ok(!/password/i.test(serialized));
  }
});

test("providersUsingProxy lists assignments and nothing else", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());
  seedProxy(storage, "alpha");
  seedProxy(storage, "beta", "http");

  manager.createProvider({ id: "p1", ...BASE, proxyId: "alpha" });
  manager.createProvider({
    id: "p2",
    ...BASE,
    baseUrl: "https://p2.example.com/v1",
    proxyId: "alpha",
  });
  manager.createProvider({
    id: "p3",
    ...BASE,
    baseUrl: "https://p3.example.com/v1",
    proxyId: "beta",
  });
  manager.createProvider({ id: "p4", ...BASE, baseUrl: "https://p4.example.com/v1" });

  assert.deepEqual(manager.providersUsingProxy("alpha"), ["p1", "p2"]);
  assert.deepEqual(manager.providersUsingProxy("beta"), ["p3"]);
  // An unknown proxy is an empty list rather than an error: "nothing uses it" is the
  // honest answer and the caller is usually rendering a count.
  assert.deepEqual(manager.providersUsingProxy("absent"), []);
});

test("providersUsingProxy validates its argument rather than querying with it", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  assert.throws(
    () => manager.providersUsingProxy("a'; DROP TABLE providers;--"),
    (error: unknown) => error instanceof ProviderError,
  );
  // The table is still there, which is the point of validating pre-SQL.
  assert.deepEqual(manager.listProviders(), []);
});

test("assignProxy sets many providers in one call and is atomic", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());
  seedProxy(storage, "tunnel");

  const ids = ["p1", "p2", "p3", "p4"];
  for (const id of ids) {
    manager.createProvider({ id, ...BASE, baseUrl: `https://${id}.example.com/v1` });
  }

  assert.equal(manager.assignProxy("tunnel", ids), 4);
  assert.deepEqual(manager.providersUsingProxy("tunnel"), ids);
});

test("assignProxy fails whole rather than partially on a bad id", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());
  seedProxy(storage, "tunnel");

  manager.createProvider({ id: "p1", ...BASE });
  manager.createProvider({ id: "p2", ...BASE, baseUrl: "https://p2.example.com/v1" });

  // One unknown provider in the batch. A partial assignment would leave the operator
  // with a half-applied change and no way to know which half.
  assert.throws(
    () => manager.assignProxy("tunnel", ["p1", "absent", "p2"]),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "provider_not_found",
  );
  assert.deepEqual(manager.providersUsingProxy("tunnel"), []);
});

test("assignProxy deduplicates ids", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());
  seedProxy(storage, "tunnel");
  manager.createProvider({ id: "p1", ...BASE });

  // The count is providers changed, not array entries processed.
  assert.equal(manager.assignProxy("tunnel", ["p1", "p1", "p1"]), 1);
  assert.deepEqual(manager.providersUsingProxy("tunnel"), ["p1"]);
});

test("assignProxy with null sets providers to direct", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());
  seedProxy(storage, "tunnel");

  manager.createProvider({ id: "p1", ...BASE, proxyId: "tunnel" });
  manager.createProvider({
    id: "p2",
    ...BASE,
    baseUrl: "https://p2.example.com/v1",
    proxyId: "tunnel",
  });

  assert.equal(manager.assignProxy(null, ["p1"]), 1);
  assert.equal(manager.getProvider("p1")?.proxyId, undefined);
  assert.deepEqual(manager.providersUsingProxy("tunnel"), ["p2"]);
});

test("assignProxy refuses an unknown proxy before touching any provider", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());
  seedProxy(storage, "tunnel");
  manager.createProvider({ id: "p1", ...BASE, proxyId: "tunnel" });

  assert.throws(
    () => manager.assignProxy("absent", ["p1"]),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "invalid_provider_config",
  );
  assert.equal(manager.getProvider("p1")?.proxyId, "tunnel");
});

test("assignProxy bounds the batch", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());
  seedProxy(storage, "tunnel");

  const tooMany = Array.from({ length: 201 }, (_v, index) => `p${index}`);
  assert.throws(
    () => manager.assignProxy("tunnel", tooMany),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "invalid_provider_config",
  );
});

test("assignProxy refuses a non-array and an empty batch", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());
  seedProxy(storage, "tunnel");

  for (const batch of [undefined, null, "p1", 1, {}] as never[]) {
    assert.throws(
      () => manager.assignProxy("tunnel", batch),
      (error: unknown) => error instanceof ProviderError,
      JSON.stringify(batch),
    );
  }
  // An empty batch is refused rather than treated as a no-op: it is almost always a
  // caller bug, and reporting "0 changed" would hide it.
  assert.throws(
    () => manager.assignProxy("tunnel", []),
    (error: unknown) => error instanceof ProviderError,
  );
});

test("a proxy assignment survives a reopen", (t) => {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-provider-proxy-reopen-")), ".bayz");
  const first = openSecretStorage({ dataDir, env: { BAYZ_MASTER_KEY: KEY } });
  seedProxy(first, "tunnel");
  createProviderManager({ storage: first }).createProvider({
    id: "p1",
    ...BASE,
    proxyId: "tunnel",
  });
  first.close();

  const second = openSecretStorage({ dataDir, env: { BAYZ_MASTER_KEY: KEY } });
  t.after(() => second.close());
  assert.equal(
    createProviderManager({ storage: second }).getProvider("p1")?.proxyId,
    "tunnel",
  );
});
