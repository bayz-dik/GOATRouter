/**
 * Fuzz target: provider configuration parsing — 9I Task 3.
 *
 * `parseProviderConfig` refuses unknown keys rather than ignoring them, and refuses a
 * non-plain prototype. Both matter for a specific reason recorded in the source: there is no
 * key in this schema that can carry an `Authorization` value, so header smuggling is
 * structurally impossible — and an inherited `timeoutMs` must not shadow the validated one.
 * A fuzzer that only checked "does not crash" would miss a regression in either.
 */

import { generateHeaderPair, generateIdentifier, generateJsonValue, generateUrl } from "../generators.mjs";
import { assertGlobalStateUnchanged, globalStateSnapshot, rejectOrAccept } from "./shared.mjs";

const { MAX_CUSTOM_HEADERS, MAX_HEADER_VALUE_LENGTH, TIMEOUT_MS_MAX, TIMEOUT_MS_MIN, parseProviderConfig, safeCustomHeaders } =
  await import("../../../packages/providers/src/config.ts");
const { PROVIDER_KINDS } = await import("../../../packages/providers/src/url.ts");

const CODES = new Set(["invalid_provider_config", "invalid_provider_id"]);

function headerBag(rng) {
  const bag = {};
  const count = rng.pick([0, 1, 2, MAX_CUSTOM_HEADERS, MAX_CUSTOM_HEADERS + 1]);
  for (let i = 0; i < count; i += 1) {
    const pair = generateHeaderPair(rng);
    bag[pair.name.length > 0 ? pair.name : `x-${i}`] = pair.value;
  }
  // The forbidden ones, explicitly: a config that could set these would be credential
  // smuggling rather than customisation.
  if (rng.int(0, 3) === 0) bag[rng.pick(["authorization", "Authorization", "AUTHORIZATION", "proxy-authorization"])] = "Basic x";
  if (rng.int(0, 6) === 0) bag[rng.pick(["host", "content-length", "transfer-encoding"])] = "1";
  return bag;
}

function generate(rng) {
  const kind = rng.pick([...PROVIDER_KINDS]);

  if (rng.int(0, 8) === 0) return { kind, config: generateJsonValue(rng) };

  const config = {};
  if (rng.bool()) config.timeoutMs = rng.pick([TIMEOUT_MS_MIN, TIMEOUT_MS_MAX, TIMEOUT_MS_MIN - 1, TIMEOUT_MS_MAX + 1, 0, -1, 1.5, "5000", null]);
  if (rng.bool()) config.discoveryPath = rng.pick(["/v1/models", "", "no-leading-slash", "/".repeat(300), generateIdentifier(rng)]);
  if (rng.bool()) config.modelLimit = rng.pick([1, 100, 0, -1, 10_000, 1.5, "50"]);
  if (rng.bool()) config.baseUrl = generateUrl(rng);
  if (rng.int(0, 2) === 0) config.headers = rng.int(0, 4) === 0 ? generateJsonValue(rng) : headerBag(rng);
  if (rng.int(0, 4) === 0) config[generateIdentifier(rng)] = 1; // unknown key
  if (rng.int(0, 8) === 0) {
    // A prototype-bearing object: an inherited value must not shadow a validated one.
    const hostile = Object.create({ timeoutMs: 1, discoveryPath: "/inherited" });
    Object.assign(hostile, config);
    return { kind, config: hostile, inherited: true };
  }
  return { kind, config };
}

function run(input, { iteration }) {
  const before = globalStateSnapshot();
  const context = `provider-config#${iteration}`;

  const outcome = rejectOrAccept(() => parseProviderConfig(input.config, input.kind), CODES, context);

  if (outcome.accepted) {
    const parsed = outcome.value;

    // An inherited value must never survive parsing.
    if (input.inherited && parsed.discoveryPath === "/inherited") {
      throw new Error(`${context}: an inherited prototype value shadowed the validated config`);
    }

    // Bounds are asserted on the *output*, because that is what callers act on.
    if (parsed.timeoutMs < TIMEOUT_MS_MIN || parsed.timeoutMs > TIMEOUT_MS_MAX) {
      throw new Error(`${context}: accepted an out-of-range timeoutMs (${parsed.timeoutMs})`);
    }

    /*
     * The header allow-list is the credential-smuggling boundary. `safeCustomHeaders` is the
     * function callers use before building a request, so it is what gets asserted — an
     * authorization header surviving to that point is the actual defect.
     */
    const safe = safeCustomHeaders(parsed.headers ?? {});
    for (const name of Object.keys(safe)) {
      const lower = name.toLowerCase();
      if (lower === "authorization" || lower === "proxy-authorization") {
        throw new Error(`${context}: a credential header survived into the safe header set`);
      }
      if (Buffer.byteLength(String(safe[name])) > MAX_HEADER_VALUE_LENGTH) {
        throw new Error(`${context}: an oversized header value survived`);
      }
    }
    if (Object.keys(safe).length > MAX_CUSTOM_HEADERS) {
      throw new Error(`${context}: more than ${MAX_CUSTOM_HEADERS} headers survived`);
    }
  }

  assertGlobalStateUnchanged(before, context);
}

export const target = {
  name: "provider-config",
  seed: "9i-provider-config-1",
  iterations: 5000,
  generate,
  run,
};
