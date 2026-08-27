import assert from "node:assert/strict";
import test from "node:test";
import { deriveProfile, GatewayError, normalizeRequest, denormalizeResponse } from "../src/index.js";

const CHAT_SCOPES = new Set(["chat.completions", "models.read"]);

function chatProfile(body: unknown, accept?: string) {
  return deriveProfile({
    path: "/v1/chat/completions",
    accept,
    body,
    grantedScopes: CHAT_SCOPES,
  });
}

const MINIMAL = { model: "gpt-test", messages: [{ role: "user", content: "hi" }] };

test("a minimal OpenAI body normalizes to the router shape", () => {
  const normalized = normalizeRequest(chatProfile(MINIMAL), MINIMAL);
  assert.deepEqual(normalized, {
    model: "gpt-test",
    messages: [{ role: "user", content: "hi" }],
  });
});

test("snake_case sampling fields map to the router's camelCase names", () => {
  const body = {
    ...MINIMAL,
    temperature: 0.5,
    max_tokens: 256,
    top_p: 0.9,
    stop: ["\n\n"],
  };
  const normalized = normalizeRequest(chatProfile(body), body);
  assert.deepEqual(normalized, {
    model: "gpt-test",
    messages: [{ role: "user", content: "hi" }],
    temperature: 0.5,
    maxTokens: 256,
    topP: 0.9,
    stop: ["\n\n"],
  });
});

test("a bare string stop value becomes a single-element array", () => {
  // The OpenAI contract permits `stop` as a string; the router requires an array.
  // Normalizing here is the whole point of this layer — refusing would break a
  // compliant client for a purely internal reason.
  const body = { ...MINIMAL, stop: "END" };
  const normalized = normalizeRequest(chatProfile(body), body);
  assert.deepEqual(normalized.stop, ["END"]);
});

test("the stream flag is consumed by the profile and never reaches the router", () => {
  // Streaming is a transport decision the profile already captured. Leaving
  // `stream` in the normalized request would make the router reject it as an
  // unknown key, and passing it through would duplicate the decision in two
  // places that could disagree.
  const body = { ...MINIMAL, stream: true };
  const profile = chatProfile(body);
  assert.ok(profile.capabilities.has("chat.stream"));
  const normalized = normalizeRequest(profile, body);
  assert.equal("stream" in normalized, false);
});

test("stream false is likewise absent from the normalized request", () => {
  const body = { ...MINIMAL, stream: false };
  const normalized = normalizeRequest(chatProfile(body), body);
  assert.equal("stream" in normalized, false);
});

test("an unknown key is an error, not a silent drop", () => {
  // This preserves the Phase 5 posture. A client sending `provider: "x"` must be
  // told it was ignored, because silently dropping it means the client believes a
  // setting took effect that never did.
  for (const key of ["provider", "logit_bias", "user", "n", "seed", "frequency_penalty"]) {
    const body = { ...MINIMAL, [key]: 1 };
    assert.throws(
      () => normalizeRequest(chatProfile(body), body),
      (error: unknown) =>
        error instanceof GatewayError && error.code === "invalid_request",
      `accepted unknown key ${key}`,
    );
  }
});

test("a camelCase alias of a snake_case field is refused", () => {
  // Accepting both spellings would let a client send `max_tokens` and `maxTokens`
  // with different values and leave the winner to insertion order.
  for (const key of ["maxTokens", "topP"]) {
    const body = { ...MINIMAL, [key]: 8 };
    assert.throws(
      () => normalizeRequest(chatProfile(body), body),
      (error: unknown) =>
        error instanceof GatewayError && error.code === "invalid_request",
      `accepted alias ${key}`,
    );
  }
});

test("the max-tokens-string quirk converts a string max_tokens", () => {
  const body = { ...MINIMAL, max_tokens: "512" };
  const profile = chatProfile(body);
  assert.ok(profile.quirks.has("max-tokens-string"));
  const normalized = normalizeRequest(profile, body);
  assert.equal(normalized.maxTokens, 512);
});

test("a string max_tokens that is not an integer is refused, not coerced", () => {
  // `parseInt` would turn "512abc" into 512 and "1e9" into 1. Either would send
  // an upstream request the client never asked for.
  for (const value of ["512abc", "1e9", "0x10", " 512", "512 ", "", "-1", "1.5", "Infinity", "NaN"]) {
    const body = { ...MINIMAL, max_tokens: value };
    assert.throws(
      () => normalizeRequest(chatProfile(body), body),
      (error: unknown) =>
        error instanceof GatewayError && error.code === "invalid_request",
      `coerced max_tokens ${JSON.stringify(value)}`,
    );
  }
});

