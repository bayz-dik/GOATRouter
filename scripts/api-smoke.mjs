#!/usr/bin/env node
/**
 * Non-mocked HTTP API proof for Phase 6.
 *
 * Starts a real Bayz server on a real free port and drives it with real HTTP
 * requests through `fetch`. In-process injection cannot show that the listener
 * binds loopback, that authentication holds over a socket, or that a full
 * provider -> route -> chat path works end to end.
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

/*
 * Route creations in this smoke pass `freeOnly: false`.
 *
 * The fixture origins here publish no pricing metadata, so their models classify as
 * undiscovered — and undiscovered is not free (spec §25 rule 5). Free-only is ON by
 * default in the schema, so leaving it out would refuse every chat below with
 * `no_free_route`, which is not what this smoke proves. Free-only routing has its own
 * dedicated coverage in packages/router/test/free-only.test.ts.
 */

const APP_ENTRY = fileURLToPath(new URL("../apps/server/src/app.ts", import.meta.url));
const RUNTIME_ENTRY = fileURLToPath(
  new URL("../apps/server/src/runtime.ts", import.meta.url),
);

if (!process.env.BAYZ_API_SMOKE_LOADER) {
  const relaunch = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url)],
    { stdio: "inherit", env: { ...process.env, BAYZ_API_SMOKE_LOADER: "1" } },
  );
  process.exit(relaunch.status ?? 1);
}

const TOKEN = "api-smoke-token-0123456789abcdef";
const KEK_HEX = Buffer.alloc(32, 0x3b).toString("hex");
const CREDENTIAL = "sk-api-smoke-credential-never-returned";
const PASSWORD = "hunter2-api-smoke-proxy-password";
const PROMPT = "API-SMOKE-PROMPT-must-never-touch-disk";
const COMPLETION = "API-SMOKE-COMPLETION-also-never-persisted";

const captured = [];
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

