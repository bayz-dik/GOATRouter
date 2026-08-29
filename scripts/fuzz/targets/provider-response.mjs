/**
 * Fuzz target: upstream response and streaming-chunk parsing — 9I Task 3.
 *
 * A provider response is **untrusted input**. It arrives from a network peer whose behaviour
 * BAYZ does not control, and 9G's posture is that model and provider output stays untrusted
 * all the way through. So `parseChatResponse` and `parseChatChunk` are fuzzed with the same
 * hostility as a client request.
 */

import { generateIdentifier, generateJsonValue, generateUtf8String } from "../generators.mjs";
import { assertGlobalStateUnchanged, globalStateSnapshot, rejectOrAccept } from "./shared.mjs";

const { parseChatResponse } = await import("../../../packages/router/src/response.ts");
const { parseChatChunk } = await import("../../../packages/router/src/chunk.ts");

const CODES = new Set(["invalid_response", "response_too_large", "invalid_request"]);

function usage(rng) {
  return rng.pick([
    { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    { prompt_tokens: -1, completion_tokens: 0, total_tokens: 0 },
    { prompt_tokens: 1.5, completion_tokens: "2" },
    { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 2 ** 40 },
    {},
    null,
    generateJsonValue(rng),
  ]);
}

function generate(rng) {
  if (rng.int(0, 8) === 0) {
    return { kind: rng.bool() ? "response" : "chunk", value: generateJsonValue(rng) };
  }

  if (rng.bool()) {
    const body = {
      id: rng.int(0, 5) === 0 ? generateIdentifier(rng) : "chatcmpl-1",
      model: rng.int(0, 5) === 0 ? generateIdentifier(rng) : "probe-model",
      choices: [
        {
          index: rng.pick([0, 1, -1, "0", null]),
          message: {
            role: rng.int(0, 5) === 0 ? generateIdentifier(rng) : "assistant",
            content: rng.int(0, 3) === 0 ? generateJsonValue(rng) : generateUtf8String(rng),
          },
          finish_reason: rng.pick(["stop", "length", "tool_calls", "", null, 42]),
        },
      ],
      usage: usage(rng),
    };

    switch (rng.int(0, 6)) {
      case 0:
        body.choices = generateJsonValue(rng);
        break;
      case 1:
        body.choices = [];
        break;
      case 2:
        // A provider trying to add a field to a BAYZ response, including a prototype key.
        body[generateIdentifier(rng)] = generateJsonValue(rng);
        break;
      case 3:
        body.choices[0].message.tool_calls = generateJsonValue(rng);
        break;
      case 4:
        body.choices[0].message = generateJsonValue(rng);
        break;
      default:
        break;
    }
    return { kind: "response", value: body };
  }

  const chunk = {
    id: "chatcmpl-1",
    model: "probe-model",
    choices: [
      {
        index: rng.pick([0, 63, 64, -1, "0"]),
        delta: rng.int(0, 3) === 0 ? generateJsonValue(rng) : { content: generateUtf8String(rng) },
        finish_reason: rng.pick([null, "stop", "tool_calls", "", 7]),
      },
    ],
  };
  if (rng.bool()) chunk.usage = usage(rng);

  /*
   * Order matters: the tool-call delta is installed *before* `choices` may be replaced with an
   * arbitrary JSON value, because reaching into `choices[0]` afterwards is a generator bug —
   * it throws in `generate`, which aborts the run rather than fuzzing anything.
   */
  if (rng.int(0, 5) === 0) {
    chunk.choices[0].delta = {
      tool_calls: [
        {
          index: rng.pick([0, 63, 64, -1]),
          id: rng.int(0, 2) === 0 ? generateIdentifier(rng) : "call_1",
          type: "function",
          function: { name: generateIdentifier(rng), arguments: generateUtf8String(rng) },
        },
      ],
    };
  }
  if (rng.int(0, 4) === 0) chunk.choices = generateJsonValue(rng);
  return { kind: "chunk", value: chunk };
}

function run(input, { iteration }) {
  const before = globalStateSnapshot();
  const context = `provider-response#${iteration}`;

  if (input.kind === "response") {
    const outcome = rejectOrAccept(() => parseChatResponse(input.value), CODES, `${context}/response`);
    if (outcome.accepted) {
      /*
       * The documented guarantee is that only known fields are copied onto a fresh object, so
       * an upstream cannot inject properties into a BAYZ response. Assert it rather than
       * trusting the comment: a regression here is an upstream-controlled field reaching a
       * client.
       */
      const proto = Object.getPrototypeOf(outcome.value);
      if (proto !== Object.prototype && proto !== null) {
        throw new Error(`${context}: parsed response carries a non-plain prototype`);
      }
    }
  } else {
    rejectOrAccept(() => parseChatChunk(input.value), CODES, `${context}/chunk`);
  }

  assertGlobalStateUnchanged(before, context);
}

export const target = {
  name: "provider-response",
  seed: "9i-provider-response-1",
  iterations: 5000,
  generate,
  run,
};
