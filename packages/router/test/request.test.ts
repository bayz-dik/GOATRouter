import assert from "node:assert/strict";
import test from "node:test";
import { RouterError, parseChatRequest } from "../src/index.js";

function rejects(input: unknown, label = ""): void {
  assert.throws(
    () => parseChatRequest(input),
    (error: unknown) =>
      error instanceof RouterError && error.code === "invalid_request",
    `request must be rejected: ${label || JSON.stringify(input)?.slice(0, 80)}`,
  );
}

const VALID = {
  model: "gpt-4o",
  messages: [{ role: "user", content: "hello" }],
};

test("a minimal request is accepted and normalized", () => {
  const parsed = parseChatRequest(VALID);
  assert.deepEqual(parsed, {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hello" }],
  });
});

test("all optional parameters are accepted within range", () => {
  const parsed = parseChatRequest({
    model: "gpt-4o",
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ],
    temperature: 0.7,
    maxTokens: 512,
    topP: 0.9,
    stop: ["\n\n", "END"],
  });
  assert.equal(parsed.temperature, 0.7);
  assert.equal(parsed.maxTokens, 512);
  assert.equal(parsed.topP, 0.9);
  assert.deepEqual(parsed.stop, ["\n\n", "END"]);
  assert.equal(parsed.messages.length, 3);
});

test("boundary values are accepted", () => {
  assert.equal(parseChatRequest({ ...VALID, temperature: 0 }).temperature, 0);
  assert.equal(parseChatRequest({ ...VALID, temperature: 2 }).temperature, 2);
  assert.equal(parseChatRequest({ ...VALID, topP: 0 }).topP, 0);
  assert.equal(parseChatRequest({ ...VALID, topP: 1 }).topP, 1);
  assert.equal(parseChatRequest({ ...VALID, maxTokens: 1 }).maxTokens, 1);
  assert.equal(
    parseChatRequest({ ...VALID, maxTokens: 128000 }).maxTokens,
    128000,
  );
});

test("the model is validated as an untrusted identifier", () => {
  rejects({ ...VALID, model: "" });
  rejects({ ...VALID, model: "../../etc/passwd" });
  rejects({ ...VALID, model: "has space" });
  rejects({ ...VALID, model: "gpt-4o\r\nX: y" });
  rejects({ ...VALID, model: "https://evil.example.com/m" });
  rejects({ ...VALID, model: 42 });
  rejects({ ...VALID, model: undefined });
  // A wildcard is a route pattern, never a request.
  rejects({ ...VALID, model: "gpt-4*" });
});

test("messages must be a non-empty array of valid entries", () => {
  rejects({ ...VALID, messages: [] });
  rejects({ ...VALID, messages: {} });
  rejects({ ...VALID, messages: "hello" });
  rejects({ ...VALID, messages: undefined });
  rejects({ ...VALID, messages: [null] });
  rejects({ ...VALID, messages: ["hello"] });
  rejects({ ...VALID, messages: [{ role: "user" }] });
  rejects({ ...VALID, messages: [{ content: "hi" }] });
  rejects({ ...VALID, messages: [{ role: "root", content: "hi" }] });
  rejects({ ...VALID, messages: [{ role: "tool", content: "hi" }] });
  rejects({ ...VALID, messages: [{ role: "user", content: "" }] });
  rejects({ ...VALID, messages: [{ role: "user", content: 42 }] });
  rejects({ ...VALID, messages: [{ role: "user", content: null }] });
  /*
   * `name` used to be listed here as an unknown key. Phase 9H Task 5 admitted it, because
   * the real Hermes client sends it on every `role: "tool"` message and the refusal made a
   * tool roundtrip impossible for that client — see the `name` tests at the end of this
   * file. The assertion is kept, pointed at a key that is genuinely not in the OpenAI
   * message contract, so the allow-list is still proven closed rather than merely widened.
   */
  rejects({
    ...VALID,
    messages: [{ role: "user", content: "hi", metadata: { trace: "x" } }],
  }, "unknown message key");
  rejects({
    ...VALID,
    messages: [{ role: "user", content: "hi", function_call: { name: "f" } }],
  }, "legacy function_call on a message");
});

test("message and content limits are enforced", () => {
  const many = Array.from({ length: 257 }, () => ({
    role: "user" as const,
    content: "x",
  }));
  rejects({ ...VALID, messages: many }, "too many messages");
  assert.equal(
    parseChatRequest({ ...VALID, messages: many.slice(0, 256) }).messages.length,
    256,
  );
  rejects(
    { ...VALID, messages: [{ role: "user", content: "x".repeat(128001) }] },
    "content too long",
  );
});

test("out-of-range sampling parameters are rejected", () => {
  rejects({ ...VALID, temperature: -0.1 });
  rejects({ ...VALID, temperature: 2.1 });
  rejects({ ...VALID, temperature: "0.7" });
  rejects({ ...VALID, temperature: Number.NaN });
  rejects({ ...VALID, temperature: Number.POSITIVE_INFINITY });
  rejects({ ...VALID, topP: -0.1 });
  rejects({ ...VALID, topP: 1.1 });
  rejects({ ...VALID, maxTokens: 0 });
  rejects({ ...VALID, maxTokens: 128001 });
  rejects({ ...VALID, maxTokens: 1.5 });
  rejects({ ...VALID, maxTokens: -1 });
});

