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

const KEY = Buffer.alloc(32, 0x2c).toString("hex");
const TOKEN = "tools-api-token-0123456789";
const AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const TOOL_ARGUMENT = '{"city":"TOOL-ARG-SENTINEL-must-never-persist"}';
const TOOL_RESULT = "TOOL-RESULT-SENTINEL-must-never-persist";
const CREDENTIAL = "sk-tools-api-credential";

const logLines: string[] = [];

function harness(): { app: FastifyInstance; runtime: BayzRuntime; dataDir: string } {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-tools-api-")), ".bayz");
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
  });
  return { app, runtime, dataDir };
}

type OriginController = {
  port: number;
  bodies: string[];
  close(): Promise<void>;
};

/** Scripted origin: each request consumes the next response in order. */
async function startOrigin(script: unknown[]): Promise<OriginController> {
  const bodies: string[] = [];
  let index = 0;
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      const step = script[Math.min(index, script.length - 1)];
      index += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(step));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    bodies,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function toolCallResponse(): unknown {
  return {
    model: "tool-model",
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_abc",
              type: "function",
              function: { name: "get_weather", arguments: TOOL_ARGUMENT },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

function finalResponse(content: string): unknown {
  return {
    model: "tool-model",
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  };
}

function seed(runtime: BayzRuntime, port: number, supportsTools?: boolean): void {
  runtime.providers.createProvider({
    id: "tp",
    kind: "openai-compatible",
    displayName: "Tool Provider",
    baseUrl: `http://127.0.0.1:${port}`,
    // One `config` in every branch: the loopback opt-in is unconditional because the
    // origin is always local, and `supportsTools` is only sometimes specified.
    config: {
      allowLoopback: true,
      ...(supportsTools === undefined ? {} : { supportsTools }),
    },
  });
  runtime.providers.setCredential("tp", CREDENTIAL);
  runtime.router.createRoute({ id: "tr", model: "tool-model", providerId: "tp" });
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "look up weather",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    },
  },
];

test("turn one sends tools and receives tool_calls", async (t) => {
  const origin = await startOrigin([toolCallResponse()]);
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
    headers: AUTH,
    payload: {
      model: "tool-model",
      messages: [{ role: "user", content: "weather?" }],
      tools: TOOLS,
    },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.choices[0].finish_reason, "tool_calls");
  // `null`, not `""` — a client rendering an empty assistant bubble would look broken.
  assert.equal(body.choices[0].message.content, null);
  assert.deepEqual(body.choices[0].message.tool_calls, [
    {
      id: "call_abc",
      type: "function",
      function: { name: "get_weather", arguments: TOOL_ARGUMENT },
    },
  ]);
  // The tools genuinely reached the provider rather than being dropped.
  assert.ok(JSON.parse(origin.bodies[0]!).tools !== undefined);
});

test("turn two sends the assistant message plus a tool result and receives the answer", async (t) => {
  const origin = await startOrigin([toolCallResponse(), finalResponse("It is sunny.")]);
  const { app, runtime } = harness();
  t.after(async () => {
    await app.close();
    runtime.close();
    await origin.close();
  });
  seed(runtime, origin.port);

  const first = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: AUTH,
    payload: {
      model: "tool-model",
      messages: [{ role: "user", content: "weather?" }],
      tools: TOOLS,
    },
  });
  const assistant = first.json().choices[0].message;

  const second = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: AUTH,
    payload: {
      model: "tool-model",
      messages: [
        { role: "user", content: "weather?" },
        { role: "assistant", tool_calls: assistant.tool_calls },
        { role: "tool", tool_call_id: "call_abc", content: TOOL_RESULT },
      ],
      tools: TOOLS,
    },
  });

  assert.equal(second.statusCode, 200);
  assert.equal(second.json().choices[0].message.content, "It is sunny.");
  // The result genuinely reached the provider — a dropped tool message would leave
  // the model answering without the data it asked for.
  assert.ok(origin.bodies[1]!.includes(TOOL_RESULT));
});

test("three turns work", async (t) => {
  const origin = await startOrigin([
    toolCallResponse(),
    toolCallResponse(),
    finalResponse("Finally done."),
  ]);
  const { app, runtime } = harness();
  t.after(async () => {
    await app.close();
    runtime.close();
    await origin.close();
  });
  seed(runtime, origin.port);

  const messages: unknown[] = [{ role: "user", content: "weather?" }];
  for (let turn = 0; turn < 2; turn += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: AUTH,
      payload: { model: "tool-model", messages, tools: TOOLS },
    });
    assert.equal(response.statusCode, 200);
    const message = response.json().choices[0].message;
    messages.push({ role: "assistant", tool_calls: message.tool_calls });
    messages.push({ role: "tool", tool_call_id: "call_abc", content: TOOL_RESULT });
  }

  const final = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: AUTH,
    payload: { model: "tool-model", messages, tools: TOOLS },
  });
  assert.equal(final.json().choices[0].message.content, "Finally done.");
});

test("a tool_call_id matching no prior call is a 400", async (t) => {
  const origin = await startOrigin([finalResponse("never reached")]);
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
    headers: AUTH,
    payload: {
      model: "tool-model",
      messages: [
        { role: "user", content: "hi" },
        { role: "tool", tool_call_id: "call_fabricated", content: "made up" },
      ],
      tools: TOOLS,
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "invalid_request");
  assert.equal(origin.bodies.length, 0, "a fabricated result must reach no provider");
});

