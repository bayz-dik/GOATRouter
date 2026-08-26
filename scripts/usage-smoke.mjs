#!/usr/bin/env node
/**
 * Non-mocked Phase 8 usage/telemetry proof.
 *
 * Drives the real stack end to end:
 *
 *   real fetch client
 *     -> authenticated BAYZ HTTP API (real listener)
 *     -> real Router
 *     -> real loopback provider origins
 *     -> real CONNECT proxy
 *     -> telemetry event boundary
 *     -> SQLite usage persistence
 *     -> authenticated Usage API
 *     -> live Flux Core display-safe adapter
 *
 * Then seeds six unmistakable sentinels and scans the database, WAL, SHM, stdout,
 * stderr, structured logs, persisted rows, and every API response for them.
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

const APP_ENTRY = fileURLToPath(new URL("../apps/server/src/app.ts", import.meta.url));
const RUNTIME_ENTRY = fileURLToPath(new URL("../apps/server/src/runtime.ts", import.meta.url));
const ADAPTER_ENTRY = fileURLToPath(
  new URL("../apps/dashboard/src/flux/adapter.ts", import.meta.url),
);

if (!process.env.BAYZ_USAGE_SMOKE_LOADER) {
  const relaunch = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url)],
    { stdio: "inherit", env: { ...process.env, BAYZ_USAGE_SMOKE_LOADER: "1" } },
  );
  process.exit(relaunch.status ?? 1);
}

/* ---------- sentinels ---------- */
const PROMPT_CONTENT_SENTINEL = "PROMPT_CONTENT_SENTINEL_7f3a91";
const COMPLETION_CONTENT_SENTINEL = "COMPLETION_CONTENT_SENTINEL_b28d40";
const PROVIDER_CREDENTIAL_SENTINEL = "PROVIDER_CREDENTIAL_SENTINEL_c91e57";
const PROXY_CREDENTIAL_SENTINEL = "PROXY_CREDENTIAL_SENTINEL_d40f2a";
const BAYZ_AUTHORIZATION_SENTINEL = "BAYZ_AUTHORIZATION_SENTINEL_e57c13";
const UPSTREAM_ERROR_BODY_SENTINEL = "UPSTREAM_ERROR_BODY_SENTINEL_a03b88";

const CONTENT_SENTINELS = [
  PROMPT_CONTENT_SENTINEL,
  COMPLETION_CONTENT_SENTINEL,
  UPSTREAM_ERROR_BODY_SENTINEL,
];
const SECRET_SENTINELS = [
  PROVIDER_CREDENTIAL_SENTINEL,
  PROXY_CREDENTIAL_SENTINEL,
  BAYZ_AUTHORIZATION_SENTINEL,
];
const ALL_SENTINELS = [...CONTENT_SENTINELS, ...SECRET_SENTINELS];

const KEK_HEX = Buffer.alloc(32, 0x5f).toString("hex");

/* ---------- harness ---------- */
const captured = [];
const responseBodies = [];
const stdoutCapture = [];
const stderrCapture = [];
const failures = [];
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

const openSockets = new Set();
function track(socket) {
  openSockets.add(socket);
  socket.on("close", () => openSockets.delete(socket));
  socket.on("error", () => {});
  return socket;
}

/** An origin whose replies are scripted per call. */
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
      response.end(typeof step.body === "string" ? step.body : JSON.stringify(step.body));
    });
  });
  server.on("connection", track);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { name, server, port: server.address().port, seen };
}

