import { GatewayError } from "./errors.js";
import type { ClientProfile } from "./profile.js";

/**
 * The shape `packages/router/src/request.ts` accepts.
 *
 * Deliberately structural rather than imported: the gateway must not depend on
 * `@bayz/router`, because the router depends on the gateway in the server's wiring
 * and a cycle would make the build order undefined. The `normalize.test.ts` cases
 * pin the field names against the router's actual allow-list.
 */
export type NormalizedChatRequest = {
  model: unknown;
  messages: unknown[];
  temperature?: unknown;
  maxTokens?: unknown;
  topP?: unknown;
  stop?: unknown[];
  tools?: unknown;
  toolChoice?: unknown;
};

export type ChatResultForClient = {
  id: string;
  created: number;
  content: string;
  finishReason: string | undefined;
  model: string | undefined;
  toolCalls?: unknown;
  usage:
    | {
        promptTokens: number | undefined;
        completionTokens: number | undefined;
        totalTokens: number | undefined;
      }
    | undefined;
};

/**
 * Every key the OpenAI chat-completions wire format may carry, mapped to the
 * router's name for it.
 *
 * `stream` maps to nothing: the profile already captured that decision, and
 * carrying it forward would put the same choice in two places that could
 * disagree. Anything not in this table is refused rather than dropped — the Phase
 * 5 posture — because a client that sent `provider: "x"` and got a silent no-op
 * would believe a setting took effect that never did.
 */
const FIELD_MAP = new Map<string, keyof NormalizedChatRequest | null>([
  ["model", "model"],
  ["messages", "messages"],
  ["temperature", "temperature"],
  ["max_tokens", "maxTokens"],
  ["top_p", "topP"],
  ["stop", "stop"],
  ["tools", "tools"],
  ["tool_choice", "toolChoice"],
  ["stream", null],
  // Consumed by the profile, which already recorded whether parallel calls were
  // requested. Forwarding it would duplicate one decision in two places.
  ["parallel_tool_calls", null],
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * A strictly integral decimal string, or nothing.
 *
 * `parseInt` would turn `"512abc"` into 512 and `"1e9"` into 1, sending an
 * upstream request the client never asked for. Coercion is only safe when the
 * whole string is the number.
 */
function strictInteger(value: string): number | undefined {
  if (!/^[0-9]{1,9}$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Map an OpenAI-shaped body onto the router's request shape.
 *
 * This layer maps names and applies declared quirks. It deliberately does **not**
 * re-validate message roles, content lengths, or numeric ranges: the router
 * already owns those rules, and a duplicated copy would drift — with the drift
 * always favouring whichever copy is looser.
 */
export function normalizeRequest(
  profile: ClientProfile,
  body: unknown,
): NormalizedChatRequest {
  if (!profile.capabilities.has("chat")) {
    throw new GatewayError("capability_unsupported", "chat");
  }
  if (!isPlainObject(body)) {
    throw new GatewayError("invalid_request", "body-shape");
  }

  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(body)) {
    const target = FIELD_MAP.get(key);
    if (target === undefined) {
      throw new GatewayError("invalid_request", "unknown-key");
    }
    if (target === null) {
      continue;
    }
    if (value === undefined) {
      continue;
    }

    if (target === "maxTokens" && typeof value === "string") {
      // The one declared quirk. It applies only because the profile observed the
      // string, so a client sending a number is unaffected.
      if (!profile.quirks.has("max-tokens-string")) {
        throw new GatewayError("invalid_request", "max-tokens-type");
      }
      const parsed = strictInteger(value);
      if (parsed === undefined) {
        throw new GatewayError("invalid_request", "max-tokens-string");
      }
      normalized.maxTokens = parsed;
      continue;
    }

    if (target === "stop" && typeof value === "string") {
      // The OpenAI contract permits a bare string. Refusing would break a
      // compliant client for a purely internal reason.
      normalized.stop = [value];
      continue;
    }

    normalized[target] = value;
  }

  // A fresh deep copy, so a caller cannot mutate the request after validation and
  // have the transport send something that was never checked.
  return structuredClone(normalized) as NormalizedChatRequest;
}

/**
 * Render a router result as the client's protocol expects.
 *
 * The OpenAI field set here is byte-identical to what Phase 6's chat route
 * emitted, which `normalize.test.ts` and `apps/server/test/gateway.test.ts` both
 * pin. Absent counts render as `null` rather than `0`: reporting zero tokens where
 * the provider reported nothing would be an invented measurement, and usage
 * figures feed billing conversations.
 */
export function denormalizeResponse(
  profile: ClientProfile,
  result: ChatResultForClient,
): {
  id: string;
  object: string;
  created: number;
  model: string | null;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: unknown;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number | null;
    completion_tokens: number | null;
    total_tokens: number | null;
  };
} {
  if (profile.protocol !== "openai") {
    // Anthropic response rendering is not implemented. Emitting an OpenAI body to
    // an Anthropic client would be a fabricated compatibility claim.
    throw new GatewayError("capability_unsupported", "protocol");
  }

  return {
    id: result.id,
    object: "chat.completion",
    created: result.created,
    model: result.model ?? null,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          // `null` when the assistant only called tools, matching the OpenAI wire
          // format. An empty string would make a client render a blank reply.
          content:
            result.toolCalls !== undefined && result.content.length === 0
              ? null
              : result.content,
          ...(result.toolCalls === undefined ? {} : { tool_calls: result.toolCalls }),
        },
        finish_reason: result.finishReason ?? null,
      },
    ],
    ...(result.usage === undefined
      ? {}
      : {
          usage: {
            prompt_tokens: result.usage.promptTokens ?? null,
            completion_tokens: result.usage.completionTokens ?? null,
            total_tokens: result.usage.totalTokens ?? null,
          },
        }),
  };
}
