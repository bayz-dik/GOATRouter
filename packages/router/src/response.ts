import { RouterError } from "./errors.js";

/** 512 KiB of completion text. Beyond this a response is hostile, not verbose. */
export const MAX_CONTENT_BYTES = 512 * 1024;
const MAX_LABEL_LENGTH = 128;

export type ChatUsage = {
  promptTokens: number | undefined;
  completionTokens: number | undefined;
  totalTokens: number | undefined;
};

export type ChatResponse = {
  content: string;
  finishReason: string | undefined;
  model: string | undefined;
  usage: ChatUsage | undefined;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A short, non-secret label echoed back to the caller, or nothing. */
function optionalLabel(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_LABEL_LENGTH
    ? value
    : undefined;
}

function optionalCount(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    // Signals the whole usage block is untrustworthy.
    throw new RouterError("invalid_response", "usage-field");
  }
  return value;
}

/**
 * Token counts are informational, so a malformed block is dropped rather than
 * failing a response whose content is fine. Content is not informational, so it
 * is never degraded — a bad content field is a hard failure.
 */
function parseUsage(value: unknown): ChatUsage | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    return undefined;
  }
  try {
    const usage = {
      promptTokens: optionalCount(value.prompt_tokens),
      completionTokens: optionalCount(value.completion_tokens),
      totalTokens: optionalCount(value.total_tokens),
    };
    if (
      usage.promptTokens === undefined &&
      usage.completionTokens === undefined &&
      usage.totalTokens === undefined
    ) {
      return undefined;
    }
    return usage;
  } catch {
    return undefined;
  }
}

/**
 * Normalize an upstream chat completion.
 *
 * Only known fields are copied onto a fresh object, so an upstream cannot inject
 * additional properties into a Bayz response, and `__proto__` in the payload
 * cannot reach the returned object or `Object.prototype`.
 */
export function parseChatResponse(body: unknown): ChatResponse {
  if (!isPlainObject(body)) {
    throw new RouterError("invalid_response", "response-shape");
  }

  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new RouterError("invalid_response", "choices");
  }
  const first = choices[0];
  if (!isPlainObject(first)) {
    throw new RouterError("invalid_response", "choice-shape");
  }
  const message = first.message;
  if (!isPlainObject(message)) {
    throw new RouterError("invalid_response", "message-shape");
  }
  const content = message.content;
  if (typeof content !== "string") {
    // Never substituted with "" — a caller must not mistake a broken response
    // for an empty completion.
    throw new RouterError("invalid_response", "content");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
    throw new RouterError("response_too_large", "content-bytes");
  }

  return {
    content,
    finishReason: optionalLabel(first.finish_reason),
    model: optionalLabel(body.model),
    usage: parseUsage(body.usage),
  };
}
