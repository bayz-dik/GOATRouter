/**
 * Shared fixtures for `scripts/verify-opencode.mjs` — 9H Task 4.
 *
 * Split from the entry script so the entry stays a thin relaunch guard and the
 * scenarios file stays readable. Run `node scripts/verify-opencode.mjs`; nothing here
 * is meant to be executed directly.
 *
 * Everything in this file exists to make the verification *real*: a scripted upstream
 * origin that speaks genuine SSE, a real HTTP CONNECT proxy, a real BAYZ listener on a
 * real port with real envelope crypto, a real isolated OpenCode configuration, and a
 * deterministic redactor so the captured transcripts can be committed without leaking
 * a credential or churning on every run.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ADMIN_TOKEN = "verify-opencode-admin-token-0123456789";
const KEK_HEX = Buffer.alloc(32, 0x4f).toString("hex");
const CREDENTIAL = "VERIFY-OPENCODE-PROVIDER-CREDENTIAL-9f8e7d";
const PROXY_USER = "bayzproxy";
const PROXY_PASSWORD = "VERIFY-OPENCODE-PROXY-PASSWORD-1a2b3c";
const MODEL = "probe-model";
const TRANSCRIPT_DIR = new URL("../docs/transcripts/opencode/", import.meta.url);
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CLIENT_TIMEOUT_MS = 180000;

/** capability -> { status, transcript, note } */
const CELLS = {};
const failures = [];
const sockets = new Set();

function record(capability, status, transcript, note) {
  CELLS[capability] = { status, transcript, note };
  const mark = status === "VERIFIED" ? "ok  " : status === "PARTIAL" ? "part" : status === "BLOCKED" ? "BLOCK" : "----";
  console.log(`  ${mark}  ${capability.padEnd(23)} ${status.padEnd(10)} ${note}`);
}

function fail(what) {
  failures.push(what);
  console.error(`  FAIL  ${what}`);
}

function section(title) {
  console.log(`\n${title}`);
}

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
 * Deterministic redaction.
 *
 * Secrets are replaced by name, not by pattern-matching a shape, so a credential can
 * never survive because it happened not to look like one. Everything else that varies
 * run to run is normalised so the committed transcript is stable — an unstable
 * transcript is one nobody reviews, and an unreviewed transcript is not evidence.
 */
function redact(text, extra = []) {
  let out = String(text);
  for (const [needle, replacement] of [
    [ADMIN_TOKEN, "<ADMIN-TOKEN-REDACTED>"],
    [CREDENTIAL, "<PROVIDER-CREDENTIAL-REDACTED>"],
    [PROXY_PASSWORD, "<PROXY-PASSWORD-REDACTED>"],
    [KEK_HEX, "<MASTER-KEY-REDACTED>"],
    ...extra,
  ]) {
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
}

/**
 * Cap one transcript section.
 *
 * The real client's request body is ~30 KiB of system prompt and tool schemas, which
 * would dominate a committed transcript nobody then reads. Truncation is **stated with
 * the real byte count** rather than done silently — a transcript that quietly drops
 * evidence is worse than a long one.
 */
const MAX_SECTION_CHARS = 4000;

function capSection(content) {
  const text = String(content);
  if (text.length <= MAX_SECTION_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_SECTION_CHARS)}\n\n[truncated by scripts/verify-opencode.mjs — ${text.length} characters total, first ${MAX_SECTION_CHARS} shown]`;
}

function writeTranscript(name, sections, extraRedactions = []) {
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const body = sections
    .map(({ heading, content, fence = "text" }) =>
      content === undefined || content === ""
        ? `## ${heading}\n\n(empty)\n`
        : `## ${heading}\n\n\`\`\`${fence}\n${capSection(redact(content, extraRedactions).trimEnd())}\n\`\`\`\n`,
    )
    .join("\n");
  writeFileSync(
    new URL(`${name}.md`, TRANSCRIPT_DIR),
    `# OpenCode → BAYZ — ${name}\n\n` +
      `Captured by \`scripts/verify-opencode.mjs\` against the real \`opencode\` binary\n` +
      `(v1.18.23) and a real BAYZ listener. Secrets are redacted by name; ports, temp\n` +
      `paths, UUIDs, and timings are normalised so a re-run reproduces these bytes.\n\n${body}`,
  );
  return `docs/transcripts/opencode/${name}.md`;
}

/**
 * A scripted upstream origin.
 *
 * Answers streaming requests with real SSE, because `opencode` streams by default and
 * a JSON reply to `stream: true` would make the router fail `invalid_response` — the
 * streaming cells would then "pass" for entirely the wrong reason.
 *
 * `mode` selects the reply for the next chat request:
 *   "text"       — a two-frame content stream
 *   "tool"       — a tool call, then plain text once a tool result comes back
 */
