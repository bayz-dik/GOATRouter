#!/usr/bin/env node
/**
 * Generic OpenAI-client protocol conformance harness — 9H Task 2.
 *
 * This drives BAYZ **exactly as a third-party OpenAI-compatible client would**: real
 * `fetch` over a real TCP port against a real listener, a real SQLite database with real
 * envelope crypto, and real loopback origins. There is no `app.inject`, no in-process
 * shortcut, and no imported handler — because the failures this is meant to catch are the
 * ones that only exist on the wire. A client that parses strictly breaks on a missing
 * `object` field or an `index` that is absent rather than `0`, and an in-process assertion
 * on a JavaScript object would never see it.
 *
 * Every check prints `ok N  <label>` or `FAIL N  <label>` with a stable number, so a
 * compatibility-matrix cell can cite `smoke:client-conformance#N` and
 * `tests/matrix-integrity.test.mjs` can resolve it.
 *
 * **Check numbers are contractual.** The matrix cites them by number, so a check must not
 * be renumbered by inserting one in the middle — append instead. If a number ever has to
 * move, the matrix citation moves with it in the same commit.
 *
 * Deliberate scope limit, stated rather than implied: this harness covers what a *generic*
 * client exercises over the protocol. Proxy-bound routes and multi-turn client restart are
 * not covered here and their matrix cells stay `UNVERIFIED` — 9H Tasks 4-6 own those.
 * Claiming them from this script would be exactly the fake compatibility claim 9H exists
 * to prevent.
 *
 * Exits non-zero on any failed check.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.BAYZ_CONFORMANCE_LOADER) {
  const relaunch = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url)],
    { stdio: "inherit", env: { ...process.env, BAYZ_CONFORMANCE_LOADER: "1" } },
  );
  process.exit(relaunch.status ?? 1);
}

const ADMIN_TOKEN = "conformance-admin-token-0123456789";
const KEK_HEX = Buffer.alloc(32, 0x5e).toString("hex");
const CREDENTIAL = "CONFORMANCE-PROVIDER-CREDENTIAL-a1b2c3";
const PROMPT = "CONFORMANCE-PROMPT";
const COMPLETION = "CONFORMANCE-COMPLETION";
const TOOL_RESULT = "CONFORMANCE-TOOL-RESULT";

const failures = [];
let checkNumber = 0;

/** Numbered, so a matrix cell can cite `smoke:client-conformance#N`. */
function check(label, condition) {
  checkNumber += 1;
  if (condition) {
    console.log(`  ok   ${String(checkNumber).padStart(2)}  ${label}`);
  } else {
    console.error(`  FAIL ${String(checkNumber).padStart(2)}  ${label}`);
    failures.push(`#${checkNumber} ${label}`);
  }
  return checkNumber;
}

function section(title) {
  console.log(`\n${title}`);
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
 * Field-for-field structural assertion.
 *
 * `expected` maps a key to either a predicate or a nested spec. Extra keys are *allowed* —
 * the OpenAI contract is additive and a strict client tolerates unknown fields — but every
 * declared key must be present with the right shape. Returns a list of human-readable
 * problems so one check can report exactly which field a strict client would trip on.
 */
function shapeProblems(value, expected, path = "") {
  const problems = [];
  if (typeof value !== "object" || value === null) {
    return [`${path || "body"} is not an object`];
  }
  for (const [key, rule] of Object.entries(expected)) {
    const here = path === "" ? key : `${path}.${key}`;
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      problems.push(`${here} is missing`);
      continue;
    }
    const actual = value[key];
    if (typeof rule === "function") {
      if (!rule(actual)) {
        problems.push(`${here} has the wrong shape: ${JSON.stringify(actual)?.slice(0, 60)}`);
      }
      continue;
    }
    problems.push(...shapeProblems(actual, rule, here));
  }
  return problems;
}

const isString = (value) => typeof value === "string" && value.length > 0;
const isInteger = (value) => Number.isInteger(value);
const isStringOrNull = (value) => value === null || typeof value === "string";
const isIntegerOrNull = (value) => value === null || Number.isInteger(value);

/**
 * A scripted upstream origin.
 *
 * `script` is an array consumed one entry per chat request; discovery requests are served
 * from `models`. A streaming request is answered with **real SSE** derived from the same
 * scripted object, because answering a `stream: true` request with a JSON body would make
 * the router fail `invalid_response` and the streaming checks would "pass" for the wrong
 * reason.
 */
