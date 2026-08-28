export type RouterErrorCode =
  | "invalid_model"
  | "invalid_route_id"
  | "invalid_route_config"
  | "invalid_request"
  | "route_already_exists"
  | "route_not_found"
  | "no_route"
  | "no_free_route"
  | "all_routes_failed"
  | "invalid_response"
  | "response_too_large"
  | "rate_limited"
  | "tools_unsupported";

/**
 * Fixed, caller-independent messages.
 *
 * Prompts, completions, and upstream response bodies are the most sensitive data
 * the router touches. None of them may be interpolated into an error, because an
 * error message reaches logs.
 */
const MESSAGES: Record<RouterErrorCode, string> = {
  invalid_model: "invalid_model: the model name is not a valid identifier",
  invalid_route_id: "invalid_route_id: the route id is not a valid slug",
  invalid_route_config: "invalid_route_config: the route configuration was rejected",
  invalid_request: "invalid_request: the chat request was rejected",
  route_already_exists: "route_already_exists: that model is already bound to this provider",
  route_not_found: "route_not_found: no route is registered with that id",
  no_route: "no_route: no enabled route matches the requested model",
  // Names no model, no provider, and no price: the operator needs to know the refusal
  // was deliberate, and anything more specific would put routing detail into logs.
  no_free_route:
    "no_free_route: no free model was available and this route may not spend money",
  all_routes_failed: "all_routes_failed: every candidate route failed",
  invalid_response: "invalid_response: the upstream response could not be interpreted",
  response_too_large: "response_too_large: the upstream response exceeded the byte cap",
  // Names no provider and no queue depth: an operator reads the configured cap from
  // their own settings, and telling a caller how full the queue is would let it probe
  // the process's load.
  rate_limited: "rate_limited: too many upstream requests are already in flight",
  tools_unsupported: "tools_unsupported: the selected provider does not support tool calling",
};

export class RouterError extends Error {
  readonly code: RouterErrorCode;
  readonly stage: string | undefined;

  constructor(code: RouterErrorCode, stage?: string) {
    super(stage ? `${MESSAGES[code]} (stage: ${stage})` : MESSAGES[code]);
    this.name = "RouterError";
    this.code = code;
    this.stage = stage;
  }
}

/**
 * Translate an arbitrary throw into a RouterError.
 *
 * As elsewhere in Bayz the original value is discarded rather than attached as
 * `cause`: structured loggers serialize `cause` and would reintroduce upstream
 * text or request detail that was deliberately removed.
 */
export function asRouterError(
  code: RouterErrorCode,
  stage: string | undefined,
  cause: unknown,
): RouterError {
  if (cause instanceof RouterError) {
    return cause;
  }
  return new RouterError(code, stage);
}
