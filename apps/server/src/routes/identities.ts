import type { FastifyInstance } from "fastify";
import { assertIdentityId } from "@bayz/identity";
import { errorEnvelope, handleDomain } from "../http-errors.js";
import { requireScope } from "../scopes.js";
import type { BayzRuntime } from "../runtime.js";

/**
 * Identity management is `admin`-only, without exception.
 *
 * Creating an identity mints a credential and grants it scopes. Any lesser scope
 * that could reach these routes would be a privilege-escalation path: a
 * `providers.write` client could mint itself an `admin` identity.
 */
export function registerIdentityRoutes(app: FastifyInstance, runtime: BayzRuntime): void {
  const validId = (id: string): string => assertIdentityId(id);

  app.get("/api/identities", async (request, reply) =>
    requireScope(request, reply, "admin") ??
    handleDomain(request, reply, () => ({
      // Views only. There is no accessor that returns a stored key, so this cannot
      // become a credential dump even by accident.
      identities: runtime.identities.list(),
    })),
  );

  app.post("/api/identities", async (request, reply) =>
    requireScope(request, reply, "admin") ??
    handleDomain(request, reply, () => {
      const { identity, key } = runtime.identities.createIdentity(request.body as never);
      void reply.code(201);
      // The one and only time the key is returned. The response is not logged and
      // there is no endpoint that can retrieve it again.
      return { identity, key, keyShownOnce: true };
    }),
  );

  app.get<{ Params: { id: string } }>("/api/identities/:id", async (request, reply) =>
    requireScope(request, reply, "admin") ??
    handleDomain(request, reply, () => {
      const identity = runtime.identities.get(validId(request.params.id));
      if (identity === undefined) {
        return reply
          .code(404)
          .send(errorEnvelope(request, "identity_not_found", "No such identity"));
      }
      return identity;
    }),
  );

  app.patch<{ Params: { id: string } }>("/api/identities/:id", async (request, reply) =>
    requireScope(request, reply, "admin") ??
    handleDomain(request, reply, () =>
      runtime.identities.update(validId(request.params.id), request.body as never),
    ),
  );

  app.delete<{ Params: { id: string } }>("/api/identities/:id", async (request, reply) =>
    requireScope(request, reply, "admin") ??
    handleDomain(request, reply, () => {
      // Revoke rather than delete: the row stays visible so an operator can see that
      // the identity existed and was switched off, which is what makes revocation
      // auditable instead of indistinguishable from "never existed".
      runtime.identities.revoke(validId(request.params.id));
      void reply.code(204);
      return null;
    }),
  );

  app.post<{ Params: { id: string } }>(
    "/api/identities/:id/rotate",
    async (request, reply) =>
      requireScope(request, reply, "admin") ??
      handleDomain(request, reply, () => {
        const { identity, key } = runtime.identities.rotateKey(
          validId(request.params.id),
        );
        return { identity, key, keyShownOnce: true };
      }),
  );

  app.get<{ Querystring: { limit?: string } }>(
    "/api/identities/audit",
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
        // Metadata only, by schema: `identity_audit` has no column able to hold a
        // key, a body, or an error string.
        audit: runtime.identities.recentAudit(limit),
      }));
    },
  );
}
