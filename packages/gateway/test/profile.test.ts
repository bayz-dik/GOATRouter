import assert from "node:assert/strict";
import test from "node:test";
import {
  CLIENT_CAPABILITIES,
  GatewayError,
  deriveProfile,
  type ClientProfile,
} from "../src/index.js";

const ALL_SCOPES = new Set([
  "chat.completions",
  "models.read",
  "usage.read",
]);

function profile(overrides: {
  path?: string;
  accept?: string | undefined;
  body?: unknown;
  grantedScopes?: ReadonlySet<string>;
}): ClientProfile {
  return deriveProfile({
    path: overrides.path ?? "/v1/chat/completions",
    accept: overrides.accept,
    // `in` rather than `??`: a caller passing `body: null` is testing the null
    // case, and `??` would silently substitute the default object instead.
    body: "body" in overrides ? overrides.body : { model: "m", messages: [] },
    grantedScopes: overrides.grantedScopes ?? ALL_SCOPES,
  });
}

test("the chat completions path derives the openai protocol", () => {
  const derived = profile({ path: "/v1/chat/completions" });
  assert.equal(derived.protocol, "openai");
  assert.ok(derived.capabilities.has("chat"));
});

test("a query string and a trailing slash do not defeat path matching", () => {
  assert.equal(profile({ path: "/v1/chat/completions/" }).protocol, "openai");
  assert.equal(profile({ path: "/v1/chat/completions?x=1" }).protocol, "openai");
});

test("the anthropic messages path derives the anthropic protocol", () => {
  const derived = profile({ path: "/v1/messages" });
  assert.equal(derived.protocol, "anthropic");
  assert.ok(derived.capabilities.has("chat"));
});

test("an unknown path derives no capabilities rather than defaulting to all", () => {
  // Defaulting to the full set would mean an unrecognized path silently gained
  // streaming and tools, which is exactly the kind of quiet over-permission this
  // package exists to prevent.
  const derived = profile({ path: "/v1/embeddings" });
  assert.equal(derived.capabilities.size, 0);
  assert.equal(derived.protocol, "openai");
});

test("stream true plus the event-stream accept header derives chat.stream", () => {
  const derived = profile({
    accept: "text/event-stream",
    body: { model: "m", messages: [], stream: true },
  });
  assert.ok(derived.capabilities.has("chat.stream"));
});

test("stream true alone derives chat.stream even without the accept header", () => {
  // Real clients are inconsistent about Accept. The body flag is the request's
  // actual intent, so requiring both would break a compliant client.
  const derived = profile({
    accept: undefined,
    body: { model: "m", messages: [], stream: true },
  });
  assert.ok(derived.capabilities.has("chat.stream"));
});

test("the accept header alone does not derive chat.stream", () => {
  // A client that advertises it can read SSE but did not ask for it must get a
  // buffered response, not a stream.
  const derived = profile({
    accept: "text/event-stream",
    body: { model: "m", messages: [] },
  });
  assert.equal(derived.capabilities.has("chat.stream"), false);
});

test("stream false and a non-boolean stream do not derive chat.stream", () => {
  for (const stream of [false, "true", 1, null, {}]) {
    const derived = profile({ body: { model: "m", messages: [], stream } });
    assert.equal(
      derived.capabilities.has("chat.stream"),
      false,
      `derived stream from ${JSON.stringify(stream)}`,
    );
  }
});

test("a tools array in the body derives tools", () => {
  const derived = profile({
    body: { model: "m", messages: [], tools: [{ type: "function" }] },
  });
  assert.ok(derived.capabilities.has("tools"));
});

test("an empty tools array does not derive tools", () => {
  const derived = profile({ body: { model: "m", messages: [], tools: [] } });
  assert.equal(derived.capabilities.has("tools"), false);
});

test("parallel tool calls derive tools.parallel only alongside tools", () => {
  const withBoth = profile({
    body: {
      model: "m",
      messages: [],
      tools: [{ type: "function" }],
      parallel_tool_calls: true,
    },
  });
  assert.ok(withBoth.capabilities.has("tools.parallel"));
  assert.ok(withBoth.capabilities.has("tools"));

  const withoutTools = profile({
    body: { model: "m", messages: [], parallel_tool_calls: true },
  });
  assert.equal(withoutTools.capabilities.has("tools.parallel"), false);
});

test("the models path derives models.list and nothing else", () => {
  const derived = profile({ path: "/v1/models", body: undefined });
  assert.deepEqual([...derived.capabilities], ["models.list"]);
});

test("a usage path derives usage.read only with the granting scope", () => {
  const granted = profile({
    path: "/api/usage/requests",
    body: undefined,
    grantedScopes: new Set(["usage.read"]),
  });
  assert.ok(granted.capabilities.has("usage.read"));

  const denied = profile({
    path: "/api/usage/requests",
    body: undefined,
    grantedScopes: new Set(["chat.completions"]),
  });
  assert.equal(denied.capabilities.has("usage.read"), false);
});

