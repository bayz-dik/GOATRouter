import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { errorEnvelope } from "./http-errors.js";

/**
 * Require `application/json` for any request that carries a body.
 *
 * Fastify would otherwise reject an unknown content type with its own 400/415
 * shape; routing it through the Bayz envelope keeps one error format across the
 * whole API, and refusing `text/plain` also removes the CORS "simple request"
 * shape a cross-site form could send without a preflight.
 */
export function installContentTypeGuard(app: FastifyInstance): void {
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method !== "POST" && request.method !== "PUT" && request.method !== "PATCH") {
      return;
    }
    const path = request.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/") && !path.startsWith("/v1/")) {
      return;
    }
    const header = request.headers["content-type"];
    if (header === undefined) {
      // A bodyless POST (discover, check) is legitimate.
      const length = request.headers["content-length"];
      if (length === undefined || length === "0") {
        return;
      }
      return reply
        .code(415)
        .send(
          errorEnvelope(
            request,
            "unsupported_media_type",
            "Content-Type must be application/json",
          ),
        );
    }
    const mediaType = header.split(";")[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      return reply
        .code(415)
        .send(
          errorEnvelope(
            request,
            "unsupported_media_type",
            "Content-Type must be application/json",
          ),
        );
    }
  });
}
