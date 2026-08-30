#!/usr/bin/env node
/**
 * Non-mocked router proof for Phase 5.
 *
 * Runs against a real on-disk SQLite database, real loopback origin servers, and a
 * real HTTP CONNECT proxy. In-process tests cannot show that a chat request truly
 * completes over a socket, that a proxy-bound route genuinely traverses its proxy,
 * or that a prompt really is absent from the bytes on disk.
 *
 * Exits non-zero on any failed check.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const STORAGE_ENTRY = fileURLToPath(
  new URL("../packages/storage/src/index.ts", import.meta.url),
);
const PROVIDERS_ENTRY = fileURLToPath(
  new URL("../packages/providers/src/index.ts", import.meta.url),
);
const PROXY_ENTRY = fileURLToPath(
  new URL("../packages/proxy/src/index.ts", import.meta.url),
);
const ROUTER_ENTRY = fileURLToPath(
  new URL("../packages/router/src/index.ts", import.meta.url),
);

if (!process.env.BAYZ_ROUTER_SMOKE_LOADER) {
  const relaunch = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url)],
    { stdio: "inherit", env: { ...process.env, BAYZ_ROUTER_SMOKE_LOADER: "1" } },
  );
  process.exit(relaunch.status ?? 1);
}

const PROMPT = "PROMPT-ROUTER-SMOKE-must-never-touch-disk-3141";
const COMPLETION = "COMPLETION-ROUTER-SMOKE-also-never-persisted";
const CREDENTIAL = "sk-router-smoke-credential-must-never-leak";
const KEK_HEX = Buffer.alloc(32, 0x1f).toString("hex");

const captured = [];
const failures = [];
let checks = 0;

/**
 * Record one check, numbered.
 *
 * The number is what makes a citation resolvable: 9L Task 1's `resolveEvidence` refuses
 * `smoke:<script>#<n>` against a script that prints no numbers, because `#n` cannot be looked up in
 * output that has none — and 9L Task 2's feature inventory needs exactly that citation for the
 * Phase 1-8 features this script proves. **Numbers are contractual: append checks, never insert
 * one**, or every citation after the insertion point silently starts pointing at the wrong check.
 */
function check(label, condition) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${String(checks).padStart(2)}  ${label}`);
  } else {
    console.error(`  FAIL ${String(checks).padStart(2)}  ${label}`);
    failures.push(`#${checks} ${label}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function logger(payload) {
  captured.push(JSON.stringify(payload));
}

const openSockets = new Set();

function track(socket) {
  openSockets.add(socket);
  socket.on("close", () => openSockets.delete(socket));
  socket.on("error", () => {});
  return socket;
}

/** A real origin that records what it received and replies per its script. */
async function startOrigin(name, script) {
  const seen = [];
  let index = 0;
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      seen.push({
        url: request.url,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const step = script[Math.min(index, script.length - 1)];
      index += 1;
      response.writeHead(step.status, { "content-type": "application/json" });
      response.end(JSON.stringify(step.body));
    });
  });
  server.on("connection", track);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    name,
    server,
    port: server.address().port,
    seen,
  };
}

/** A real CONNECT proxy that records the tunnels it opened. */
async function startConnectProxy(originPort) {
  const connects = [];
  const server = createServer((client) => {
    track(client);
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, Buffer.from(chunk)]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        return;
      }
      client.off("data", onData);
      connects.push(head.subarray(0, end).toString("utf8"));
      const rest = head.subarray(end + 4);
      const upstream = track(
        connect({ host: "127.0.0.1", port: originPort }, () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (rest.length > 0) {
            upstream.write(rest);
          }
          client.pipe(upstream);
          upstream.pipe(client);
        }),
      );
      upstream.on("error", () => client.destroy());
    };
    client.on("data", onData);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, connects };
}