test("capability is the intersection of request intent and granted scope", () => {
  // This is the core rule. A request asking for streaming and tools with only a
  // models.read scope gets neither, because intent alone grants nothing.
  const derived = deriveProfile({
    path: "/v1/chat/completions",
    accept: "text/event-stream",
    body: {
      model: "m",
      messages: [],
      stream: true,
      tools: [{ type: "function" }],
      parallel_tool_calls: true,
    },
    grantedScopes: new Set(["models.read"]),
  });
  assert.equal(derived.capabilities.size, 0);
});

test("a chat.completions scope alone does not grant usage.read", () => {
  const derived = deriveProfile({
    path: "/api/usage/requests",
    accept: undefined,
    body: { period: "day" },
    grantedScopes: new Set(["chat.completions"]),
  });
  assert.equal(derived.capabilities.has("usage.read"), false);
});

test("admin satisfies every capability's underlying scope", () => {
  const derived = deriveProfile({
    path: "/v1/chat/completions",
    accept: undefined,
    body: { model: "m", messages: [], stream: true, tools: [{ type: "function" }] },
    grantedScopes: new Set(["admin"]),
  });
  assert.ok(derived.capabilities.has("chat"));
  assert.ok(derived.capabilities.has("chat.stream"));
  assert.ok(derived.capabilities.has("tools"));
});

test("cancel is always derived for a chat request", () => {
  // Every chat request can be aborted by disconnecting; the capability records
  // that BAYZ honours it rather than that the client opted in.
  assert.ok(profile({}).capabilities.has("cancel"));
});

test("a body that is not a plain object derives an empty capability set", () => {
  for (const body of ["string", 42, true, [], null, new Map()]) {
    const derived = profile({ body });
    assert.equal(
      derived.capabilities.size,
      0,
      `derived capabilities from ${JSON.stringify(body)}`,
    );
  }
});

test("a prototype-polluted body derives nothing", () => {
  const hostile = Object.create({ stream: true, tools: [{ type: "function" }] });
  const derived = profile({ body: hostile });
  assert.equal(derived.capabilities.size, 0);
});

test("deriveProfile is pure and returns frozen sets", () => {
  const input = {
    path: "/v1/chat/completions",
    accept: "text/event-stream",
    body: { model: "m", messages: [], stream: true },
    grantedScopes: ALL_SCOPES,
  };
  const first = deriveProfile(input);
  const second = deriveProfile(input);
  assert.deepEqual([...first.capabilities].sort(), [...second.capabilities].sort());
  assert.equal(first.protocol, second.protocol);
  assert.ok(Object.isFrozen(first));
  assert.throws(() => (first.capabilities as Set<never>).add("chat" as never));
  assert.throws(() => (first.quirks as Set<never>).add("x" as never));
});

test("a hostile 64 KiB accept header is bounded", () => {
  const derived = profile({ accept: "x".repeat(64 * 1024) });
  assert.equal(derived.capabilities.has("chat.stream"), false);
  assert.ok(derived.capabilities.has("chat"));
});

test("a body with ten thousand keys is refused, not iterated", () => {
  const body: Record<string, unknown> = { model: "m", messages: [] };
  for (let index = 0; index < 10000; index += 1) {
    body[`k${index}`] = index;
  }
  assert.throws(
    () => profile({ body }),
    (error: unknown) =>
      error instanceof GatewayError && error.code === "invalid_request",
  );
});

test("a hostile path is bounded", () => {
  assert.throws(
    () => profile({ path: `/v1/${"a".repeat(9000)}` }),
    (error: unknown) =>
      error instanceof GatewayError && error.code === "invalid_request",
  );
});

test("every derived capability is a member of the declared vocabulary", () => {
  const derived = deriveProfile({
    path: "/v1/chat/completions",
    accept: "text/event-stream",
    body: {
      model: "m",
      messages: [],
      stream: true,
      tools: [{ type: "function" }],
      parallel_tool_calls: true,
    },
    grantedScopes: new Set(["admin"]),
  });
  for (const capability of derived.capabilities) {
    assert.ok(
      (CLIENT_CAPABILITIES as readonly string[]).includes(capability),
      `${capability} is not in the vocabulary`,
    );
  }
});

test("an invalid granted scope set is refused", () => {
  assert.throws(
    () =>
      deriveProfile({
        path: "/v1/chat/completions",
        accept: undefined,
        body: { model: "m", messages: [] },
        grantedScopes: new Set(["not-a-scope"]),
      }),
    (error: unknown) =>
      error instanceof GatewayError && error.code === "invalid_profile",
  );
});

test("the max-tokens-string quirk is derived from an observed string value", () => {
  const derived = profile({
    body: { model: "m", messages: [], max_tokens: "512" },
  });
  assert.ok(derived.quirks.has("max-tokens-string"));

  const numeric = profile({ body: { model: "m", messages: [], max_tokens: 512 } });
  assert.equal(numeric.quirks.has("max-tokens-string"), false);
});
