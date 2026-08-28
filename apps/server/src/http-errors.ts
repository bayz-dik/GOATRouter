import type { ApiErrorResponse } from "@bayz/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Map a domain error code to an HTTP status.
 *
 * Every error class in Phases 2-5 already refuses to interpolate secrets or
 * upstream bodies into its message, so passing that fixed message through cannot
 * leak by construction. An unrecognized code becomes a generic 500 rather than
 * being echoed, so a new domain code can never accidentally surface prose that
 * has not been reviewed.
 */
const STATUS_BY_CODE: Record<string, number> = {
  // Validation
  invalid_argument: 400,
  invalid_provider_id: 400,
  invalid_provider_config: 400,
  invalid_proxy_id: 400,
  invalid_proxy_config: 400,
  invalid_route_id: 400,
  invalid_route_config: 400,
  invalid_identity_id: 400,
  invalid_identity_config: 400,
  invalid_scope: 400,
  invalid_request: 400,
  invalid_model: 400,
  invalid_response: 502,
  no_route: 400,
  // 409, not 503. A refusal on economics grounds means "add a free provider"; a 503
  // means "the network is down". One conflates an operator decision with an outage.
  no_free_route: 409,
  password_missing: 400,
  credential_missing: 400,

  // Auth / access
  unauthorized: 401,
  forbidden: 403,
  // A revoked or expired identity reached a route it would otherwise be allowed on.
  // 403 rather than 401: the presented credential authenticated as far as the guard
  // is concerned, and the refusal is about the identity's state.
  identity_revoked: 403,
  identity_expired: 403,
  key_invalid: 401,
  forbidden_host: 403,
  forbidden_origin: 403,

  // Existence
  identity_not_found: 404,
  provider_not_found: 404,
  proxy_not_found: 404,
  route_not_found: 404,
  secret_not_found: 404,

  // Conflict
  identity_already_exists: 409,
  provider_already_exists: 409,
  proxy_already_exists: 409,
  route_already_exists: 409,

  // Payload
  response_too_large: 502,

  // Rate
  rate_limited: 429,

  // Not implemented
  unsupported_operation: 501,
  // The request was well-formed and the capability is real, but the provider this
  // model routes to cannot do it. 501 matches `unsupported_operation`: the remedy is
  // to configure a capable provider, not to fix the request.
  tools_unsupported: 501,

  // Upstream / transport
  unreachable: 502,
  refused: 502,
  upstream_error: 502,
  auth_failed: 502,
  proxy_error: 502,
  protocol_error: 502,
  discovery_failed: 502,
  all_routes_failed: 502,
  timeout: 504,

  // 9G tool dispatch. All four are produced in response to *model output*, so every
  // message behind them is fixed vocabulary with nothing interpolated.
  //
  // 400 for a bad argument or an exhausted loop: the model asked for something
  // malformed or unbounded, and the remedy is a different request or a different model,
  // not a retry. 403 for a scope refusal, matching `forbidden`. 502 for a capability
  // that threw, matching every other "something downstream of us failed" code — the
  // client did nothing wrong.
  invalid_tool_call: 400,
  invalid_tool_arguments: 400,
  tool_arguments_too_large: 413,
  too_many_tool_calls: 400,
  tool_dispatch_exhausted: 400,
  tool_dispatch_split: 400,
  dispatch_depth_exceeded: 400,
  capability_forbidden: 403,
  capability_failed: 502,
  // A model naming a capability that does not exist is not an error the *client* can
  // act on, and the chat route forwards such a call rather than refusing it. The code
  // is mapped anyway so a future caller that does surface it gets 400 rather than a
  // generic 500.
  unknown_capability: 400,

  // Storage
  storage_unavailable: 503,
  master_key_invalid: 500,
  master_key_mismatch: 500,
  // 409, not 500 or 501: the request was valid and the deployment's key custody is
  // what refuses. The remedy is an operator decision about custody, not a retry.
  rotation_unsupported: 409,
  secret_corrupt: 500,
};

const GENERIC_MESSAGE = "Request failed";

export type MappedError = {
  status: number;
  code: string;
  message: string;
};

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

export function mapDomainError(error: unknown): MappedError {
  const code = codeOf(error);
  if (code === undefined || STATUS_BY_CODE[code] === undefined) {
    return { status: 500, code: "internal_error", message: GENERIC_MESSAGE };
  }
  return {
    status: STATUS_BY_CODE[code]!,
    code,
    message: error instanceof Error ? error.message : GENERIC_MESSAGE,
  };
}

export function errorEnvelope(
  request: FastifyRequest,
  code: string,
  message: string,
): ApiErrorResponse {
  return { error: { code, message, requestId: String(request.id) } };
}

/** Send a domain failure using the stable envelope and the mapped status. */
export function sendDomainError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  const mapped = mapDomainError(error);
  return reply
    .code(mapped.status)
    .send(errorEnvelope(request, mapped.code, mapped.message));
}

/**
 * Run a handler, translating any domain throw into the stable envelope.
 *
 * Handlers therefore never build error responses themselves, which is what keeps
 * the mapping in exactly one reviewable place.
 */
export async function handleDomain<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  run: () => Promise<T> | T,
): Promise<T | FastifyReply> {
  try {
    return await run();
  } catch (error) {
    return sendDomainError(request, reply, error);
  }
}
