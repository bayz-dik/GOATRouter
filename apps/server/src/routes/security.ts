import type { FastifyInstance } from "fastify";
import { errorEnvelope, handleDomain } from "../http-errors.js";
import { principalOf, requireScope } from "../scopes.js";
import type { BayzRuntime } from "../runtime.js";

/**
 * Deployment-security routes.
 *
 * `admin`-only without exception, and for a stronger reason than the identity
 * routes: rotation replaces the key that protects every stored credential, and the
 * audit surface names key fingerprints and rotation counts — deployment shape a
 * chat client has no claim on.
 *
 * There is deliberately no route that *reads* the root key, no route that accepts a
 * caller-supplied replacement key, and no field in either response able to carry key
 * material. The replacement is minted by the storage layer's own custody, so the
 * strongest thing an authenticated admin can do over HTTP is ask for a new key, not
 * choose one.
 */
export function registerSecurityRoutes(app: FastifyInstance, runtime: BayzRuntime): void {
  app.post("/api/security/rotate-root-key", async (request, reply) => {
    const denied = requireScope(request, reply, "admin");
    if (denied !== undefined) {
      return denied;
    }
    if (!runtime.security.canRotateRootKey) {
      // 409, not 501: the operation exists and the deployment's custody is what
      // refuses it. Answered before any row is touched, so a refusal is a genuine
      // no-op rather than a half-rotation reported as an error.
      return reply
        .code(409)
        .send(
          errorEnvelope(
            request,
            "rotation_unsupported",
            "This deployment's root key custody cannot persist a replacement key",
          ),
        );
    }
    return handleDomain(request, reply, () => {
      const result = runtime.security.rotateRootKey(principalOf(request).id);
      // Assembled field by field rather than spread, so a future field added to the
      // storage result cannot appear here without a decision.
      return {
        rotated: result.rotated,
        keyId: result.keyId,
        previousKeyId: result.previousKeyId,
        rotatedAt: new Date().toISOString(),
      };
    });
  });

  app.get<{ Querystring: { limit?: string } }>(
    "/api/security/audit",
    async (request, reply) => {
      const denied = requireScope(request, reply, "admin");
      if (denied !== undefined) {
        return denied;
      }
      const raw = request.query.limit;
      let limit = 100;
      if (raw !== undefined) {
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
          return reply
            .code(400)
            .send(
              errorEnvelope(
                request,
                "invalid_request",
                "limit must be an integer from 1 to 500",
              ),
            );
        }
        limit = parsed;
      }
      return handleDomain(request, reply, () => ({
        // Metadata only, by schema: `security_audit` has no column able to hold a
        // key, a secret name, or a free-text error string.
        audit: runtime.security.recentAudit(limit).map((row) => ({
          occurredAt: row.occurredAt,
          action: row.action,
          actor: row.actor,
          outcome: row.outcome,
          keyId: row.keyId ?? null,
          previousKeyId: row.previousKeyId ?? null,
          subjectCount: row.subjectCount,
        })),
      }));
    },
  );
}