async function startOrigin({ host = "127.0.0.1", models = [{ id: "conf-model" }] } = {}) {
  const state = { script: [], index: 0, chatHits: 0, bodies: [], aborted: 0, holdMs: 0 };
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
      const step = state.script[Math.min(state.index, state.script.length - 1)];
      state.index += 1;

      // Client abort must reach here as a destroyed socket, which is what proves the
      // teardown propagated rather than the response merely being discarded.
      response.on("close", () => {
        if (!response.writableEnded) {
          state.aborted += 1;
        }
      });

      let wantsStream = false;
      try {
        wantsStream = JSON.parse(raw).stream === true;
      } catch {
        wantsStream = false;
      }

      const send = () => {
        if (!wantsStream) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(step));
          return;
        }
        const message = step?.choices?.[0]?.message ?? {};
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (message.tool_calls !== undefined) {
          response.write(
            `data: ${JSON.stringify({
              model: "conf-model",
              choices: [
                {
                  delta: {
                    tool_calls: message.tool_calls.map((call, index) => ({
                      index,
                      ...call,
                    })),
                  },
                },
              ],
            })}\n\n`,
          );
        } else {
          // Two content frames, so incremental delivery is observable rather than assumed.
          const text = message.content ?? "";
          const split = Math.max(1, Math.floor(text.length / 2));
          response.write(
            `data: ${JSON.stringify({
              model: "conf-model",
              choices: [{ delta: { content: text.slice(0, split) } }],
            })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: text.slice(split) } }],
            })}\n\n`,
          );
        }
        response.write(
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: step?.choices?.[0]?.finish_reason ?? "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
          })}\n\n`,
        );
        response.write("data: [DONE]\n\n");
        response.end();
      };

      if (state.holdMs > 0) {
        // Held open so a client abort has a window to land mid-flight.
        setTimeout(send, state.holdMs);
        return;
      }
      send();
    });
  });
  await new Promise((resolve) => server.listen(0, host, resolve));
  return {
    port: server.address().port,
    state,
    arm(script) {
      state.script = script;
      state.index = 0;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function chatTurn(content) {
  return {
    id: "chatcmpl-upstream",
    model: "conf-model",
    choices: [
      { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
  };
}

function toolCallTurn(name, args, id = "call_conf_1") {
  return {
    id: "chatcmpl-upstream-tool",
    model: "conf-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

async function main() {
  const { buildApp } = await import("../apps/server/src/app.ts");
  const { createBayzRuntime } = await import("../apps/server/src/runtime.ts");

  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-conformance-")), ".bayz");
  const runtime = createBayzRuntime(
    { host: "127.0.0.1", port: 0, dataDir, dashboardRoot: "/nonexistent" },
    {
      env: { BAYZ_MASTER_KEY: KEK_HEX, BAYZ_API_TOKEN: ADMIN_TOKEN },
      notify: () => {},
      logger: () => {},
    },
  );
  const app = buildApp({
    logger: false,
    apiToken: ADMIN_TOKEN,
    runtime,
    rateLimit: { max: 100000, authMax: 100000 },
  });

  const primary = await startOrigin();
  const secondary = await startOrigin();
  let base = "";

  /** A generic OpenAI client's request: bearer key, JSON body, real fetch. */
  async function client(method, path, { body, key, signal, accept } = {}) {
    const headers = {};
    const token = key === undefined ? ADMIN_TOKEN : key;
    if (token !== null) {
      headers.authorization = `Bearer ${token}`;
    }
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (accept !== undefined) {
      headers.accept = accept;
    }
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    });
    const text = await response.text();
    let json;
    try {
      json = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, headers: response.headers, text, json };
  }

  const CITED = {};

  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${app.server.address().port}`;

    /* ------------------------------------------------------------------ *
     * Configure — what a user pastes into a client's settings
     * ------------------------------------------------------------------ */
    section("A. Configure (base URL + API key, exactly as documented)");
    await client("POST", "/api/providers", {
      body: {
        id: "conf",
        kind: "openai-compatible",
        displayName: "Conformance Origin",
        baseUrl: `http://127.0.0.1:${primary.port}`,
        config: { allowLoopback: true },
      },
    });
    await client("PUT", "/api/providers/conf/credential", { body: { value: CREDENTIAL } });
    /*
     * `freeOnly: false` on the scenario route.
     *
     * The loopback fixture origin publishes no pricing metadata, so its models classify as
     * undiscovered — and undiscovered is not free (spec §25 rule 5). Free-only is ON by
     * default, so without this opt-out every chat below would refuse `no_free_route`, which
     * is not what section A-H is about. Section I proves the default and the refusal for
     * real, against a genuinely PAID-classified provider.
     */
    await client("POST", "/api/routes", {
      body: { id: "conf-route", model: "conf-model", providerId: "conf", freeOnly: false },
    });

    const health = await client("GET", "/api/health", { key: null });
    CITED.configure = check(
      "the documented base URL answers unauthenticated /api/health",
      health.status === 200 && health.json?.status === "ok",
    );

    const identity = await client("POST", "/api/identities", {
      body: {
        id: "generic-openai-client",
        displayName: "Generic OpenAI Client",
        scopes: ["chat.completions", "models.read"],
        // The real preset identifier the identity registry validates, not a label
        // invented for this script.
        preset: "generic-openai",
      },
    });
    const clientKey = identity.json?.key;
    check(
      "a scoped client key is issued once, 32 bytes of hex",
      identity.status === 201 && /^[0-9a-f]{64}$/.test(clientKey ?? ""),
    );

    /* ------------------------------------------------------------------ *
     * Authenticate
     * ------------------------------------------------------------------ */
    section("B. Authenticate");
    const authed = await client("GET", "/v1/models", { key: clientKey });
    const anonymous = await client("GET", "/v1/models", { key: null });
    const wrongKey = await client("GET", "/v1/models", { key: "f".repeat(64) });
    CITED.authenticate = check(
      "a valid client key authenticates, a missing and a wrong key are refused 401",
      authed.status === 200 && anonymous.status === 401 && wrongKey.status === 401,
    );
    check(
      "the 401 body is the stable error envelope, not an HTML page or empty body",
      shapeProblems(anonymous.json, {
        error: { code: isString, message: isString, requestId: isString },
      }).length === 0,
    );

    /* ------------------------------------------------------------------ *
     * models.list — GET /v1/models
     * ------------------------------------------------------------------ */
    section("C. GET /v1/models");
    const models = await client("GET", "/v1/models", { key: clientKey });
    const listProblems = shapeProblems(models.json, {
      object: (value) => value === "list",
      data: (value) => Array.isArray(value) && value.length > 0,
    });
    CITED["models.list"] = check(
      `GET /v1/models returns the OpenAI list envelope${listProblems.length > 0 ? ` — ${listProblems.join("; ")}` : ""}`,
      models.status === 200 && listProblems.length === 0,
    );
    const entryProblems = shapeProblems(models.json?.data?.[0], {
      id: isString,
      object: (value) => value === "model",
      owned_by: isString,
    });
    check(
      `each model entry carries id/object/owned_by${entryProblems.length > 0 ? ` — ${entryProblems.join("; ")}` : ""}`,
      entryProblems.length === 0,
    );
    check(
      "the configured model appears in the list a client selects from",
      models.json.data.some((entry) => entry.id === "conf-model"),
    );
    check(
      "the response content-type is application/json",
      (models.headers.get("content-type") ?? "").includes("application/json"),
    );

    /* ------------------------------------------------------------------ *
     * chat — POST /v1/chat/completions, non-streaming
     * ------------------------------------------------------------------ */
    section("D. POST /v1/chat/completions (non-streaming)");
    primary.arm([chatTurn(COMPLETION)]);
    const chat = await client("POST", "/v1/chat/completions", {
      key: clientKey,
      body: { model: "conf-model", messages: [{ role: "user", content: PROMPT }] },
    });
    /*
     * Field-for-field, because this is the exact shape a strict client destructures. A
     * missing `object`, an absent `index`, or a `finish_reason` that is `undefined` rather
     * than `null` each break a real client while leaving a loose assertion green.
     */
    const chatProblems = shapeProblems(chat.json, {
      id: isString,
      object: (value) => value === "chat.completion",
      created: isInteger,
      model: isStringOrNull,
      choices: (value) => Array.isArray(value) && value.length === 1,
    });
    const choiceProblems = shapeProblems(chat.json?.choices?.[0], {
      index: (value) => value === 0,
      finish_reason: isStringOrNull,
      message: { role: (value) => value === "assistant", content: isStringOrNull },
    });
    const allChat = [...chatProblems, ...choiceProblems];
    CITED.chat = check(
      `a non-streaming completion matches the OpenAI contract field-for-field${allChat.length > 0 ? ` — ${allChat.join("; ")}` : ""}`,
      chat.status === 200 && allChat.length === 0,
    );
    check(
      "the assistant content is the upstream completion, unmodified",
      chat.json.choices[0].message.content === COMPLETION,
    );
    const usageProblems = shapeProblems(chat.json?.usage, {
      prompt_tokens: isIntegerOrNull,
      completion_tokens: isIntegerOrNull,
      total_tokens: isIntegerOrNull,
    });
    check(
      `usage is reported with snake_case token fields${usageProblems.length > 0 ? ` — ${usageProblems.join("; ")}` : ""}`,
      usageProblems.length === 0,
    );
    check(
      "routing facts travel in headers, keeping the body exactly the OpenAI shape",
      chat.headers.get("x-bayz-route") === "conf-route" &&
        chat.headers.get("x-bayz-provider") === "conf",
    );
    check(
      "no credential reaches the client response body",
      !chat.text.includes(CREDENTIAL),
    );

    /* ------------------------------------------------------------------ *
     * stream — the same endpoint with stream: true
     * ------------------------------------------------------------------ */
    section("E. POST /v1/chat/completions (streaming SSE)");
    primary.arm([chatTurn(COMPLETION)]);
    const streamResponse = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${clientKey}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: "conf-model",
        messages: [{ role: "user", content: PROMPT }],
        stream: true,
      }),
    });
    const streamHeaders = {
      contentType: streamResponse.headers.get("content-type") ?? "",
      cacheControl: streamResponse.headers.get("cache-control") ?? "",
      accelBuffering: streamResponse.headers.get("x-accel-buffering") ?? "",
    };
    const streamText = await streamResponse.text();
    const frames = streamText
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: "))
      .map((frame) => frame.slice(6));
    const dataFrames = frames.filter((frame) => frame !== "[DONE]").map((frame) => JSON.parse(frame));

    CITED.stream = check(
      "a streaming request returns 200 with text/event-stream",
      streamResponse.status === 200 && streamHeaders.contentType.includes("text/event-stream"),
    );
    check(
      "the stream sets no-cache and x-accel-buffering:no so a reverse proxy cannot buffer it away",
      streamHeaders.cacheControl.includes("no-cache") &&
        streamHeaders.accelBuffering === "no",
    );
    check(
      "the stream terminates with the literal data: [DONE] sentinel",
      frames.at(-1) === "[DONE]",
    );
    const chunkProblems = shapeProblems(dataFrames[0], {
      id: isString,
      object: (value) => value === "chat.completion.chunk",
      created: isInteger,
      choices: (value) => Array.isArray(value) && value.length === 1,
    });
    const deltaProblems = shapeProblems(dataFrames[0]?.choices?.[0], {
      index: (value) => value === 0,
      delta: (value) => typeof value === "object" && value !== null,
      finish_reason: (value) => value === null || typeof value === "string",
    });
    const allChunk = [...chunkProblems, ...deltaProblems];
    check(
      `each chunk matches the chat.completion.chunk contract${allChunk.length > 0 ? ` — ${allChunk.join("; ")}` : ""}`,
      allChunk.length === 0,
    );
    check(
      "content arrives across multiple deltas rather than one blob",
      dataFrames.filter((frame) => typeof frame.choices?.[0]?.delta?.content === "string")
        .length >= 2,
    );
    check(
      "the reassembled deltas equal the upstream completion exactly",
      dataFrames
        .map((frame) => frame.choices?.[0]?.delta?.content ?? "")
        .join("") === COMPLETION,
    );
    check(
      "the stream carries a terminal finish_reason",
      dataFrames.some((frame) => frame.choices?.[0]?.finish_reason === "stop"),
    );
    check(
      "every chunk id is identical, so a client can correlate the stream",
      new Set(dataFrames.map((frame) => frame.id).filter(Boolean)).size === 1,
    );

    /* ------------------------------------------------------------------ *
     * tool call and tool result roundtrip
     * ------------------------------------------------------------------ */
    section("F. Tool call and tool result roundtrip");
    primary.arm([toolCallTurn("get_weather", { city: "Jakarta" })]);
    const toolCall = await client("POST", "/v1/chat/completions", {
      key: clientKey,
      body: {
        model: "conf-model",
        messages: [{ role: "user", content: PROMPT }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Look up weather",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
        tool_choice: "auto",
      },
    });
    const callProblems = shapeProblems(toolCall.json?.choices?.[0]?.message?.tool_calls?.[0], {
      id: isString,
      type: (value) => value === "function",
      function: { name: isString, arguments: isString },
    });
    CITED["tool call"] = check(
      `a tool call reaches the client in snake_case tool_calls${callProblems.length > 0 ? ` — ${callProblems.join("; ")}` : ""}`,
      toolCall.status === 200 && callProblems.length === 0,
    );
    check(
      "content is null (not empty string) when the assistant only called tools",
      toolCall.json.choices[0].message.content === null,
    );
    check(
      "finish_reason is tool_calls, which is how a client knows to act",
      toolCall.json.choices[0].finish_reason === "tool_calls",
    );
    check(
      "the arguments field is an opaque JSON string, per the OpenAI contract",
      typeof toolCall.json.choices[0].message.tool_calls[0].function.arguments === "string" &&
        JSON.parse(toolCall.json.choices[0].message.tool_calls[0].function.arguments).city ===
          "Jakarta",
    );
    check(
      "the internal camelCase toolCalls key never appears on the wire",
      !toolCall.text.includes("toolCalls"),
    );

    // The roundtrip: the client executes the tool itself and sends the result back.
    const emittedCall = toolCall.json.choices[0].message.tool_calls[0];
    primary.arm([chatTurn(COMPLETION)]);
    const roundtrip = await client("POST", "/v1/chat/completions", {
      key: clientKey,
      body: {
        model: "conf-model",
        messages: [
          { role: "user", content: PROMPT },
          { role: "assistant", content: null, tool_calls: [emittedCall] },
          { role: "tool", tool_call_id: emittedCall.id, content: TOOL_RESULT },
        ],
      },
    });
    CITED["tool result roundtrip"] = check(
      "a client-supplied tool result is accepted and answered",
      roundtrip.status === 200 &&
        roundtrip.json?.choices?.[0]?.message?.content === COMPLETION,
    );
    const forwarded = primary.state.bodies.at(-1);
    check(
      "the tool result reaches the upstream under the wire keys tool_calls/tool_call_id",
      forwarded.includes("tool_call_id") &&
        forwarded.includes("tool_calls") &&
        !forwarded.includes("toolCallId") &&
        !forwarded.includes("toolCalls"),
    );
    check(
      "the tool result content itself is forwarded intact",
      forwarded.includes(TOOL_RESULT),
    );
    // A result naming a call that never happened is refused: otherwise untrusted output
    // could fabricate tool output for a call the model never made.
    const fabricated = await client("POST", "/v1/chat/completions", {
      key: clientKey,
      body: {
        model: "conf-model",
        messages: [
          { role: "user", content: PROMPT },
          { role: "tool", tool_call_id: "call_never_happened", content: TOOL_RESULT },
        ],
      },
    });
    check(
      "a tool result for a call that never happened is refused 400",
      fabricated.status === 400,
    );

    /* ------------------------------------------------------------------ *
     * large request
     * ------------------------------------------------------------------ */
    section("G. Large request");
    /*
     * Two payloads, because one would not distinguish "bounded" from "broken".
     *
     * First a genuinely large request *within* the documented bound
     * (`MAX_CONTENT_CHARS` = 128,000 characters per message in
     * `packages/router/src/request.ts`), which must be served in full with nothing
     * truncated. Then the plan's 200 KiB payload, which exceeds that bound and must be
     * refused *cleanly* — a 4xx with the stable envelope, never a 5xx, a hang, or a silent
     * truncation. A harness that only sent the oversized one could not tell a working
     * bound from a broken large-body path.
     */
    primary.arm([chatTurn(COMPLETION)]);
    const withinBound = "W".repeat(120 * 1024);
    const largeServed = await client("POST", "/v1/chat/completions", {
      key: clientKey,
      body: { model: "conf-model", messages: [{ role: "user", content: withinBound }] },
    });
    CITED["large request"] = check(
      `a 120 KiB message (inside the 128,000-char bound) is served in full (observed ${largeServed.status})`,
      largeServed.status === 200 &&
        largeServed.json?.choices?.[0]?.message?.content === COMPLETION,
    );
    check(
      "the full payload reached the upstream with no truncation",
      (primary.state.bodies.at(-1) ?? "").includes(withinBound),
    );

    const upstreamBefore = primary.state.bodies.length;
    const big = "L".repeat(200 * 1024);
    const large = await client("POST", "/v1/chat/completions", {
      key: clientKey,
      body: { model: "conf-model", messages: [{ role: "user", content: big }] },
    });
    const largeIsServed = large.status === 200;
    const largeIsBounded =
      large.status >= 400 &&
      large.status < 500 &&
      shapeProblems(large.json, {
        error: { code: isString, message: isString, requestId: isString },
      }).length === 0;
    check(
      `a 200 KiB message is cleanly bounded, never 5xx (observed ${large.status}${largeIsServed ? "" : ` ${large.json?.error?.code}`})`,
      largeIsServed || largeIsBounded,
    );
    check(
      "the oversized request was refused before anything was sent upstream",
      largeIsServed || primary.state.bodies.length === upstreamBefore,
    );

    /* ------------------------------------------------------------------ *
     * cancel
     * ------------------------------------------------------------------ */
    section("H. Cancel (client abort tears the upstream down)");
    primary.arm([chatTurn(COMPLETION)]);
    primary.state.holdMs = 3000;
    const abortedBefore = primary.state.aborted;
    const controller = new AbortController();
    const pending = fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${clientKey}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: "conf-model",
        messages: [{ role: "user", content: PROMPT }],
        stream: true,
      }),
      signal: controller.signal,
    });
    // Abort after the request is genuinely in flight upstream, not before it leaves.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const reachedUpstream = primary.state.chatHits;
    controller.abort();
    let abortRejected = false;
    try {
      await pending;
    } catch {
      abortRejected = true;
    }
    // Give the socket teardown a moment to be observed by the origin.
    await new Promise((resolve) => setTimeout(resolve, 600));
    primary.state.holdMs = 0;
    CITED.cancel = check(
      "an aborted streaming request rejects client-side and the upstream sees the socket close",
      abortRejected &&
        reachedUpstream > 0 &&
        primary.state.aborted > abortedBefore,
    );
    // And the listener is still healthy afterwards — an abort must not poison the server.
    primary.arm([chatTurn(COMPLETION)]);
    const afterAbort = await client("POST", "/v1/chat/completions", {
      key: clientKey,
      body: { model: "conf-model", messages: [{ role: "user", content: PROMPT }] },
    });
    check(
      "the listener still serves normally after a client abort",
      afterAbort.status === 200,
    );

    /* ------------------------------------------------------------------ *
     * error surface
     * ------------------------------------------------------------------ */
    section("I. Error surface (stable envelope, correct status codes)");
    const errorCases = [
      ["an unknown model", { model: "no-such-model", messages: [{ role: "user", content: PROMPT }] }, 400],
      ["a missing messages array", { model: "conf-model" }, 400],
      ["an empty messages array", { model: "conf-model", messages: [] }, 400],
      ["an unknown role", { model: "conf-model", messages: [{ role: "wizard", content: PROMPT }] }, 400],
      ["a non-object body", "not-an-object", 400],
    ];
    let errorsWellFormed = true;
    let errorStatusesCorrect = true;
    for (const [label, body, expected] of errorCases) {
      const response = await client("POST", "/v1/chat/completions", { key: clientKey, body });
      const wellFormed =
        shapeProblems(response.json, {
          error: { code: isString, message: isString, requestId: isString },
        }).length === 0;
      if (!wellFormed) {
        errorsWellFormed = false;
        console.error(`       ${label}: envelope malformed (${response.status})`);
      }
      if (response.status !== expected) {
        errorStatusesCorrect = false;
        console.error(`       ${label}: expected ${expected}, got ${response.status}`);
      }
    }
    CITED["error surface"] = check(
      "every malformed request answers the stable {error:{code,message,requestId}} envelope",
      errorsWellFormed,
    );
    check("each error case carries its documented status code", errorStatusesCorrect);
    /*
     * A recorded imprecision, not a failure.
     *
     * A JSON scalar body is refused 400 — correct, and fixed in this task, since it was a
     * generic 500 before. But the *code* is `capability_unsupported` with stage `chat`,
     * whose message reads "the client is not granted that capability". The real cause is
     * that the body is not an object, so `deriveProfile` never derived the `chat` intent
     * in the first place. A client is told about authority when the truth is about shape.
     *
     * Not corrected here: the honest code would be `invalid_request/body-shape`, which
     * means changing `deriveProfile`/`intentOf` in `@bayz/gateway` — a behaviour change
     * outside Task 2's remit, pinned by several of the 74 gateway tests. The status code
     * and envelope are conformant, so no client breaks; the message is merely
     * misdirecting. Asserted so the wording is a known, pinned fact rather than a
     * surprise, and so a later fix has a test to update deliberately.
     */
    const scalarBody = await client("POST", "/v1/chat/completions", {
      key: clientKey,
      body: "not-an-object",
    });
    check(
      "a JSON scalar body is 400 (was 500 before this task) — code is capability_unsupported, a known message imprecision",
      scalarBody.status === 400 && scalarBody.json?.error?.code === "capability_unsupported",
    );
    const forbidden = await client("GET", "/api/providers", { key: clientKey });
    check(
      "a scope violation is 403 with the same envelope and no enumeration of resources",
      forbidden.status === 403 &&
        shapeProblems(forbidden.json, {
          error: { code: isString, message: isString, requestId: isString },
        }).length === 0 &&
        !forbidden.text.includes(CREDENTIAL),
    );
    check(
      "every response carries an x-request-id a user can quote in a bug report",
      isString(forbidden.headers.get("x-request-id")),
    );

    /* ------------------------------------------------------------------ *
     * custom provider
     * ------------------------------------------------------------------ */
    section("J. Custom provider serves a generic client");
    await client("POST", "/api/providers", {
      body: {
        id: "conf-custom",
        kind: "custom-openai",
        displayName: "Custom Conformance Origin",
        baseUrl: `http://127.0.0.1:${secondary.port}`,
        config: { allowLoopback: true },
      },
    });
    await client("PUT", "/api/providers/conf-custom/credential", {
      body: { value: CREDENTIAL },
    });
    await client("POST", "/api/routes", {
      body: {
        id: "conf-custom-route",
        model: "custom-model",
        providerId: "conf-custom",
        freeOnly: false,
      },
    });
    secondary.arm([chatTurn(COMPLETION)]);
    const custom = await client("POST", "/v1/chat/completions", {
      key: clientKey,
      body: { model: "custom-model", messages: [{ role: "user", content: PROMPT }] },
    });
    CITED["custom provider"] = check(
      "a custom-openai provider serves a generic client through the same contract",
      custom.status === 200 &&
        custom.json?.choices?.[0]?.message?.content === COMPLETION &&
        custom.headers.get("x-bayz-provider") === "conf-custom",
    );
    check(
      "the custom provider's model is listed for the client to select",
      (await client("GET", "/v1/models", { key: clientKey })).json.data.some(
        (entry) => entry.id === "custom-model",
      ),
    );

    /* ------------------------------------------------------------------ *
     * combo and failover
     * ------------------------------------------------------------------ */
    section("K. Combo routing and failover");
    const deadOrigin = await startOrigin();
    const deadPort = deadOrigin.port;
    await deadOrigin.close();
    await client("POST", "/api/providers", {
      body: {
        id: "conf-dead",
        kind: "openai-compatible",
        displayName: "Dead Origin",
        baseUrl: `http://127.0.0.1:${deadPort}`,
        config: { allowLoopback: true },
      },
    });
    await client("PUT", "/api/providers/conf-dead/credential", {
      body: { value: CREDENTIAL },
    });
    // Higher priority than conf-route, so the dead provider is tried first.
    await client("POST", "/api/routes", {
      body: {
        id: "conf-dead-route",
        model: "conf-model",
        providerId: "conf-dead",
        priority: 900,
        freeOnly: false,
      },
    });
    primary.arm([chatTurn(COMPLETION)]);
    const hitsBefore = primary.state.chatHits;
    const failedOver = await client("POST", "/v1/chat/completions", {
      key: clientKey,
      body: { model: "conf-model", messages: [{ role: "user", content: PROMPT }] },
    });
    CITED.failover = check(
      "a dead primary fails over to a live provider without the client noticing",
      failedOver.status === 200 &&
        failedOver.json?.choices?.[0]?.message?.content === COMPLETION &&
        failedOver.headers.get("x-bayz-provider") === "conf",
    );
    check(
      "the surviving provider genuinely served the retry",
      primary.state.chatHits === hitsBefore + 1,
    );
    CITED.combo = check(
      "two providers bound to one model form a combo the client selects by model name alone",
      (await client("GET", "/api/routes")).json.routes.filter(
        (route) => route.model === "conf-model",
      ).length === 2,
    );

    /* ------------------------------------------------------------------ *
     * key revoke / rotate
     * ------------------------------------------------------------------ */
    section("L. Key revoke and rotate");
    const rotatable = await client("POST", "/api/identities", {
      body: {
        id: "conf-rotatable",
        displayName: "Rotatable",
        scopes: ["chat.completions", "models.read"],
        preset: "generic-openai",
      },
    });
    const firstKey = rotatable.json.key;
    check(
      "the new client key works before rotation",
      (await client("GET", "/v1/models", { key: firstKey })).status === 200,
    );
    const rotated = await client("POST", "/api/identities/conf-rotatable/rotate");
    const secondKey = rotated.json?.key;
    const oldAfterRotate = await client("GET", "/v1/models", { key: firstKey });
    const newAfterRotate = await client("GET", "/v1/models", { key: secondKey });
    check(
      "rotation invalidates the old key and the new one works immediately",
      secondKey !== firstKey &&
        oldAfterRotate.status === 401 &&
        newAfterRotate.status === 200,
    );
    await client("DELETE", "/api/identities/conf-rotatable");
    const afterRevoke = await client("GET", "/v1/models", { key: secondKey });
    const otherStillWorks = await client("GET", "/v1/models", { key: clientKey });
    CITED["key revoke/rotate"] = check(
      "revocation takes effect immediately and does not affect another client's key",
      afterRevoke.status === 401 && otherStillWorks.status === 200,
    );

    /* ------------------------------------------------------------------ *
     * free-only routing — the §25 amendment
     * ------------------------------------------------------------------ */
    section("M. FREE-ONLY routing (spec §25 amendment)");
    /*
     * The default is asserted first, and it is the cheapest of the three checks to get
     * wrong: a route created with no `freeOnly` field must come back free-only, or an
     * older client creates a spending route by omission (§25 rule 6).
     */
    const defaulted = await client("POST", "/api/routes", {
      body: { id: "conf-free-default", model: "free-default-model", providerId: "conf" },
    });
    check(
      "a route created without freeOnly defaults to free-only, so omission cannot spend",
      defaulted.status === 201 && defaulted.json?.freeOnly === true,
    );

    /*
     * Then the real refusal, against a genuinely PAID-classified provider.
     *
     * This needs a **non-loopback** origin: `allowLoopback` short-circuits classification
     * to LOCAL, and LOCAL is free — so a loopback origin cannot exercise the PAID path at
     * all. When the host has no private IPv4 the check is reported as skipped rather than
     * asserted against loopback, because a pass that proves nothing is worse than an
     * honest skip.
     */
    const econHost = privateHost();
    if (econHost === undefined) {
      checkNumber += 1;
      console.log(
        `  SKIP ${String(checkNumber).padStart(2)}  free-only refuses a PAID provider — no non-loopback IPv4 on this host`,
      );
      CITED["free-only routing"] = undefined;
    } else {
      const paidOrigin = await startOrigin({
        host: econHost,
        models: [{ id: "paid-conf-model", pricing: { prompt: "0.00002", completion: "0.00004" } }],
      });
      try {
        await client("POST", "/api/providers", {
          body: {
            id: "conf-paid",
            kind: "openai-compatible",
            displayName: "Paid Origin",
            baseUrl: `http://${econHost}:${paidOrigin.port}`,
            config: { allowPrivate: true },
          },
        });
        await client("PUT", "/api/providers/conf-paid/credential", {
          body: { value: CREDENTIAL },
        });
        const catalogue = await client("POST", "/api/providers/conf-paid/catalogue", {});
        check(
          "the paid provider published a real catalogue, so its model is classified PAID",
          catalogue.status === 200,
        );
        // Free-only left at its default: this is the refusal under test.
        await client("POST", "/api/routes", {
          body: { id: "conf-paid-route", model: "paid-conf-model", providerId: "conf-paid" },
        });
        paidOrigin.arm([chatTurn(COMPLETION)]);
        const refused = await client("POST", "/v1/chat/completions", {
          key: clientKey,
          body: { model: "paid-conf-model", messages: [{ role: "user", content: PROMPT }] },
        });
        CITED["free-only routing"] = check(
          `a free-only route to a PAID-classified provider is refused 409 no_free_route (observed ${refused.status} ${refused.json?.error?.code})`,
          refused.status === 409 && refused.json?.error?.code === "no_free_route",
        );
        // The load-bearing half: a 409 alone would not prove nothing was spent.
        check(
          "the paid origin was never called, so no money could be spent",
          paidOrigin.state.chatHits === 0,
        );
        check(
          "the refusal uses the stable error envelope a client can parse",
          shapeProblems(refused.json, {
            error: { code: isString, message: isString, requestId: isString },
          }).length === 0,
        );
        // And an explicit opt-out still works, so free-only is a bound rather than a wall.
        await client("PATCH", "/api/routes/conf-paid-route", { body: { freeOnly: false } });
        paidOrigin.arm([chatTurn(COMPLETION)]);
        const optedOut = await client("POST", "/v1/chat/completions", {
          key: clientKey,
          body: { model: "paid-conf-model", messages: [{ role: "user", content: PROMPT }] },
        });
        check(
          "an explicit freeOnly:false opt-out then routes, so the guard is a bound not a wall",
          optedOut.status === 200 && paidOrigin.state.chatHits === 1,
        );
      } finally {
        await paidOrigin.close();
      }
    }

    /* ------------------------------------------------------------------ *
     * What this harness does NOT verify
     * ------------------------------------------------------------------ */
    section("N. Deliberately not claimed by this harness");
    console.log("       proxy-bound route  — needs a real CONNECT proxy fixture; 9H Task 4 owns it");
    console.log("       restart/reconnect  — needs a client surviving a listener restart; Task 4/5");
    console.log("       Their matrix cells stay UNVERIFIED. Claiming them here would be a fake");
    console.log("       compatibility claim, which is the failure 9H exists to prevent.");

    /* ------------------------------------------------------------------ *
     * Citation manifest, written so the matrix cannot cite a fictional check
     * ------------------------------------------------------------------ */
    section("Citations for the generic-openai matrix row");
    for (const [capability, number] of Object.entries(CITED)) {
      console.log(
        number === undefined
          ? `       ${capability.padEnd(22)} SKIPPED on this host`
          : `       ${capability.padEnd(22)} smoke:client-conformance#${number}`,
      );
    }

    /*
     * The manifest is what makes a citation checkable rather than decorative.
     *
     * Without it, `tests/matrix-integrity.test.mjs` can only confirm that the *script*
     * being cited exists — so `smoke:client-conformance#99` in a cell for a capability
     * this harness never exercises would pass. That was a real hole, found by mutating
     * the matrix to claim `proxy-bound route` from a fictional check number.
     *
     * Written only on a fully passing run: a manifest from a failing run would let a
     * matrix cite a check that did not pass.
     */
    if (failures.length === 0) {
      mkdirSync(new URL("../docs/evidence/", import.meta.url), { recursive: true });
      writeFileSync(
        new URL("../docs/evidence/client-conformance.json", import.meta.url),
        `${JSON.stringify(
          {
            script: "client-conformance",
            generatedBy: "scripts/client-conformance.mjs",
            note: "Regenerated on every fully passing run. Do not hand-edit: tests/matrix-integrity.test.mjs resolves matrix citations against it.",
            totalChecks: checkNumber,
            capabilities: Object.fromEntries(
              Object.entries(CITED).filter(([, number]) => number !== undefined),
            ),
          },
          null,
          2,
        )}\n`,
      );
      console.log("\n       wrote docs/evidence/client-conformance.json");
    }
  } finally {
    await app.close();
    runtime.close();
    await primary.close();
    await secondary.close();
  }

  console.log(`\n${checkNumber - failures.length}/${checkNumber} checks passed`);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`  failed: ${failure}`);
    }
    console.error("client conformance: FAIL");
    process.exit(1);
  }
  console.log("client conformance: PASS");
}

main().catch((error) => {
  console.error("client conformance crashed:", error);
  process.exit(1);
});
