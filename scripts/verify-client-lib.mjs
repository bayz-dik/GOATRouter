/**
 * Shared fixtures for the real-client verification harnesses — 9H Tasks 4 and 5.
 *
 * Extracted from `verify-opencode-lib.mjs` so `verify-hermes.mjs` reuses the *same*
 * BAYZ-side fixtures rather than a second copy that could drift. A drifting copy is the
 * failure mode that matters here: two harnesses disagreeing about what "a real listener"
 * means would make their matrix rows incomparable.
 *
 * Client-specific configuration stays in each client's own script, because the two
 * clients agree on almost nothing — OpenCode is JSON with camelCase `options.baseURL`,
 * Hermes is YAML with snake_case `model.base_url` and a host-derived env var.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const sockets = new Set();

function track(socket) {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  return socket;
}

function privateHost() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }
  return undefined;
}

/**
 * Cap one transcript section.
 *
 * Real agent clients send tens of KiB of system prompt and tool schemas. Truncation is
 * **stated with the real total** rather than done silently: a transcript that quietly
 * drops evidence is worse than a long one.
 */
const MAX_SECTION_CHARS = 4000;

function capSection(content) {
  const text = String(content);
  if (text.length <= MAX_SECTION_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_SECTION_CHARS)}\n\n[truncated — ${text.length} characters total, first ${MAX_SECTION_CHARS} shown]`;
}

/**
 * Build a deterministic redactor.
 *
 * Secrets are replaced **by name**, never by pattern-matching a shape, so a credential
 * cannot survive because it happened not to look like one. Everything that varies run to
 * run is normalised, so a committed transcript reproduces byte-identically — an unstable
 * transcript is one nobody reviews, and an unreviewed transcript is not evidence.
 */
function makeRedactor(fixedSecrets) {
  return (text, extra = []) => {
    let out = String(text);
    for (const [needle, replacement] of [...fixedSecrets, ...extra]) {
      if (needle) {
        out = out.split(needle).join(replacement);
      }
    }
    return out
      .replace(/\/tmp\/[A-Za-z0-9._-]+/g, "<TMP>")
      .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<PORT>")
      .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+/g, "<HOST>:<PORT>")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<UUID>")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<TIMESTAMP>")
      .replace(/"latencyMs":\s*\d+/g, '"latencyMs":<MS>')
      .replace(/"created":\s*\d+/g, '"created":<EPOCH>')
      .replace(/\bbayz-\w+-[A-Za-z0-9]{6,}\b/g, "<TMPNAME>")
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  };
}

function makeTranscriptWriter({ dir, title, preamble, redact }) {
  return (name, sections, extraRedactions = []) => {
    mkdirSync(dir, { recursive: true });
    const body = sections
      .map(({ heading, content, fence = "text" }) =>
        content === undefined || content === ""
          ? `## ${heading}\n\n(empty)\n`
          : `## ${heading}\n\n\`\`\`${fence}\n${capSection(redact(content, extraRedactions).trimEnd())}\n\`\`\`\n`,
      )
      .join("\n");
    writeFileSync(new URL(`${name}.md`, dir), `# ${title} — ${name}\n\n${preamble}\n\n${body}`);
    return `${new URL(dir).pathname.slice(REPO_ROOT.length)}${name}.md`;
  };
}

/**
 * A scripted upstream origin that speaks real SSE.
 *
 * Answering a `stream: true` request with a JSON body would make the router fail
 * `invalid_response`, and the streaming cells would then "pass" for entirely the wrong
 * reason — so streaming requests get genuine frames.
 *
 * `mode: "tool"` emits a tool call on the first turn that carries tools, then plain text
 * once a `role: "tool"` message comes back. `mode: "text"` always answers with text.
 */
