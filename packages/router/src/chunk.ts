import { RouterError } from "./errors.js";
import type { ChatUsage } from "./response.js";

/** A single streamed increment of a completion. */
export type ChatChunk = {
  /** Text to append. Absent for a role-only or keepalive chunk. */
  contentDelta: string | undefined;
  finishReason: string | undefined;
  model: string | undefined;
  /** Only present when the upstream reported it, typically on the last chunk. */
  usage: ChatUsage | undefined;
};

const MAX_LABEL_LENGTH = 128;
/** 512 KiB per delta. A single increment larger than this is not a token. */
const MAX_DELTA_BYTES = 512 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalLabel(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_LABEL_LENGTH
    ? value
    : undefined;
}

function optionalCount(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

/**
 * Token counts from a streamed usage block.
 *
 * Absent stays absent. Reporting 0 where the provider reported nothing would be an
 * invented measurement, and these numbers feed billing conversations.
 */
function parseStreamUsage(value: unknown): ChatUsage | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const usage: ChatUsage = {
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
}

/**
 * Normalize one already-JSON-parsed SSE payload into a chunk.
 *
 * Only known fields are copied onto a fresh object, matching
 * `parseChatResponse`: an upstream cannot inject extra properties into a BAYZ
 * chunk, and `__proto__` in the payload cannot reach the result.
 *
 * A missing `choices` array is tolerated when a `usage` block is present, because
 * several providers send a final usage-only frame. A frame with neither is
 * malformed.
 */
export function parseChatChunk(payload: unknown): ChatChunk {
  if (!isPlainObject(payload)) {
    throw new RouterError("invalid_response", "chunk-shape");
  }

  const usage = parseStreamUsage(payload.usage);
  const choices = payload.choices;

  if (!Array.isArray(choices) || choices.length === 0) {
    if (usage === undefined) {
      throw new RouterError("invalid_response", "chunk-choices");
    }
    return {
      contentDelta: undefined,
      finishReason: undefined,
      model: optionalLabel(payload.model),
      usage,
    };
  }

  const first = choices[0];
  if (!isPlainObject(first)) {
    throw new RouterError("invalid_response", "chunk-choice-shape");
  }

  // `delta` is the streaming shape; `message` appears when a provider sends a
  // whole choice in one frame. Accepting both costs nothing and avoids failing a
  // legitimate upstream over a formatting difference.
  const source = isPlainObject(first.delta)
    ? first.delta
    : isPlainObject(first.message)
      ? first.message
      : undefined;

  let contentDelta: string | undefined;
  if (source !== undefined && source.content !== undefined && source.content !== null) {
    if (typeof source.content !== "string") {
      throw new RouterError("invalid_response", "chunk-content-type");
    }
    if (Buffer.byteLength(source.content, "utf8") > MAX_DELTA_BYTES) {
      throw new RouterError("response_too_large", "chunk-content-bytes");
    }
    contentDelta = source.content;
  }

  return {
    contentDelta,
    finishReason: optionalLabel(first.finish_reason),
    model: optionalLabel(payload.model),
    usage,
  };
}
