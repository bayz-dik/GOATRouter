import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createBayzRuntime, type BayzRuntime } from "../src/runtime.js";

/*
 * Route fixtures in this file set `freeOnly: false`.
 *
 * These tests assert HTTP surface behaviour — status codes, headers, streaming frames,
 * error envelopes — against fixture origins that publish no pricing metadata. An
 * undiscovered model is not free (spec §25 rule 5), so the schema's free-only default
 * would refuse every chat below with `no_free_route` for a reason none of these tests is
 * about. Free-only enforcement has its own coverage in the router package and in
 * `economics-api.test.ts`.
 */

const KEY = Buffer.alloc(32, 0x77).toString("hex");
const TOKEN = "chat-stream-token-0123456789";
const AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const NO_STREAM_KEY = "chat-stream-nostream-key-0123";
const PROMPT = "CHAT-STREAM-PROMPT-must-never-be-logged";
const COMPLETION = "CHAT-STREAM-COMPLETION-must-never-be-logged";
const CREDENTIAL = "sk-chat-stream-credential";

const logLines: string[] = [];

function harness(): { app: FastifyInstance; runtime: BayzRuntime } {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-chat-stream-")), ".bayz");
  const runtime = createBayzRuntime(
    { host: "127.0.0.1", port: 20128, dataDir, dashboardRoot: "/nonexistent" },
    {
      env: { BAYZ_MASTER_KEY: KEY, BAYZ_API_TOKEN: TOKEN },
      notify: () => {},
      logger: (payload) => logLines.push(JSON.stringify(payload)),
    },
  );
  const app = buildApp({
    logger: false,
    apiToken: TOKEN,
    runtime,
    rateLimit: { max: 100000, authMax: 100000 },
    resolveIdentity: (presented) =>
      presented === NO_STREAM_KEY
        ? { id: "no-stream", scopes: new Set(["models.read"]) }
        : undefined,
  });
  return { app, runtime };
}

type OriginController = {
  port: number;
  requests: number;
  bodies: string[];
  destroyedEarly: number;
  close(): Promise<void>;
};

