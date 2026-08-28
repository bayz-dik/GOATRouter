import { RouterError } from "./errors.js";
import { assertModelId } from "./model.js";
import {
  MAX_TOOL_ARGUMENT_BYTES,
  parseToolCalls,
  parseToolChoice,
  parseToolDefinitions,
  parseToolMessage,
  type ToolCall,
  type ToolChoice,
  type ToolDefinition,
} from "./tools.js";

export const MAX_MESSAGES = 256;
export const MAX_CONTENT_CHARS = 128000;
export const MAX_TOKENS_MAX = 128000;
export const MAX_STOP_SEQUENCES = 4;
/** Matches the tool-name bound: a message `name` names a function. */
export const MAX_MESSAGE_NAME_LENGTH = 64;
export const MAX_STOP_LENGTH = 64;
/** Re-exported so a caller sees one number for every tool-shaped blob. */
export const MAX_TOOL_BLOB_BYTES = MAX_TOOL_ARGUMENT_BYTES;
/** 1 MiB. A larger body is a bug or an attack, not a prompt. */
export const MAX_REQUEST_BYTES = 1024 * 1024;

const ROLES = new Set(["system", "user", "assistant", "tool"]);
const ALLOWED_KEYS = new Set([
  "model",
  "messages",
  "temperature",
  "maxTokens",
  "topP",
  "stop",
  "tools",
  "toolChoice",
]);
/**
 * Keys a client may put on a chat message.
 *
 * **`name` was added in Phase 9H Task 5, because the real Hermes Agent client sends it on
 * every `role: "tool"` message** — `{role, tool_call_id, name, content}` — and without it
 * the whole request failed `invalid_request (message-unknown-key)`. A real tool roundtrip
 * was impossible for that client: BAYZ delivered the call, Hermes executed it, and the
 * result message was refused on the way back. See `docs/transcripts/hermes/`.
 *
 * `name` is part of the OpenAI chat contract (the function whose result this message
 * carries, and historically the author name on other roles). It is validated below rather
 * than merely tolerated, and it is **not forwarded**: `tool_call_id` already identifies the
 * call unambiguously, so echoing a client-supplied name upstream would add an untrusted
 * string to the provider request for no gain. Accepting-and-ignoring is safe here in a way
 * it is not for a *setting* — no behaviour is being silently declined, because the field
 * carries no instruction.
 */
const ALLOWED_MESSAGE_KEYS = new Set([
  "role",
  "content",
  "tool_calls",
  "tool_call_id",
  "name",
]);

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ChatMessage = {
  role: ChatRole;
  /**
   * Absent only on an assistant message that is purely tool calls.
   *
   * A provider legitimately returns `content: null` with `tool_calls` populated,
   * and a client echoes that message back on the next turn. Requiring content
   * would make a tool roundtrip impossible.
   */
  content?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
};

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseFiniteRange(
  value: unknown,
  min: number,
  max: number,
  stage: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    throw new RouterError("invalid_request", stage);
  }
  return value;
}

function parseIntegerRange(
  value: unknown,
  min: number,
  max: number,
  stage: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new RouterError("invalid_request", stage);
  }
  return value;
}

/**
 * Validate the message array, threading tool-call ids forward.
 *
 * Order matters: a `role: "tool"` result is only valid if an *earlier* assistant
 * message declared that call id. Walking forward and accumulating known ids is what
 * makes a fabricated result — one for a call that never happened — impossible to
 * smuggle in, whether it came from a buggy client or from model output a client
 * echoed back without checking.
 */
function parseMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MESSAGES) {
    throw new RouterError("invalid_request", "messages");
  }

  const knownCallIds = new Set<string>();
  return value.map((entry) => {
    if (!isPlainObject(entry)) {
      throw new RouterError("invalid_request", "message-shape");
    }
    for (const key of Object.keys(entry)) {
      if (!ALLOWED_MESSAGE_KEYS.has(key)) {
        // Rejecting extras keeps multimodal payloads out until they are actually
        // implemented and verified.
        throw new RouterError("invalid_request", "message-unknown-key");
      }
    }
    const role = entry.role;
    if (typeof role !== "string" || !ROLES.has(role)) {
      throw new RouterError("invalid_request", "message-role");
    }

    /*
     * `name` is validated even though it is dropped rather than forwarded. Accepting a
     * key without bounding it would let a client push an unbounded string through the
     * message loop, and "we ignore it" is not a reason to skip validation — the value
     * still has to be parsed and held before it is discarded.
     */
    if (entry.name !== undefined) {
      if (
        typeof entry.name !== "string" ||
        entry.name.length === 0 ||
        entry.name.length > MAX_MESSAGE_NAME_LENGTH
      ) {
        throw new RouterError("invalid_request", "message-name");
      }
    }

    if (role === "tool") {
      const parsed = parseToolMessage(
        {
          role: "tool",
          tool_call_id: entry.tool_call_id,
          content: entry.content,
        },
        knownCallIds,
      );
      return {
        role: "tool" as ChatRole,
        content: parsed.content,
        toolCallId: parsed.toolCallId,
      };
    }

    const toolCalls =
      entry.tool_calls === undefined ? undefined : parseToolCalls(entry.tool_calls);
    if (toolCalls !== undefined) {
      if (role !== "assistant") {
        // Only an assistant makes tool calls. A user message carrying them would be
        // an attempt to inject a call BAYZ never received from a model.
        throw new RouterError("invalid_request", "message-tool-calls-role");
      }
      for (const call of toolCalls) {
        knownCallIds.add(call.id);
      }
    }

    const content = entry.content;
    // An assistant message that is purely tool calls legitimately has no content.
    const contentOptional = role === "assistant" && toolCalls !== undefined;
    if (content === undefined || content === null) {
      if (!contentOptional) {
        throw new RouterError("invalid_request", "message-content");
      }
      return { role: role as ChatRole, ...(toolCalls === undefined ? {} : { toolCalls }) };
    }
    if (
      typeof content !== "string" ||
      (content.length === 0 && !contentOptional) ||
      content.length > MAX_CONTENT_CHARS
    ) {
      throw new RouterError("invalid_request", "message-content");
    }
    return {
      role: role as ChatRole,
      content,
      ...(toolCalls === undefined ? {} : { toolCalls }),
    };
  });
}

function parseStop(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_STOP_SEQUENCES
  ) {
    throw new RouterError("invalid_request", "stop");
  }
  return value.map((entry) => {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > MAX_STOP_LENGTH
    ) {
      throw new RouterError("invalid_request", "stop-entry");
    }
    return entry;
  });
}

/**
 * Validate an incoming chat request.
 *
 * Unknown keys are rejected rather than dropped. That is what prevents a caller
 * from smuggling `stream: true`, a tool definition, a header bag, or a provider
 * override into a request the router has not verified — anything unrecognized is
 * a loud failure instead of a silent no-op with surprising upstream behaviour.
 *
 * The returned object is a fresh deep copy, so a caller cannot mutate the request
 * after validation and have the transport send something that was never checked.
 */
export function parseChatRequest(input: unknown): ChatRequest {
  if (!isPlainObject(input)) {
    throw new RouterError("invalid_request", "request-shape");
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new RouterError("invalid_request", "request-unknown-key");
    }
  }

  let model: string;
  try {
    model = assertModelId(input.model);
  } catch {
    throw new RouterError("invalid_request", "request-model");
  }
  // A wildcard belongs to a route pattern; a request must name one model.
  if (model.includes("*")) {
    throw new RouterError("invalid_request", "request-model-wildcard");
  }

  const request: ChatRequest = {
    model,
    messages: parseMessages(input.messages),
  };

  if (input.temperature !== undefined) {
    request.temperature = parseFiniteRange(input.temperature, 0, 2, "temperature");
  }
  if (input.maxTokens !== undefined) {
    request.maxTokens = parseIntegerRange(
      input.maxTokens,
      1,
      MAX_TOKENS_MAX,
      "max-tokens",
    );
  }
  if (input.topP !== undefined) {
    request.topP = parseFiniteRange(input.topP, 0, 1, "top-p");
  }
  if (input.stop !== undefined) {
    request.stop = parseStop(input.stop);
  }
  if (input.tools !== undefined) {
    request.tools = parseToolDefinitions(input.tools);
  }
  if (input.toolChoice !== undefined) {
    if (request.tools === undefined) {
      // Naming a tool that was never declared cannot be honoured, and silently
      // dropping the choice would leave the caller believing it was applied.
      throw new RouterError("invalid_request", "tool-choice-without-tools");
    }
    const choice = parseToolChoice(input.toolChoice);
    if (typeof choice === "object") {
      const declared = request.tools.some(
        (tool) => tool.function.name === choice.function.name,
      );
      if (!declared) {
        throw new RouterError("invalid_request", "tool-choice-unknown-tool");
      }
    }
    request.toolChoice = choice;
  }

  // Checked last, on the validated copy, so the cap reflects what will actually
  // be sent rather than whatever the caller happened to pass.
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > MAX_REQUEST_BYTES) {
    throw new RouterError("invalid_request", "request-too-large");
  }

  return request;
}
