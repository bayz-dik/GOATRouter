import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  RouterError,
  parseChatChunk,
  parseChatResponse,
  sendChatRequest,
} from "../src/index.js";
import { wireBody } from "../src/wire.js";

function responseWithToolCalls(calls: unknown): unknown {
  return {
    model: "m",
    choices: [
      {
        message: { role: "assistant", content: null, tool_calls: calls },
        finish_reason: "tool_calls",
      },
    ],
  };
}

test("an upstream tool_calls array normalizes onto a fresh object", () => {
  const parsed = parseChatResponse(
    responseWithToolCalls([
      { id: "call_1", type: "function", function: { name: "ping", arguments: '{"a":1}' } },
    ]),
  );
  assert.equal(parsed.content, "");
  assert.equal(parsed.finishReason, "tool_calls");
  assert.deepEqual(parsed.toolCalls, [
    { id: "call_1", type: "function", function: { name: "ping", arguments: '{"a":1}' } },
  ]);
});

test("content is an empty string when a response is purely tool calls", () => {
  // The alternative — `undefined` — would break `ChatResponse.content`'s contract
  // that it is always a string, and every caller would need a new branch. An empty
  // string with a populated `toolCalls` is unambiguous.
  const parsed = parseChatResponse(
    responseWithToolCalls([
      { id: "call_1", type: "function", function: { name: "ping", arguments: "{}" } },
    ]),
  );
  assert.equal(parsed.content, "");
  assert.ok(parsed.toolCalls !== undefined);
});

test("an injected extra field on an upstream tool call is discarded", () => {
  const parsed = parseChatResponse(
    responseWithToolCalls([
      {
        id: "call_1",
        type: "function",
        function: { name: "ping", arguments: "{}" },
        index: 0,
      },
    ]),
  );
  assert.deepEqual(Object.keys(parsed.toolCalls![0]!), ["id", "type", "function"]);
});

test("a response with neither content nor tool calls is still a hard failure", () => {
  assert.throws(
    () =>
      parseChatResponse({
        model: "m",
        choices: [{ message: { role: "assistant", content: null }, finish_reason: "stop" }],
      }),
    (error: unknown) =>
      error instanceof RouterError && error.code === "invalid_response",
  );
});

test("a hostile upstream tool call is refused, not forwarded", () => {
  for (const calls of [
    [{ id: "call_1", type: "function", function: { name: "bad name", arguments: "{}" } }],
    [{ id: "call_1", type: "function", function: { name: "ping", arguments: "not json" } }],
    [{ id: "call_1", type: "function", function: { name: "__proto__", arguments: "{}" } }],
    [{ id: "call_1", type: "function", function: { name: "ping", arguments: "[1]" } }],
    Array.from({ length: 9 }, (_value, index) => ({
      id: `call_${index}`,
      type: "function",
      function: { name: "ping", arguments: "{}" },
    })),
    "not-an-array",
    [],
  ]) {
    assert.throws(
      () => parseChatResponse(responseWithToolCalls(calls)),
      (error: unknown) =>
        error instanceof RouterError && error.code === "invalid_response",
      `accepted upstream tool calls ${JSON.stringify(calls).slice(0, 60)}`,
    );
  }
});

test("a streamed tool call reassembles across chunks", () => {
  // Providers stream tool-call arguments a few characters at a time with a shared
  // `index`. A chunk parser that ignored `index` would produce one call per chunk.
  const first = parseChatChunk({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: "call_1", type: "function", function: { name: "ping", arguments: '{"a' } },
          ],
        },
      },
    ],
  });
  assert.deepEqual(first.toolCallDeltas, [
    { index: 0, id: "call_1", name: "ping", argumentsDelta: '{"a' },
  ]);

  const second = parseChatChunk({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '":1}' } }] } }],
  });
  assert.deepEqual(second.toolCallDeltas, [
    { index: 0, id: undefined, name: undefined, argumentsDelta: '":1}' },
  ]);
});

test("a streamed tool call delta with a hostile index is refused", () => {
  for (const index of [-1, 1.5, "0", null, 999999]) {
    assert.throws(
      () =>
        parseChatChunk({
          choices: [
            { delta: { tool_calls: [{ index, function: { arguments: "{}" } }] } },
          ],
        }),
      (error: unknown) =>
        error instanceof RouterError && error.code === "invalid_response",
      `accepted index ${JSON.stringify(index)}`,
    );
  }
});

test("an oversized streamed argument delta is refused", () => {
  assert.throws(
    () =>
      parseChatChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: "x".repeat(64 * 1024) } },
              ],
            },
          },
        ],
      }),
    (error: unknown) =>
      error instanceof RouterError && error.code === "response_too_large",
  );
});

test("more than the tool-call cap in one streamed chunk is refused", () => {
  assert.throws(
    () =>
      parseChatChunk({
        choices: [
          {
            delta: {
              tool_calls: Array.from({ length: 9 }, (_value, index) => ({
                index,
                function: { arguments: "{}" },
              })),
            },
          },
        ],
      }),
    (error: unknown) =>
      error instanceof RouterError && error.code === "invalid_response",
  );
});

test("finish_reason tool_calls survives on a streamed chunk", () => {
  const chunk = parseChatChunk({
    choices: [{ delta: {}, finish_reason: "tool_calls" }],
  });
  assert.equal(chunk.finishReason, "tool_calls");
});