test("an undocumented quirk cannot be asked for", () => {
  // Quirks are derived from observed behaviour, never from a client's request. A
  // body claiming a quirk gets the unknown-key refusal like anything else.
  const body = { ...MINIMAL, quirks: ["invent-a-quirk"] };
  assert.throws(
    () => normalizeRequest(chatProfile(body), body),
    (error: unknown) => error instanceof GatewayError && error.code === "invalid_request",
  );
});

test("normalization refuses a request whose profile lacks the chat capability", () => {
  const profile = deriveProfile({
    path: "/v1/chat/completions",
    accept: undefined,
    body: MINIMAL,
    grantedScopes: new Set(["models.read"]),
  });
  assert.equal(profile.capabilities.has("chat"), false);
  assert.throws(
    () => normalizeRequest(profile, MINIMAL),
    (error: unknown) =>
      error instanceof GatewayError && error.code === "capability_unsupported",
  );
});

test("normalization returns a fresh deep copy", () => {
  const messages = [{ role: "user", content: "hi" }];
  const body = { model: "gpt-test", messages, stop: ["x"] };
  const normalized = normalizeRequest(chatProfile(body), body);
  (normalized.messages[0] as { content: string }).content = "mutated";
  (normalized.stop as string[]).push("y");
  assert.equal(messages[0]!.content, "hi");
  assert.deepEqual(body.stop, ["x"]);
});

test("a non-plain-object body is refused", () => {
  for (const body of [null, undefined, "s", 42, [], Object.create({ model: "m" })]) {
    assert.throws(
      () => normalizeRequest(chatProfile(MINIMAL), body),
      (error: unknown) =>
        error instanceof GatewayError && error.code === "invalid_request",
      `accepted body ${JSON.stringify(body)}`,
    );
  }
});

test("message shape is passed through for the router to validate", () => {
  // The gateway maps names; it does not duplicate the router's content rules.
  // Duplicated validation drifts, and the drift always favours the looser copy.
  const body = { model: "m", messages: [{ role: "tool", content: "x" }] };
  const normalized = normalizeRequest(chatProfile(body), body);
  assert.deepEqual(normalized.messages, [{ role: "tool", content: "x" }]);
});

test("denormalizeResponse produces exactly the Phase 6 OpenAI field set", () => {
  const body = denormalizeResponse(chatProfile(MINIMAL), {
    id: "chatcmpl-fixed",
    created: 1700000000,
    content: "hello",
    finishReason: "stop",
    model: "gpt-test",
    usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
  });
  assert.deepEqual(body, {
    id: "chatcmpl-fixed",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-test",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hello" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  });
});

test("absent model, finish reason, and usage denormalize as Phase 6 did", () => {
  const body = denormalizeResponse(chatProfile(MINIMAL), {
    id: "chatcmpl-fixed",
    created: 1700000000,
    content: "hello",
    finishReason: undefined,
    model: undefined,
    usage: undefined,
  });
  assert.equal(body.model, null);
  assert.equal(body.choices[0]!.finish_reason, null);
  assert.equal("usage" in body, false);
});

test("a present usage block with absent counts denormalizes to nulls, not zeros", () => {
  // Reporting 0 tokens where the provider reported nothing would be an invented
  // measurement, and usage figures feed billing conversations.
  const body = denormalizeResponse(chatProfile(MINIMAL), {
    id: "chatcmpl-fixed",
    created: 1700000000,
    content: "hello",
    finishReason: "stop",
    model: "m",
    usage: { promptTokens: undefined, completionTokens: undefined, totalTokens: undefined },
  });
  assert.deepEqual(body.usage, {
    prompt_tokens: null,
    completion_tokens: null,
    total_tokens: null,
  });
});

test("no product name appears in any normalization branch", () => {
  const source = `${normalizeRequest.toString()}${denormalizeResponse.toString()}`;

  // `continue` is a JavaScript keyword, so a bare substring scan for it would
  // flag every loop in the codebase. What actually matters is whether a product
  // name is *branched on*, which means appearing as a string literal or a
  // comparison operand. Quoted-form matching catches that and ignores the
  // keyword; the plain scan still applies to every name that is not a keyword.
  const quoted = /["'`]\s*(opencode|hermes|antigravity|cline|continue)\b/i;
  assert.equal(quoted.test(source), false, "a product name is used as a literal");

  for (const name of ["opencode", "hermes", "antigravity", "cline"]) {
    assert.ok(!source.includes(name), `normalization mentions ${name}`);
  }
});
