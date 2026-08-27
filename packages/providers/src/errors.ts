export type ProviderErrorCode =
  | "invalid_provider_id"
  | "invalid_provider_config"
  | "provider_already_exists"
  | "provider_not_found"
  | "credential_missing"
  | "unsupported_operation"
  | "unreachable"
  | "auth_failed"
  | "rate_limited"
  | "upstream_error"
  | "discovery_failed";

/**
 * Fixed, caller-independent messages.
 *
 * Upstream responses, base URLs, and rejected configuration values are all
 * attacker- or operator-controlled text that may embed credentials; none of it
 * may be interpolated into an error that gets logged or returned.
 */
const MESSAGES: Record<ProviderErrorCode, string> = {
  invalid_provider_id: "invalid_provider_id: the provider id is not a valid slug",
  invalid_provider_config: "invalid_provider_config: the provider configuration was rejected",
  provider_already_exists: "provider_already_exists: a provider with that id is already registered",
  provider_not_found: "provider_not_found: no provider is registered with that id",
  credential_missing: "credential_missing: this provider requires a stored credential",
  unsupported_operation: "unsupported_operation: this provider kind does not support that operation",
  unreachable: "unreachable: the upstream provider could not be reached",
  auth_failed: "auth_failed: the upstream provider rejected the credential",
  rate_limited: "rate_limited: the upstream provider is rate limiting this client",
  upstream_error: "upstream_error: the upstream provider returned an unusable response",
  discovery_failed: "discovery_failed: the model list could not be interpreted",
};

/**
 * A safe token that may appear in an error message.
 *
 * Deliberately narrow: letters, digits, hyphen, underscore, dot, bounded at 64. The
 * only values passed as a detail are ones that already cleared a strict charset check
 * (a header name, for instance), and this re-checks rather than trusting the caller —
 * an error message reaches logs and a UI, so one unvalidated path is one too many.
 */
const SAFE_DETAIL_RE = /^[A-Za-z0-9._-]{1,64}$/;

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly stage: string | undefined;
  /**
   * An operator-supplied identifier that makes the failure actionable.
   *
   * Present only where a bare code would leave the operator guessing — "which of my
   * eight headers was rejected?" is not a question they should have to answer by
   * bisection. Never a value, only a name, and only one that matched
   * `SAFE_DETAIL_RE`.
   */
  readonly detail: string | undefined;

  constructor(code: ProviderErrorCode, stage?: string, detail?: string) {
    const safeDetail =
      typeof detail === "string" && SAFE_DETAIL_RE.test(detail) ? detail : undefined;
    const parts = [MESSAGES[code]];
    if (stage !== undefined) {
      parts.push(`(stage: ${stage})`);
    }
    if (safeDetail !== undefined) {
      parts.push(`(detail: ${safeDetail})`);
    }
    super(parts.join(" "));
    this.name = "ProviderError";
    this.code = code;
    this.stage = stage;
    this.detail = safeDetail;
  }
}

/**
 * Translate an arbitrary throw into a ProviderError.
 *
 * As in `@bayz/storage`, the original value is discarded rather than attached as
 * `cause`: structured loggers serialize `cause` and would reintroduce upstream
 * text, request URLs, or DNS detail that was deliberately removed.
 */
export function asProviderError(
  code: ProviderErrorCode,
  stage: string | undefined,
  cause: unknown,
): ProviderError {
  if (cause instanceof ProviderError) {
    return cause;
  }
  return new ProviderError(code, stage);
}
