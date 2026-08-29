/**
 * Fuzz target: identifier and model-name validation — 9I Task 3.
 *
 * Route ids, provider ids, proxy ids, identity ids, and model names are all slugs that end up
 * in SQL parameters, filesystem-adjacent lookups, and log lines. The interesting property is
 * not just "hostile input is refused" but that **acceptance is narrow**: an accepted id must
 * match the documented charset, because everything downstream trusts that.
 */

import { generateIdentifier, generateSqliteHostileString, generateUtf8String } from "../generators.mjs";
import { assertGlobalStateUnchanged, globalStateSnapshot, rejectOrAccept } from "./shared.mjs";

const { assertModelId, assertModelPattern, matchesModelPattern } = await import("../../../packages/router/src/model.ts");
const { assertRouteId } = await import("../../../packages/router/src/repository.ts");
const { assertProviderId } = await import("../../../packages/providers/src/identity.ts");
const { assertProxyId } = await import("../../../packages/proxy/src/endpoint.ts");
const { assertIdentityId } = await import("../../../packages/identity/src/repository.ts");

/*
 * Codes read from the implementations rather than guessed. `assertModelPattern` and
 * `matchesModelPattern` report `invalid_route_config` (a pattern *is* route configuration),
 * not `invalid_model` — the first draft of this target asserted the wrong vocabulary and
 * produced 62 false failures in 300 iterations.
 */
const ROUTER_CODES = new Set(["invalid_model", "invalid_route_id"]);
const PATTERN_CODES = new Set(["invalid_route_config", "invalid_model"]);
const PROVIDER_CODES = new Set(["invalid_provider_id"]);
const PROXY_CODES = new Set(["invalid_proxy_id"]);
const IDENTITY_CODES = new Set(["invalid_identity_id"]);

/** The documented slug charset for ids: what an accepted value is allowed to contain. */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
/** Model ids are broader — they carry vendor prefixes and version dots. */
const MODEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._:/-]*[A-Za-z0-9])?$/;

function generate(rng) {
  const which = rng.pick(["model", "pattern", "route", "provider", "proxy", "identity", "match"]);
  const value =
    rng.int(0, 6) === 0
      ? generateSqliteHostileString(rng)
      : rng.int(0, 5) === 0
        ? generateUtf8String(rng)
        : generateIdentifier(rng);
  return { which, value, pattern: rng.int(0, 2) === 0 ? generateIdentifier(rng) : `${value}*` };
}

function run(input, { iteration }) {
  const before = globalStateSnapshot();
  const context = `identifier#${iteration}/${input.which}`;

  switch (input.which) {
    case "model": {
      const outcome = rejectOrAccept(() => assertModelId(input.value), ROUTER_CODES, context);
      if (outcome.accepted && !MODEL_RE.test(outcome.value)) {
        // A validator that accepts something outside its own documented charset is worse than
        // one that rejects too much: every consumer downstream trusts the shape.
        throw new Error(`${context}: accepted a model id outside the documented charset: ${JSON.stringify(outcome.value)}`);
      }
      break;
    }
    case "pattern":
      rejectOrAccept(() => assertModelPattern(input.value), PATTERN_CODES, context);
      break;
    case "route": {
      const outcome = rejectOrAccept(() => assertRouteId(input.value), ROUTER_CODES, context);
      if (outcome.accepted && !SLUG_RE.test(outcome.value)) {
        throw new Error(`${context}: accepted a route id outside the slug charset: ${JSON.stringify(outcome.value)}`);
      }
      break;
    }
    case "provider": {
      const outcome = rejectOrAccept(() => assertProviderId(input.value), PROVIDER_CODES, context);
      if (outcome.accepted && !SLUG_RE.test(outcome.value)) {
        throw new Error(`${context}: accepted a provider id outside the slug charset`);
      }
      break;
    }
    case "proxy": {
      const outcome = rejectOrAccept(() => assertProxyId(input.value), PROXY_CODES, context);
      if (outcome.accepted && !SLUG_RE.test(outcome.value)) {
        throw new Error(`${context}: accepted a proxy id outside the slug charset`);
      }
      break;
    }
    case "identity": {
      const outcome = rejectOrAccept(() => assertIdentityId(input.value), IDENTITY_CODES, context);
      if (outcome.accepted && !SLUG_RE.test(outcome.value)) {
        throw new Error(`${context}: accepted an identity id outside the slug charset`);
      }
      break;
    }
    default: {
      /*
       * Pattern matching must be total: given any two strings it answers true or false. A
       * throw here would let a hostile model name crash route selection rather than miss it.
       *
       * Argument order is `(pattern, model)` — read from the signature, since passing them
       * the wrong way round would still "pass" while testing the mirror image of the rule.
       */
      let answered;
      try {
        answered = matchesModelPattern(String(input.pattern), String(input.value));
      } catch (error) {
        // Only a BAYZ rejection is acceptable; anything else is the defect.
        rejectOrAccept(() => {
          throw error;
        }, PATTERN_CODES, context);
        break;
      }
      if (typeof answered !== "boolean") {
        throw new Error(`${context}: matchesModelPattern returned ${typeof answered}`);
      }
      break;
    }
  }

  assertGlobalStateUnchanged(before, context);
}

export const target = {
  name: "identifier",
  seed: "9i-identifier-1",
  iterations: 5000,
  generate,
  run,
};
