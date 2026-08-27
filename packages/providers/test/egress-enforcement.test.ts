import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openSecretStorage, type SecretStorage } from "@bayz/storage";
import {
  ProviderError,
  createProviderManager,
  discoverOpenAiModels,
  egressPolicyOf,
  parseProviderConfig,
  safeCustomHeaders,
  type ProviderConfig,
  type ProviderManager,
} from "../src/index.js";

/**
 * Enforcement on the wire.
 *
 * The policy tests in `egress.test.ts` prove the classifier. This file proves the
 * classifier is actually *consulted* before a socket opens, against real loopback
 * origins, because a correct policy that nothing calls protects nothing.
 */

const KEY = Buffer.alloc(32, 0x4e).toString("hex");
const CREDENTIAL = "sk-egress-enforcement-credential";

type Origin = {
  port: number;
  base: string;
  /** TCP connections, not requests: a refusal must not even reach the listener. */
  connections: number;
  requests: IncomingMessage[];
  headers: Record<string, string | string[] | undefined>[];
  close(): Promise<void>;
};

async function startOrigin(
  handler?: (request: IncomingMessage, response: import("node:http").ServerResponse) => void,
): Promise<Origin> {
  const state = { connections: 0 };
  const requests: IncomingMessage[] = [];
  const headers: Record<string, string | string[] | undefined>[] = [];
  const server: Server = createServer((request, response) => {
    requests.push(request);
    headers.push({ ...request.headers });
    request.resume();
    if (handler !== undefined) {
      handler(request, response);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "local-model" }] }));
  });
  server.on("connection", () => {
    state.connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    get connections() {
      return state.connections;
    },
    requests,
    headers,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function harness(): { storage: SecretStorage; manager: ProviderManager } {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-egress-enforce-")), ".bayz");
  const storage = openSecretStorage({ dataDir, env: { BAYZ_MASTER_KEY: KEY } });
  return { storage, manager: createProviderManager({ storage }) };
}

/** Write a row the current policy would refuse, as a pre-9D install holds one. */
function insertLegacyRow(storage: SecretStorage, id: string, baseUrl: string): void {
  storage.sql
    .prepare(
      `INSERT INTO providers
         (id, kind, display_name, base_url, enabled, config_json, created_at, updated_at)
       VALUES (?, 'openai-compatible', 'Legacy', ?, 1,
               '{"timeoutMs":5000,"discoveryPath":"/v1/models","modelLimit":100}',
               '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
    )
    .run(id, baseUrl);
}

function target(baseUrl: string, config: Partial<ProviderConfig> = {}) {
  return {
    kind: "openai-compatible" as const,
    baseUrl,
    config: { ...parseProviderConfig(undefined, "openai-compatible"), ...config },
  };
}

test("a provider that opted into loopback reaches a local origin", async (t) => {
  const origin = await startOrigin();
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });

  manager.createProvider({
    id: "local",
    kind: "custom-openai",
    displayName: "Local",
    baseUrl: origin.base,
    config: { allowLoopback: true, timeoutMs: 5000 },
  });

  assert.deepEqual(await manager.discoverModels("local"), ["local-model"]);
  assert.equal(origin.connections, 1);
});

test("a loopback provider without the opt-in is refused before any socket opens", async (t) => {
  const origin = await startOrigin();
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });

  // Stored directly, because creation would refuse it. This is the pre-9D upgrade
  // case: the row loads, and the *request* is what fails.
  insertLegacyRow(storage, "legacy", origin.base);

  await assert.rejects(
    manager.discoverModels("legacy"),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "invalid_provider_config",
  );
  assert.equal(
    origin.connections,
    0,
    "the origin must observe zero connections: refusal precedes connect",
  );
});

test("custom headers arrive at the origin exactly as configured", async (t) => {
  const origin = await startOrigin();
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });

  manager.createProvider({
    id: "relay",
    kind: "custom-openai",
    displayName: "Relay",
    baseUrl: origin.base,
    config: {
      allowLoopback: true,
      timeoutMs: 5000,
      headers: { "x-relay-token": "relay-value-1", "X-Tenant": "acme" },
    },
  });
  manager.setCredential("relay", CREDENTIAL);

  await manager.discoverModels("relay");
  const seen = origin.headers[0]!;
  assert.equal(seen["x-relay-token"], "relay-value-1");
  // Names are normalized to lower case at parse time; the wire form is what HTTP
  // uses, so the value has to survive the normalization unchanged.
  assert.equal(seen["x-tenant"], "acme");
  assert.equal(seen.authorization, `Bearer ${CREDENTIAL}`);
});

test("a configured header cannot override the credential header", async (t) => {
  const origin = await startOrigin();
  t.after(() => origin.close());

  // Hand-forged past `parseProviderConfig`, which already refuses `authorization`.
  // This asserts the *second* line of defence: even if a hostile config reached the
  // send path, the real credential wins and the forged value never goes out.
  const forged = {
    ...parseProviderConfig({ allowLoopback: true, timeoutMs: 5000 }, "openai-compatible"),
    headers: { authorization: "Bearer forged-value", host: "evil.example.com" },
  } satisfies ProviderConfig;

  await discoverOpenAiModels({
    provider: target(origin.base, forged),
    credential: CREDENTIAL,
  });

  const seen = origin.headers[0]!;
  assert.equal(seen.authorization, `Bearer ${CREDENTIAL}`);
  assert.ok(!String(seen.authorization).includes("forged-value"));
  assert.notEqual(seen.host, "evil.example.com");
});

test("safeCustomHeaders drops a denied name instead of trusting the parser", () => {
  // The parser is the primary guard; this is the one that holds if a row was written
  // by an older build, by hand, or by a future code path that forgets to re-parse.
  const filtered = safeCustomHeaders({
    timeoutMs: 30000,
    discoveryPath: "/v1/models",
    modelLimit: 100,
    headers: {
      authorization: "Bearer forged",
      "proxy-authorization": "Basic forged",
      host: "evil.example.com",
      "content-length": "0",
      "x-relay-token": "kept",
    },
  });
  assert.deepEqual(filtered, { "x-relay-token": "kept" });
});

test("a redirect is refused rather than followed on the discovery path", async (t) => {
  const redirected: string[] = [];
  const origin = await startOrigin((request, response) => {
    redirected.push(String(request.url));
    response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
    response.end();
  });
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });

  manager.createProvider({
    id: "redirector",
    kind: "custom-openai",
    displayName: "Redirector",
    baseUrl: origin.base,
    config: { allowLoopback: true, timeoutMs: 5000 },
  });

  await assert.rejects(
    manager.discoverModels("redirector"),
    (error: unknown) => error instanceof ProviderError && error.code === "unreachable",
  );
  // A followed redirect is an SSRF bypass all by itself: the policy approved the
  // original host, not wherever the upstream points next.
  assert.deepEqual(redirected, ["/v1/models"]);
});

test("the resolved address is checked before connect", async (t) => {
  const origin = await startOrigin();
  t.after(() => origin.close());

  // A public *name* that resolves to the metadata endpoint. This is the rebinding
  // shape: the hostname passes the name check and the resolution is what betrays it.
  await assert.rejects(
    discoverOpenAiModels({
      provider: target("http://relay.example.com/v1", { timeoutMs: 5000 }),
      resolve: async () => ["169.254.169.254"],
    }),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "invalid_provider_config",
  );
  assert.equal(origin.connections, 0);
});

test("every resolved address must pass, not merely the first", async (t) => {
  const origin = await startOrigin();
  t.after(() => origin.close());

  // A multi-A-record answer where only one entry is hostile. Checking just the first
  // would let the connect pick the other one.
  await assert.rejects(
    discoverOpenAiModels({
      provider: target("http://relay.example.com/v1", { timeoutMs: 5000 }),
      resolve: async () => ["93.184.216.34", "10.0.0.7"],
    }),
    (error: unknown) => error instanceof ProviderError,
  );
});

test("an IP literal base URL performs no resolution at all", async (t) => {
  const origin = await startOrigin();
  t.after(() => origin.close());

  let resolveCalls = 0;
  await discoverOpenAiModels({
    provider: target(origin.base, { allowLoopback: true, timeoutMs: 5000 }),
    resolve: async () => {
      resolveCalls += 1;
      return ["127.0.0.1"];
    },
  });
  // The literal has already been classified. Resolving it would be a pointless
  // lookup and a second place for the answer to differ.
  assert.equal(resolveCalls, 0);
});

test("a resolution failure is unreachable, not a policy error", async (t) => {
  const origin = await startOrigin();
  t.after(() => origin.close());

  await assert.rejects(
    discoverOpenAiModels({
      provider: target("http://relay.example.com/v1", { timeoutMs: 5000 }),
      resolve: async () => {
        throw new Error("ENOTFOUND");
      },
    }),
    (error: unknown) => error instanceof ProviderError && error.code === "unreachable",
  );
  assert.equal(origin.connections, 0);
});

test("egressPolicyOf reads the opt-ins and defaults to deny", () => {
  const base = parseProviderConfig(undefined, "openai-compatible");
  assert.deepEqual(egressPolicyOf(base), { allowLoopback: false, allowPrivate: false });
  assert.deepEqual(egressPolicyOf({ ...base, allowLoopback: true }), {
    allowLoopback: true,
    allowPrivate: false,
  });
  assert.deepEqual(egressPolicyOf({ ...base, allowPrivate: true }), {
    allowLoopback: false,
    allowPrivate: true,
  });
});

test("a gemini provider is enforced on the same path", async (t) => {
  const origin = await startOrigin();
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });

  insertLegacyRow(storage, "gem", origin.base);
  storage.sql.prepare("UPDATE providers SET kind = 'gemini' WHERE id = 'gem'").run();
  manager.setCredential("gem", CREDENTIAL);

  await assert.rejects(
    manager.discoverModels("gem"),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "invalid_provider_config",
  );
  assert.equal(origin.connections, 0);
});

test("the credential is never placed in a custom header or the URL", async (t) => {
  const origin = await startOrigin();
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });

  manager.createProvider({
    id: "relay",
    kind: "custom-openai",
    displayName: "Relay",
    baseUrl: origin.base,
    config: {
      allowLoopback: true,
      timeoutMs: 5000,
      headers: { "x-relay-token": "relay-value-1" },
    },
  });
  manager.setCredential("relay", CREDENTIAL);
  await manager.discoverModels("relay");

  assert.ok(!String(origin.requests[0]!.url).includes(CREDENTIAL));
  const seen = origin.headers[0]!;
  assert.equal(seen["x-relay-token"], "relay-value-1");
  for (const [name, value] of Object.entries(seen)) {
    if (name === "authorization") {
      continue;
    }
    assert.ok(!String(value).includes(CREDENTIAL), `credential leaked into ${name}`);
  }
});