/** A real upstream that serves both a model list and a chat completion. */
async function startOrigin() {
  const seen = [];
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      seen.push({
        url: request.url,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const requestBody = Buffer.concat(chunks).toString("utf8");
      // Added in 9B: the origin now answers a streaming request with real SSE, so
      // the smoke exercises the actual transport rather than a refusal path.
      let wantsStream = false;
      try {
        wantsStream = JSON.parse(requestBody).stream === true;
      } catch {
        wantsStream = false;
      }
      if (request.url?.includes("/chat/completions") && wantsStream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({
            model: "gpt-4o",
            choices: [{ delta: { content: COMPLETION } }],
          })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
          })}\n\n`,
        );
        response.write("data: [DONE]\n\n");
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url?.includes("/chat/completions")) {
        response.end(
          JSON.stringify({
            id: "chatcmpl-origin",
            model: "gpt-4o",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: COMPLETION },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
          }),
        );
        return;
      }
      response.end(JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }));
    });
  });
  server.on("connection", track);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, seen };
}

/** A real CONNECT proxy requiring Basic auth, piping to the origin. */
async function startConnectProxy(originPort) {
  const connects = [];
  const expected = Buffer.from(`bayz:${PASSWORD}`, "utf8").toString("base64");
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

/**
 * Issue a raw HTTP/1.1 request so headers `fetch` forbids (notably `Host`) can be
 * set verbatim. A DNS-rebinding attacker controls the Host header, so the defence
 * has to be provable with an arbitrary one.
 */
function rawRequest(baseUrl, path, headers) {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: Number(port) }, () => {
      const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
      socket.write(
        `GET ${path} HTTP/1.1\r\n${lines.join("\r\n")}\r\nconnection: close\r\n\r\n`,
      );
    });
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      raw += chunk;
    });
    socket.on("end", () => {
      const status = Number(/^HTTP\/1\.\d (\d{3})/.exec(raw)?.[1] ?? 0);
      resolve({ status, raw });
    });
    socket.on("error", reject);
  });
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
  const root = mkdtempSync(join(tmpdir(), "bayz-api-smoke-"));
  const dataDir = join(root, ".bayz");
  const { buildApp } = await import(APP_ENTRY);
  const { createBayzRuntime } = await import(RUNTIME_ENTRY);

  const origin = await startOrigin();
  const proxy = await startConnectProxy(origin.port);

  const runtime = createBayzRuntime(
    { host: "127.0.0.1", port: 0, dataDir, dashboardRoot: join(root, "no-dashboard") },
    {
      env: { BAYZ_MASTER_KEY: KEK_HEX, BAYZ_API_TOKEN: TOKEN },
      notify: () => {},
      logger: (payload) => captured.push(JSON.stringify(payload)),
    },
  );
  const app = buildApp({ logger: false, apiToken: TOKEN, runtime });

  let base;
  const bodies = [];

  async function call(method, path, options = {}) {
    const headers = { ...(options.headers ?? {}) };
    if (options.auth !== false) {
      headers.authorization = `Bearer ${TOKEN}`;
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
    return { status: response.status, headers: response.headers, text, json };
  }

  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    base = `http://127.0.0.1:${address.port}`;
    section(`1. Real server listening on ${base}`);
    check("the listener bound loopback", address.address === "127.0.0.1");

    section("2. Health is unauthenticated and contract-identical");
    const health = await call("GET", "/api/health", { auth: false });
    check("health returns 200 without a token", health.status === 200);
    check(
      "health has exactly the Phase 1 fields",
      JSON.stringify(Object.keys(health.json ?? {}).sort()) ===
        JSON.stringify(["status", "uptimeSeconds", "version"]),
    );
    check("health status is ok", health.json?.status === "ok");

    section("3. Every other endpoint requires the token");
    const unauthenticated = await Promise.all([
      call("GET", "/api/status", { auth: false }),
      call("GET", "/api/providers", { auth: false }),
      call("GET", "/api/proxies", { auth: false }),
      call("GET", "/api/routes", { auth: false }),
      call("GET", "/v1/models", { auth: false }),
      call("POST", "/v1/chat/completions", { auth: false, body: { model: "gpt-4o" } }),
    ]);
    check(
      "all guarded endpoints answer 401 without a token",
      unauthenticated.every((response) => response.status === 401),
    );
    check(
      "the 401 body uses the stable envelope",
      unauthenticated[0]?.json?.error?.code === "unauthorized" &&
        typeof unauthenticated[0]?.json?.error?.requestId === "string",
    );

    const wrong = await call("GET", "/api/status", {
      headers: { authorization: "Bearer definitely-not-the-token" },
      auth: false,
    });
    check("a wrong token is also 401", wrong.status === 401);
    check(
      "malformed Authorization shapes are refused",
      (await call("GET", "/api/status", { auth: false, headers: { authorization: TOKEN } }))
        .status === 401,
    );

    section("4. Register a provider, proxy, and route over HTTP");
    const created = await call("POST", "/api/providers", {
      body: {
        id: "smoke",
        kind: "openai-compatible",
        displayName: "Smoke",
        baseUrl: `http://127.0.0.1:${origin.port}/v1`,
        config: { allowLoopback: true },
      },
    });
    check("the provider was created", created.status === 201);
    check("credential absent at creation", created.json?.credentialPresent === false);

    const credential = await call("PUT", "/api/providers/smoke/credential", {
      body: { value: CREDENTIAL },
    });
    check("the credential write returned 204", credential.status === 204);
    check("the credential write had no body", credential.text === "");

    const proxyCreated = await call("POST", "/api/proxies", {
      body: {
        id: "tunnel",
        kind: "http",
        host: "127.0.0.1",
        port: proxy.port,
        username: "bayz",
        config: {
          connectTimeoutMs: 5000,
          healthCheckHost: "127.0.0.1",
          healthCheckPort: origin.port,
        },
      },
    });
    check("the proxy was created", proxyCreated.status === 201);
    const proxyPassword = await call("PUT", "/api/proxies/tunnel/password", {
      body: { value: PASSWORD },
    });
    check("the password write returned 204", proxyPassword.status === 204);

    const routeCreated = await call("POST", "/api/routes", {
      body: { id: "r1", model: "gpt-4o", providerId: "smoke", freeOnly: false },
    });
    check("the route was created", routeCreated.status === 201);

    section("5. There is no read path for any secret");
    const reads = await Promise.all([
      call("GET", "/api/providers/smoke/credential"),
      call("GET", "/api/proxies/tunnel/password"),
      call("GET", "/api/providers/smoke/api_key"),
      call("GET", "/api/secrets"),
      call("GET", "/api/keys"),
    ]);
    check(
      "no secret read endpoint exists",
      reads.every((response) => response.status === 404),
    );
    const provider = await call("GET", "/api/providers/smoke");
    check("the provider reports presence only", provider.json?.credentialPresent === true);
    check(
      "the provider body carries no credential",
      !provider.text.includes(CREDENTIAL),
    );

    section("6. Discovery and a proxy check run over real sockets");
    const discovered = await call("POST", "/api/providers/smoke/discover");
    check("discovery succeeded", discovered.status === 200);
    check(
      "discovery returned the upstream models",
      JSON.stringify(discovered.json?.models) === JSON.stringify(["gpt-4o", "gpt-4o-mini"]),
    );
    check(
      "the upstream received the bearer credential",
      origin.seen.some((entry) => entry.authorization === `Bearer ${CREDENTIAL}`),
    );

    const checked = await call("POST", "/api/proxies/tunnel/check");
    check("the proxy check succeeded", checked.status === 200 && checked.json?.ok === true);
    check("the proxy really saw a CONNECT", proxy.connects.length >= 1);

    section("7. A real chat completes through the API");
    const chat = await call("POST", "/v1/chat/completions", {
      body: { model: "gpt-4o", messages: [{ role: "user", content: PROMPT }] },
    });
    check("the chat returned 200", chat.status === 200);
    check("the response is an OpenAI chat completion", chat.json?.object === "chat.completion");
    check(
      "the completion content came from the origin",
      chat.json?.choices?.[0]?.message?.content === COMPLETION,
    );
    check("routing metadata is in headers", chat.headers.get("x-bayz-route") === "r1");
    check("no credential is in the chat body", !chat.text.includes(CREDENTIAL));
    check(
      "the upstream really received the prompt",
      origin.seen.some((entry) => entry.body.includes(PROMPT)),
    );

    section("8. A proxy-bound route traverses the proxy");
    const beforeConnects = proxy.connects.length;
    await call("PATCH", "/api/routes/r1", { body: { proxyId: "tunnel" } });
    const proxiedChat = await call("POST", "/v1/chat/completions", {
      body: { model: "gpt-4o", messages: [{ role: "user", content: PROMPT }] },
    });
    check("the proxied chat returned 200", proxiedChat.status === 200);
    check(
      "the proxy binding is reported",
      proxiedChat.headers.get("x-bayz-proxy") === "tunnel",
    );
    check(
      "the proxy opened another tunnel for the chat",
      proxy.connects.length > beforeConnects,
    );
    check(
      "no CONNECT preamble carried the upstream credential",
      !proxy.connects.some((entry) => entry.includes(CREDENTIAL)),
    );
    await call("PATCH", "/api/routes/r1", { body: { proxyId: null } });

    section("9. Streaming works over real SSE");
    const streamed = await call("POST", "/v1/chat/completions", {
      body: {
        model: "gpt-4o",
        messages: [{ role: "user", content: PROMPT }],
        stream: true,
      },
    });
    check("a stream request is 200", streamed.status === 200);
    check(
      "the response is server-sent events",
      String(streamed.headers.get("content-type")).startsWith("text/event-stream"),
    );
    check("the stream is terminated by DONE", streamed.text.trimEnd().endsWith("data: [DONE]"));
    const streamFrames = streamed.text
      .split("\n\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice("data: ".length)));
    check("every frame is a chat completion chunk",
      streamFrames.length >= 2 &&
        streamFrames.every((frame) => frame.object === "chat.completion.chunk"));
    check(
      "the stream id is stable across frames",
      new Set(streamFrames.map((frame) => frame.id)).size === 1,
    );
    check(
      "the streamed completion reaches the client",
      streamFrames.some((frame) => frame.choices?.[0]?.delta?.content === COMPLETION),
    );
    check(
      "the streamed usage is reported",
      streamFrames.some((frame) => frame.usage?.prompt_tokens === 7),
    );
    check(
      "the routing headers arrive before the body",
      streamed.headers.get("x-bayz-route") === "r1" &&
        streamed.headers.get("x-bayz-provider") === "smoke",
    );
    check(
      "the strict CSP is served on a stream too",
      String(streamed.headers.get("content-security-policy")).includes("default-src 'none'"),
    );
    check(
      "the upstream was asked to stream",
      origin.seen.some((entry) => entry.body.includes('"stream":true')),
    );

    section("10. Hostile input fails safely");
    const hostile = await Promise.all([
      call("GET", "/api/providers/Upper"),
      call("GET", "/api/routes/a..b"),
      call("POST", "/api/providers", { body: { id: "x", kind: "anthropic" } }),
      call("POST", "/v1/chat/completions", { body: { model: "unbound", messages: [{ role: "user", content: "x" }] } }),
      call("POST", "/api/providers", {
        headers: { "content-type": "text/plain" },
        body: undefined,
      }),
    ]);
    check("an invalid provider id is 400", hostile[0]?.status === 400);
    check("an invalid route id is 400", hostile[1]?.status === 400);
    check("an unknown kind is 400", hostile[2]?.status === 400);
    check("an unbound model is 400 no_route", hostile[3]?.json?.error?.code === "no_route");

    // `fetch` treats Host as a forbidden header and will not send an override, so
    // the rebinding probe has to be made with a raw request.
    const rebinding = await rawRequest(base, "/api/status", {
      authorization: `Bearer ${TOKEN}`,
      host: "bayz.attacker.test",
    });
    check("a rebinding Host is refused", rebinding.status === 403);

    const crossOrigin = await fetch(`${base}/api/providers`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        origin: "https://evil.example.com",
      },
      body: JSON.stringify({
        id: "csrf",
        kind: "openai-compatible",
        displayName: "X",
        baseUrl: "http://127.0.0.1:1/v1",
        config: { allowLoopback: true },
      }),
    });
    check("a cross-site POST is refused", crossOrigin.status === 403);
    check(
      "no CORS header is ever emitted",
      crossOrigin.headers.get("access-control-allow-origin") === null,
    );

    section("11. Rate limiting is real");
    const limited = [];
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const response = await fetch(`${base}/api/status`, {
        headers: { authorization: "Bearer wrong-token-value-here" },
      });
      limited.push(response.status);
    }
    check(
      "repeated bad tokens eventually receive 429",
      limited.includes(429),
      );
    check(
      "the health probe still works while an attacker is throttled",
      (await fetch(`${base}/api/health`)).status === 200,
    );

    section("12. No response body ever contained a secret");
    const combined = bodies.join("\n");
    check("response bodies were captured", combined.length > 0);
    check("no provider credential in any body", !combined.includes(CREDENTIAL));
    check("no proxy password in any body", !combined.includes(PASSWORD));
    check("no api token in any body", !combined.includes(TOKEN));
    check("no root key in any body", !combined.includes(KEK_HEX));
  } finally {
    await app.close();
    runtime.close();
    for (const socket of openSockets) {
      socket.destroy();
    }
    await new Promise((resolve) => proxy.server.close(resolve));
    await new Promise((resolve) => origin.server.close(resolve));
  }

  section("13. Scan the real bytes on disk and the logs");
  {
    const bytes = readDatabaseBytes(dataDir);
    check("database bytes were read", bytes.byteLength > 0);
    check("the prompt is absent from disk", !bytes.includes(Buffer.from(PROMPT, "utf8")));
    check(
      "the completion is absent from disk",
      !bytes.includes(Buffer.from(COMPLETION, "utf8")),
    );
    check(
      "the provider credential is absent from disk",
      !bytes.includes(Buffer.from(CREDENTIAL, "utf8")),
    );
    check(
      "the proxy password is absent from disk",
      !bytes.includes(Buffer.from(PASSWORD, "utf8")),
    );
    check("the api token is absent from disk", !bytes.includes(Buffer.from(TOKEN, "utf8")));
    check("the root key is absent from disk", !bytes.includes(Buffer.from(KEK_HEX, "utf8")));
    check(
      "provider metadata is present, proving the scan reads real content",
      bytes.includes(Buffer.from("smoke", "utf8")),
    );

    const logs = captured.join("\n");
    check("no prompt in the logs", !logs.includes(PROMPT));
    check("no completion in the logs", !logs.includes(COMPLETION));
    check("no credential in the logs", !logs.includes(CREDENTIAL));
    check("no password in the logs", !logs.includes(PASSWORD));
    check("no api token in the logs", !logs.includes(TOKEN));
  }

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length > 0) {
    console.error("api smoke: FAIL");
    process.exit(1);
  }
  console.log("api smoke: PASS");
}

main().catch((error) => {
  console.error("api smoke: FAIL");
  console.error(error);
  process.exit(1);
});
