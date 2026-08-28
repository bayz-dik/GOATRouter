import { satisfies, type ClientScope } from "@bayz/identity";
import type { FastifyReply, FastifyRequest } from "fastify";
import { errorEnvelope } from "./http-errors.js";
import { isLoopbackPeer } from "./posture.js";
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
 *
 * `admin` carries one extra condition (9F Task 6): it is refused over a non-loopback
 * connection **regardless of posture**, and regardless of the credential being
 * genuinely valid. Management of the deployment stays on the machine — an admin key
 * can rotate the root key and reach every provider credential, so allowing one leaked
 * header to arrive from off-machine would make the rest of the ladder decorative. The
 * check is on the *peer address* rather than on the configured posture, so a proxy in
 * front or a spoofed posture flag cannot re-open it.
 */
export function requireScope(
  request: FastifyRequest,
  reply: FastifyReply,
  scope: ClientScope,
): FastifyReply | undefined {
  if (!satisfies(principalOf(request).scopes, scope)) {
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
  if (scope === "admin" && !isLoopbackPeer(request.ip)) {
    return reply
      .code(403)
      .send(
        errorEnvelope(
          request,
          "forbidden",
          "Administrative operations are permitted only over a loopback connection",
        ),
      );
  }
  return undefined;
}

export function hasScope(request: FastifyRequest, scope: ClientScope): boolean {
  return satisfies(principalOf(request).scopes, scope);
}
