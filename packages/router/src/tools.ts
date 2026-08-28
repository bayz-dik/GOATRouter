import { RouterError } from "./errors.js";

export const MAX_TOOLS = 64;
export const MAX_TOOL_CALLS = 8;
/** 32 KiB per argument or result blob. */
export const MAX_TOOL_ARGUMENT_BYTES = 32 * 1024;
export const MAX_TOOL_NAME_LENGTH = 64;
/**
 * 16 KiB of description text per tool.
 *
 * **Raised from 1024 in Phase 9H Task 4, because 1024 blocked every real agent
 * client.** The measured payload from `opencode` v1.18.23 carries ten tools whose
 * descriptions run to **4,628 characters** (`bash`), 3,019 (`task`), and 2,012
 * (`todowrite`) — see `docs/transcripts/opencode/`. Agent clients put their entire
 * usage contract in the description, so a 1 KiB cap is not a security boundary, it
 * is an incompatibility: no real coding agent could call a tool through BAYZ at
 * all, and the previous limit was set against hand-written examples rather than a
 * real client's payload.
 *
 * A description is inert text forwarded to the provider — never parsed, executed,
 * or used as a key. The bound that actually protects the process is the aggregate
 * one: `MAX_REQUEST_BYTES` (1 MiB) is checked last in
 * `packages/router/src/request.ts` on the *validated* request, so 64 tools at this
 * cap cannot get through even though 64 × 16 KiB exceeds it. Per-tool generosity
 * plus a hard aggregate ceiling is the combination that admits real clients
 * without admitting unbounded input.
 */
const MAX_TOOL_DESCRIPTION_LENGTH = 16 * 1024;
const MAX_TOOL_CALL_ID_LENGTH = 128;
/** How deep a JSON-Schema `parameters` blob may nest. */
const MAX_PARAMETERS_DEPTH = 16;

const TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const TOOL_CALL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Names beginning `__` are reserved.
 *
 * `TOOL_NAME_RE` permits a leading underscore, which means `__proto__`,
 * `__defineGetter__`, and friends would pass. Inside BAYZ that is harmless — a
 * name is only ever a *value* here and a `Map` key in the 9G registry, never an
 * object property. But BAYZ hands these names to clients it does not control, and
 * a client that builds `handlers[toolName]` would resolve `__proto__` through the
 * prototype chain. Refusing the prefix costs nothing and removes a hazard from
 * somebody else's code.
 */
const RESERVED_NAME_PREFIX = "__";

const TOOL_KEYS = new Set(["type", "function"]);
const TOOL_FUNCTION_KEYS = new Set(["name", "description", "parameters"]);
const TOOL_CALL_KEYS = new Set(["id", "type", "function", "index"]);
const TOOL_CALL_FUNCTION_KEYS = new Set(["name", "arguments"]);
const TOOL_MESSAGE_KEYS = new Set(["role", "tool_call_id", "content"]);

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
};

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export type ToolCall = {
  id: string;
  type: "function";
  /** `arguments` stays the opaque JSON string the OpenAI contract defines. */
  function: { name: string; arguments: string };
};

export type ToolMessage = {
  role: "tool";
  toolCallId: string;
  content: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  stage: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new RouterError("invalid_request", stage);
    }
  }
}

function assertToolName(value: unknown, stage: string): string {
  if (
    typeof value !== "string" ||
    !TOOL_NAME_RE.test(value) ||
    value.startsWith(RESERVED_NAME_PREFIX)
  ) {
    throw new RouterError("invalid_request", stage);
  }
  return value;
}

/**
 * Bound a JSON-Schema blob by size and depth.
 *
 * Depth matters separately from size: a small deeply-nested object is cheap to
 * send and expensive to walk, so a byte cap alone would not stop it.
 */
function assertBoundedJson(value: unknown, stage: string): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new RouterError("invalid_request", stage);
  }
  if (serialized === undefined) {
    throw new RouterError("invalid_request", stage);
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_TOOL_ARGUMENT_BYTES) {
    throw new RouterError("invalid_request", stage);
  }

  const walk = (node: unknown, depth: number): void => {
    if (depth > MAX_PARAMETERS_DEPTH) {
      throw new RouterError("invalid_request", stage);
    }
    if (Array.isArray(node)) {
      for (const entry of node) {
        walk(entry, depth + 1);
      }
      return;
    }
    if (typeof node === "object" && node !== null) {
      for (const entry of Object.values(node)) {
        walk(entry, depth + 1);
      }
    }
  };
  walk(value, 0);
}

/**
 * Validate the `tools` array a client sent.
 *
 * Every field is copied onto a fresh object, so nothing an upstream or a client
 * added rides along into the request BAYZ forwards. Unknown keys are refused rather
 * than dropped, matching the Phase 5 posture: a client that sent `strict: true` and
 * got a silent no-op would believe a constraint was being enforced.
 */
