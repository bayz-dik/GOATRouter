import assert from "node:assert/strict";
import test from "node:test";
import { RouterError, parseChatResponse } from "../src/index.js";

function rejects(body: unknown, code = "invalid_response", label = ""): void {
  assert.throws(
    () => parseChatResponse(body),
    (error: unknown) => error instanceof RouterError && error.code === code,
    `response must be rejected: ${label || JSON.stringify(body)?.slice(0, 80)}`,
  );
}

const VALID = {
  id: "chatcmpl-123",
  model: "gpt-4o-2024-08-06",
  choices: [
    { index: 0, message: { role: "assistant", content: "Hello there." }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
};

test("a well-formed response is normalized", () => {
  const parsed = parseChatResponse(VALID);
  assert.equal(parsed.content, "Hello there.");
  assert.equal(parsed.finishReason, "stop");
  assert.equal(parsed.model, "gpt-4o-2024-08-06");
  assert.deepEqual(parsed.usage, {
    promptTokens: 10,
    completionTokens: 4,
    totalTokens: 14,
  });
});

test("only known fields survive; upstream extras are discarded", () => {
  const parsed = parseChatResponse({
    ...VALID,
    injected: "attacker-controlled",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hi", injected: "x" },
        finish_reason: "stop",
        injected: "y",
      },
    ],
  });
  assert.deepEqual(Object.keys(parsed).sort(), [
    "content",
    "finishReason",
    "model",
    "usage",
  ]);
  const serialized = JSON.stringify(parsed);
  assert.equal(serialized.includes("injected"), false);
  assert.equal(serialized.includes("attacker-controlled"), false);
});

test("a missing or malformed content field fails closed", () => {
  rejects({ ...VALID, choices: [] }, "invalid_response", "no choices");
  rejects({ ...VALID, choices: {} });
  rejects({ ...VALID, choices: undefined });
  rejects({ ...VALID, choices: [null] });
  rejects({ ...VALID, choices: ["text"] });
  rejects({ ...VALID, choices: [{ index: 0 }] }, "invalid_response", "no message");
  rejects({ ...VALID, choices: [{ message: {} }] });
  rejects({ ...VALID, choices: [{ message: { content: null } }] });
  rejects({ ...VALID, choices: [{ message: { content: 42 } }] });
  rejects({ ...VALID, choices: [{ message: { content: [] } }] });
  rejects({ ...VALID, choices: [{ message: { content: { text: "hi" } } }] });
});

test("an empty completion is preserved rather than treated as a failure", () => {
  // A model legitimately returning "" is different from a broken response.
  const parsed = parseChatResponse({
    choices: [{ message: { role: "assistant", content: "" } }],
  });
  assert.equal(parsed.content, "");
});

test("only the first choice is used", () => {
  const parsed = parseChatResponse({
    choices: [
      { message: { content: "first" } },
      { message: { content: "second" } },
    ],
  });
  assert.equal(parsed.content, "first");
});

test("a completion beyond the byte cap is refused", () => {
  rejects(
    { choices: [{ message: { content: "x".repeat(512 * 1024 + 1) } }] },
    "response_too_large",
    "content over cap",
  );
  // Exactly at the cap is fine.
  const parsed = parseChatResponse({
    choices: [{ message: { content: "x".repeat(512 * 1024) } }],
  });
  assert.equal(parsed.content.length, 512 * 1024);
});

test("a malformed usage block degrades to undefined without failing the response", () => {
  for (const usage of [
    { prompt_tokens: -1 },
    { prompt_tokens: 1.5 },
    { prompt_tokens: "10" },
    { completion_tokens: Number.NaN },
    { total_tokens: Number.POSITIVE_INFINITY },
    "usage",
    42,
    [],
  ]) {
    const parsed = parseChatResponse({ ...VALID, usage });
    assert.equal(
      parsed.usage,
      undefined,
      `usage must degrade, not fail: ${JSON.stringify(usage)}`,
    );
    // The content is what matters and must still come through.
    assert.equal(parsed.content, "Hello there.");
  }
});

test("a partial usage block keeps the fields that are valid", () => {
  const parsed = parseChatResponse({
    ...VALID,
    usage: { prompt_tokens: 7, completion_tokens: 0 },
  });
  assert.deepEqual(parsed.usage, {
    promptTokens: 7,
    completionTokens: 0,
    totalTokens: undefined,
  });
});

test("an absent usage block is undefined, not an error", () => {
  const parsed = parseChatResponse({
    choices: [{ message: { content: "hi" } }],
  });
  assert.equal(parsed.usage, undefined);
});

test("a non-string model or finish_reason degrades to undefined", () => {
  const parsed = parseChatResponse({
    ...VALID,
    model: 42,
    choices: [{ message: { content: "hi" }, finish_reason: {} }],
  });
  assert.equal(parsed.model, undefined);
  assert.equal(parsed.finishReason, undefined);
  assert.equal(parsed.content, "hi");
});

test("an over-long model or finish_reason is dropped rather than echoed", () => {
  const parsed = parseChatResponse({
    ...VALID,
    model: "m".repeat(500),
    choices: [{ message: { content: "hi" }, finish_reason: "f".repeat(500) }],
  });
  assert.equal(parsed.model, undefined);
  assert.equal(parsed.finishReason, undefined);
});

test("non-object bodies are rejected", () => {
  rejects(null);
  rejects(undefined);
  rejects("Hello there.");
  rejects(42);
  rejects([]);
  rejects(true);
});

test("a prototype-polluting payload cannot reach the returned object", () => {
  const parsed = parseChatResponse(
    JSON.parse('{"choices":[{"message":{"content":"hi","__proto__":{"polluted":true}}}]}'),
  );
  assert.equal(parsed.content, "hi");
  assert.equal(
    (parsed as unknown as Record<string, unknown>).polluted,
    undefined,
  );
  assert.equal(
    ({} as unknown as Record<string, unknown>).polluted,
    undefined,
    "Object.prototype must be untouched",
  );
});

test("deeply nested junk around a valid choice does not break parsing", () => {
  let nested: unknown = { deep: true };
  for (let depth = 0; depth < 500; depth += 1) {
    nested = { nested };
  }
  const parsed = parseChatResponse({
    choices: [{ message: { content: "hi" } }],
    junk: nested,
  });
  assert.equal(parsed.content, "hi");
});