async function startOrigin(
  handler: (write: (text: string) => void, end: () => void, destroy: () => void) => void,
  status = 200,
): Promise<OriginController> {
  const state = { requests: 0, bodies: [] as string[], destroyedEarly: 0 };
  const server: Server = createServer((request, response) => {
    state.requests += 1;
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      state.bodies.push(Buffer.concat(chunks).toString("utf8"));
      request.socket.on("close", () => {
        if (!response.writableEnded) {
          state.destroyedEarly += 1;
        }
      });
      response.writeHead(status, { "content-type": "text/event-stream" });
      handler(
        (text) => {
          if (!response.writableEnded) {
            response.write(text);
          }
        },
        () => {
          if (!response.writableEnded) {
            response.end();
          }
        },
        () => response.socket?.destroy(),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    get requests() {
      return state.requests;
    },
    get bodies() {
      return state.bodies;
    },
    get destroyedEarly() {
      return state.destroyedEarly;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function frame(content: string): string {
  return `data: ${JSON.stringify({
    model: "stream-model",
    choices: [{ delta: { content } }],
  })}\n\n`;
}

function seed(runtime: BayzRuntime, port: number): void {
  runtime.providers.createProvider({
    id: "sp",
    kind: "openai-compatible",
    displayName: "Stream Provider",
    baseUrl: `http://127.0.0.1:${port}`,
    config: { allowLoopback: true },
  });
  runtime.providers.setCredential("sp", CREDENTIAL);
  runtime.router.createRoute({ freeOnly: false, id: "sr", model: "stream-model", providerId: "sp" });
}

const REQUEST = {
  model: "stream-model",
  messages: [{ role: "user", content: PROMPT }],
};

/** Drive the real listener with real `fetch`, since `inject` buffers SSE. */
async function listen(app: FastifyInstance): Promise<{ base: string }> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${address.port}` };
}

test("stream true returns SSE headers and a terminated frame sequence", async (t) => {
  const origin = await startOrigin((write, end) => {
    write(frame("hello "));
    write(frame("world"));
    write("data: [DONE]\n\n");
    end();
  });
  const { app, runtime } = harness();
  t.after(async () => {
    await app.close();
    runtime.close();
    await origin.close();
  });
  seed(runtime, origin.port);
  const { base } = await listen(app);

  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ ...REQUEST, stream: true }),
  });

  assert.equal(response.status, 200);
  assert.match(String(response.headers.get("content-type")), /^text\/event-stream/);
  // `no-transform` is present alongside `no-cache` deliberately: an intermediary
  // permitted to transform the body could gzip or re-chunk the stream and defeat
  // incremental delivery without violating `no-cache`.
  assert.equal(response.headers.get("cache-control"), "no-cache, no-transform");
  assert.equal(response.headers.get("connection"), "keep-alive");
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  // The strict CSP must still be present: a streaming response is still a response.
  assert.match(
    String(response.headers.get("content-security-policy")),
    /default-src 'none'/,
  );
  // Routing headers arrive before the first chunk, so a client learns where its
  // request went even though the body has not finished.
  assert.equal(response.headers.get("x-bayz-route"), "sr");
  assert.equal(response.headers.get("x-bayz-provider"), "sp");

  const text = await response.text();
  const frames = text.split("\n\n").filter((line) => line.length > 0);
  assert.equal(frames.at(-1), "data: [DONE]");
  const deltas = frames
    .slice(0, -1)
    .map((line) => JSON.parse(line.slice("data: ".length)))
    .map((chunk) => chunk.choices[0].delta.content);
  assert.deepEqual(deltas, ["hello ", "world"]);
});

test("streamed tool calls reach the client instead of being dropped", async (t) => {
  /*
   * Phase 9H Task 4 regression.
   *
   * `apps/server/src/routes/chat.ts` built a `content`-only delta, so on a streaming
   * request every tool call the provider emitted was discarded. The router had always
   * parsed them (`packages/router/src/chunk.ts`) and the non-streaming path had always
   * rendered them, which is why no test caught it.
   *
   * The real-client symptom is in docs/transcripts/opencode/: `opencode` v1.18.23
   * streams by default, got `finish_reason: "tool_calls"` with no calls attached, and
   * re-sent the identical request 18 times before the run was killed.
   */
  const origin = await startOrigin((write, end) => {
    // Fragmented exactly as a provider streams it: identity on the first fragment,
    // arguments split across later ones sharing the same index.
    write(
      `data: ${JSON.stringify({
        model: "stream-model",
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_stream_1", type: "function", function: { name: "get_weather", arguments: '{"ci' } },
              ],
            },
          },
        ],
      })}\n\n`,
    );
    write(
      `data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Oslo"}' } }] } }],
      })}\n\n`,
    );
    write(
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`,
    );
    write("data: [DONE]\n\n");
    end();
  });
  const { app, runtime } = harness();
  t.after(async () => {
    await app.close();
    runtime.close();
    await origin.close();
  });
  seed(runtime, origin.port);
  const { base } = await listen(app);

  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({
      ...REQUEST,
      stream: true,
      tools: [
        {
          type: "function",
          function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
        },
      ],
    }),
  });

  assert.equal(response.status, 200);
  const text = await response.text();
  const frames = text
    .split("\n\n")
    .filter((line) => line.length > 0 && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice("data: ".length)));

  const fragments = frames.flatMap((chunk) => chunk.choices[0].delta.tool_calls ?? []);
  assert.ok(fragments.length > 0, "no tool_calls survived the stream");

  // The first fragment carries the identity a client needs to open the call.
  assert.equal(fragments[0].index, 0);
  assert.equal(fragments[0].id, "call_stream_1");
  assert.equal(fragments[0].type, "function");
  assert.equal(fragments[0].function.name, "get_weather");

  // Reassembling by index yields the arguments the provider actually sent, which is
  // what a client does — so this asserts the fragments are usable, not merely present.
  const byIndex = new Map<number, string>();
  for (const fragment of fragments) {
    const previous = byIndex.get(fragment.index) ?? "";
    byIndex.set(fragment.index, previous + (fragment.function?.arguments ?? ""));
  }
  assert.deepEqual(JSON.parse(byIndex.get(0) as string), { city: "Oslo" });

  // A later fragment must NOT repeat the identity: a client keyed on `id` would open a
  // second call for the same one.
  assert.equal(fragments.at(-1).id, undefined);
  assert.equal(fragments.at(-1).function.name, undefined);

  assert.equal(frames.at(-1).choices[0].finish_reason, "tool_calls");
});

