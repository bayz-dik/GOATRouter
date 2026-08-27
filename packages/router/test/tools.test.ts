import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  MAX_TOOLS,
  MAX_TOOL_ARGUMENT_BYTES,
  MAX_TOOL_CALLS,
  MAX_TOOL_NAME_LENGTH,
  RouterError,
  parseToolChoice,
  parseToolDefinitions,
  parseToolMessage,
  parseToolCalls,
} from "../src/index.js";

function tool(name: string, parameters: unknown = { type: "object" }) {
  return {
    type: "function",
    function: { name, description: `does ${name}`, parameters },
  };
}

test("a valid tool definition parses to a fresh normalized object", () => {
  const parsed = parseToolDefinitions([tool("get_weather")]);
  assert.deepEqual(parsed, [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "does get_weather",
        parameters: { type: "object" },
      },
    },
  ]);
});

test("description and parameters are optional", () => {
  const parsed = parseToolDefinitions([{ type: "function", function: { name: "ping" } }]);
  assert.deepEqual(parsed, [{ type: "function", function: { name: "ping" } }]);
});

test("only known keys survive parsing", () => {
  // A tool definition is forwarded to a provider. An unknown key would be either
  // silently dropped — leaving the client believing it took effect — or forwarded
  // unvalidated. Refusing is the only honest option.
  assert.throws(
    () =>
      parseToolDefinitions([
        { type: "function", function: { name: "ping" }, strict: true },
      ]),
    (error: unknown) => error instanceof RouterError && error.code === "invalid_request",
  );
  assert.throws(
    () =>
      parseToolDefinitions([
        { type: "function", function: { name: "ping", handler: "x" } },
      ]),
    (error: unknown) => error instanceof RouterError && error.code === "invalid_request",
  );
});

test("a tool name outside the safe alphabet is refused", () => {
  for (const name of [
    "",
    " ",
    "1leading_digit",
    "-leading_dash",
    "has space",
    "has.dot",
    "has/slash",
    "has:colon",
    "hasé",
    "__proto__",
    "__defineGetter__",
    "a".repeat(MAX_TOOL_NAME_LENGTH + 1),
  ]) {
    assert.throws(
      () => parseToolDefinitions([tool(name)]),
      (error: unknown) => error instanceof RouterError && error.code === "invalid_request",
      `accepted tool name ${JSON.stringify(name)}`,
    );
  }
});

test("a safe tool name is accepted at the boundary length", () => {
  const parsed = parseToolDefinitions([tool(`a${"b".repeat(MAX_TOOL_NAME_LENGTH - 1)}`)]);
  assert.equal(parsed[0]?.function.name.length, MAX_TOOL_NAME_LENGTH);
});

test("more than the tool cap is refused", () => {
  const many = Array.from({ length: MAX_TOOLS }, (_value, index) => tool(`t${index}`));
  assert.equal(parseToolDefinitions(many).length, MAX_TOOLS);
  assert.throws(
    () => parseToolDefinitions([...many, tool("one_too_many")]),
    (error: unknown) => error instanceof RouterError && error.code === "invalid_request",
  );
});

test("a duplicate tool name is refused", () => {
  // Two tools with one name make a model's choice ambiguous, and whichever the
  // provider picks would be arbitrary.
  assert.throws(
    () => parseToolDefinitions([tool("dup"), tool("dup")]),
    (error: unknown) => error instanceof RouterError && error.code === "invalid_request",
  );
});

test("an oversized parameters blob is refused", () => {
  const huge = { type: "object", description: "x".repeat(MAX_TOOL_ARGUMENT_BYTES + 100) };
  assert.throws(
    () => parseToolDefinitions([tool("big", huge)]),
    (error: unknown) => error instanceof RouterError && error.code === "invalid_request",
  );
});

test("a deeply nested parameters blob is refused rather than recursed", () => {
  let nested: Record<string, unknown> = { type: "object" };
  for (let depth = 0; depth < 200; depth += 1) {
    nested = { type: "object", properties: { inner: nested } };
  }
  assert.throws(
    () => parseToolDefinitions([tool("deep", nested)]),
    (error: unknown) => error instanceof RouterError && error.code === "invalid_request",
  );
});

