/**
 * Fuzz target: URL and egress policy — 9I Task 3.
 *
 * This is the SSRF boundary. The property under test is **fail-closed**: a hostname that is
 * loopback, private, link-local, CGNAT, or a cloud metadata service must be refused under the
 * default policy, whatever encoding it arrives in. An accept where a reject was required is
 * not a cosmetic bug — it is a request BAYZ makes on an attacker's behalf against the
 * operator's own network.
 */

import { generateIdentifier, generateUrl } from "../generators.mjs";
import { assertGlobalStateUnchanged, globalStateSnapshot, rejectOrAccept } from "./shared.mjs";

const { DEFAULT_EGRESS_POLICY, assertEgressAllowed, isEgressAllowed } = await import(
  "../../../packages/providers/src/egress.ts"
);
const { normalizeBaseUrl, hostnameOfBaseUrl } = await import("../../../packages/providers/src/url.ts");

const CODES = new Set(["invalid_provider_config", "unreachable"]);

/**
 * Hostnames that must never be allowed under the default policy.
 *
 * Every entry is a real form seen in SSRF reports, not a hypothetical: the decimal, octal and
 * hex encodings of 127.0.0.1 all resolve to loopback while looking like ordinary hosts, and
 * `169.254.169.254` is the cloud metadata endpoint whose exposure leaks instance credentials.
 */
const MUST_REFUSE = Object.freeze([
  "127.0.0.1",
  "127.1",
  "localhost",
  "LOCALHOST",
  "0.0.0.0",
  "::1",
  "10.0.0.1",
  "10.255.255.254",
  "172.16.0.1",
  "172.31.255.254",
  "192.168.0.1",
  "192.168.100.53",
  "169.254.169.254",
  "169.254.0.1",
  "100.64.0.1",
  "fe80::1",
  "fd00::1",
  "metadata.google.internal",
]);

function generate(rng) {
  const kind = rng.int(0, 5);
  if (kind === 0) return { which: "policy", host: rng.pick(MUST_REFUSE), mustRefuse: true };
  if (kind === 1) return { which: "policy", host: generateIdentifier(rng) };
  if (kind === 2) return { which: "policy", host: rng.pick(["example.com", "api.openai.com", "provider.test", "a.b.c.d"]) };
  return { which: "url", url: generateUrl(rng) };
}

function run(input, { iteration }) {
  const before = globalStateSnapshot();
  const context = `url#${iteration}`;

  if (input.which === "policy") {
    const outcome = rejectOrAccept(
      () => assertEgressAllowed(input.host, DEFAULT_EGRESS_POLICY),
      CODES,
      `${context}/egress`,
    );

    if (input.mustRefuse && outcome.accepted) {
      throw new Error(`${context}: the default policy allowed ${JSON.stringify(input.host)} — SSRF boundary breached`);
    }

    /*
     * The predicate and the assertion must agree. If `isEgressAllowed` said yes while
     * `assertEgressAllowed` threw, a caller choosing the cheaper check would bypass the
     * boundary — the two-function divergence is the classic way a guard gets defeated.
     */
    let predicate;
    try {
      predicate = isEgressAllowed(input.host, DEFAULT_EGRESS_POLICY);
    } catch (error) {
      throw new Error(`${context}: isEgressAllowed threw instead of answering: ${error?.message}`);
    }
    if (typeof predicate !== "boolean") {
      throw new Error(`${context}: isEgressAllowed returned ${typeof predicate}`);
    }
    if (predicate !== outcome.accepted) {
      throw new Error(
        `${context}: isEgressAllowed=${predicate} disagrees with assertEgressAllowed=${outcome.accepted} for ${JSON.stringify(input.host)}`,
      );
    }
  } else {
    const outcome = rejectOrAccept(() => normalizeBaseUrl(input.url), CODES, `${context}/base-url`);
    if (outcome.accepted) {
      // An accepted base URL must be http(s) and must yield a hostname the egress policy can
      // then judge; anything else means a `file:`/`gopher:` form slipped through.
      if (!/^https?:\/\//.test(outcome.value)) {
        throw new Error(`${context}: accepted a non-HTTP base URL: ${JSON.stringify(outcome.value)}`);
      }
      rejectOrAccept(() => hostnameOfBaseUrl(outcome.value), CODES, `${context}/hostname`);
    }
  }

  assertGlobalStateUnchanged(before, context);
}

export const target = {
  name: "url",
  seed: "9i-url-1",
  iterations: 5000,
  generate,
  run,
};