export function parseToolDefinitions(input: unknown): ToolDefinition[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_TOOLS) {
    throw new RouterError("invalid_request", "tools");
  }

  const seen = new Set<string>();
  return input.map((entry) => {
    if (!isPlainObject(entry)) {
      throw new RouterError("invalid_request", "tool-shape");
    }
    assertKnownKeys(entry, TOOL_KEYS, "tool-unknown-key");
    if (entry.type !== "function") {
      // `retrieval` and other provider-specific types are not implemented, and
      // forwarding one unvalidated would be a fabricated capability.
      throw new RouterError("invalid_request", "tool-type");
    }
    const fn = entry.function;
    if (!isPlainObject(fn)) {
      throw new RouterError("invalid_request", "tool-function-shape");
    }
    assertKnownKeys(fn, TOOL_FUNCTION_KEYS, "tool-function-unknown-key");

    const name = assertToolName(fn.name, "tool-name");
    if (seen.has(name)) {
      // Two tools with one name make the model's choice ambiguous, and whichever
      // the provider picks would be arbitrary.
      throw new RouterError("invalid_request", "tool-duplicate-name");
    }
    seen.add(name);

    const definition: ToolDefinition = { type: "function", function: { name } };

    if (fn.description !== undefined) {
      if (
        typeof fn.description !== "string" ||
        fn.description.length > MAX_TOOL_DESCRIPTION_LENGTH
      ) {
        throw new RouterError("invalid_request", "tool-description");
      }
      definition.function.description = fn.description;
    }
    if (fn.parameters !== undefined) {
      assertBoundedJson(fn.parameters, "tool-parameters");
      // A structured clone strips any inherited property and any `__proto__` key's
      // special meaning, so the forwarded schema is inert data.
      definition.function.parameters = structuredClone(fn.parameters);
    }
    return definition;
  });
}

export function parseToolChoice(input: unknown): ToolChoice {
  if (input === "auto" || input === "none" || input === "required") {
    return input;
  }
  if (!isPlainObject(input)) {
    throw new RouterError("invalid_request", "tool-choice");
  }
  assertKnownKeys(input, TOOL_KEYS, "tool-choice-unknown-key");
  if (input.type !== "function") {
    throw new RouterError("invalid_request", "tool-choice-type");
  }
  const fn = input.function;
  if (!isPlainObject(fn)) {
    throw new RouterError("invalid_request", "tool-choice-function");
  }
  assertKnownKeys(fn, new Set(["name"]), "tool-choice-function-unknown-key");
  return { type: "function", function: { name: assertToolName(fn.name, "tool-choice-name") } };
}

/**
 * Validate assistant tool calls.
 *
 * `arguments` is validated as JSON but returned as the original string. Two reasons:
 * the OpenAI contract defines it as a string, and re-serializing would change bytes
 * the model produced — a provider comparing them, or a client hashing them, would
 * see a mismatch BAYZ introduced.
 *
 * The value is parsed only to prove it is a JSON *object*. It is never evaluated:
 * `tools.test.ts` scans this file for `eval`, `new Function`, `require`, and dynamic
 * import to keep that structural rather than aspirational.
 */
export function parseToolCalls(input: unknown): ToolCall[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_TOOL_CALLS) {
    throw new RouterError("invalid_request", "tool-calls");
  }

  const seen = new Set<string>();
  return input.map((entry) => {
    if (!isPlainObject(entry)) {
      throw new RouterError("invalid_request", "tool-call-shape");
    }
    // `index` appears on streamed tool calls. It is accepted and then dropped,
    // because reassembly already happened before this point.
    assertKnownKeys(entry, TOOL_CALL_KEYS, "tool-call-unknown-key");
    if (entry.type !== "function") {
      throw new RouterError("invalid_request", "tool-call-type");
    }
    if (typeof entry.id !== "string" || !TOOL_CALL_ID_RE.test(entry.id)) {
      throw new RouterError("invalid_request", "tool-call-id");
    }
    if (entry.id.length > MAX_TOOL_CALL_ID_LENGTH) {
      throw new RouterError("invalid_request", "tool-call-id-length");
    }
    if (seen.has(entry.id)) {
      throw new RouterError("invalid_request", "tool-call-duplicate-id");
    }
    seen.add(entry.id);

    const fn = entry.function;
    if (!isPlainObject(fn)) {
      throw new RouterError("invalid_request", "tool-call-function-shape");
    }
    assertKnownKeys(fn, TOOL_CALL_FUNCTION_KEYS, "tool-call-function-unknown-key");
    const name = assertToolName(fn.name, "tool-call-name");

    const args = fn.arguments;
    if (typeof args !== "string" || args.length === 0) {
      throw new RouterError("invalid_request", "tool-call-arguments-type");
    }
    if (Buffer.byteLength(args, "utf8") > MAX_TOOL_ARGUMENT_BYTES) {
      throw new RouterError("invalid_request", "tool-call-arguments-bytes");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(args);
    } catch {
      throw new RouterError("invalid_request", "tool-call-arguments-json");
    }
    if (!isPlainObject(parsed)) {
      // A bare number, string, or array is not an argument set. Forwarding one
      // would push the type confusion into the tool handler.
      throw new RouterError("invalid_request", "tool-call-arguments-object");
    }

    return { id: entry.id, type: "function", function: { name, arguments: args } };
  });
}

/**
 * Validate a `role: "tool"` result message.
 *
 * `knownCallIds` is required rather than optional: a result whose id matches no
 * prior call is either a client bug or a model-driven attempt to inject a result
 * for a call that never happened, and accepting it would let untrusted output
 * fabricate tool output.
 */
export function parseToolMessage(
  input: unknown,
  knownCallIds: ReadonlySet<string>,
): ToolMessage {
  if (!isPlainObject(input)) {
    throw new RouterError("invalid_request", "tool-message-shape");
  }
  assertKnownKeys(input, TOOL_MESSAGE_KEYS, "tool-message-unknown-key");
  if (input.role !== "tool") {
    throw new RouterError("invalid_request", "tool-message-role");
  }
  const id = input.tool_call_id;
  if (typeof id !== "string" || !TOOL_CALL_ID_RE.test(id) || !knownCallIds.has(id)) {
    throw new RouterError("invalid_request", "tool-message-call-id");
  }
  const content = input.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new RouterError("invalid_request", "tool-message-content");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_TOOL_ARGUMENT_BYTES) {
    throw new RouterError("invalid_request", "tool-message-content-bytes");
  }
  return { role: "tool", toolCallId: id, content };
}