test("stop sequences are bounded in count and length", () => {
  rejects({ ...VALID, stop: "END" });
  rejects({ ...VALID, stop: [] });
  rejects({ ...VALID, stop: ["a", "b", "c", "d", "e"] });
  rejects({ ...VALID, stop: [""] });
  rejects({ ...VALID, stop: ["x".repeat(65)] });
  rejects({ ...VALID, stop: [42] });
  assert.deepEqual(parseChatRequest({ ...VALID, stop: ["a"] }).stop, ["a"]);
});

test("unknown keys are rejected, so stream cannot be smuggled in", () => {
  rejects({ ...VALID, stream: true }, "stream");
  rejects({ ...VALID, stream: false }, "stream false");
  rejects({ ...VALID, tools: [] });
  rejects({ ...VALID, functions: [] });
  rejects({ ...VALID, n: 4 });
  rejects({ ...VALID, headers: { Authorization: "Bearer sk-attacker" } });
  rejects({ ...VALID, api_key: "sk-attacker" });
  rejects({ ...VALID, baseUrl: "https://evil.example.com" });
  rejects({ ...VALID, provider: "p2" }, "provider override");
  rejects({ ...VALID, extra: 1 });
});

test("a non-plain prototype is refused", () => {
  rejects({ __proto__: { polluted: true }, ...VALID }, "polluted prototype");
  rejects(Object.assign(Object.create({ model: "gpt-4o" }), { messages: VALID.messages }));
});

test("non-object requests are rejected", () => {
  rejects(null);
  rejects(undefined);
  rejects("gpt-4o");
  rejects(42);
  rejects([]);
  rejects(true);
});

test("a request whose serialized size exceeds the cap is rejected", () => {
  // Each message is under the per-message cap, but together they exceed 1 MiB.
  const messages = Array.from({ length: 20 }, () => ({
    role: "user" as const,
    content: "x".repeat(60000),
  }));
  rejects({ ...VALID, messages }, "body over 1 MiB");
});

test("parsing returns a fresh object and does not mutate its input", () => {
  const input = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hello" }],
    temperature: 0.5,
  };
  const parsed = parseChatRequest(input);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed.messages, input.messages);
  assert.notEqual(parsed.messages[0], input.messages[0]);

  parsed.messages[0]!.content = "mutated";
  parsed.temperature = 1.9;
  assert.equal(input.messages[0]!.content, "hello");
  assert.equal(input.temperature, 0.5);
});

test("the parsed request contains no key the caller did not supply", () => {
  const parsed = parseChatRequest(VALID);
  assert.deepEqual(Object.keys(parsed).sort(), ["messages", "model"]);
  assert.equal("stream" in parsed, false);
  assert.equal("temperature" in parsed, false);
});

test("a tool result message carrying `name` is accepted", () => {
  /*
   * Phase 9H Task 5 regression.
   *
   * The real Hermes Agent client (v0.20.5) sends `name` on every `role: "tool"` message —
   * `{role, tool_call_id, name, content}` — which is part of the OpenAI chat contract. The
   * message allow-list refused it, so the whole request failed
   * `invalid_request (message-unknown-key)` and a tool roundtrip was impossible for that
   * client: BAYZ delivered the call, Hermes ran it, and the result was refused on the way
   * back. See docs/transcripts/hermes/.
   */
  const parsed = parseChatRequest({
    model: "gpt-4o",
    messages: [
      { role: "user", content: "what is the weather" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Oslo"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", name: "get_weather", content: "18C" },
    ],
  });
  const toolMessage = parsed.messages.at(-1)!;
  assert.equal(toolMessage.role, "tool");
  assert.equal(toolMessage.toolCallId, "call_1");
  assert.equal(toolMessage.content, "18C");
  // Validated, then dropped: `tool_call_id` already identifies the call, so echoing a
  // client-supplied name upstream would add an untrusted string for no gain.
  assert.equal("name" in (toolMessage as Record<string, unknown>), false);
});

test("`name` is accepted on other roles and still not forwarded", () => {
  const parsed = parseChatRequest({
    model: "gpt-4o",
    messages: [{ role: "user", name: "alice", content: "hello" }],
  });
  assert.deepEqual(parsed.messages, [{ role: "user", content: "hello" }]);
});

test("a message `name` is still bounded and type-checked", () => {
  // Accepting a key is not accepting anything in it. "We drop it" is no reason to skip
  // validation: the value is still parsed and held before it is discarded.
  for (const name of ["", "x".repeat(65), 42, null, {}, []]) {
    rejects(
      { model: "gpt-4o", messages: [{ role: "user", name, content: "hello" }] },
      `message name ${JSON.stringify(name)}`,
    );
  }
  const atLimit = parseChatRequest({
    model: "gpt-4o",
    messages: [{ role: "user", name: "n".repeat(64), content: "hello" }],
  });
  assert.deepEqual(atLimit.messages, [{ role: "user", content: "hello" }]);
});
