export type ProxyErrorCode =
  | "invalid_proxy_id"
  | "invalid_proxy_config"
  | "proxy_already_exists"
  | "proxy_not_found"
  | "password_missing"
  | "unsupported_operation"
  | "unreachable"
  | "refused"
  | "timeout"
  | "auth_failed"
  | "forbidden"
  | "protocol_error"
  | "proxy_error";

/**
 * Fixed, caller-independent messages.
 *
 * Proxy handshakes carry operator hostnames and attacker-controlled reply bytes,
 * and a rejected configuration value may itself be a credential. None of it may
 * be interpolated into an error that gets logged or returned.
 */
const MESSAGES: Record<ProxyErrorCode, string> = {
  invalid_proxy_id: "invalid_proxy_id: the proxy id is not a valid slug",
  invalid_proxy_config: "invalid_proxy_config: the proxy configuration was rejected",
  proxy_already_exists: "proxy_already_exists: a proxy with that id is already registered",
  proxy_not_found: "proxy_not_found: no proxy is registered with that id",
  password_missing: "password_missing: this proxy requires a stored password",
  unsupported_operation: "unsupported_operation: this proxy does not support that operation",
  unreachable: "unreachable: the proxy could not reach the requested target",
  refused: "refused: the connection through the proxy was refused",
  timeout: "timeout: the proxy did not complete the handshake in time",
  auth_failed: "auth_failed: the proxy rejected the supplied credentials",
  forbidden: "forbidden: the proxy refused to allow this connection",
  protocol_error: "protocol_error: the proxy sent an unintelligible response",
  proxy_error: "proxy_error: the proxy reported a general failure",
};

export class ProxyError extends Error {
  readonly code: ProxyErrorCode;
  readonly stage: string | undefined;

  constructor(code: ProxyErrorCode, stage?: string) {
    super(stage ? `${MESSAGES[code]} (stage: ${stage})` : MESSAGES[code]);
    this.name = "ProxyError";
    this.code = code;
    this.stage = stage;
  }
}

/**
 * Translate an arbitrary throw into a ProxyError.
 *
 * As elsewhere in Bayz the original value is discarded rather than attached as
 * `cause`: structured loggers serialize `cause` and would reintroduce the peer
 * address, DNS text, or raw handshake bytes that were deliberately removed.
 */
export function asProxyError(
  code: ProxyErrorCode,
  stage: string | undefined,
  cause: unknown,
): ProxyError {
  if (cause instanceof ProxyError) {
    return cause;
  }
  return new ProxyError(code, stage);
}