/** A real CONNECT proxy that requires Basic auth carrying the proxy sentinel. */
async function startConnectProxy(originPort) {
  const connects = [];
  const expected = Buffer.from(`bayz:${PROXY_CREDENTIAL_SENTINEL}`, "utf8").toString("base64");
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
      const request = head.subarray(0, end).toString("utf8");
      connects.push(request);
      if (!request.includes(expected)) {
        client.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
        client.end();
        return;
      }
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

function completionBody(content, usage) {
  return {
    id: "chatcmpl-smoke",
    model: "gpt-4o",
    choices: [
      { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
    ],
    ...(usage === undefined ? {} : { usage }),
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

async function main() {
  const root = mkdtempSync(join(tmpdir(), "bayz-usage-smoke-"));
  const dataDir = join(root, ".bayz");

  const { buildApp } = await import(APP_ENTRY);
  const { createBayzRuntime } = await import(RUNTIME_ENTRY);
  const { buildLiveViewModel, buildDemoViewModel } = await import(ADAPTER_ENTRY);

  /* Capture stdout/stderr so a stray console write is caught by the scan. */
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => {
    stdoutCapture.push(String(chunk));
    return realOut(chunk, ...rest);
  };
  process.stderr.write = (chunk, ...rest) => {
    stderrCapture.push(String(chunk));
    return realErr(chunk, ...rest);
  };

  const ok = await startOrigin("ok", [
    {
      status: 200,
      body: completionBody(COMPLETION_CONTENT_SENTINEL, {
        prompt_tokens: 31,
        completion_tokens: 9,
        total_tokens: 40,
      }),
    },
  ]);
  const zero = await startOrigin("zero", [
    {
      status: 200,
      body: completionBody(COMPLETION_CONTENT_SENTINEL, {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      }),
    },
  ]);
  const unknown = await startOrigin("unknown", [
    { status: 200, body: completionBody(COMPLETION_CONTENT_SENTINEL) },
  ]);
  const malformed = await startOrigin("malformed", [
    {
      status: 200,
      body: completionBody(COMPLETION_CONTENT_SENTINEL, {
        prompt_tokens: -12,
        completion_tokens: "lots",
        total_tokens: null,
      }),
    },
  ]);
  const hostile = await startOrigin("hostile", [
    {
      status: 500,
      body: { error: `${UPSTREAM_ERROR_BODY_SENTINEL} ${PROVIDER_CREDENTIAL_SENTINEL}` },
    },
  ]);
  const failing = await startOrigin("failing", [{ status: 503, body: { error: "down" } }]);
  const proxied = await startOrigin("proxied", [
    { status: 200, body: completionBody(COMPLETION_CONTENT_SENTINEL) },
  ]);
  const proxy = await startConnectProxy(proxied.port);

  const runtime = createBayzRuntime(
    { host: "127.0.0.1", port: 0, dataDir, dashboardRoot: join(root, "no-dashboard") },
    {
      env: {
        BAYZ_MASTER_KEY: KEK_HEX,
        BAYZ_API_TOKEN: BAYZ_AUTHORIZATION_SENTINEL,
        BAYZ_USAGE_RETENTION: "50",
      },
      notify: () => {},
      logger: (payload) => captured.push(JSON.stringify(payload)),
    },
  );
  const app = buildApp({ logger: false, apiToken: BAYZ_AUTHORIZATION_SENTINEL, runtime });

  let base;

  /**
   * Response bodies are bucketed.
   *
   * A chat response legitimately contains the completion — that is the product
   * working. What must never contain it is a *usage/telemetry* response, so the
   * scan below is scoped to those rather than blurring the two.
   */
  async function call(method, path, options = {}) {
    const headers = { ...(options.headers ?? {}) };
    if (options.auth !== false) {
      headers.authorization = `Bearer ${BAYZ_AUTHORIZATION_SENTINEL}`;
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
    if (path.startsWith("/api/usage") || path.startsWith("/api/providers") ||
        path.startsWith("/api/proxies") || path.startsWith("/api/routes") ||
        path.startsWith("/api/status")) {
      responseBodies.push(text);
    }
    let json;
    try {
      json = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, headers: response.headers, text, json };
  }

  const seedProvider = (id, port) =>
    call("POST", "/api/providers", {
      body: {
        id,
        kind: "openai-compatible",
        displayName: id.toUpperCase(),
        baseUrl: `http://127.0.0.1:${port}/v1`,
      },
    });

  const chat = (model) =>
    call("POST", "/v1/chat/completions", {
      body: { model, messages: [{ role: "user", content: PROMPT_CONTENT_SENTINEL }] },
    });

  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${app.server.address().port}`;

    section(`1. Real authenticated stack on ${base}`);
    check("the listener bound loopback", app.server.address().address === "127.0.0.1");
    const health = await call("GET", "/api/health", { auth: false });
    check("health is unauthenticated and unchanged", health.status === 200);
    check(
      "health keeps its Phase 1 field set",
      JSON.stringify(Object.keys(health.json ?? {}).sort()) ===
        JSON.stringify(["status", "uptimeSeconds", "version"]),
    );
    check(
      "usage endpoints reject an unauthenticated caller",
      (await call("GET", "/api/usage/summary", { auth: false })).status === 401 &&
        (await call("GET", "/api/usage/requests", { auth: false })).status === 401 &&
        (await call("GET", "/api/usage/providers", { auth: false })).status === 401,
    );

    section("2. Strict CSP on the real served response");
    check(
      "the CSP header is present",
      typeof health.headers.get("content-security-policy") === "string",
    );
    const csp = health.headers.get("content-security-policy") ?? "";
    check("default-src is 'none'", csp.includes("default-src 'none'"));
    check("no unsafe-eval", !csp.includes("unsafe-eval"));
    check("no unsafe-inline", !csp.includes("unsafe-inline"));
    check("no remote origin in the policy", !/https?:\/\//.test(csp));
    check("no Google Fonts in the policy", !/googleapis|gstatic/.test(csp));
    check("object-src is 'none'", csp.includes("object-src 'none'"));
    check("frame-ancestors is 'none'", csp.includes("frame-ancestors 'none'"));

    section("3. Successful request with real token counts");
    await seedProvider("ok", ok.port);
    await call("PUT", "/api/providers/ok/credential", {
      body: { value: PROVIDER_CREDENTIAL_SENTINEL },
    });
    await call("POST", "/api/routes", {
      body: { id: "r-ok", model: "gpt-4o", providerId: "ok" },
    });
    const okChat = await chat("gpt-4o");
    check("the chat succeeded", okChat.status === 200);
    check(
      "the completion came from the origin",
      okChat.json?.choices?.[0]?.message?.content === COMPLETION_CONTENT_SENTINEL,
    );
    check(
      "the upstream received the credential",
      ok.seen.some((entry) => entry.authorization === `Bearer ${PROVIDER_CREDENTIAL_SENTINEL}`),
    );

    let summary = await call("GET", "/api/usage/summary");
    check("usage recorded the request", summary.json?.totalRequests === 1);
    check("real prompt tokens were stored", summary.json?.promptTokens === 31);
    check("real completion tokens were stored", summary.json?.completionTokens === 9);
    check("cost is reported unavailable", summary.json?.costAvailable === false);
    check("a cost reason is stated", summary.json?.costReason === "no_pricing_data");
    check("retention is reported", summary.json?.retention?.requests === 50);

    section("4. Unknown, zero, and malformed token usage");
    await seedProvider("unknown", unknown.port);
    await call("POST", "/api/routes", {
      body: { id: "r-unknown", model: "model-unknown", providerId: "unknown" },
    });
    check("the unknown-usage chat succeeded", (await chat("model-unknown")).status === 200);

    await seedProvider("zero", zero.port);
    await call("POST", "/api/routes", {
      body: { id: "r-zero", model: "model-zero", providerId: "zero" },
    });
    check("the zero-usage chat succeeded", (await chat("model-zero")).status === 200);

    await seedProvider("malformed", malformed.port);
    await call("POST", "/api/routes", {
      body: { id: "r-malformed", model: "model-malformed", providerId: "malformed" },
    });
    check("the malformed-usage chat succeeded", (await chat("model-malformed")).status === 200);

    const rows = await call("GET", "/api/usage/requests?limit=50");
    const byModel = new Map(
      (rows.json?.requests ?? []).map((row) => [row.model, row]),
    );
    check(
      "unknown token counts stayed null",
      byModel.get("model-unknown")?.promptTokens === null &&
        byModel.get("model-unknown")?.completionTokens === null,
    );
    check(
      "a genuine zero stayed zero",
      byModel.get("model-zero")?.promptTokens === 0 &&
        byModel.get("model-zero")?.completionTokens === 0,
    );
    check(
      "malformed upstream usage degraded to null, not zero",
      byModel.get("model-malformed")?.promptTokens === null &&
        byModel.get("model-malformed")?.completionTokens === null,
    );

    section("5. Hostile upstream error body");
    await seedProvider("hostile", hostile.port);
    await call("POST", "/api/routes", {
      body: { id: "r-hostile", model: "model-hostile", providerId: "hostile" },
    });
    const hostileChat = await chat("model-hostile");
    check("a 500 upstream surfaces as 502", hostileChat.status === 502);
    check(
      "the upstream body never reaches the response",
      !hostileChat.text.includes(UPSTREAM_ERROR_BODY_SENTINEL),
    );
    const hostileRows = await call("GET", "/api/usage/requests?limit=50");
    const hostileRow = (hostileRows.json?.requests ?? []).find(
      (row) => row.model === "model-hostile",
    );
    check("the failure was recorded", hostileRow?.outcome === "failed");
    check(
      "the failure category is normalized",
      hostileRow?.failureCategory === "upstream_error",
    );
    check(
      "no upstream body reached the stored row",
      !JSON.stringify(hostileRow ?? {}).includes(UPSTREAM_ERROR_BODY_SENTINEL),
    );

    section("6. Failover across providers");
    await seedProvider("failing", failing.port);
    await call("POST", "/api/routes", {
      body: {
        id: "r-fail",
        model: "model-failover",
        providerId: "failing",
        priority: 900,
      },
    });
    await call("POST", "/api/routes", {
      body: { id: "r-recover", model: "model-failover", providerId: "ok", priority: 100 },
    });
    // The ok origin has already served its single scripted reply; it repeats the
    // last step, so the failover lands on a working provider.
    const failoverChat = await chat("model-failover");
    check("the failover chat succeeded", failoverChat.status === 200);
    check(
      "routing metadata reports the surviving provider",
      failoverChat.headers.get("x-bayz-provider") === "ok",
    );
    const failoverRows = await call("GET", "/api/usage/requests?limit=50");
    const failoverRow = (failoverRows.json?.requests ?? []).find(
      (row) => row.model === "model-failover",
    );
    check("failover was recorded as failover", failoverRow?.routingMode === "failover");
    check("the failed attempt was counted", failoverRow?.attempts === 2);

    section("7. Per-provider Combo participation");
    const providersView = await call("GET", "/api/usage/providers");
    const activity = new Map(
      (providersView.json?.providers ?? []).map((entry) => [entry.providerId, entry]),
    );
    check("the failing provider is individually named", activity.has("failing"));
    check("its failure is attributed", (activity.get("failing")?.failures ?? 0) >= 1);
    check("the surviving provider is named", (activity.get("ok")?.attempts ?? 0) >= 1);
    check(
      "every registered provider appears",
      ["ok", "unknown", "zero", "malformed", "hostile", "failing"].every((id) =>
        activity.has(id),
      ),
    );
    check(
      "no credential value appears in provider activity",
      !providersView.text.includes(PROVIDER_CREDENTIAL_SENTINEL),
    );

    section("8. Proxy-bound routing records the proxy by id only");
    await seedProvider("proxied", proxied.port);
    await call("POST", "/api/proxies", {
      body: {
        id: "tunnel",
        kind: "http",
        host: "127.0.0.1",
        port: proxy.port,
        username: "bayz",
        config: {
          connectTimeoutMs: 5000,
          healthCheckHost: "127.0.0.1",
          healthCheckPort: proxied.port,
        },
      },
    });
    await call("PUT", "/api/proxies/tunnel/password", {
      body: { value: PROXY_CREDENTIAL_SENTINEL },
    });
    await call("POST", "/api/routes", {
      body: {
        id: "r-proxy",
        model: "model-proxied",
        providerId: "proxied",
        proxyId: "tunnel",
      },
    });
    const proxyChat = await chat("model-proxied");
    check("the proxied chat succeeded", proxyChat.status === 200);
    check("the proxy really opened a tunnel", proxy.connects.length >= 1);
    const expectedProxyAuth = Buffer.from(
      `bayz:${PROXY_CREDENTIAL_SENTINEL}`,
      "utf8",
    ).toString("base64");
    check(
      "the proxy authenticated with the seeded password",
      proxy.connects.some((entry) => entry.includes(expectedProxyAuth)),
    );
    check(
      "the raw proxy password never appeared on the wire",
      !proxy.connects.some((entry) => entry.includes(PROXY_CREDENTIAL_SENTINEL)),
    );
    const proxyRows = await call("GET", "/api/usage/requests?limit=50");
    const proxyRow = (proxyRows.json?.requests ?? []).find(
      (row) => row.model === "model-proxied",
    );
    check("the proxy is recorded by id", proxyRow?.proxyId === "tunnel");
    check(
      "no proxy password reached the stored row",
      !JSON.stringify(proxyRow ?? {}).includes(PROXY_CREDENTIAL_SENTINEL),
    );

    section("9. Malformed Usage API input fails closed");
    for (const [path, label] of [
      ["/api/usage/summary?period=forever", "unknown period"],
      ["/api/usage/summary?period=", "empty period"],
      ["/api/usage/requests?limit=0", "zero limit"],
      ["/api/usage/requests?limit=-5", "negative limit"],
      ["/api/usage/requests?limit=abc", "non-numeric limit"],
      ["/api/usage/requests?limit=999999", "over-large limit"],
    ]) {
      const response = await call("GET", path);
      check(`${label} is rejected`, response.status === 400);
    }
    check(
      "no content endpoint exists",
      (await call("GET", "/api/usage/requests/req_1/prompt")).status === 404 &&
        (await call("GET", "/api/usage/content")).status === 404,
    );

    section("10. Live Flux Core view model from the real API");
    const liveSummary = (await call("GET", "/api/usage/summary")).json;
    const liveProviders = (await call("GET", "/api/usage/providers")).json;
    const liveRequests = (await call("GET", "/api/usage/requests?limit=50")).json;
    const liveModel = buildLiveViewModel({
      summary: liveSummary,
      providers: liveProviders.providers,
      requests: liveRequests.requests,
    });
    check("the model is marked live", liveModel.source === "live");
    check(
      "every registered provider is represented",
      liveModel.providers.length === liveProviders.providers.length,
    );
    check(
      "every provider keeps a distinct id",
      new Set(liveModel.providers.map((provider) => provider.id)).size ===
        liveModel.providers.length,
    );
    check("real request count is carried", liveModel.routedRequests === liveSummary.totalRequests);
    check("token knowledge is explicit", typeof liveModel.tokens?.known === "boolean");
    check("cost stays unavailable", liveModel.cost?.available === false);
    const modelText = JSON.stringify(liveModel);
    check(
      "the live model carries no sentinel",
      ALL_SENTINELS.every((sentinel) => !modelText.includes(sentinel)),
    );
    check(
      "the live model exposes no credentialPresent field",
      !modelText.includes("credentialPresent"),
    );
    const demoModel = buildDemoViewModel();
    check("the demo adapter is separately labelled", demoModel.source === "simulation");
    check(
      "demo provider names never appear in the live model",
      !liveModel.providers.some((provider) => provider.displayName === "TABITOKEN"),
    );

    section("11. Dense Combo, failures, and duplicate names through the adapter");
    const dense = Array.from({ length: 40 }, (_unused, index) => ({
      providerId: `dense-${index}`,
      displayName: index === 17 ? "TOKYO EDGE" : `PROVIDER ${index}`,
      kind: "openai-compatible",
      enabled: true,
      credentialPresent: false,
      attempts: 3,
      failures: index === 17 ? 3 : 0,
      lastOutcome: index === 17 ? "failed" : "ok",
      lastFailureCategory: index === 17 ? "rate_limited" : null,
      averageLatencyMs: 200,
    }));
    const denseModel = buildLiveViewModel({ summary: liveSummary, providers: dense });
    check("40 providers are all represented", denseModel.providers.length === 40);
    check("the failed provider keeps its identity", 
      denseModel.providers.find((provider) => provider.id === "dense-17")?.displayName ===
        "TOKYO EDGE",
    );
    check(
      "the failed provider is marked failed",
      denseModel.providers.find((provider) => provider.id === "dense-17")?.state === "failed",
    );
    check("dense traffic reads as combo", denseModel.routingMode === "failover");

    const huge = Array.from({ length: 120 }, (_unused, index) => ({
      ...dense[0],
      providerId: `many-${index}`,
      displayName: `MANY ${index}`,
      failures: 0,
      lastOutcome: "ok",
      lastFailureCategory: null,
    }));
    check(
      "120 providers are all represented",
      buildLiveViewModel({ summary: liveSummary, providers: huge }).providers.length === 120,
    );

    const duplicates = [
      { ...dense[0], providerId: "cust-a", displayName: "CUSTOM" },
      { ...dense[0], providerId: "cust-b", displayName: "CUSTOM" },
      { ...dense[0], providerId: "cust-c", displayName: "CUSTOM" },
    ];
    const dupModel = buildLiveViewModel({ summary: liveSummary, providers: duplicates });
    check(
      "duplicate display names stay distinguishable by id",
      new Set(dupModel.providers.map((provider) => provider.id)).size === 3,
    );
    check(
      "a single provider reads as direct",
      buildLiveViewModel({
        summary: liveSummary,
        providers: [{ ...dense[0], providerId: "solo", failures: 0, lastOutcome: "ok" }],
      }).routingMode === "direct",
    );
    for (const count of [5, 12]) {
      const model = buildLiveViewModel({
        summary: liveSummary,
        providers: Array.from({ length: count }, (_unused, index) => ({
          ...dense[0],
          providerId: `c${count}-${index}`,
          displayName: `C${count} ${index}`,
          failures: 0,
          lastOutcome: "ok",
          lastFailureCategory: null,
        })),
      });
      check(`${count} providers are all represented`, model.providers.length === count);
      check(`${count} providers read as combo`, model.routingMode === "combo");
    }

    section("12. Retention and purge affect usage only");
    const beforePurge = (await call("GET", "/api/usage/summary")).json?.totalRequests ?? 0;
    check("usage rows exist before the purge", beforePurge > 0);
    check("the purge returns 204", (await call("DELETE", "/api/usage/requests")).status === 204);
    check(
      "the purge is idempotent",
      (await call("DELETE", "/api/usage/requests")).status === 204,
    );
    check(
      "usage is empty after the purge",
      (await call("GET", "/api/usage/summary")).json?.totalRequests === 0,
    );
    const survivingProviders = await call("GET", "/api/providers");
    check(
      "providers survived the purge",
      (survivingProviders.json?.providers ?? []).length >= 6,
    );
    check(
      "routes survived the purge",
      ((await call("GET", "/api/routes")).json?.routes ?? []).length >= 6,
    );
    check(
      "the stored credential survived the purge",
      (await call("GET", "/api/providers/ok")).json?.credentialPresent === true,
    );
    check(
      "the stored proxy password survived the purge",
      (await call("GET", "/api/proxies/tunnel")).json?.passwordPresent === true,
    );
  } finally {
    await app.close();
    runtime.close();
    for (const socket of openSockets) {
      socket.destroy();
    }
    for (const origin of [ok, zero, unknown, malformed, hostile, failing, proxied]) {
      await new Promise((resolve) => origin.server.close(resolve));
    }
    await new Promise((resolve) => proxy.server.close(resolve));
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }

  section("13. Sentinel leak drill: database, WAL, SHM");
  {
    const bytes = readDatabaseBytes(dataDir);
    check("database bytes were read", bytes.byteLength > 0);
    for (const sentinel of CONTENT_SENTINELS) {
      check(
        `content sentinel absent from db/wal/shm: ${sentinel.slice(0, 26)}`,
        !bytes.includes(Buffer.from(sentinel, "utf8")),
      );
    }
    for (const sentinel of SECRET_SENTINELS) {
      check(
        `secret sentinel absent from db/wal/shm: ${sentinel.slice(0, 26)}`,
        !bytes.includes(Buffer.from(sentinel, "utf8")),
      );
    }
    check(
      "the root key is absent from db/wal/shm",
      !bytes.includes(Buffer.from(KEK_HEX, "utf8")),
    );
    check(
      "metadata is present, proving the scan reads real content",
      bytes.includes(Buffer.from("model-proxied", "utf8")),
    );
  }

  section("14. Sentinel leak drill: logs, stdout, stderr, API responses");
  {
    const logs = captured.join("\n");
    const out = stdoutCapture.join("\n");
    const err = stderrCapture.join("\n");
    const bodies = responseBodies.join("\n");

    check("log output was captured", captured.length > 0);
    check("usage/management response bodies were captured", responseBodies.length > 0);

    for (const sentinel of ALL_SENTINELS) {
      const short = sentinel.slice(0, 26);
      check(`absent from structured logs: ${short}`, !logs.includes(sentinel));
      check(
        `absent from every usage/management API response: ${short}`,
        !bodies.includes(sentinel),
      );
    }
    // stdout/stderr may legitimately contain the auth sentinel only because this
    // script prints its own check labels; the sentinels themselves are never
    // printed, so the scan is exact.
    for (const sentinel of ALL_SENTINELS) {
      const short = sentinel.slice(0, 26);
      check(`absent from stdout: ${short}`, !out.includes(sentinel));
      check(`absent from stderr: ${short}`, !err.includes(sentinel));
    }
    check("the root key is absent from logs", !logs.includes(KEK_HEX));
  }

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length > 0) {
    console.error("usage smoke: FAIL");
    process.exit(1);
  }
  console.log("usage smoke: PASS");
}

main().catch((error) => {
  console.error("usage smoke: FAIL");
  console.error(error);
  process.exit(1);
});
