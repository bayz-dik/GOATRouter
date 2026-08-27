#!/usr/bin/env node
/**
 * Non-mocked streaming and tool-calling proof for Phase 9B.
 *
 * Everything here runs against real components: a real Bayz listener on a real
 * port, real SSE origins, a real HTTP CONNECT proxy, and real `fetch`. In-process
 * injection cannot demonstrate incremental delivery, socket teardown on client
 * abort, or that a proxy-bound route genuinely tunnels a stream — those are the
 * properties most likely to be quietly wrong, so they are the ones proven here.
 *
 * Exits non-zero on any failed check.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.BAYZ_STREAM_SMOKE_LOADER) {
  const relaunch = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url)],
    { stdio: "inherit", env: { ...process.env, BAYZ_STREAM_SMOKE_LOADER: "1" } },
  );
  process.exit(relaunch.status ?? 1);
}

const TOKEN = "stream-smoke-token-0123456789ab";
const KEK_HEX = Buffer.alloc(32, 0x4d).toString("hex");
const CREDENTIAL = "sk-stream-smoke-credential-never-logged";
const PROXY_PASSWORD = "hunter2-stream-smoke-proxy";
const PROMPT = "STREAM-SMOKE-PROMPT-must-never-touch-disk";
const COMPLETION = "STREAM-SMOKE-COMPLETION-also-never-persisted";
const TOOL_ARGUMENT = '{"city":"STREAM-SMOKE-TOOL-ARG-never-persisted"}';
const TOOL_RESULT = "STREAM-SMOKE-TOOL-RESULT-never-persisted";

const failures = [];
const bodies = [];
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

function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function deltaFrame(content) {
  return sseFrame({ model: "smoke-model", choices: [{ delta: { content } }] });
}

/**
 * A real SSE origin whose behaviour is chosen per request by a `mode` field in the
 * request body, so one server covers every scenario without racing on shared state.
 */