test("a tool result before its call in message order is refused", async (t) => {
  // Order is the check: a result must follow the assistant message that declared its
  // id. Accepting an out-of-order pair would let a client assert a result for a call
  // the model had not made yet.
  const origin = await startOrigin([finalResponse("never reached")]);
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
    headers: AUTH,
    payload: {
      model: "tool-model",
      messages: [
        { role: "tool", tool_call_id: "call_abc", content: "early" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_abc",
              type: "function",
              function: { name: "get_weather", arguments: "{}" },
            },
          ],
        },
      ],
      tools: TOOLS,
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(origin.bodies.length, 0);
});

test("a user message carrying tool_calls is refused", async (t) => {
  const origin = await startOrigin([finalResponse("never reached")]);
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
    headers: AUTH,
    payload: {
      model: "tool-model",
      messages: [
        {
          role: "user",
          content: "hi",
          tool_calls: [
            { id: "call_x", type: "function", function: { name: "ping", arguments: "{}" } },
          ],
        },
      ],
      tools: TOOLS,
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(origin.bodies.length, 0);
});

test("a provider declared without tool support refuses the request", async (t) => {
  const origin = await startOrigin([finalResponse("never reached")]);
  const { app, runtime } = harness();
  t.after(async () => {
    await app.close();
    runtime.close();
    await origin.close();
  });
  seed(runtime, origin.port, false);

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: AUTH,
    payload: {
      model: "tool-model",
      messages: [{ role: "user", content: "hi" }],
      tools: TOOLS,
    },
  });
  assert.equal(response.statusCode, 501);
  assert.equal(response.json().error.code, "tools_unsupported");
  assert.equal(origin.bodies.length, 0, "no upstream call for an unsupported capability");
});

test("a request without tools still works against a tools-disabled provider", async (t) => {
  const origin = await startOrigin([finalResponse("plain answer")]);
  const { app, runtime } = harness();
  t.after(async () => {
    await app.close();
    runtime.close();
    await origin.close();
  });
  seed(runtime, origin.port, false);

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: AUTH,
    payload: { model: "tool-model", messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().choices[0].message.content, "plain answer");
});

test("no tool argument or result appears in telemetry, logs, or the database", async (t) => {
  logLines.length = 0;
  const origin = await startOrigin([toolCallResponse(), finalResponse("done")]);
  const { app, runtime, dataDir } = harness();
  t.after(async () => {
    await app.close();
    runtime.close();
    await origin.close();
  });
  seed(runtime, origin.port);

  const first = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: AUTH,
    payload: {
      model: "tool-model",
      messages: [{ role: "user", content: "weather?" }],
      tools: TOOLS,
    },
  });
  await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: AUTH,
    payload: {
      model: "tool-model",
      messages: [
        { role: "user", content: "weather?" },
        { role: "assistant", tool_calls: first.json().choices[0].message.tool_calls },
        { role: "tool", tool_call_id: "call_abc", content: TOOL_RESULT },
      ],
      tools: TOOLS,
    },
  });

  const logged = logLines.join("\n");
  assert.ok(!logged.includes(TOOL_ARGUMENT), "a tool argument must not be logged");
  assert.ok(!logged.includes(TOOL_RESULT), "a tool result must not be logged");
  assert.ok(!logged.includes(CREDENTIAL));

  const rows = JSON.stringify(runtime.usage.recentRequests(50));
  assert.ok(!rows.includes(TOOL_ARGUMENT));
  assert.ok(!rows.includes(TOOL_RESULT));

  // The database bytes are the authority: a row could hold something the API view
  // filters out.
  const { readFileSync } = await import("node:fs");
  for (const suffix of ["", "-wal", "-shm"]) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(dataDir, `bayz.db${suffix}`));
    } catch {
      continue;
    }
    assert.ok(
      !bytes.includes(Buffer.from(TOOL_ARGUMENT, "utf8")),
      `tool argument found in bayz.db${suffix}`,
    );
    assert.ok(
      !bytes.includes(Buffer.from(TOOL_RESULT, "utf8")),
      `tool result found in bayz.db${suffix}`,
    );
  }
});

test("tool_choice naming an undeclared tool is refused", async (t) => {
  const origin = await startOrigin([finalResponse("never reached")]);
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
    headers: AUTH,
    payload: {
      model: "tool-model",
      messages: [{ role: "user", content: "hi" }],
      tools: TOOLS,
      tool_choice: { type: "function", function: { name: "not_declared" } },
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(origin.bodies.length, 0);
});

test("tool_choice without tools is refused", async (t) => {
  const origin = await startOrigin([finalResponse("never reached")]);
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
    headers: AUTH,
    payload: {
      model: "tool-model",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: "required",
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(origin.bodies.length, 0);
});

test("tool_choice auto is forwarded alongside tools", async (t) => {
  const origin = await startOrigin([finalResponse("ok")]);
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
    headers: AUTH,
    payload: {
      model: "tool-model",
      messages: [{ role: "user", content: "hi" }],
      tools: TOOLS,
      tool_choice: "auto",
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(origin.bodies[0]!).tool_choice, "auto");
});