test("a content-only stream carries no tool_calls key at all", async (t) => {
  // The other half of the fix: `delta` must not gain an empty `tool_calls` array on
  // ordinary text, or a strict client would see a tool call that never happened.
  const origin = await startOrigin((write, end) => {
    write(frame("plain"));
    write("data: [DONE]\n\n");
    end();
  });
  const { app, runtime } = harness();
  t.after(async () => {
    await app.close();
    runtime.close();
    await origin.close();
  });
  seed(runtime, origin.port);
  const { base } = await listen(app);

  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ ...REQUEST, stream: true }),
  });
  const text = await response.text();
  const frames = text
    .split("\n\n")
    .filter((line) => line.length > 0 && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice("data: ".length)));
  for (const chunk of frames) {
    assert.equal(
      "tool_calls" in chunk.choices[0].delta,
      false,
      "a text-only stream must not advertise tool_calls",
    );
  }
});

test("each streamed frame carries the OpenAI chunk object name", async (t) => {
  const origin = await startOrigin((write, end) => {
    write(frame("x"));
    write("data: [DONE]\n\n");
    end();
  });
  const { app, runtime } = harness();
  t.after(async () => {
    await app.close();
    runtime.close();
    await origin.close();
  });
  seed(runtime, origin.port);
  const { base } = await listen(app);

  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ ...REQUEST, stream: true }),
  });
  const first = JSON.parse(
    (await response.text()).split("\n\n")[0]!.slice("data: ".length),
  );
  // A client that validates `object` would otherwise reject every chunk.
  assert.equal(first.object, "chat.completion.chunk");
  assert.match(String(first.id), /^chatcmpl-/);
  assert.equal(typeof first.created, "number");
  assert.equal(first.choices[0].index, 0);
});

test("the stream id is stable across every chunk of one response", async (t) => {
  const origin = await startOrigin((write, end) => {
    write(frame("a"));
    write(frame("b"));
    write(frame("c"));
    write("data: [DONE]\n\n");
    end();
  });
  const { app, runtime } = harness();
  t.after(async () => {
    await app.close();
    runtime.close();
    await origin.close();
  });
  seed(runtime, origin.port);
  const { base } = await listen(app);

  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ ...REQUEST, stream: true }),
  });
  const ids = (await response.text())
    .split("\n\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice("data: ".length)).id);
  assert.ok(ids.length >= 3);
  assert.equal(new Set(ids).size, 1, "a single response must have a single id");
});

test("stream false and an absent stream behave exactly as Phase 6", async (t) => {
  const origin = await startOrigin((write, end) => {
    write(
      JSON.stringify({
        model: "stream-model",
        choices: [{ message: { role: "assistant", content: COMPLETION }, finish_reason: "stop" }],
      }),
    );
    end();
  });
  const { app, runtime } = harness();
  t.after(async () => {
    await app.close();
    runtime.close();
    await origin.close();
  });
  seed(runtime, origin.port);

  for (const payload of [{ ...REQUEST }, { ...REQUEST, stream: false }]) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: AUTH,
      payload,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0].message.content, COMPLETION);
    assert.match(String(response.headers["content-type"]), /application\/json/);
  }
});

