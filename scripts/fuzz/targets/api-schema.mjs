/**
 * Fuzz target: the OpenAI request schema boundary — 9I Task 3.
 *
 * Covers `parseChatRequest` (the router's own contract) and `normalizeRequest` (the gateway's
 * name mapping) with hostile JSON bodies. These two are the outermost surface a client
 * touches, so a `TypeError` escaping either means unchecked caller input reached the router.
 */

import { generateJsonValue, generateIdentifier, generateUtf8String } from "../generators.mjs";
import { assertGlobalStateUnchanged, expectBayzError, globalStateSnapshot, rejectOrAccept } from "./shared.mjs";

const { parseChatRequest } = await import("../../../packages/router/src/request.ts");
const { normalizeRequest } = await import("../../../packages/gateway/src/normalize.ts");
const { deriveProfile } = await import("../../../packages/gateway/src/profile.ts");

const ROUTER_CODES = new Set(["invalid_request", "invalid_model"]);
const GATEWAY_CODES = new Set(["invalid_request", "invalid_profile", "capability_unsupported", "invalid_quirk"]);

/**
 * The documented top-level request keys, and the documented message keys.
 *
 * Mirrored here **on purpose**, as an independent oracle rather than an import. A target that
 * imported `ALLOWED_KEYS` from the module under test would agree with any regression by
 * construction: widen the set and the assertion widens with it. Mutation C2 proved that this
 * matters — replacing `isPlainObject` + the unknown-key loop with a bare `typeof === "object"`
 * check left the whole target green at 500 iterations, because nothing asserted what acceptance
 * *should* have refused. If a legitimate key is ever added to the contract, this list must be
 * updated in the same commit, and that friction is the point.
 */
const DOCUMENTED_KEYS = Object.freeze(
  new Set(["model", "messages", "temperature", "max_tokens", "top_p", "stop", "tools", "tool_choice"]),
);
const DOCUMENTED_MESSAGE_KEYS = Object.freeze(new Set(["role", "content", "tool_calls", "tool_call_id", "name"]));
const DOCUMENTED_ROLES = Object.freeze(new Set(["system", "user", "assistant", "tool"]));

/**
 * A body that is *usually* well formed with one hostile field, plus sometimes pure garbage.
 *
 * Entirely random bodies are rejected at the first check and never reach the interesting
 * code; the realistic attack is a request that looks ordinary except in one place.
 */
function generate(rng) {
  if (rng.int(0, 9) === 0) return generateJsonValue(rng);

  const body = {
    model: rng.int(0, 3) === 0 ? generateIdentifier(rng) : "probe-model",
    messages: [{ role: "user", content: rng.int(0, 3) === 0 ? generateJsonValue(rng) : "hello" }],
  };

  switch (rng.int(0, 11)) {
    case 0:
      body.messages = generateJsonValue(rng);
      break;
    case 1:
      body.messages = Array.from({ length: rng.pick([0, 1, 255, 256, 257]) }, () => ({ role: "user", content: "x" }));
      break;
    case 2:
      body.temperature = generateJsonValue(rng);
      break;
    case 3:
      body.max_tokens = rng.pick([0, -1, 1.5, "512", "abc", 2 ** 31, Number.MAX_SAFE_INTEGER, null]);
      break;
    case 4:
      body.stop = rng.pick([[], ["a"], ["a", "b", "c", "d", "e"], "single", 42, [null]]);
      break;
    case 5:
      body.top_p = rng.pick([-1, 0, 1, 1.0001, "0.5", null]);
      break;
    case 6:
      body.tools = generateJsonValue(rng);
      break;
    case 7:
      body[generateIdentifier(rng)] = 1; // unknown top-level key
      break;
    case 8:
      body.messages[0][generateIdentifier(rng)] = 1; // unknown message key
      break;
    case 9:
      body.messages[0].role = rng.pick(["user", "system", "assistant", "tool", "root", "", "USER", 1, null]);
      break;
    case 10:
      body.messages[0].content = generateUtf8String(rng).repeat(rng.pick([1, 100, 5000]));
      break;
    default:
      body.stream = rng.pick([true, false, "true", 1, null]);
      if (rng.bool()) body.stream_options = rng.pick([{ include_usage: true }, { include_usage: false }, {}, 42, null]);
      break;
  }
  return body;
}