async function startSseOrigin() {
  const state = { requests: 0, bodies: [], abandoned: 0, streamFlags: [] };
  const timers = new Set();
  const server = createHttpServer((request, response) => {
    state.requests += 1;
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      state.bodies.push(raw);
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        body = {};
      }
      state.streamFlags.push(body.stream === true);

      request.socket.on("close", () => {
        if (!response.writableEnded) {
          state.abandoned += 1;
        }
      });

      // A non-streaming request gets a normal JSON completion, which is how the
      // buffered regression check in section 3 is served.
      if (body.stream !== true) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            model: "smoke-model",
            choices: [
              { message: { role: "assistant", content: COMPLETION }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          }),
        );
        return;
      }

      const mode = String(body.messages?.[0]?.content ?? "").includes("MODE:")
        ? String(body.messages[0].content).split("MODE:")[1].split(" ")[0]
        : "complete";

      response.writeHead(200, { "content-type": "text/event-stream" });

      if (mode === "truncate") {
        // Ends without [DONE]: a truncation the client must be told about.
        response.write(deltaFrame("partial-"));
        response.end();
        return;
      }
      if (mode === "destroy") {
        response.write(deltaFrame("partial-"));
        const timer = setTimeout(() => {
          response.socket?.destroy();
          timers.delete(timer);
        }, 40);
        timers.add(timer);
        return;
      }
      if (mode === "forever") {
        // Never terminates. Used to prove a client abort tears the upstream down.
        const timer = setInterval(() => {
          if (response.writableEnded) {
            clearInterval(timer);
            timers.delete(timer);
            return;
          }
          response.write(deltaFrame("tick"));
        }, 20);
        timers.add(timer);
        return;
      }
      if (mode === "malformed") {
        response.write("data: not-json\n\n");
        response.write(deltaFrame(COMPLETION));
        response.write("data: [DONE]\n\n");
        response.end();
        return;
      }

      // Split across three writes so incremental delivery is genuinely exercised
      // rather than arriving as one buffer.
      response.write(deltaFrame(COMPLETION.slice(0, 10)));
      const timer = setTimeout(() => {
        response.write(deltaFrame(COMPLETION.slice(10)));
        response.write(
          sseFrame({
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          }),
        );
        response.write("data: [DONE]\n\n");
        response.end();
        timers.delete(timer);
      }, 30);
      timers.add(timer);
    });
  });
  server.on("connection", track);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    state,
    async close() {
      for (const timer of timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A real tool-calling origin: first a tool call, then a final answer. */
async function startToolOrigin() {
  const state = { bodies: [] };
  let index = 0;
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      state.bodies.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      if (index === 0) {
        index += 1;
        response.end(
          JSON.stringify({
            model: "tool-model",
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_smoke",
                      type: "function",
                      function: { name: "get_weather", arguments: TOOL_ARGUMENT },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
        );
        return;
      }
      index += 1;
      response.end(
        JSON.stringify({
          model: "tool-model",
          choices: [
            { message: { role: "assistant", content: COMPLETION }, finish_reason: "stop" },
          ],
        }),
      );
    });
  });
  server.on("connection", track);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    state,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A real HTTP CONNECT proxy, recording every tunnel target it is asked for. */
async function startConnectProxy() {
  const connects = [];
  const server = createServer();
  server.on("connection", track);
  server.on("connect", () => {});
  server.on("connection", (socket) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) {
        return;
      }
      const head = buffer.subarray(0, end).toString("utf8");
      connects.push(head);
      const rest = buffer.subarray(end + 4);
      socket.removeListener("data", onData);

      const target = head.split("\r\n")[0]?.split(" ")[1] ?? "";
      const [host, port] = target.split(":");
      const upstream = track(connect({ host, port: Number(port) }, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length > 0) {
          upstream.write(rest);
        }
        socket.pipe(upstream);
        upstream.pipe(socket);
      }));
      upstream.on("error", () => socket.destroy());
    };
    socket.on("data", onData);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    connects,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function main() {
  const { buildApp } = await import("../apps/server/src/app.ts");
  const { createBayzRuntime } = await import("../apps/server/src/runtime.ts");

  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-stream-smoke-")), ".bayz");
  const logLines = [];
  const runtime = createBayzRuntime(
    { host: "127.0.0.1", port: 0, dataDir, dashboardRoot: "/nonexistent" },
    {
      env: { BAYZ_MASTER_KEY: KEK_HEX, BAYZ_API_TOKEN: TOKEN },
      notify: () => {},
      logger: (payload) => logLines.push(JSON.stringify(payload)),
    },
  );
  const app = buildApp({
    logger: false,
    apiToken: TOKEN,
    runtime,
    rateLimit: { max: 100000, authMax: 100000 },
  });

  const sse = await startSseOrigin();
  const tools = await startToolOrigin();
  const proxy = await startConnectProxy();
  let base = "";

  async function call(path, options = {}) {
    const headers = { authorization: `Bearer ${TOKEN}` };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const response = await fetch(`${base}${path}`, {
      method: options.method ?? "POST",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return response;
  }

  async function streamText(response) {
    const text = await response.text();
    bodies.push(text);
    return text;
  }

  function framesOf(text) {
    return text
      .split("\n\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice("data: ".length)));
  }

  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${app.server.address().port}`;

    section(`1. Real listener on ${base} with real SSE origins`);
    check("the listener bound loopback", app.server.address().address === "127.0.0.1");

    // Registered through the real API, not by reaching into the runtime, so the
    // management surface is exercised too.
    const created = await call("/api/providers", {
      body: {
        id: "sse",
        kind: "openai-compatible",
        displayName: "SSE Origin",
        baseUrl: `http://127.0.0.1:${sse.port}`,
      },
    });
    check("the streaming provider was created", created.status === 201);
    const credentialed = await call("/api/providers/sse/credential", {
      method: "PUT",
      body: { value: CREDENTIAL },
    });
    check("the credential write returned 204", credentialed.status === 204);
    const routed = await call("/api/routes", {
      body: { id: "sr", model: "smoke-model", providerId: "sse" },
    });
    check("the streaming route was created", routed.status === 201);

    section("2. Incremental delivery with a terminated frame sequence");
    const streamed = await call("/v1/chat/completions", {
      body: {
        model: "smoke-model",
        messages: [{ role: "user", content: `${PROMPT} MODE:complete` }],
        stream: true,
      },
    });
    check("a stream request is 200", streamed.status === 200);
    check(
      "the content type is server-sent events",
      String(streamed.headers.get("content-type")).startsWith("text/event-stream"),
    );
    check(
      "the routing headers arrive before the body",
      streamed.headers.get("x-bayz-route") === "sr" &&
        streamed.headers.get("x-bayz-provider") === "sse",
    );
    check(
      "the strict CSP is served on a stream",
      String(streamed.headers.get("content-security-policy")).includes("default-src 'none'"),
    );
    const streamedText = await streamText(streamed);
    check("the stream is terminated by DONE", streamedText.trimEnd().endsWith("data: [DONE]"));
    const frames = framesOf(streamedText);
    check(
      "every frame is a chat completion chunk",
      frames.length >= 2 && frames.every((frame) => frame.object === "chat.completion.chunk"),
    );
    check(
      "the stream id is stable across frames",
      new Set(frames.map((frame) => frame.id)).size === 1,
    );
    const assembled = frames
      .map((frame) => frame.choices?.[0]?.delta?.content ?? "")
      .join("");
    check("the reassembled completion is exact", assembled === COMPLETION);
    check(
      "the terminal usage is reported",
      frames.some((frame) => frame.usage?.prompt_tokens === 5),
    );
    check(
      "the upstream was asked to stream",
      sse.state.streamFlags.some((flag) => flag === true),
    );

    section("3. Buffered requests are unchanged");
    const buffered = await call("/v1/chat/completions", {
      body: {
        model: "smoke-model",
        messages: [{ role: "user", content: PROMPT }],
      },
    });
    check("a non-streaming request is 200", buffered.status === 200);
    const bufferedBody = await buffered.json();
    bodies.push(JSON.stringify(bufferedBody));
    check("the buffered object name is unchanged", bufferedBody.object === "chat.completion");
    check(
      "the buffered completion is delivered",
      bufferedBody.choices?.[0]?.message?.content === COMPLETION,
    );
    check(
      "an explicit stream false is buffered too",
      (await (await call("/v1/chat/completions", {
        body: {
          model: "smoke-model",
          messages: [{ role: "user", content: PROMPT }],
          stream: false,
        },
      })).json()).object === "chat.completion",
    );

    section("4. Truncation and mid-stream failure are reported, never hidden");
    const truncated = await streamText(
      await call("/v1/chat/completions", {
        body: {
          model: "smoke-model",
          messages: [{ role: "user", content: `${PROMPT} MODE:truncate` }],
          stream: true,
        },
      }),
    );
    check(
      "a truncated stream does not end with DONE",
      !truncated.trimEnd().endsWith("data: [DONE]"),
    );
    const truncatedFrames = framesOf(truncated);
    check(
      "a truncated stream ends with a terminal error event",
      truncatedFrames.at(-1)?.error?.code === "invalid_response",
    );
    check(
      "the partial content still reached the client",
      truncated.includes("partial-"),
    );

    const destroyed = await streamText(
      await call("/v1/chat/completions", {
        body: {
          model: "smoke-model",
          messages: [{ role: "user", content: `${PROMPT} MODE:destroy` }],
          stream: true,
        },
      }),
    );
    check(
      "a destroyed upstream ends with a terminal error event",
      framesOf(destroyed).at(-1)?.error !== undefined,
    );
    check(
      "a destroyed upstream does not claim success",
      !destroyed.trimEnd().endsWith("data: [DONE]"),
    );

    section("5. A malformed frame is skipped, not fatal");
    const malformed = await streamText(
      await call("/v1/chat/completions", {
        body: {
          model: "smoke-model",
          messages: [{ role: "user", content: `${PROMPT} MODE:malformed` }],
          stream: true,
        },
      }),
    );
    check("a malformed frame is skipped", malformed.includes(COMPLETION));
    check("the stream still terminates", malformed.trimEnd().endsWith("data: [DONE]"));

    section("6. A client abort tears down the upstream");
    const abandonedBefore = sse.state.abandoned;
    const controller = new AbortController();
    const abortable = await call("/v1/chat/completions", {
      body: {
        model: "smoke-model",
        messages: [{ role: "user", content: `${PROMPT} MODE:forever` }],
        stream: true,
      },
      signal: controller.signal,
    });
    const reader = abortable.body.getReader();
    await reader.read();
    controller.abort();
    try {
      await reader.cancel();
    } catch {
      // Already aborted; the upstream teardown below is the assertion.
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    check(
      "abandoning a stream stops the provider generating",
      sse.state.abandoned > abandonedBefore,
    );

    section("7. Pre-first-byte failover, and none after it");
    // A dead origin at higher priority, and the working SSE origin behind it.
    const dead = createHttpServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(503, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    dead.on("connection", track);
    await new Promise((resolve) => dead.listen(0, "127.0.0.1", resolve));
    await call("/api/providers", {
      body: {
        id: "dead",
        kind: "openai-compatible",
        displayName: "Dead Origin",
        baseUrl: `http://127.0.0.1:${dead.address().port}`,
      },
    });
    await call("/api/routes", {
      body: { id: "dr", model: "smoke-model", providerId: "dead", priority: 900 },
    });

    const failoverResponse = await call("/v1/chat/completions", {
      body: {
        model: "smoke-model",
        messages: [{ role: "user", content: `${PROMPT} MODE:complete` }],
        stream: true,
      },
    });
    // Read before the body: the header is written from the same chunk the body
    // carries, so this proves they agree about which provider actually served it.
    const servedBy = failoverResponse.headers.get("x-bayz-provider");
    const failedOver = await streamText(failoverResponse);
    check(
      "failover before the first byte reaches the healthy origin",
      failedOver.includes(COMPLETION.slice(0, 10)),
    );
    check(
      "the failed-over stream terminates cleanly",
      failedOver.trimEnd().endsWith("data: [DONE]"),
    );
    check(
      "the surviving stream names the provider that served it, not the dead one",
      servedBy === "sse",
    );
    await call("/api/routes/dr", { method: "DELETE" });
    dead.closeAllConnections();
    await new Promise((resolve) => dead.close(resolve));

    section("8. A stream traverses a real CONNECT proxy");
    const proxyCreated = await call("/api/proxies", {
      body: {
        id: "tunnel",
        kind: "http",
        host: "127.0.0.1",
        port: proxy.port,
        username: "smoke",
      },
    });
    check("the proxy was created", proxyCreated.status === 201);
    const proxyPassword = await call("/api/proxies/tunnel/password", {
      method: "PUT",
      body: { value: PROXY_PASSWORD },
    });
    check("the proxy password write returned 204", proxyPassword.status === 204);
    const bound = await call("/api/routes/sr", {
      method: "PATCH",
      body: { proxyId: "tunnel" },
    });
    check("the route was bound to the proxy", bound.status === 200);

    const proxiedText = await streamText(
      await call("/v1/chat/completions", {
        body: {
          model: "smoke-model",
          messages: [{ role: "user", content: `${PROMPT} MODE:complete` }],
          stream: true,
        },
      }),
    );
    check("the proxied stream delivered content", proxiedText.includes(COMPLETION.slice(0, 10)));
    check("the proxied stream terminated", proxiedText.trimEnd().endsWith("data: [DONE]"));
    check(
      "the tunnel was actually used",
      proxy.connects.some((head) => head.startsWith(`CONNECT 127.0.0.1:${sse.port}`)),
    );
    check(
      "no credential crossed the proxy handshake",
      !proxy.connects.some((head) => head.includes(CREDENTIAL)),
    );
    await call("/api/routes/sr", { method: "PATCH", body: { proxyId: null } });

    section("9. A tool roundtrip over three turns");
    await call("/api/providers", {
      body: {
        id: "tool",
        kind: "openai-compatible",
        displayName: "Tool Origin",
        baseUrl: `http://127.0.0.1:${tools.port}`,
      },
    });
    await call("/api/providers/tool/credential", {
      method: "PUT",
      body: { value: CREDENTIAL },
    });
    await call("/api/routes", {
      body: { id: "tr", model: "tool-model", providerId: "tool" },
    });

    const toolDefinitions = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "look up weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
    ];
    const turnOne = await call("/v1/chat/completions", {
      body: {
        model: "tool-model",
        messages: [{ role: "user", content: PROMPT }],
        tools: toolDefinitions,
      },
    });
    const turnOneBody = await turnOne.json();
    bodies.push(JSON.stringify(turnOneBody));
    check("turn one is 200", turnOne.status === 200);
    check(
      "turn one finished for tool calls",
      turnOneBody.choices?.[0]?.finish_reason === "tool_calls",
    );
    check(
      "turn one content is null, not an empty string",
      turnOneBody.choices?.[0]?.message?.content === null,
    );
    check(
      "turn one returned the tool call",
      turnOneBody.choices?.[0]?.message?.tool_calls?.[0]?.function?.name === "get_weather",
    );

    const turnTwo = await call("/v1/chat/completions", {
      body: {
        model: "tool-model",
        messages: [
          { role: "user", content: PROMPT },
          { role: "assistant", tool_calls: turnOneBody.choices[0].message.tool_calls },
          { role: "tool", tool_call_id: "call_smoke", content: TOOL_RESULT },
        ],
        tools: toolDefinitions,
      },
    });
    const turnTwoBody = await turnTwo.json();
    bodies.push(JSON.stringify(turnTwoBody));
    check("turn two is 200", turnTwo.status === 200);
    check(
      "turn two returned the final answer",
      turnTwoBody.choices?.[0]?.message?.content === COMPLETION,
    );
    check(
      "the tool result genuinely reached the provider",
      tools.state.bodies.some((body) => body.includes(TOOL_RESULT)),
    );

    const fabricated = await call("/v1/chat/completions", {
      body: {
        model: "tool-model",
        messages: [
          { role: "user", content: PROMPT },
          { role: "tool", tool_call_id: "call_never_made", content: "fabricated" },
        ],
        tools: toolDefinitions,
      },
    });
    check("a fabricated tool result is refused", fabricated.status === 400);
    bodies.push(await fabricated.text());

    section("10. Six-sentinel leak drill");
    const dbPath = join(dataDir, "bayz.db");
    let bytes = Buffer.alloc(0);
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = `${dbPath}${suffix}`;
      if (existsSync(path)) {
        bytes = Buffer.concat([bytes, readFileSync(path)]);
      }
    }
    check("the database files were read", bytes.length > 0);
    for (const [label, sentinel] of [
      ["prompt", PROMPT],
      ["completion", COMPLETION],
      ["tool argument", TOOL_ARGUMENT],
      ["tool result", TOOL_RESULT],
      ["credential", CREDENTIAL],
      ["proxy password", PROXY_PASSWORD],
    ]) {
      check(
        `the ${label} is absent from disk`,
        !bytes.includes(Buffer.from(sentinel, "utf8")),
      );
    }

    const logs = logLines.join("\n");
    for (const [label, sentinel] of [
      ["prompt", PROMPT],
      ["completion", COMPLETION],
      ["tool argument", TOOL_ARGUMENT],
      ["tool result", TOOL_RESULT],
      ["credential", CREDENTIAL],
      ["proxy password", PROXY_PASSWORD],
    ]) {
      check(`the ${label} is absent from the logs`, !logs.includes(sentinel));
    }

    // The chat and stream responses legitimately contain the completion, so the
    // response scan is scoped to what must never carry it: the management surface.
    const usage = await (await call("/api/usage/requests", { method: "GET" })).text();
    bodies.push(usage);
    for (const [label, sentinel] of [
      ["prompt", PROMPT],
      ["tool argument", TOOL_ARGUMENT],
      ["tool result", TOOL_RESULT],
      ["credential", CREDENTIAL],
      ["proxy password", PROXY_PASSWORD],
    ]) {
      check(`the ${label} is absent from the usage API`, !usage.includes(sentinel));
    }
    check(
      "usage rows were recorded for the streamed requests",
      JSON.parse(usage).requests.length > 0,
    );
  } finally {
    await app.close();
    runtime.close();
    await sse.close();
    await tools.close();
    await proxy.close();
    for (const socket of openSockets) {
      socket.destroy();
    }
  }

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length > 0) {
    console.error("stream smoke: FAIL");
    process.exit(1);
  }
  console.log("stream smoke: PASS");
}

main().catch((error) => {
  console.error("stream smoke crashed:", error);
  process.exit(1);
});