function completionBody(content) {
  return {
    id: "chatcmpl-smoke",
    model: "gpt-4o",
    choices: [
      { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
  };
}

function readDatabaseBytes(dataDir) {
  const base = join(dataDir, "bayz.db");
  const parts = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${base}${suffix}`;
    if (existsSync(file)) {
      parts.push(readFileSync(file));
    }
  }
  return Buffer.concat(parts);
}

const REQUEST = {
  model: "gpt-4o",
  messages: [{ role: "user", content: PROMPT }],
};

async function main() {
  const root = mkdtempSync(join(tmpdir(), "bayz-router-smoke-"));
  const dataDir = join(root, ".bayz");
  const { openSecretStorage } = await import(STORAGE_ENTRY);
  const { createProviderManager } = await import(PROVIDERS_ENTRY);
  const { createProxyManager } = await import(PROXY_ENTRY);
  const { createRouter, RouterError } = await import(ROUTER_ENTRY);

  const primary = await startOrigin("primary", [
    { status: 200, body: completionBody(COMPLETION) },
  ]);
  const flaky = await startOrigin("flaky", [{ status: 503, body: { error: "down" } }]);
  const backup = await startOrigin("backup", [
    { status: 200, body: completionBody("FAILOVER-COMPLETION") },
  ]);
  const denied = await startOrigin("denied", [{ status: 401, body: { error: "bad key" } }]);
  const proxy = await startConnectProxy(primary.port);

  const build = () => {
    const storage = openSecretStorage({
      dataDir,
      env: { BAYZ_MASTER_KEY: KEK_HEX },
      logger,
    });
    const providers = createProviderManager({ storage, logger });
    const proxies = createProxyManager({ storage, logger });
    return {
      storage,
      router: createRouter({ storage, providers, proxies, logger }),
    };
  };

  try {
    section("1. Register providers, a proxy, and routes on a real database");
    let { router, storage } = build();
    try {
      router.providers.createProvider({
        id: "primary",
        kind: "openai-compatible",
        displayName: "Primary",
        baseUrl: `http://127.0.0.1:${primary.port}/v1`,
        config: { allowLoopback: true },
      });
      router.providers.setCredential("primary", CREDENTIAL);
      router.providers.createProvider({
        id: "flaky",
        kind: "openai-compatible",
        displayName: "Flaky",
        baseUrl: `http://127.0.0.1:${flaky.port}/v1`,
        config: { allowLoopback: true },
      });
      router.providers.createProvider({
        id: "backup",
        kind: "openai-compatible",
        displayName: "Backup",
        baseUrl: `http://127.0.0.1:${backup.port}/v1`,
        config: { allowLoopback: true },
      });
      router.providers.createProvider({
        id: "denied",
        kind: "openai-compatible",
        displayName: "Denied",
        baseUrl: `http://127.0.0.1:${denied.port}/v1`,
        config: { allowLoopback: true },
      });
      router.proxies.createProxy({
        id: "tunnel",
        kind: "http",
        host: "127.0.0.1",
        port: proxy.port,
        config: {
          connectTimeoutMs: 5000,
          healthCheckHost: "127.0.0.1",
          healthCheckPort: primary.port,
        },
      });

      const route = router.createRoute({
        // This smoke proves transport, proxying, and failover against fixture origins
        // that publish no pricing metadata, so every model here is undiscovered — and
        // undiscovered is not free (spec §25 rule 5). Free-only routing has its own
        // coverage in `packages/router/test/free-only.test.ts`; leaving the default on
        // here would fail every chat below for a reason this smoke is not about.
        freeOnly: false,
        id: "direct",
        model: "gpt-4o",
        providerId: "primary",
        priority: 500,
      });
      check("route row created", route.id === "direct");
      check("database file exists on disk", existsSync(join(dataDir, "bayz.db")));

      section("2. A real chat request completes directly");
      const direct = await router.chat(REQUEST);
      check("the completion came back", direct.content === COMPLETION);
      check("the route is reported", direct.routeId === "direct");
      check("the provider is reported", direct.providerId === "primary");
      check("no proxy was used", direct.proxyId === undefined);
      check("exactly one attempt", direct.attempts === 1);
      check(
        "usage was normalized",
        direct.usage?.promptTokens === 9 && direct.usage?.totalTokens === 13,
      );
      check(
        "the credential travelled as a bearer header",
        primary.seen[0]?.authorization === `Bearer ${CREDENTIAL}`,
      );
      check(
        "no credential appeared in the request URL",
        !String(primary.seen[0]?.url).includes(CREDENTIAL) &&
          !String(primary.seen[0]?.url).includes("?"),
      );
      check(
        "no credential appeared in the request body",
        !String(primary.seen[0]?.body).includes(CREDENTIAL),
      );
      check(
        "the result object carries no credential",
        !JSON.stringify(direct).includes(CREDENTIAL),
      );

      section("3. A proxy-bound route really traverses the proxy");
      router.updateRoute("direct", { enabled: false });
      // A distinct model, because (model, provider_id) is unique by design: the
      // same pair cannot be bound twice, which is what the registry enforces.
      router.createRoute({
        freeOnly: false,
        id: "viaproxy",
        model: "gpt-4o-mini",
        providerId: "primary",
        proxyId: "tunnel",
        priority: 400,
      });
      const proxied = await router.chat({ ...REQUEST, model: "gpt-4o-mini" });
      check("the proxied completion came back", proxied.content === COMPLETION);
      check("the proxy binding is reported", proxied.proxyId === "tunnel");
      check("the proxy opened exactly one tunnel", proxy.connects.length === 1);
      check(
        "the tunnel targeted the origin",
        (proxy.connects[0] ?? "").startsWith(`CONNECT 127.0.0.1:${primary.port} `),
      );
      check(
        "the CONNECT preamble carried no credential",
        !(proxy.connects[0] ?? "").includes(CREDENTIAL),
      );
      router.deleteRoute("viaproxy");

      section("4. Failover advances past a failing provider");
      router.createRoute({
        freeOnly: false,
        id: "r-flaky",
        model: "gpt-4o",
        providerId: "flaky",
        priority: 900,
      });
      router.createRoute({
        freeOnly: false,
        id: "r-backup",
        model: "gpt-4o",
        providerId: "backup",
        priority: 100,
      });
      const failedOver = await router.chat(REQUEST);
      check("failover produced a completion", failedOver.content === "FAILOVER-COMPLETION");
      check("failover landed on the backup route", failedOver.routeId === "r-backup");
      check("the failed attempt was counted", failedOver.attempts === 2);
      check("the flaky provider really was tried", flaky.seen.length === 1);

      section("5. auth_failed stops instead of masking a bad credential");
      router.updateRoute("r-flaky", { enabled: false });
      router.updateRoute("r-backup", { enabled: false });
      router.createRoute({
        freeOnly: false,
        id: "r-denied",
        model: "gpt-4o",
        providerId: "denied",
        priority: 900,
      });
      const backupHitsBefore = backup.seen.length;
      let authCode;
      let authMessage = "";
      try {
        await router.chat(REQUEST);
      } catch (error) {
        authCode = error?.code;
        authMessage = String(error?.message ?? "");
      }
      check("a 401 surfaces as auth_failed", authCode === "auth_failed");
      check(
        "no other provider was tried after auth_failed",
        backup.seen.length === backupHitsBefore,
      );
      check(
        "the upstream error body never reached the message",
        !authMessage.includes("bad key"),
      );
      router.deleteRoute("r-denied");

      section("6. Hostile input is refused before any request");
      const primaryHitsBefore = primary.seen.length;
      let streamCode;
      try {
        await router.chat({ ...REQUEST, stream: true });
      } catch (error) {
        streamCode = error?.code;
      }
      check("a stream flag is rejected", streamCode === "invalid_request");

      let modelCode;
      try {
        await router.chat({ ...REQUEST, model: "gpt-4o/../../admin" });
      } catch (error) {
        modelCode = error?.code;
      }
      check(
        "a traversal model name is rejected",
        modelCode === "invalid_request" || modelCode === "invalid_model",
      );

      let noRouteCode;
      try {
        await router.chat({ ...REQUEST, model: "unbound-model" });
      } catch (error) {
        noRouteCode = error instanceof RouterError ? error.code : "unknown";
      }
      check("an unbound model is no_route", noRouteCode === "no_route");
      check(
        "no hostile request reached the upstream",
        primary.seen.length === primaryHitsBefore,
      );

      section("7. No credential accessor is exposed");
      check(
        "the provider manager has no getter",
        typeof router.providers.getCredential === "undefined",
      );
      check(
        "the router exposes no credential",
        typeof router.getCredential === "undefined" &&
          !Object.keys(router).includes("credential"),
      );
    } finally {
      router.close();
    }

    section("8. Reopen in a SEPARATE PROCESS and confirm persistence");
    {
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "-e",
          `
          const { openSecretStorage } = await import(${JSON.stringify(STORAGE_ENTRY)});
          const { createProviderManager } = await import(${JSON.stringify(PROVIDERS_ENTRY)});
          const { createProxyManager } = await import(${JSON.stringify(PROXY_ENTRY)});
          const { createRouter } = await import(${JSON.stringify(ROUTER_ENTRY)});
          const storage = openSecretStorage({
            dataDir: ${JSON.stringify(dataDir)},
            env: { BAYZ_MASTER_KEY: ${JSON.stringify(KEK_HEX)} },
          });
          const router = createRouter({
            storage,
            providers: createProviderManager({ storage }),
            proxies: createProxyManager({ storage }),
          });
          try {
            process.stdout.write(JSON.stringify({
              routes: router.listRoutes().map((r) => r.id),
              providers: router.providers.listProviders().map((p) => p.id),
              credentialPresent: router.providers.requireProvider("primary").credentialPresent,
              hasAccessor: typeof router.providers.getCredential !== "undefined",
            }));
          } finally {
            router.close();
          }
        `,
        ],
        { encoding: "utf8", env: { ...process.env, BAYZ_ROUTER_SMOKE_LOADER: "1" } },
      );
      check("child process reopened the database", child.status === 0);
      let parsed = {};
      try {
        parsed = JSON.parse(child.stdout.trim());
      } catch {
        // Reported by the checks below.
      }
      check(
        "route rows survived the reopen",
        JSON.stringify(parsed.routes) ===
          JSON.stringify(["direct", "r-backup", "r-flaky"]),
      );
      check(
        "provider rows survived the reopen",
        JSON.stringify(parsed.providers) ===
          JSON.stringify(["backup", "denied", "flaky", "primary"]),
      );
      check(
        "the credential survived and is still only reported as present",
        parsed.credentialPresent === true && parsed.hasAccessor === false,
      );
    }

    section("9. Scan the real bytes on disk");
    {
      const bytes = readDatabaseBytes(dataDir);
      check("database bytes were read", bytes.byteLength > 0);
      check(
        "the prompt is absent from bayz.db, -wal, and -shm",
        !bytes.includes(Buffer.from(PROMPT, "utf8")),
      );
      check(
        "the completion is absent from bayz.db, -wal, and -shm",
        !bytes.includes(Buffer.from(COMPLETION, "utf8")),
      );
      check(
        "the credential is absent from bayz.db, -wal, and -shm",
        !bytes.includes(Buffer.from(CREDENTIAL, "utf8")),
      );
      check(
        "the root key is absent from bayz.db, -wal, and -shm",
        !bytes.includes(Buffer.from(KEK_HEX, "utf8")),
      );
      check(
        "route metadata is present, proving the scan reads real content",
        bytes.includes(Buffer.from("r-backup", "utf8")),
      );
    }

    section("10. Scan captured log output");
    {
      const logs = captured.join("\n");
      check("log output was captured", captured.length > 0);
      check("no prompt in the logs", !logs.includes(PROMPT));
      check("no completion in the logs", !logs.includes(COMPLETION));
      check("no credential in the logs", !logs.includes(CREDENTIAL));
      check("no root key in the logs", !logs.includes(KEK_HEX));
      check("routing attempts were logged", logs.includes("router_attempt"));
    }
  } finally {
    for (const socket of openSockets) {
      socket.destroy();
    }
    for (const origin of [primary, flaky, backup, denied]) {
      await new Promise((resolve) => origin.server.close(resolve));
    }
    await new Promise((resolve) => proxy.server.close(resolve));
  }

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length > 0) {
    console.error("router smoke: FAIL");
    process.exit(1);
  }
  console.log("router smoke: PASS");
}

main().catch((error) => {
  console.error("router smoke: FAIL");
  console.error(error);
  process.exit(1);
});
