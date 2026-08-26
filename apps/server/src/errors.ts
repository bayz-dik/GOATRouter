import type { FastifyError, FastifyInstance } from "fastify";
import type { ApiErrorResponse } from "@bayz/contracts";
import { redactSecrets } from "@bayz/security";
import { mapDomainError } from "./http-errors.js";

/**
 * Framework-level failures that must not collapse into a generic 500.
 *
 * Fastify raises these before any handler runs, so they never pass through the
 * domain error mapping. Left alone they would all answer 500, which would hide a
 * body that was simply too large or malformed behind an "internal error".
 */
const FRAMEWORK_STATUS: Record<string, { status: number; code: string; message: string }> = {
  FST_ERR_CTP_BODY_TOO_LARGE: {
    status: 413,
    code: "payload_too_large",
    message: "Request body exceeds the permitted size",
  },
  FST_ERR_CTP_INVALID_JSON: {
    status: 400,
    code: "invalid_json",
    message: "Request body is not valid JSON",
  },
  FST_ERR_CTP_INVALID_JSON_BODY: {
    status: 400,
    code: "invalid_json",
    message: "Request body is not valid JSON",
  },
  FST_ERR_CTP_EMPTY_JSON_BODY: {
    status: 400,
    code: "invalid_json",
    message: "Request body is not valid JSON",
  },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: {
    status: 415,
    code: "unsupported_media_type",
    message: "Content-Type must be application/json",
  },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: {
    status: 400,
    code: "invalid_request",
    message: "Request body length is invalid",
  },
  FST_ERR_VALIDATION: {
    status: 400,
    code: "invalid_request",
    message: "Request failed validation",
  },
};

export type InstallErrorHandlingOptions = {
  /**
   * Whether to install the JSON 404 handler.
   *
   * The static dashboard installs its own, which serves `index.html` for
   * client-side routes while keeping `/api/*` and `/v1/*` misses as JSON. Fastify
   * permits only one per scope, so the caller decides which owns it.
   */
  notFoundHandler?: boolean;
};

export function installErrorHandling(
  app: FastifyInstance,
  options: InstallErrorHandlingOptions = {},
): void {
  if (options.notFoundHandler ?? true) {
    app.setNotFoundHandler((request, reply) => {
      const body: ApiErrorResponse = {
        error: {
          code: "not_found",
          message: "No such endpoint",
          requestId: String(request.id),
        },
      };
      void reply.code(404).send(body);
    });
  }

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Headers are redacted before logging: an Authorization header would
    // otherwise put the API token into every error line.
    request.log.error(
      redactSecrets({
        error: { name: error.name, message: error.message },
        headers: request.headers,
      }),
    );

    const framework = error.code === undefined ? undefined : FRAMEWORK_STATUS[error.code];
    if (framework !== undefined) {
      void reply.code(framework.status).send({
        error: {
          code: framework.code,
          message: framework.message,
          requestId: String(request.id),
        },
      } satisfies ApiErrorResponse);
      return;
    }

    // A domain error that escaped a handler still gets its mapped status; an
    // unrecognized throw becomes a generic 500 with no message from the error.
    const mapped = mapDomainError(error);
    void reply.code(mapped.status).send({
      error: {
        code: mapped.code,
        message: mapped.message,
        requestId: String(request.id),
      },
    } satisfies ApiErrorResponse);
  });
}
