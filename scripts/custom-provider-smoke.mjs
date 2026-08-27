#!/usr/bin/env node
/**
 * Non-mocked custom-provider proof for Phase 9D.
 *
 * The claims under test are all about a *running system*, so nothing here is mocked:
 * a real on-disk SQLite database, a real HTTP listener, real `fetch`, and two real
 * loopback origins. In-process tests with an injected fetcher cannot show that an
 * SSRF-shaped provider is refused before a socket opens, that a custom header really
 * arrives on the wire, or that a credential-bearing error body never lands on disk.
 *
 * Exits non-zero on any failed check.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.BAYZ_CUSTOM_PROVIDER_SMOKE_LOADER) {
  const relaunch = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url)],
    {
      stdio: "inherit",
      env: { ...process.env, BAYZ_CUSTOM_PROVIDER_SMOKE_LOADER: "1" },
    },
  );
  process.exit(relaunch.status ?? 1);
}

const ADMIN_TOKEN = "custom-provider-smoke-token-0123456789";
const KEK_HEX = Buffer.alloc(32, 0x7d).toString("hex");
const CREDENTIAL = "sk-live-CUSTOM-SMOKE-must-never-touch-disk-6620";
const HEADER_VALUE = "relay-tenant-acme-7741";
const ERROR_SENTINEL = "UPSTREAM-ERROR-BODY-SENTINEL-CUSTOM-SMOKE";
const COMPLETION = "CUSTOM-PROVIDER-SMOKE-COMPLETION";
const PROMPT = "CUSTOM-PROVIDER-SMOKE-PROMPT-must-never-be-stored";

const failures = [];
const bodies = [];
const logLines = [];
let checks = 0;

function check(label, condition) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    failures.push(label);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/**
 * The relay origin.
 *
 * Records every request it sees, so the smoke can assert what actually reached the
 * wire rather than what the code intended to send.
 */