test("a non-array or empty tools value is refused", () => {
  for (const value of [[], {}, "tools", 42, null]) {
    assert.throws(
      () => parseToolDefinitions(value),
      (error: unknown) => error instanceof RouterError && error.code === "invalid_request",
      `accepted ${JSON.stringify(value)}`,
    );
  }
});

test("a non-function tool type is refused", () => {
  assert.throws(
    () => parseToolDefinitions([{ type: "retrieval", function: { name: "x" } }]),
    (error: unknown) => error instanceof RouterError && error.code === "invalid_request",
  );
});

test("tool_choice accepts auto, none, required, and a named function", () => {
  assert.equal(parseToolChoice("auto"), "auto");
  assert.equal(parseToolChoice("none"), "none");
  assert.equal(parseToolChoice("required"), "required");
  assert.deepEqual(parseToolChoice({ type: "function", function: { name: "ping" } }), {
    type: "function",
    function: { name: "ping" },
  });
});

test("tool_choice refuses anything else", () => {
  for (const value of [
    "AUTO",
    "any",
    "",
    42,
    null,
    [],
    {},
    { type: "function" },
    { type: "function", function: {} },
    { type: "function", function: { name: "bad name" } },
    { type: "tool", function: { name: "ping" } },
    { type: "function", function: { name: "ping" }, extra: 1 },
  ]) {
    assert.throws(
      () => parseToolChoice(value),
      (error: unknown) => error instanceof RouterError && error.code === "invalid_request",
      `accepted tool_choice ${JSON.stringify(value)}`,
    );
  }
});

test("assistant tool calls parse with arguments kept as an opaque JSON string", () => {
  // Arguments stay a string on the wire, exactly as OpenAI defines them. They are
  // *validated* as JSON but never re-serialized, so a provider receives byte-for-byte
  // what the model produced and nothing is silently reformatted.
  const parsed = parseToolCalls([
    { id: "call_1", type: "function", function: { name: "ping", arguments: '{"a":1}' } },
  ]);
  assert.deepEqual(parsed, [
    { id: "call_1", type: "function", function: { name: "ping", arguments: '{"a":1}' } },
  ]);
});

test("an injected extra field on a tool call is discarded, not forwarded", () => {
  const parsed = parseToolCalls([
    {
      id: "call_1",
      type: "function",
      function: { name: "ping", arguments: "{}" },
      index: 0,
    },
  ]);
  assert.deepEqual(Object.keys(parsed[0]!), ["id", "type", "function"]);
  assert.deepEqual(Object.keys(parsed[0]!.function), ["name", "arguments"]);
});

test("tool call arguments must be a JSON object, never code or a bare value", () => {
  for (const args of [
    "not json",
    "42",
    '"a string"',
    "null",
    "true",
    "[1,2]",
    "() => {}",
    "process.exit(1)",
    "",
  ]) {
    assert.throws(
      () =>
        parseToolCalls([
          { id: "call_1", type: "function", function: { name: "ping", arguments: args } },
        ]),
      (error: unknown) => error instanceof RouterError && error.code === "invalid_request",
      `accepted arguments ${JSON.stringify(args)}`,
    );
  }
});

test("an oversized argument blob is refused", () => {
  const args = JSON.stringify({ payload: "x".repeat(MAX_TOOL_ARGUMENT_BYTES) });
  assert.throws(
    () =>
      parseToolCalls([
        { id: "call_1", type: "function", function: { name: "ping", arguments: args } },
      ]),
    (error: unknown) => error instanceof RouterError && error.code === "invalid_request",
  );
});

test("more than the tool-call cap in one assistant message is refused", () => {
  const calls = Array.from({ length: MAX_TOOL_CALLS }, (_value, index) => ({
    id: `call_${index}`,
    type: "function",
    function: { name: "ping", arguments: "{}" },
  }));
  assert.equal(parseToolCalls(calls).length, MAX_TOOL_CALLS);
  assert.throws(
    () =>
      parseToolCalls([
        ...calls,
        { id: "call_extra", type: "function", function: { name: "ping", arguments: "{}" } },
      ]),
    (error: unknown) => error instanceof RouterError && error.code === "invalid_request",
  );
});