test("a chunk with no tool calls reports undefined, not an empty array", () => {
  // An empty array would make a consumer believe a tool-call frame arrived.
  const chunk = parseChatChunk({ choices: [{ delta: { content: "x" } }] });
  assert.equal(chunk.toolCallDeltas, undefined);
});

test("wireBody forwards tools and tool_choice when present", () => {
  const body = JSON.parse(
    wireBody(
      {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "ping" } }],
        toolChoice: "auto",
      },
      false,
    ),
  );
  assert.deepEqual(body.tools, [{ type: "function", function: { name: "ping" } }]);
  assert.equal(body.tool_choice, "auto");
});

test("wireBody omits tool_choice when no tools are present", () => {
  const body = JSON.parse(
    wireBody({ model: "m", messages: [{ role: "user", content: "hi" }] }, false),
  );
  assert.equal("tools" in body, false);
  assert.equal("tool_choice" in body, false);
});

test("wireBody renames the internal tool fields to the wire contract", () => {
  /*
   * A regression guard for a bug 9G Task 3 found in this file's own subject.
   *
   * `ChatMessage` is BAYZ's internal shape and uses `toolCalls` / `toolCallId`; the
   * OpenAI wire contract is `tool_calls` / `tool_call_id`. `wireBody` used to serialize
   * `request.messages` directly, so both reached the upstream under names it does not
   * recognise — the model was handed a conversation with the tool call and its result
   * effectively missing, and would answer without the data it asked for or ask again.
   *
   * The 9B suite could not see it: the only assertion on the outbound body was that the
   * result *string* appeared somewhere in it, which held either way because `content`
   * needs no renaming. Asserting the key names is what makes the failure visible.
   */
  const body = JSON.parse(
    wireBody(
      {
        model: "m",
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            toolCalls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"x"}' },
              },
            ],
          },
          { role: "tool", toolCallId: "call_1", content: "sunny" },
        ],
      },
      false,
    ),
  ) as { messages: Array<Record<string, unknown>> };

  const [user, assistant, tool] = body.messages;
  assert.deepEqual(Object.keys(user!).sort(), ["content", "role"]);

  assert.deepEqual(Object.keys(assistant!).sort(), ["content", "role", "tool_calls"]);
  // Explicitly `null`, which is what the contract specifies for an assistant turn that
  // is purely tool calls. Omitting the key makes some upstreams reject the message.
  assert.equal(assistant!.content, null);
  assert.equal(
    (assistant!.tool_calls as Array<{ id: string }>)[0]?.id,
    "call_1",
  );
  assert.equal("toolCalls" in assistant!, false, "the internal name reached the wire");

  assert.deepEqual(Object.keys(tool!).sort(), ["content", "role", "tool_call_id"]);
  assert.equal(tool!.tool_call_id, "call_1");
  assert.equal("toolCallId" in tool!, false, "the internal name reached the wire");
});

test("a provider declared without tool support refuses rather than silently dropping", async () => {
  // The honest failure. A silent strip would hand the client a normal prose answer
  // that never mentions its tools were ignored, which reads as the model declining
  // to call anything rather than as a configuration problem.
  const origin = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "x" }, finish_reason: "stop" }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", () => resolve()));
  const port = (origin.address() as AddressInfo).port;

  try {
    await assert.rejects(
      () =>
        sendChatRequest({
          provider: {
            kind: "openai-compatible",
            baseUrl: `http://127.0.0.1:${port}`,
            requestTimeoutMs: 5000,
            egress: { allowLoopback: true, allowPrivate: false },
            supportsTools: false,
          },
          request: {
            model: "m",
            messages: [{ role: "user", content: "hi" }],
            tools: [{ type: "function", function: { name: "ping" } }],
          },
        }),
      (error: unknown) =>
        error instanceof RouterError && error.code === "tools_unsupported",
    );
  } finally {
    await new Promise<void>((resolve) => origin.close(() => resolve()));
  }
});

test("an unknown tool capability forwards and lets the upstream decide", async () => {
  // `supportsTools` absent means BAYZ does not know. A discovery endpoint does not
  // reveal tool support, so guessing either way would be fabrication.
  let seen = "";
  const origin = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      seen = Buffer.concat(chunks).toString("utf8");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "x" }, finish_reason: "stop" }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", () => resolve()));
  const port = (origin.address() as AddressInfo).port;

  try {
    await sendChatRequest({
      provider: {
        kind: "openai-compatible",
        baseUrl: `http://127.0.0.1:${port}`,
        requestTimeoutMs: 5000,
        egress: { allowLoopback: true, allowPrivate: false },
      },
      request: {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "ping" } }],
      },
    });
    assert.deepEqual(JSON.parse(seen).tools, [
      { type: "function", function: { name: "ping" } },
    ]);
  } finally {
    await new Promise<void>((resolve) => origin.close(() => resolve()));
  }
});

test("a provider declared with tool support forwards them", async () => {
  let seen = "";
  const origin = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      seen = Buffer.concat(chunks).toString("utf8");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "x" }, finish_reason: "stop" }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", () => resolve()));
  const port = (origin.address() as AddressInfo).port;

  try {
    await sendChatRequest({
      provider: {
        kind: "openai-compatible",
        baseUrl: `http://127.0.0.1:${port}`,
        requestTimeoutMs: 5000,
        supportsTools: true,
        egress: { allowLoopback: true, allowPrivate: false },
      },
      request: {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "ping" } }],
      },
    });
    assert.ok(JSON.parse(seen).tools !== undefined);
  } finally {
    await new Promise<void>((resolve) => origin.close(() => resolve()));
  }
});