async function startRelay() {
  const seen = [];
  const server = createHttpServer((request, response) => {
    seen.push({
      url: request.url,
      authorization: request.headers.authorization,
      relayToken: request.headers["x-relay-token"],
      host: request.headers.host,
    });
    request.resume();
    request.on("end", () => {
      if (request.url?.includes("/chat/completions")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            model: "relay-model",
            choices: [
              {
                message: { role: "assistant", content: COMPLETION },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
          }),
        );
        return;
      }
      if (request.url?.includes("/deny")) {
        // Exactly what a real upstream does on a bad key: echo it back.
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: `rejected ${CREDENTIAL}`, note: ERROR_SENTINEL }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          data: [
            { id: "relay-model", pricing: { prompt: "0", completion: "0", request: "0", image: "0" } },
            { id: "relay-paid", pricing: { prompt: "0.000015", completion: "0.00006", request: "0", image: "0" } },
            { id: "relay-mystery" },
            { id: "<script>alert(1)</script>" },
          ],
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    seen,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Every byte of the database, including WAL and shared memory. */
function databaseBytes(dataDir) {
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

async function main() {
  const { buildApp } = await import("../apps/server/src/app.ts");
  const { createBayzRuntime } = await import("../apps/server/src/runtime.ts");

  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-custom-provider-smoke-")), ".bayz");
  const runtime = createBayzRuntime(
    { host: "127.0.0.1", port: 0, dataDir, dashboardRoot: "/nonexistent" },
    {
      env: { BAYZ_MASTER_KEY: KEK_HEX, BAYZ_API_TOKEN: ADMIN_TOKEN },
      notify: () => {},
      logger: (payload) => logLines.push(JSON.stringify(payload)),
    },
  );
  const app = buildApp({
    logger: false,
    apiToken: ADMIN_TOKEN,
    runtime,
    rateLimit: { max: 100000, authMax: 100000 },
  });
  const relay = await startRelay();
  let base = "";

  async function call(method, path, options = {}) {
    const headers = {};
    const token = options.token ?? ADMIN_TOKEN;
    if (token !== null) {
      headers.authorization = `Bearer ${token}`;
    }
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    bodies.push(text);
    let json;
    try {
      json = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, text, json };
  }

  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${app.server.address().port}`;

    section(`1. Real listener on ${base}`);
    check("the listener bound loopback", app.server.address().address === "127.0.0.1");

    section("2. A custom-openai relay against a real loopback origin");
    const created = await call("POST", "/api/providers", {
      body: {
        id: "relay",
        kind: "custom-openai",
        displayName: "Smoke Relay",
        baseUrl: `http://127.0.0.1:${relay.port}`,
        config: {
          allowLoopback: true,
          timeoutMs: 5000,
          headers: { "x-relay-token": HEADER_VALUE },
        },
      },
    });
    check("the custom provider was created", created.status === 201);
    check("the kind round-trips as custom-openai", created.json?.kind === "custom-openai");
    check(
      "the loopback opt-in is persisted",
      created.json?.config?.allowLoopback === true,
    );
    check(
      "the view lists header names",
      JSON.stringify(created.json?.config?.headerNames ?? []) === '["x-relay-token"]',
    );
    check(
      "the view does not echo the header value",
      !created.text.includes(HEADER_VALUE),
    );

    check(
      "the credential was stored",
      (
        await call("PUT", "/api/providers/relay/credential", {
          body: { value: CREDENTIAL },
        })
      ).status === 204,
    );

    section("3. Discovery, catalogue, capabilities, and test connection all work");
    const discovered = await call("POST", "/api/providers/relay/discover");
    check("discovery succeeded", discovered.status === 200);
    check(
      "the hostile model id was skipped",
      Array.isArray(discovered.json?.models) &&
        discovered.json.models.includes("relay-model") &&
        !discovered.json.models.some((id) => id.includes("<script>")),
    );

    const catalogued = await call("POST", "/api/providers/relay/catalogue");
    check("the catalogue succeeded", catalogued.status === 200);
    check(
      "the catalogue agrees with discovery on the model id set",
      JSON.stringify((catalogued.json?.models ?? []).map((entry) => entry.id)) ===
        JSON.stringify(discovered.json?.models ?? []),
    );
    check(
      "a loopback provider classifies LOCAL",
      (catalogued.json?.models ?? []).every((entry) => entry.economics === "LOCAL"),
    );
    check(
      "no upstream price is republished",
      !catalogued.text.includes("0.000015"),
    );

    const capabilities = await call("POST", "/api/providers/relay/capabilities");
    check("capabilities succeeded", capabilities.status === 200);
    check("models is genuinely probed", capabilities.json?.models === true);
    check(
      "tool support is reported as unknown rather than guessed",
      capabilities.json?.tools === "unknown",
    );
    check(
      "streaming support is reported as unknown rather than guessed",
      capabilities.json?.streaming === "unknown",
    );

    const tested = await call("POST", "/api/providers/relay/test");
    check("the connection test succeeded", tested.status === 200);
    check("the test reports ok", tested.json?.ok === true);
    check("the test reports a latency", typeof tested.json?.latencyMs === "number");
    check("the test reports a model count", tested.json?.modelCount === 3);

    section("4. The custom header really reaches the wire, and cannot forge auth");
    check(
      "the relay observed the custom header",
      relay.seen.some((entry) => entry.relayToken === HEADER_VALUE),
    );
    check(
      "the credential arrived as a bearer header",
      relay.seen.some((entry) => entry.authorization === `Bearer ${CREDENTIAL}`),
    );
    check(
      "no request URL carried the credential",
      relay.seen.every((entry) => !String(entry.url).includes(CREDENTIAL)),
    );
    check(
      "the Host header is the real origin, not a config value",
      relay.seen.every((entry) => String(entry.host).startsWith("127.0.0.1:")),
    );

    section("5. Chat through the custom provider");
    check(
      "the route was created",
      (
        await call("POST", "/api/routes", {
          body: { id: "relay-route", model: "relay-model", providerId: "relay" },
        })
      ).status === 201,
    );
    const chat = await call("POST", "/v1/chat/completions", {
      body: { model: "relay-model", messages: [{ role: "user", content: PROMPT }] },
    });
    check("the chat completed through the custom provider", chat.status === 200);
    check(
      "the completion came from the relay",
      chat.json?.choices?.[0]?.message?.content === COMPLETION,
    );
    check(
      "the chat request carried the custom header too",
      relay.seen.some(
        (entry) =>
          String(entry.url).includes("/chat/completions") &&
          entry.relayToken === HEADER_VALUE,
      ),
    );

    section("6. An SSRF-shaped provider cannot be created at all");
    for (const [label, baseUrl] of [
      ["the cloud metadata address", "http://169.254.169.254/latest/meta-data"],
      ["the GCP metadata name", "http://metadata.google.internal/v1"],
      ["a private LAN address", "http://10.0.0.5/v1"],
      ["loopback without the opt-in", "http://127.0.0.1:11434/v1"],
      ["a decimal-encoded loopback", "http://2130706433/v1"],
    ]) {
      const refused = await call("POST", "/api/providers", {
        body: {
          id: "ssrf",
          kind: "custom-openai",
          displayName: "SSRF",
          baseUrl,
        },
      });
      check(`${label} is refused with a 400`, refused.status === 400);
      check(
        `${label} refusal names the config, not the address`,
        refused.json?.error?.code === "invalid_provider_config" &&
          !refused.text.includes(baseUrl),
      );
    }
    check(
      "no SSRF provider row was created",
      (await call("GET", "/api/providers")).json?.providers?.every(
        (provider) => provider.id !== "ssrf",
      ) === true,
    );

    section("7. A denied header is refused and named");
    for (const name of ["authorization", "Authorization", "host", "proxy-authorization"]) {
      const refused = await call("POST", "/api/providers", {
        body: {
          id: "smuggle",
          kind: "custom-openai",
          displayName: "Smuggle",
          baseUrl: "https://relay.example.com/v1",
          config: { headers: { [name]: `Bearer ${CREDENTIAL}` } },
        },
      });
      check(`the ${name} header is refused with a 400`, refused.status === 400);
      check(
        `the ${name} refusal names the header and not the value`,
        refused.text.toLowerCase().includes(name.toLowerCase()) &&
          !refused.text.includes(CREDENTIAL),
      );
    }

    section("8. An upstream error body never surfaces");
    check(
      "the failing relay provider was created",
      (
        await call("POST", "/api/providers", {
          body: {
            id: "denier",
            kind: "custom-openai",
            displayName: "Denier",
            baseUrl: `http://127.0.0.1:${relay.port}`,
            config: { allowLoopback: true, timeoutMs: 5000, discoveryPath: "/deny" },
          },
        })
      ).status === 201,
    );
    check(
      "the denier credential was stored",
      (
        await call("PUT", "/api/providers/denier/credential", {
          body: { value: CREDENTIAL },
        })
      ).status === 204,
    );

    const failedDiscovery = await call("POST", "/api/providers/denier/discover");
    check("a 401 upstream surfaces as an error", failedDiscovery.status >= 400);
    check(
      "the upstream error body is absent from the response",
      !failedDiscovery.text.includes(ERROR_SENTINEL) &&
        !failedDiscovery.text.includes(CREDENTIAL),
    );

    const failedTest = await call("POST", "/api/providers/denier/test");
    check("the connection test itself still succeeds", failedTest.status === 200);
    check("the test reports failure", failedTest.json?.ok === false);
    check(
      "the test reports auth_failed rather than a generic failure",
      failedTest.json?.failureCode === "auth_failed",
    );
    check(
      "the test result carries no upstream body",
      !failedTest.text.includes(ERROR_SENTINEL),
    );

    section("9. Nothing sensitive reached disk, responses, or logs");
    const bytes = databaseBytes(dataDir);
    check("the credential is absent from the database bytes", !bytes.includes(CREDENTIAL));
    check(
      "the upstream error body is absent from the database bytes",
      !bytes.includes(ERROR_SENTINEL),
    );
    check("the prompt is absent from the database bytes", !bytes.includes(PROMPT));
    check(
      "the completion is absent from the database bytes",
      !bytes.includes(COMPLETION),
    );
    // The header value is stored configuration, so it is legitimately on disk. What
    // must not happen is it coming back out through a response.
    check(
      "the header value never appears in any response body",
      bodies.every((body) => !body.includes(HEADER_VALUE)),
    );

    const logs = logLines.join("\n");
    check("no log line carries the credential", !logs.includes(CREDENTIAL));
    check("no log line carries the upstream error body", !logs.includes(ERROR_SENTINEL));
    check("no log line carries the prompt", !logs.includes(PROMPT));
    check("no log line carries the completion", !logs.includes(COMPLETION));
    check("no log line carries the header value", !logs.includes(HEADER_VALUE));
    check(
      "the custom provider work is observable at all",
      logs.includes("provider_created") || logs.includes("provider_connection_tested"),
    );

    section("10. Read scope cannot make BAYZ originate traffic");
    const reader = await call("POST", "/api/identities", {
      body: { id: "reader", displayName: "Reader", scopes: ["providers.read"] },
    });
    check("the read-only identity was created", reader.status === 201);
    const readerKey = reader.json?.key;
    for (const path of ["test", "capabilities", "catalogue", "discover"]) {
      const denied = await call("POST", `/api/providers/relay/${path}`, {
        token: readerKey,
      });
      check(`a read-scoped key is refused on /${path}`, denied.status === 403);
    }
    const before = relay.seen.length;
    await call("POST", "/api/providers/relay/test", { token: readerKey });
    check("the refusal happened before any upstream request", relay.seen.length === before);
  } finally {
    await app.close();
    runtime.close();
    await relay.close();
  }

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length > 0) {
    console.error("custom provider smoke: FAIL");
    process.exit(1);
  }
  console.log("custom provider smoke: PASS");
}

main().catch((error) => {
  console.error("custom provider smoke: FAIL");
  console.error(error);
  process.exit(1);
});