test("an identity lacking chat.completions cannot stream", async (t) => {
  const origin = await startOrigin((write, end) => {
    write("data: [DONE]\n\n");
    end();
  });
  const { app, runtime } = harness();
  t.after(async () => {
    await app.close();
    runtime.close();
    await origin.close();
  });
  seed(runtime, origin.port);

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${NO_STREAM_KEY}`, "content-type": "application/json" },
    payload: { ...REQUEST, stream: true },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(origin.requests, 0, "an unauthorized stream must open no upstream");
});

test("a pre-first-byte upstream failure is a normal JSON error, not a stream", async (t) => {
  // Before any byte is emitted the response is not committed, so the honest
  // answer is the stable error envelope a client already knows how to read.
  const origin = await startOrigin((_write, end) => end(), 503);
  const { app, runtime } = harness();
  t.after(async () => {
    await app.close();
    runtime.close();
    await origin.close();
  });
  seed(runtime, origin.port);
  const { base } = await listen(app);

  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ ...REQUEST, stream: true }),
  });
  assert.equal(response.status, 502);
  assert.match(String(response.headers.get("content-type")), /application\/json/);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "upstream_error");
});

test("a mid-stream failure emits a terminal error event, never a silent truncation", async (t) => {
  const origin = await startOrigin((write, _end, destroy) => {
    write(frame("partial"));
    setTimeout(destroy, 30);
  });
  const { app, runtime } = harness();
  t.after(async () => {
    await app.close();
    runtime.close();
    await origin.close();
  });
  seed(runtime, origin.port);
  const { base } = await listen(app);

  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ ...REQUEST, stream: true }),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(text.includes("partial"));
  // The client must be able to tell a failed stream from a complete one. Ending
  // with [DONE] after a failure would claim success.
  assert.ok(!text.trimEnd().endsWith("data: [DONE]"));
  const frames = text.split("\n\n").filter((line) => line.startsWith("data: {"));
  const last = JSON.parse(frames.at(-1)!.slice("data: ".length));
  assert.ok(last.error !== undefined, "a terminal error event is required");
  assert.equal(typeof last.error.code, "string");
});

test("a client that disconnects mid-stream destroys the upstream request", async (t) => {
  const timers: NodeJS.Timeout[] = [];
  const origin = await startOrigin((write) => {
    const timer = setInterval(() => write(frame("tick")), 15);
    timers.push(timer);
  });
  const { app, runtime } = harness();
  t.after(async () => {
    timers.forEach(clearInterval);
    await app.close();
    runtime.close();
    await origin.close();
  });
  seed(runtime, origin.port);
  const { base } = await listen(app);

  const controller = new AbortController();
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ ...REQUEST, stream: true }),
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  await reader.read();
  controller.abort();
  try {
    await reader.cancel();
  } catch {
    // Already aborted; the point is the upstream teardown below.
  }

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(
    origin.destroyedEarly,
    1,
    "abandoning a stream must stop the provider generating tokens",
  );
});

test("the upstream request carries stream true", async (t) => {
  const origin = await startOrigin((write, end) => {
    write("data: [DONE]\n\n");
    end();
  });
  const { app, runtime } = harness();
  t.after(async () => {
    await app.close();
    runtime.close();
    await origin.close();
  });
  seed(runtime, origin.port);
  const { base } = await listen(app);

  await (
    await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQUEST, stream: true }),
    })
  ).text();
  assert.equal(JSON.parse(origin.bodies[0]!).stream, true);
});

test("no prompt or completion sentinel appears in the logs after a stream", async (t) => {
  logLines.length = 0;
  const origin = await startOrigin((write, end) => {
    write(frame(COMPLETION));
    write("data: [DONE]\n\n");
    end();
  });
  const { app, runtime } = harness();
  t.after(async () => {
    await app.close();
    runtime.close();
    await origin.close();
  });
  seed(runtime, origin.port);
  const { base } = await listen(app);

  const text = await (
    await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQUEST, stream: true }),
    })
  ).text();
  assert.ok(text.includes(COMPLETION), "the client legitimately receives it");

  const logged = logLines.join("\n");
  assert.ok(!logged.includes(PROMPT), "the prompt must not be logged");
  assert.ok(!logged.includes(COMPLETION), "the completion must not be logged");
  assert.ok(!logged.includes(CREDENTIAL), "the credential must not be logged");
});

test("a usage chunk reaches the client and telemetry", async (t) => {
  const origin = await startOrigin((write, end) => {
    write(frame("a"));
    write(
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
      })}\n\n`,
    );
    write("data: [DONE]\n\n");
    end();
  });
  const { app, runtime } = harness();
  t.after(async () => {
    await app.close();
    runtime.close();
    await origin.close();
  });
  seed(runtime, origin.port);
  const { base } = await listen(app);

  const text = await (
    await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...REQUEST, stream: true }),
    })
  ).text();
  assert.ok(text.includes('"finish_reason":"stop"'));

  const rows = runtime.usage.recentRequests(10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.promptTokens, 11);
  assert.equal(rows[0]?.outcome, "ok");
});
