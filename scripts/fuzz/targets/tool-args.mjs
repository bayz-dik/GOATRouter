/**
 * Fuzz target: tool definitions, tool calls, tool choice, and tool result messages — 9I Task 3.
 *
 * The tool surface is the one place where *model output* becomes an argument to something
 * that runs, which is why 9G exists. A `TypeError` escaping here would mean hostile
 * model-authored JSON reached the dispatcher without being validated.
 */

import { generateIdentifier, generateJsonValue, generateUtf8String } from "../generators.mjs";
import { assertGlobalStateUnchanged, globalStateSnapshot, rejectOrAccept } from "./shared.mjs";

const { parseToolCalls, parseToolChoice, parseToolDefinitions, parseToolMessage } = await import(
  "../../../packages/router/src/tools.ts"
);

const CODES = new Set(["invalid_request"]);

function toolDefinition(rng) {
  return {
    type: rng.int(0, 6) === 0 ? generateIdentifier(rng) : "function",
    function: {
      name: rng.int(0, 3) === 0 ? generateIdentifier(rng) : `tool_${rng.int(0, 99)}`,
      description: rng.int(0, 4) === 0 ? generateUtf8String(rng) : "does a thing",
      parameters: rng.int(0, 3) === 0 ? generateJsonValue(rng) : { type: "object", properties: {} },
    },
  };
}

function toolCall(rng, id) {
  return {
    id,
    type: rng.int(0, 6) === 0 ? generateIdentifier(rng) : "function",
    function: {
      name: rng.int(0, 3) === 0 ? generateIdentifier(rng) : "run",
      // Arguments are a *string* of JSON on the wire, so both malformed JSON and
      // well-formed-but-hostile JSON have to be covered.
      arguments: rng.int(0, 2) === 0 ? JSON.stringify(generateJsonValue(rng)) : generateUtf8String(rng),
    },
  };
}

function generate(rng) {
  const kind = rng.int(0, 5);
  const callId = rng.int(0, 3) === 0 ? generateIdentifier(rng) : `call_${rng.int(0, 999)}`;

  switch (kind) {
    case 0:
      return { kind: "definitions", value: Array.from({ length: rng.pick([0, 1, 2, 64, 65]) }, () => toolDefinition(rng)) };
    case 1:
      return { kind: "definitions", value: generateJsonValue(rng) };
    case 2:
      return { kind: "choice", value: rng.pick(["auto", "none", "required", "AUTO", "", generateJsonValue(rng), { type: "function", function: { name: generateIdentifier(rng) } }]) };
    case 3:
      return { kind: "calls", value: Array.from({ length: rng.pick([0, 1, 8, 9]) }, () => toolCall(rng, callId)) };
    case 4:
      return { kind: "calls", value: generateJsonValue(rng) };
    default: {
      /*
       * A tool *result* is validated against the ids of calls actually made, because a result
       * for a call that never happened is how untrusted output fabricates tool output. Both
       * the matching and non-matching cases are generated.
       */
      const known = rng.bool() ? [callId] : [`call_${rng.int(1000, 1999)}`];
      const message = {
        role: rng.int(0, 6) === 0 ? generateIdentifier(rng) : "tool",
        tool_call_id: callId,
        content: rng.int(0, 3) === 0 ? generateJsonValue(rng) : "result text",
      };
      if (rng.int(0, 4) === 0) message.name = rng.int(0, 2) === 0 ? generateIdentifier(rng) : "run";
      if (rng.int(0, 6) === 0) message[generateIdentifier(rng)] = 1;
      return { kind: "message", value: message, known };
    }
  }
}

function run(input, { iteration }) {
  const before = globalStateSnapshot();
  const context = `tool-args#${iteration}`;

  switch (input.kind) {
    case "definitions":
      rejectOrAccept(() => parseToolDefinitions(input.value), CODES, `${context}/definitions`);
      break;
    case "choice":
      rejectOrAccept(() => parseToolChoice(input.value), CODES, `${context}/choice`);
      break;
    case "calls": {
      const outcome = rejectOrAccept(() => parseToolCalls(input.value), CODES, `${context}/calls`);
      if (outcome.accepted) {
        /*
         * An accepted call list must be usable: every entry needs an id the result path can
         * match. A parser that returned a hole here would push the failure downstream into
         * the dispatcher.
         */
        for (const call of outcome.value) {
          if (typeof call.id !== "string" || call.id.length === 0) {
            throw new Error(`${context}: accepted a tool call with no usable id`);
          }
        }
      }
      break;
    }
    default:
      rejectOrAccept(() => parseToolMessage(input.value, new Set(input.known)), CODES, `${context}/message`);
      break;
  }

  assertGlobalStateUnchanged(before, context);
}

export const target = {
  name: "tool-args",
  seed: "9i-tool-args-1",
  iterations: 5000,
  generate,
  run,
};