async function startOrigin({ host = "127.0.0.1", models = [{ id: "probe-model" }], mode = "text", text = "BAYZ-OK", toolName = "bash", toolArgs = {} } = {}) {
  const state = { chatHits: 0, bodies: [], aborted: 0, holdMs: 0, mode, text, sawToolResult: false, inFlight: 0 };
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!request.url?.includes("/chat/completions")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: models }));
        return;
      }
      state.chatHits += 1;
      state.bodies.push(raw);
      state.inFlight += 1;
      response.on("close", () => {
        state.inFlight -= 1;
        if (!response.writableEnded) {
          state.aborted += 1;
        }
      });

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { messages: [] };
      }
      const hasToolResult = (parsed.messages ?? []).some((message) => message.role === "tool");
      if (hasToolResult) {
        state.sawToolResult = true;
      }
      const isAgentTurn = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      const wantsStream = parsed.stream === true;

      const send = () => {
        if (response.writableEnded) {
          return;
        }
        const emitTool = state.mode === "tool" && isAgentTurn && !hasToolResult;
        const reply = state.mode === "tool" && hasToolResult ? "TOOL-ROUNDTRIP-COMPLETE" : state.text;

        if (!wantsStream) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify(
              emitTool
                ? {
                    id: "chatcmpl-origin-tool",
                    model: models[0]?.id ?? "probe-model",
                    choices: [
                      {
                        index: 0,
                        message: {
                          role: "assistant",
                          content: null,
                          tool_calls: [
                            { id: "call_verify_1", type: "function", function: { name: toolName, arguments: JSON.stringify(toolArgs) } },
                          ],
                        },
                        finish_reason: "tool_calls",
                      },
                    ],
                    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
                  }
                : {
                    id: "chatcmpl-origin-text",
                    model: models[0]?.id ?? "probe-model",
                    choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
                  },
            ),
          );
          return;
        }

        response.writeHead(200, { "content-type": "text/event-stream" });
        if (emitTool) {
          response.write(
            `data: ${JSON.stringify({
              id: "chatcmpl-origin-tool",
              model: models[0]?.id ?? "probe-model",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [
                      { index: 0, id: "call_verify_1", type: "function", function: { name: toolName, arguments: JSON.stringify(toolArgs) } },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
              usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
            })}\n\n`,
          );
        } else {
          // Two content frames, so incremental delivery is observable rather than assumed.
          const split = Math.max(1, Math.floor(reply.length / 2));
          response.write(
            `data: ${JSON.stringify({
              id: "chatcmpl-origin-text",
              model: models[0]?.id ?? "probe-model",
              choices: [{ index: 0, delta: { role: "assistant", content: reply.slice(0, split) }, finish_reason: null }],
            })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: reply.slice(split) }, finish_reason: null }] })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
            })}\n\n`,
          );
        }
        response.write("data: [DONE]\n\n");
        response.end();
      };

      if (state.holdMs > 0) {
        setTimeout(send, state.holdMs);
        return;
      }
      send();
    });
  });
  server.on("connection", track);
  await new Promise((resolve) => server.listen(0, host, resolve));
  return {
    port: server.address().port,
    state,
    set(next) {
      Object.assign(state, next);
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A real HTTP CONNECT proxy requiring Basic auth, recording every CONNECT authority. */
async function startConnectProxy({ user, password }) {
  const connects = [];
  const expected = Buffer.from(`${user}:${password}`, "utf8").toString("base64");
  const server = createTcpServer((client) => {
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
      const authority = /^CONNECT (\S+)/.exec(request)?.[1];
      if (!request.includes(expected)) {
        client.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
        client.end();
        return;
      }
      const port = Number(authority?.split(":")[1] ?? 0);
      connects.push({ authority, port });
      const rest = head.subarray(end + 4);
      const upstream = track(
        connect({ host: "127.0.0.1", port }, () => {
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
  return {
    port: server.address().port,
    connects,
    async close() {
      server.close();
    },
  };
}

/**
 * Start a real BAYZ listener. `port: 0` picks one; a fixed port restarts in place.
 *
 * `gatewayCalls` records method, path, **and response status** for every `/v1/` request.
 * The status is what distinguishes "the client called an endpoint" from "the client
 * called an endpoint and BAYZ served it" — a distinction a path list alone hides.
 */
async function startBayz({ dataDir, port = 0, adminToken, kekHex }) {
  const { buildApp } = await import("../apps/server/src/app.ts");
  const { createBayzRuntime } = await import("../apps/server/src/runtime.ts");
  const runtime = createBayzRuntime(
    { host: "127.0.0.1", port: 0, dataDir, dashboardRoot: "/nonexistent" },
    { env: { BAYZ_MASTER_KEY: kekHex, BAYZ_API_TOKEN: adminToken }, notify: () => {}, logger: () => {} },
  );
  const app = buildApp({
    logger: false,
    apiToken: adminToken,
    runtime,
    rateLimit: { max: 100000, authMax: 100000 },
  });
  const gatewayCalls = [];
  app.addHook("onResponse", async (request, reply) => {
    if (request.url.startsWith("/v1/")) {
      gatewayCalls.push(`${request.method} ${request.url} -> ${reply.statusCode}`);
    }
  });
  await app.listen({ host: "127.0.0.1", port });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  /*
   * `content-type` only when there is a body: sending it with an empty body makes
   * Fastify answer `400 invalid_json`, which silently turned a `DELETE` revocation into
   * a no-op in the first draft of the OpenCode harness and was misreported as a BAYZ
   * defect. Bodyless verbs must be sent bodyless.
   */
  const admin = async (method, path, body) => {
    const headers = { authorization: `Bearer ${adminToken}` };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const response = await fetch(base + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json;
    try {
      json = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, json, text };
  };
  return {
    app,
    runtime,
    base,
    port: app.server.address().port,
    gatewayCalls,
    admin,
    async close() {
      await app.close();
      runtime.close();
    },
  };
}

/** Run a real client binary to completion. `onSpawn` receives the child, for cancel tests. */
async function runClient(command, args, { env, cwd, timeoutMs = 240000, onSpawn } = {}) {
  const child = spawn(command, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  onSpawn?.(child);
  const killAt = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const { code, signal } = await new Promise((resolve) => {
    child.on("exit", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
  });
  clearTimeout(killAt);
  return { code, signal, stdout, stderr, command: `${command} ${args.join(" ")}` };
}

/**
 * The verdict recorder, shared so both harnesses refuse to self-certify identically.
 *
 * A `VERIFIED` or `PARTIAL` cell whose transcript is not on disk when the run ends fails
 * the run. A script's own opinion is not evidence.
 */
function makeRecorder(expectedCapabilities) {
  const cells = {};
  const failures = [];
  return {
    cells,
    failures,
    record(capability, status, transcript, note) {
      cells[capability] = { status, transcript, note };
      const mark =
        status === "VERIFIED" ? "ok   " : status === "PARTIAL" ? "part " : status === "BLOCKED" ? "BLOCK" : "---- ";
      console.log(`  ${mark} ${capability.padEnd(23)} ${status.padEnd(10)} ${note}`);
    },
    fail(what) {
      failures.push(what);
      console.error(`  FAIL  ${what}`);
    },
    /** Returns the tally, having pushed a failure for every unbacked claim. */
    audit() {
      for (const [capability, cell] of Object.entries(cells)) {
        if (cell.status !== "VERIFIED" && cell.status !== "PARTIAL") {
          continue;
        }
        if (cell.transcript === undefined) {
          failures.push(`${capability} is ${cell.status} with no transcript path`);
          continue;
        }
        if (!existsSync(new URL(cell.transcript, `file://${REPO_ROOT}`))) {
          failures.push(`${capability} is ${cell.status} but ${cell.transcript} is not on disk`);
          continue;
        }
        console.log(`  ok    ${capability.padEnd(23)} ${cell.transcript}`);
      }
      for (const capability of expectedCapabilities) {
        if (cells[capability] === undefined) {
          failures.push(`no verdict was recorded for ${capability}`);
        }
      }
      const tally = { VERIFIED: 0, PARTIAL: 0, BLOCKED: 0, UNVERIFIED: 0 };
      for (const capability of expectedCapabilities) {
        const cell = cells[capability];
        if (cell !== undefined) {
          tally[cell.status] += 1;
        }
      }
      return tally;
    },
  };
}

/** The seventeen matrix capabilities, in matrix order. */
const CAPABILITIES = Object.freeze([
  "configure",
  "authenticate",
  "models.list",
  "chat",
  "stream",
  "tool call",
  "tool result roundtrip",
  "large request",
  "cancel",
  "error surface",
  "custom provider",
  "proxy-bound route",
  "combo",
  "failover",
  "restart/reconnect",
  "key revoke/rotate",
  "free-only routing",
]);

export {
  CAPABILITIES,
  REPO_ROOT,
  capSection,
  makeRecorder,
  makeRedactor,
  makeTranscriptWriter,
  privateHost,
  runClient,
  sockets,
  startBayz,
  startConnectProxy,
  startOrigin,
  track,
};
