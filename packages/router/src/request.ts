import { RouterError } from "./errors.js";
import { assertModelId } from "./model.js";

export const MAX_MESSAGES = 256;
export const MAX_CONTENT_CHARS = 128000;
export const MAX_TOKENS_MAX = 128000;
export const MAX_STOP_SEQUENCES = 4;
export const MAX_STOP_LENGTH = 64;
/** 1 MiB. A larger body is a bug or an attack, not a prompt. */
export const MAX_REQUEST_BYTES = 1024 * 1024;

const ROLES = new Set(["system", "user", "assistant"]);
const ALLOWED_KEYS = new Set([
  "model",
  "messages",
  "temperature",
  "maxTokens",
  "topP",
  "stop",
]);
const ALLOWED_MESSAGE_KEYS = new Set(["role", "content"]);

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
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

function parseMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MESSAGES) {
    throw new RouterError("invalid_request", "messages");
  }
  return value.map((entry) => {
    if (!isPlainObject(entry)) {
      throw new RouterError("invalid_request", "message-shape");
    }
    for (const key of Object.keys(entry)) {
      if (!ALLOWED_MESSAGE_KEYS.has(key)) {
        // Rejecting extras keeps tool-call and multimodal payloads out until
        // they are actually implemented and verified.
        throw new RouterError("invalid_request", "message-unknown-key");
      }
    }
    const role = entry.role;
    if (typeof role !== "string" || !ROLES.has(role)) {
      throw new RouterError("invalid_request", "message-role");
    }
    const content = entry.content;
    if (
      typeof content !== "string" ||
      content.length === 0 ||
      content.length > MAX_CONTENT_CHARS
    ) {
      throw new RouterError("invalid_request", "message-content");
    }
    return { role: role as ChatRole, content };
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

  // Checked last, on the validated copy, so the cap reflects what will actually
  // be sent rather than whatever the caller happened to pass.
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > MAX_REQUEST_BYTES) {
    throw new RouterError("invalid_request", "request-too-large");
  }

  return request;
}
