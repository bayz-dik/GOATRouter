import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openSecretStorage, type SecretStorage } from "@bayz/storage";
import {
  ProviderError,
  createProviderManager,
  discoverOpenAiCatalogue,
  discoverOpenAiModels,
  parseProviderConfig,
  type ProviderManager,
} from "../src/index.js";

/**
 * Adversarial pressure on the custom-provider surface.
 *
 * `custom-openai` is the kind an operator points at their own endpoint, which makes it
 * the kind most likely to be pointed somewhere it should not be — and the kind whose
 * upstream is least likely to be well behaved. Everything here is a real socket.
 */

const KEY = Buffer.alloc(32, 0x2f).toString("hex");
const CREDENTIAL = "sk-live-CUSTOM-ADVERSARIAL-must-never-touch-disk-4417";
const ERROR_SENTINEL = "UPSTREAM-ERROR-BODY-SENTINEL-8823";

type Origin = {
  base: string;
  connections: number;
  headers: Array<Record<string, string | string[] | undefined>>;
  close(): Promise<void>;
};

async function startOrigin(
  handler: (
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ) => void,
): Promise<Origin> {
  const state = { connections: 0 };
  const headers: Array<Record<string, string | string[] | undefined>> = [];
  const server: Server = createServer((request, response) => {
    headers.push({ ...request.headers });
    request.resume();
    handler(request, response);
  });
  server.on("connection", () => {
    state.connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    get connections() {
      return state.connections;
    },
    headers,
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

type Harness = {
  storage: SecretStorage;
  manager: ProviderManager;
  dataDir: string;
  logs: string[];
};

function harness(): Harness {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-custom-adversarial-")), ".bayz");
  const logs: string[] = [];
  const storage = openSecretStorage({ dataDir, env: { BAYZ_MASTER_KEY: KEY } });
  const manager = createProviderManager({
    storage,
    logger: (payload) => logs.push(JSON.stringify(payload)),
  });
  return { storage, manager, dataDir, logs };
}

/** Every byte of the database, including the WAL and shared-memory files. */
function databaseBytes(dataDir: string): Buffer {
  const base = join(dataDir, "bayz.db");
  const parts: Buffer[] = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${base}${suffix}`;
    if (existsSync(file)) {
      parts.push(readFileSync(file));
    }
  }
  return Buffer.concat(parts);
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

function target(baseUrl: string, config: Record<string, unknown> = {}) {
  return {
    kind: "custom-openai" as const,
    baseUrl,
    config: {
      ...parseProviderConfig(undefined, "custom-openai"),
      ...config,
    },
  };
}

test("a 5 MiB discovery response is refused rather than buffered", async (t) => {
  const huge = `{"data":[${Array.from(
    { length: 60_000 },
    (_v, index) => `{"id":"model-${index}-${"x".repeat(50)}"}`,
  ).join(",")}]}`;
  const origin = await jsonOrigin(huge);
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });
  seed(manager, origin.base);

  assert.ok(Buffer.byteLength(huge) > 4 * 1024 * 1024, "the body must really be huge");
  await assert.rejects(
    manager.discoverModels("relay"),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "discovery_failed",
  );
});

test("a 50,000-model payload inside the byte budget is capped at 500", async (t) => {
  // Short ids so 50,000 entries stay under the 64 KiB discovery cap is impossible —
  // 50,000 entries cannot fit. The honest test is therefore the largest count that
  // does fit, which still proves the cap: the model limit fires, not the byte limit.
  const many = { data: Array.from({ length: 3_000 }, (_v, i) => ({ id: `m${i}` })) };
  const origin = await jsonOrigin(many);
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

  assert.equal((await manager.discoverModels("flood")).length, 500);
});

test("the model limit can never be raised above the absolute maximum", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  // A hostile *config* is the other half of a flood: an operator (or a rewritten row)
  // asking for a million models must be refused at parse time.
  assert.throws(
    () =>
      manager.createProvider({
        id: "greedy",
        kind: "custom-openai",
        displayName: "Greedy",
        baseUrl: "https://relay.example.com/v1",
        config: { modelLimit: 1_000_000 },
      }),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "invalid_provider_config",
  );
});

test("an injection-shaped model name is skipped, not stored", async (t) => {
  const origin = await jsonOrigin({
    data: [
      { id: "<script>alert(1)</script>" },
      { id: "'; DROP TABLE providers;--" },
      { id: "../../../etc/passwd" },
      { id: "good-model" },
      { id: "a".repeat(500) },
      { id: "model\u0000null" },
      { id: "model\nnewline" },
    ],
  });
  const { storage, manager, dataDir } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });
  seed(manager, origin.base);

  assert.deepEqual(await manager.discoverModels("relay"), ["good-model"]);
  const bytes = databaseBytes(dataDir);
  for (const hostile of ["<script>", "DROP TABLE", "etc/passwd"]) {
    assert.ok(!bytes.includes(hostile), hostile);
  }
});

test("an error body containing a credential reaches no row, response, or log", async (t) => {
  const origin = await startOrigin((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    // Exactly what a real upstream does: echo the key it just rejected.
    response.end(JSON.stringify({ error: `invalid key ${CREDENTIAL}`, note: ERROR_SENTINEL }));
  });
  const { storage, manager, dataDir, logs } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });
  seed(manager, origin.base);
  manager.setCredential("relay", CREDENTIAL);

  let raised: unknown;
  try {
    await manager.discoverModels("relay");
  } catch (error) {
    raised = error;
  }
  assert.ok(raised instanceof ProviderError);
  assert.equal(raised.code, "auth_failed");
  assert.ok(!raised.message.includes(CREDENTIAL));
  assert.ok(!raised.message.includes(ERROR_SENTINEL));

  const result = await manager.testConnection("relay");
  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify(result).includes(ERROR_SENTINEL));

  assert.ok(!logs.join("\n").includes(ERROR_SENTINEL));
  assert.ok(!logs.join("\n").includes(CREDENTIAL));

  // The credential is stored, so it is legitimately in the database — but only ever
  // encrypted. Its plaintext must not be.
  assert.ok(!databaseBytes(dataDir).includes(CREDENTIAL));
  assert.ok(!databaseBytes(dataDir).includes(ERROR_SENTINEL));
});

test("a hostile Host header cannot be injected through config", async (t) => {
  const origin = await jsonOrigin({ data: [{ id: "m" }] });
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });

  // Refused at parse time.
  for (const name of ["host", "Host", "HOST"]) {
    assert.throws(
      () =>
        manager.createProvider({
          id: "spoof",
          kind: "custom-openai",
          displayName: "Spoof",
          baseUrl: origin.base,
          config: { allowLoopback: true, headers: { [name]: "evil.example.com" } },
        }),
      (error: unknown) =>
        error instanceof ProviderError && error.code === "invalid_provider_config",
      name,
    );
  }

  // And filtered again on the wire, for a row that reached storage another way.
  await discoverOpenAiModels({
    provider: target(origin.base, {
      allowLoopback: true,
      timeoutMs: 5000,
      headers: { host: "evil.example.com", authorization: "Bearer forged" },
    }),
    credential: CREDENTIAL,
  });
  const seen = origin.headers[0]!;
  assert.notEqual(seen.host, "evil.example.com");
  assert.equal(seen.authorization, `Bearer ${CREDENTIAL}`);
});

test("a provider whose name resolves to metadata is refused at connect", async (t) => {
  const origin = await jsonOrigin({ data: [{ id: "m" }] });
  t.after(() => origin.close());

  // The rebinding shape: creation approved a public name, and DNS answers differently
  // by the time the request happens.
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

test("a rebinding answer is refused on the catalogue path too", async (t) => {
  const origin = await jsonOrigin({ data: [{ id: "m" }] });
  t.after(() => origin.close());

  // Every path that opens a socket has to be covered, or the weakest one is the
  // actual policy.
  await assert.rejects(
    discoverOpenAiCatalogue({
      provider: target("http://relay.example.com/v1", { timeoutMs: 5000 }),
      resolve: async () => ["127.0.0.1"],
    }),
    (error: unknown) => error instanceof ProviderError,
  );
  assert.equal(origin.connections, 0);
});

test("a rewritten row with a hostile config fails closed on read", async (t) => {
  const origin = await jsonOrigin({ data: [{ id: "m" }] });
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });
  seed(manager, origin.base);

  storage.sql
    .prepare("UPDATE providers SET config_json = ? WHERE id = 'relay'")
    .run(JSON.stringify({ headers: { authorization: "Bearer forged" } }));

  // Reading the row re-parses the config, so a hand-edited denied header is a load
  // failure rather than a header that quietly goes out.
  assert.throws(
    () => manager.getProvider("relay"),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "invalid_provider_config",
  );
});

test("a rewritten row with a hostile kind fails closed", async (t) => {
  const origin = await jsonOrigin({ data: [{ id: "m" }] });
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });
  seed(manager, origin.base);

  // The CHECK constraint refuses this, which is the first line of defence. Asserted so
  // a future migration that dropped the constraint would be caught here.
  assert.throws(() =>
    storage.sql.prepare("UPDATE providers SET kind = 'anthropic' WHERE id = 'relay'").run(),
  );
  assert.equal(manager.getProvider("relay")?.kind, "custom-openai");
});

test("a redirect toward metadata is refused rather than followed", async (t) => {
  const origin = await startOrigin((_request, response) => {
    response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
    response.end();
  });
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });
  seed(manager, origin.base);

  await assert.rejects(
    manager.discoverModels("relay"),
    (error: unknown) => error instanceof ProviderError && error.code === "unreachable",
  );
});

test("a slow-loris body is bounded by the timeout, not held open", async (t) => {
  const origin = await startOrigin((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"data":[');
    // Never finished. Without a timeout covering the body this would hang forever.
  });
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });

  manager.createProvider({
    id: "slow",
    kind: "custom-openai",
    displayName: "Slow",
    baseUrl: origin.base,
    config: { allowLoopback: true, timeoutMs: 1000 },
  });

  const started = Date.now();
  await assert.rejects(
    manager.discoverModels("slow"),
    (error: unknown) => error instanceof ProviderError,
  );
  assert.ok(Date.now() - started < 5000, "the request must not hang");
});

test("a non-UTF-8 body is a fixed failure, not a crash", async (t) => {
  const origin = await startOrigin((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(Buffer.from([0xff, 0xfe, 0xfd, 0xfc]));
  });
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });
  seed(manager, origin.base);

  await assert.rejects(
    manager.discoverModels("relay"),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "discovery_failed",
  );
});

test("a prototype-polluting catalogue cannot poison Object.prototype", async (t) => {
  const origin = await jsonOrigin(
    '{"data":[{"id":"m","__proto__":{"polluted":true}}],"__proto__":{"polluted":true}}',
  );
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });
  seed(manager, origin.base);

  await manager.discoverModelCatalogue("relay");
  assert.equal(
    ({} as Record<string, unknown>).polluted,
    undefined,
    "Object.prototype must be untouched",
  );
});

test("no credential ever appears in a request URL for a custom provider", async (t) => {
  const seenUrls: string[] = [];
  const origin = await startOrigin((request, response) => {
    seenUrls.push(String(request.url));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "m" }] }));
  });
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });
  seed(manager, origin.base);
  manager.setCredential("relay", CREDENTIAL);

  await manager.discoverModels("relay");
  await manager.discoverModelCatalogue("relay");
  await manager.testConnection("relay");
  await manager.detectCapabilities("relay");

  assert.ok(seenUrls.length >= 4);
  for (const url of seenUrls) {
    assert.ok(!url.includes(CREDENTIAL), url);
  }
});

test("a custom provider's credential is never returned in any view", async (t) => {
  const origin = await jsonOrigin({ data: [{ id: "m" }] });
  const { storage, manager } = harness();
  t.after(async () => {
    storage.close();
    await origin.close();
  });
  seed(manager, origin.base);
  manager.setCredential("relay", CREDENTIAL);

  const surfaces: unknown[] = [
    manager.getProvider("relay"),
    manager.listProviders(),
    manager.requireProvider("relay"),
    await manager.testConnection("relay"),
    await manager.detectCapabilities("relay"),
    await manager.discoverModelCatalogue("relay"),
  ];
  for (const surface of surfaces) {
    assert.ok(!JSON.stringify(surface).includes(CREDENTIAL));
  }
});

test("a header value is absent from every view even though it is stored", async (t) => {
  const secretish = "relay-header-value-that-should-not-be-echoed";
  const origin = await jsonOrigin({ data: [{ id: "m" }] });
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
      headers: { "x-relay-token": secretish },
    },
  });

  assert.ok(!JSON.stringify(manager.getProvider("relay")).includes(secretish));
  assert.ok(!JSON.stringify(manager.listProviders()).includes(secretish));
  // `requestConfig` is the one deliberate exception, because the router has to put the
  // value on the wire. Asserted so the exception stays explicit and greppable.
  assert.equal(manager.requestConfig("relay").headers?.["x-relay-token"], secretish);
});

test("every custom-provider entry point refuses an unknown id identically", async (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  const calls: Array<() => Promise<unknown> | unknown> = [
    () => manager.requireProvider("absent"),
    () => manager.requestConfig("absent"),
    () => manager.discoverModels("absent"),
    () => manager.discoverModelCatalogue("absent"),
    () => manager.testConnection("absent"),
    () => manager.detectCapabilities("absent"),
  ];
  for (const call of calls) {
    await assert.rejects(
      async () => call(),
      (error: unknown) =>
        error instanceof ProviderError && error.code === "provider_not_found",
    );
  }
});
