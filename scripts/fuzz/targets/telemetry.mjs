/**
 * Fuzz target: usage telemetry event normalisation — 9I Task 3.
 *
 * `normalizeUsageEvent` is unusual in this set: it **returns `undefined`** for a bad event
 * rather than throwing, because a malformed telemetry row must never fail the request it
 * describes. So the contract fuzzed here is different — no throw is permitted at all, and an
 * accepted row must be within every declared bound, since accounting reads these numbers.
 */

import { generateIdentifier, generateJsonValue, generateUtf8String } from "../generators.mjs";
import { assertGlobalStateUnchanged, globalStateSnapshot } from "./shared.mjs";

const {
  FAILURE_CATEGORIES,
  MAX_ATTEMPTS,
  MAX_LATENCY_MS,
  MAX_TOKENS,
  ROUTING_MODES,
  USAGE_EVENT_KINDS,
  normalizeFailureCategory,
  normalizeUsageEvent,
} = await import("../../../packages/telemetry/src/events.ts");

function generate(rng) {
  if (rng.int(0, 8) === 0) return generateJsonValue(rng);

  const event = {
    kind: rng.int(0, 4) === 0 ? generateIdentifier(rng) : rng.pick([...USAGE_EVENT_KINDS]),
    requestId: rng.int(0, 4) === 0 ? generateIdentifier(rng) : `req_${rng.int(0, 99_999)}`,
  };

  if (rng.bool()) event.routeId = rng.int(0, 3) === 0 ? generateIdentifier(rng) : "r";
  if (rng.bool()) event.providerId = rng.int(0, 3) === 0 ? generateIdentifier(rng) : "o";
  if (rng.bool()) event.model = rng.int(0, 3) === 0 ? generateUtf8String(rng) : "probe-model";
  if (rng.bool()) event.routingMode = rng.int(0, 3) === 0 ? generateIdentifier(rng) : rng.pick([...ROUTING_MODES]);
  if (rng.bool()) event.outcome = rng.pick(["ok", "error", "refused", "", 1, null, generateIdentifier(rng)]);

  // Numbers are where accounting integrity lives: negatives, fractions, and values past the
  // declared caps all have to be handled without producing a row that lies.
  if (rng.bool()) event.promptTokens = rng.pick([0, 1, -1, 1.5, MAX_TOKENS, MAX_TOKENS + 1, 2 ** 53, "5", null, NaN, Infinity]);
  if (rng.bool()) event.completionTokens = rng.pick([0, -1, 1.5, MAX_TOKENS + 1, "7", null]);
  if (rng.bool()) event.latencyMs = rng.pick([0, -1, 1.5, MAX_LATENCY_MS, MAX_LATENCY_MS + 1, "50", null]);
  if (rng.bool()) event.attempts = rng.pick([1, 0, -1, 1.5, MAX_ATTEMPTS, MAX_ATTEMPTS + 1, "2"]);
  if (rng.bool()) event.failureCategory = rng.int(0, 2) === 0 ? generateIdentifier(rng) : rng.pick([...FAILURE_CATEGORIES]);
  if (rng.int(0, 4) === 0) event[generateIdentifier(rng)] = generateJsonValue(rng);

  return event;
}

function run(input, { iteration }) {
  const before = globalStateSnapshot();
  const context = `telemetry#${iteration}`;

  let row;
  try {
    row = normalizeUsageEvent(input);
  } catch (error) {
    /*
     * A throw here is a defect by design, not just by taste: telemetry is written on the
     * request path, so an exception normalising a row would fail a request that had already
     * succeeded. `undefined` is the documented refusal.
     */
    throw new Error(`${context}: normalizeUsageEvent threw instead of returning undefined: ${error?.name}: ${error?.message}`);
  }

  if (row !== undefined) {
    // Accepted rows feed accounting, so every declared bound is asserted on the output.
    if (!USAGE_EVENT_KINDS.includes(row.kind)) {
      throw new Error(`${context}: accepted an unknown event kind ${JSON.stringify(row.kind)}`);
    }
    if (row.routingMode !== undefined && !ROUTING_MODES.includes(row.routingMode)) {
      throw new Error(`${context}: accepted an unknown routing mode ${JSON.stringify(row.routingMode)}`);
    }
    for (const [field, cap] of [
      ["promptTokens", MAX_TOKENS],
      ["completionTokens", MAX_TOKENS],
      ["latencyMs", MAX_LATENCY_MS],
      ["attempts", MAX_ATTEMPTS],
    ]) {
      const value = row[field];
      if (value === undefined) continue;
      if (!Number.isInteger(value)) {
        throw new Error(`${context}: ${field} is not an integer (${String(value)})`);
      }
      if (value < 0 || value > cap) {
        throw new Error(`${context}: ${field}=${value} is outside [0, ${cap}]`);
      }
    }
    if (row.failureCategory !== undefined && !FAILURE_CATEGORIES.includes(row.failureCategory)) {
      throw new Error(`${context}: accepted an unknown failure category ${JSON.stringify(row.failureCategory)}`);
    }
  }

  // The category normaliser has the same total-function contract.
  let category;
  try {
    category = normalizeFailureCategory(input?.failureCategory);
  } catch (error) {
    throw new Error(`${context}: normalizeFailureCategory threw: ${error?.name}: ${error?.message}`);
  }
  if (category !== undefined && !FAILURE_CATEGORIES.includes(category)) {
    throw new Error(`${context}: normalizeFailureCategory produced ${JSON.stringify(category)}`);
  }

  assertGlobalStateUnchanged(before, context);
}

export const target = {
  name: "telemetry",
  seed: "9i-telemetry-1",
  iterations: 5000,
  generate,
  run,
};
