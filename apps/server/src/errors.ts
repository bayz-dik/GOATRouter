import type { FastifyError, FastifyInstance } from "fastify";
import type { ApiErrorResponse } from "@bayz/contracts";
import { redactSecrets } from "@bayz/security";

export function installErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error(redactSecrets({
      error: { name: error.name, message: error.message },
      headers: request.headers,
    }));
    const body: ApiErrorResponse = {
      error: {
        code: "internal_error",
        message: "Request failed",
        requestId: request.id,
      },
    };
    void reply.code(500).send(body);
  });
}