test("a duplicate tool call id is refused", () => {
  assert.throws(
    () =>
      parseToolCalls([
        { id: "call_1", type: "function", function: { name: "a", arguments: "{}" } },
        { id: "call_1", type: "function", function: { name: "b", arguments: "{}" } },
      ]),
    (error: unknown) => error instanceof RouterError && error.code === "invalid_request",
  );
});

test("a tool call id outside the safe alphabet is refused", () => {
  for (const id of ["", "has space", "a".repeat(200), "../x", "id\nwith-newline"]) {
    assert.throws(
      () =>
        parseToolCalls([
          { id, type: "function", function: { name: "ping", arguments: "{}" } },
        ]),
      (error: unknown) => error instanceof RouterError && error.code === "invalid_request",
      `accepted call id ${JSON.stringify(id)}`,
    );
  }
});

test("a tool result message requires a tool_call_id matching a prior call", () => {
  const known = new Set(["call_1"]);
  assert.deepEqual(
    parseToolMessage({ role: "tool", tool_call_id: "call_1", content: "42" }, known),
    { role: "tool", toolCallId: "call_1", content: "42" },
  );
  assert.throws(
    () =>
      parseToolMessage({ role: "tool", tool_call_id: "call_missing", content: "42" }, known),
    (error: unknown) => error instanceof RouterError && error.code === "invalid_request",
  );
});

test("a tool result with no tool_call_id is refused", () => {
  assert.throws(
    () => parseToolMessage({ role: "tool", content: "42" }, new Set(["call_1"])),
    (error: unknown) => error instanceof RouterError && error.code === "invalid_request",
  );
});

test("an oversized tool result body is refused", () => {
  assert.throws(
    () =>
      parseToolMessage(
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "x".repeat(MAX_TOOL_ARGUMENT_BYTES + 1),
        },
        new Set(["call_1"]),
      ),
    (error: unknown) => error instanceof RouterError && error.code === "invalid_request",
  );
});

test("a tool result content must be a string", () => {
  // A tool result is data the *client* produced, so it is text by contract. An
  // object here would mean the client is asking BAYZ to serialize on its behalf and
  // guessing the encoding.
  for (const content of [42, null, {}, [], true, undefined]) {
    assert.throws(
      () =>
        parseToolMessage(
          { role: "tool", tool_call_id: "call_1", content },
          new Set(["call_1"]),
        ),
      (error: unknown) => error instanceof RouterError && error.code === "invalid_request",
      `accepted content ${JSON.stringify(content)}`,
    );
  }
});

test("the caps are the documented values", () => {
  assert.equal(MAX_TOOLS, 64);
  assert.equal(MAX_TOOL_CALLS, 8);
  assert.equal(MAX_TOOL_ARGUMENT_BYTES, 32 * 1024);
  assert.equal(MAX_TOOL_NAME_LENGTH, 64);
});

test("tool arguments are never evaluated", () => {
  // The structural guarantee behind 9G: a tool argument is *data*. There is no
  // code path in this module that could turn model output into an executed
  // expression, and the scan proves it against the source rather than the comment.
  const source = readFileSync(new URL("../src/tools.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  for (const forbidden of [
    /\beval\s*\(/,
    /new\s+Function\s*\(/,
    /\brequire\s*\(/,
    /\bimport\s*\(/,
    /setTimeout\s*\(\s*["'`]/,
    /child_process/,
    /node:fs/,
    /node:vm/,
  ]) {
    assert.ok(!forbidden.test(source), `tools.ts matches ${forbidden}`);
  }
});

test("prototype pollution through a tool definition does not reach Object.prototype", () => {
  const hostile = JSON.parse(
    '{"type":"function","function":{"name":"ping","parameters":{"__proto__":{"polluted":true}}}}',
  );
  parseToolDefinitions([hostile]);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("a tool definition with a replaced prototype is refused", () => {
  const hostile = Object.create({ type: "function", function: { name: "ping" } });
  assert.throws(
    () => parseToolDefinitions([hostile]),
    (error: unknown) => error instanceof RouterError && error.code === "invalid_request",
  );
});
