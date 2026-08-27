import { satisfies, type ClientScope } from "@bayz/identity";
import type { FastifyReply, FastifyRequest } from "fastify";
import { errorEnvelope } from "./http-errors.js";
import { bootstrapPrincipal, type BayzPrincipal } from "./principal.js";

/**
 * The principal for a guarded request.
 *
 * Falling back to the bootstrap principal covers the unguarded configuration used
 * by the Phase 1-6 tests that build an app without `apiToken`. In that mode there
 * is no authentication at all, so treating the caller as admin is accurate rather
 * than permissive — it is what those tests already assumed.
 */
export function principalOf(request: FastifyRequest): BayzPrincipal {
  return request.principal ?? bootstrapPrincipal();
}

/**
 * Enforce a scope, returning a 403 reply when it is missing.
 *
 * The message names the missing scope and nothing else. Saying which providers,
 * routes, or identities exist would turn an authorization failure into an
 * enumeration primitive.
 */
export function requireScope(
  request: FastifyRequest,
  reply: FastifyReply,
  scope: ClientScope,
): FastifyReply | undefined {
  if (satisfies(principalOf(request).scopes, scope)) {
    return undefined;
  }
  return reply
    .code(403)
    .send(
      errorEnvelope(
        request,
        "forbidden",
        `This credential lacks the required scope: ${scope}`,
      ),
    );
}

export function hasScope(request: FastifyRequest, scope: ClientScope): boolean {
  return satisfies(principalOf(request).scopes, scope);
}