/**
 * Does the documented contract require this body to be refused?
 *
 * This is the oracle that actually bites. Asserting on the *parsed output* is not enough:
 * `parseChatRequest` builds a fresh `ChatRequest` copying only known fields, so an undocumented
 * key that slipped past validation is simply absent from the result and invisible to an
 * output-shape check. Mutation C2 — replacing `isPlainObject` plus the unknown-key loop with a
 * bare `typeof === "object"` test — stayed green through two rounds of output assertions for
 * exactly that reason.
 *
 * So the oracle reads the **input** and decides independently whether acceptance is permitted.
 * A body carrying an undocumented top-level key, an undocumented message key, a non-plain
 * prototype, or an own `__proto__` must be rejected; if it is accepted, that is the failure.
 */
function mustReject(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return true;

  const proto = Object.getPrototypeOf(body);
  if (proto !== Object.prototype && proto !== null) return true;
  if (Object.prototype.hasOwnProperty.call(body, "__proto__")) return true;

  for (const key of Object.keys(body)) {
    if (!DOCUMENTED_KEYS.has(key)) return true;
  }

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return true;
  for (const message of messages) {
    if (message === null || typeof message !== "object" || Array.isArray(message)) return true;
    const messageProto = Object.getPrototypeOf(message);
    if (messageProto !== Object.prototype && messageProto !== null) return true;
    if (Object.prototype.hasOwnProperty.call(message, "__proto__")) return true;
    for (const key of Object.keys(message)) {
      if (!DOCUMENTED_MESSAGE_KEYS.has(key)) return true;
    }
    if (!DOCUMENTED_ROLES.has(message.role)) return true;
  }

  // Anything else — value ranges, lengths, tool shapes — is the parser's business, and this
  // oracle deliberately says nothing about it.
  return false;
}

function run(input, { iteration }) {
  const before = globalStateSnapshot();

  const parsed = rejectOrAccept(() => parseChatRequest(input), ROUTER_CODES, `parseChatRequest#${iteration}`);

  if (parsed.accepted && mustReject(input)) {
    throw new Error(
      `api-schema#${iteration}: accepted a body the documented contract forbids: ${JSON.stringify(input).slice(0, 200)}`,
    );
  }

  if (parsed.accepted) {
    // Output-shape assertions as well: they catch a parser that laundered a hostile input into
    // a well-formed-looking result.
    const request = parsed.value;

    const proto = Object.getPrototypeOf(request);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`api-schema#${iteration}: accepted request carries a non-plain prototype`);
    }
    if (Object.prototype.hasOwnProperty.call(request, "__proto__")) {
      throw new Error(`api-schema#${iteration}: accepted request carries an own __proto__ key`);
    }
    for (const key of Object.keys(request)) {
      if (!DOCUMENTED_KEYS.has(key)) {
        throw new Error(`api-schema#${iteration}: accepted an undocumented top-level key ${JSON.stringify(key)}`);
      }
    }
    if (!Array.isArray(request.messages) || request.messages.length === 0) {
      throw new Error(`api-schema#${iteration}: accepted a request with no messages`);
    }
    for (const message of request.messages) {
      if (!DOCUMENTED_ROLES.has(message.role)) {
        throw new Error(`api-schema#${iteration}: accepted an undocumented role ${JSON.stringify(message.role)}`);
      }
      for (const key of Object.keys(message)) {
        // The parser returns camelCase internals (`toolCallId`), so both spellings are allowed.
        if (!DOCUMENTED_MESSAGE_KEYS.has(key) && !["toolCalls", "toolCallId"].includes(key)) {
          throw new Error(`api-schema#${iteration}: accepted an undocumented message key ${JSON.stringify(key)}`);
        }
      }
    }
  }

  /*
   * The gateway is fuzzed through a real derived profile rather than a hand-made one, so the
   * capability gate is the same object the server builds. Shape read from
   * `DeriveProfileInput`: `grantedScopes` is a `ReadonlySet`, not an array.
   */
  const profile = deriveProfile({
    path: "/v1/chat/completions",
    accept: undefined,
    body: input,
    grantedScopes: new Set(["chat.completions", "models.read"]),
  });

  try {
    normalizeRequest(profile, input);
  } catch (error) {
    expectBayzError(error, GATEWAY_CODES, `normalizeRequest#${iteration}`);
  }

  assertGlobalStateUnchanged(before, `api-schema#${iteration}`);
}

export const target = {
  name: "api-schema",
  seed: "9i-api-schema-1",
  iterations: 5000,
  generate,
  run,
};