async function startOrigin({ host = "127.0.0.1", models = [{ id: MODEL }], mode = "text", text = "BAYZ-OK" } = {}) {
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
      // OpenCode's first request is a title generation with no tools; the agent turn
      // carries them. Answering the title request with a tool call would test nothing.
      const isAgentTurn = Array.isArray(parsed.tools) && parsed.tools.length > 0;

      const send = () => {
        if (response.writableEnded) {
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (state.mode === "tool" && isAgentTurn && !hasToolResult) {
          response.write(
            `data: ${JSON.stringify({
              id: "chatcmpl-origin-tool",
              model: MODEL,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_verify_1",
                        type: "function",
                        function: {
                          name: "bash",
                          arguments: JSON.stringify({
                            command: "echo BAYZ-TOOL-RAN",
                            description: "verify-opencode tool roundtrip",
                          }),
                        },
                      },
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
          const reply = state.mode === "tool" && hasToolResult ? "TOOL-ROUNDTRIP-COMPLETE" : state.text;
          const split = Math.max(1, Math.floor(reply.length / 2));
          response.write(
            `data: ${JSON.stringify({
              id: "chatcmpl-origin-text",
              model: MODEL,
              choices: [{ index: 0, delta: { role: "assistant", content: reply.slice(0, split) }, finish_reason: null }],
            })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: { content: reply.slice(split) }, finish_reason: null }],
            })}\n\n`,
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
async function startConnectProxy() {
  const connects = [];
  const expected = Buffer.from(`${PROXY_USER}:${PROXY_PASSWORD}`, "utf8").toString("base64");
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

/** Start a real BAYZ listener. `port: 0` picks one; a fixed port is used to restart in place. */
async function startBayz({ dataDir, port = 0 }) {
  const { buildApp } = await import("../apps/server/src/app.ts");
  const { createBayzRuntime } = await import("../apps/server/src/runtime.ts");
  const runtime = createBayzRuntime(
    { host: "127.0.0.1", port: 0, dataDir, dashboardRoot: "/nonexistent" },
    { env: { BAYZ_MASTER_KEY: KEK_HEX, BAYZ_API_TOKEN: ADMIN_TOKEN }, notify: () => {}, logger: () => {} },
  );
  const app = buildApp({
    logger: false,
    apiToken: ADMIN_TOKEN,
    runtime,
    rateLimit: { max: 100000, authMax: 100000 },
  });
  const gatewayPaths = [];
  app.addHook("onRequest", async (request) => {
    if (request.url.startsWith("/v1/")) {
      gatewayPaths.push(`${request.method} ${request.url}`);
    }
  });
  await app.listen({ host: "127.0.0.1", port });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const admin = async (method, path, body) => {
    /*
     * `content-type` is set **only** when there is a body.
     *
     * Sending `content-type: application/json` with an empty body makes Fastify reject
     * the request `400 invalid_json` — which is correct behaviour, but it meant the
     * first version of this harness silently failed to revoke anything: `DELETE
     * /api/identities/opencode` was refused, the client kept working, and the run
     * reported `key revoke/rotate` as BLOCKED against BAYZ. The bug was here, not in
     * the server. Bodyless verbs must be sent bodyless.
     */
    const headers = { authorization: `Bearer ${ADMIN_TOKEN}` };
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
    gatewayPaths,
    admin,
    async close() {
      await app.close();
      runtime.close();
    },
  };
}

/**
 * Write a real OpenCode configuration and return the environment that isolates it.
 *
 * The field names are OpenCode's own, read from `~/.config/opencode/opencode.json` on
 * this host and documented in `docs/clients/opencode.md`: camelCase `options.baseURL`
 * and `options.apiKey`, the `@ai-sdk/openai-compatible` adapter, an explicit `models`
 * map, and a `<provider>/<model>` prefixed top-level `model`.
 *
 * Every XDG directory is redirected into a throwaway HOME so this cannot read or
 * modify the operator's real OpenCode state.
 */
function configureOpenCode({ base, key, model = MODEL, permission = { bash: "allow", edit: "allow", webfetch: "deny" } }) {
  const home = mkdtempSync(join(tmpdir(), "bayz-oc-home-"));
  for (const dir of ["config", "data", "cache", "state", "project"]) {
    mkdirSync(join(home, dir), { recursive: true });
  }
  const configPath = join(home, "config", "opencode.json");
  const config = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      bayz: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `${base}/v1`, apiKey: key },
        models: { [model]: { name: model } },
      },
    },
    model: `bayz/${model}`,
    permission,
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return {
    home,
    configPath,
    configJson: JSON.stringify(config, null, 2),
    cwd: join(home, "project"),
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_CACHE_HOME: join(home, "cache"),
      XDG_STATE_HOME: join(home, "state"),
      OPENCODE_CONFIG: configPath,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
    },
  };
}

/** Run the real client to completion. `onSpawn` gets the child, for the cancel scenario. */
async function runOpenCode(args, setup, { onSpawn } = {}) {
  const child = spawn("opencode", args, { env: setup.env, cwd: setup.cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  onSpawn?.(child);
  const killAt = setTimeout(() => child.kill("SIGKILL"), CLIENT_TIMEOUT_MS);
  const { code, signal } = await new Promise((resolve) => {
    child.on("exit", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
  });
  clearTimeout(killAt);
  return { code, signal, stdout, stderr, command: `opencode ${args.join(" ")}` };
}

function usageJson(bayz, limit = 5) {
  return JSON.stringify(bayz.runtime.usage.recentRequests(limit), null, 1);
}

export {
  CELLS,
  failures,
  record,
  fail,
  section,
  redact,
  writeTranscript,
  startOrigin,
  startConnectProxy,
  startBayz,
  configureOpenCode,
  runOpenCode,
  usageJson,
  privateHost,
  sockets,
  ADMIN_TOKEN,
  CREDENTIAL,
  PROXY_USER,
  PROXY_PASSWORD,
  MODEL,
  TRANSCRIPT_DIR,
  REPO_ROOT,
};
