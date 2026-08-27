import { RouterError } from "./errors.js";
import type { ChatUsage } from "./response.js";

/**
 * One streamed tool-call fragment.
 *
 * Providers stream tool-call arguments a few characters at a time, all sharing an
 * `index` that identifies which call in the response they belong to. The `index` is
 * therefore load-bearing: a parser that ignored it would produce one distinct call
 * per network chunk. `id` and `name` appear only on the first fragment of each call.
 *
 * Reassembly is deliberately *not* done here. This module parses one frame with no
 * memory of previous frames, which keeps it pure and testable; whoever consumes the
 * stream accumulates by index.
 */
export type ToolCallDelta = {
  index: number;
  id: string | undefined;
  name: string | undefined;
  argumentsDelta: string | undefined;
};

/** A single streamed increment of a completion. */
export type ChatChunk = {
  /** Text to append. Absent for a role-only or keepalive chunk. */
  contentDelta: string | undefined;
  finishReason: string | undefined;
  model: string | undefined;
  /** Only present when the upstream reported it, typically on the last chunk. */
  usage: ChatUsage | undefined;
  /** Absent rather than empty when a frame carries no tool-call fragment. */
  toolCallDeltas?: ToolCallDelta[];
};

/** Matches the request-path caps so a stream cannot exceed what a client may send. */
const MAX_STREAM_TOOL_CALLS = 8;
const MAX_STREAM_ARGUMENT_DELTA_BYTES = 32 * 1024;
const MAX_TOOL_CALL_INDEX = 63;
const STREAM_TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const STREAM_TOOL_CALL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Parse the `tool_calls` fragment array on one streamed delta.
 *
 * Every field is bounded and copied. The argument fragment is *not* JSON-validated
 * here because a fragment is legitimately incomplete JSON — validation happens once
 * the consumer has reassembled the whole string.
 */
function parseToolCallDeltas(value: unknown): ToolCallDelta[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RouterError("invalid_response", "chunk-tool-calls");
  }
  if (value.length > MAX_STREAM_TOOL_CALLS) {
    throw new RouterError("invalid_response", "chunk-tool-calls-count");
  }

  return value.map((entry) => {
    if (!isPlainObject(entry)) {
      throw new RouterError("invalid_response", "chunk-tool-call-shape");
    }
    const index = entry.index;
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index > MAX_TOOL_CALL_INDEX
    ) {
      throw new RouterError("invalid_response", "chunk-tool-call-index");
    }

    let id: string | undefined;
    if (entry.id !== undefined && entry.id !== null) {
      if (typeof entry.id !== "string" || !STREAM_TOOL_CALL_ID_RE.test(entry.id)) {
        throw new RouterError("invalid_response", "chunk-tool-call-id");
      }
      id = entry.id;
    }

    let name: string | undefined;
    let argumentsDelta: string | undefined;
    const fn = entry.function;
    if (fn !== undefined && fn !== null) {
      if (!isPlainObject(fn)) {
        throw new RouterError("invalid_response", "chunk-tool-call-function");
      }
      if (fn.name !== undefined && fn.name !== null) {
        if (
          typeof fn.name !== "string" ||
          !STREAM_TOOL_NAME_RE.test(fn.name) ||
          fn.name.startsWith("__")
        ) {
          throw new RouterError("invalid_response", "chunk-tool-call-name");
        }
        name = fn.name;
      }
      if (fn.arguments !== undefined && fn.arguments !== null) {
        if (typeof fn.arguments !== "string") {
          throw new RouterError("invalid_response", "chunk-tool-call-arguments");
        }
        if (
          Buffer.byteLength(fn.arguments, "utf8") > MAX_STREAM_ARGUMENT_DELTA_BYTES
        ) {
          throw new RouterError("response_too_large", "chunk-tool-call-arguments-bytes");
        }
        argumentsDelta = fn.arguments;
      }
    }

    return { index, id, name, argumentsDelta };
  });
}

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

  const toolCallDeltas =
    source !== undefined && source.tool_calls !== undefined
      ? parseToolCallDeltas(source.tool_calls)
      : undefined;

  return {
    contentDelta,
    finishReason: optionalLabel(first.finish_reason),
    model: optionalLabel(payload.model),
    usage,
    ...(toolCallDeltas === undefined ? {} : { toolCallDeltas }),
  };
}
