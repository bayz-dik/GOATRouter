/**
 * Failure categories the display layer is willing to show.
 *
 * Mirrors the telemetry boundary's closed enum. Duplicated deliberately rather than
 * imported from `@bayz/telemetry`: the dashboard must not gain a dependency on a
 * server-side package, and a drift between the two lists is caught by the API tests
 * that assert the stored value round-trips.
 */
export const FAILURE_CATEGORY_KEYS: ReadonlySet<string> = new Set([
  "auth_failed",
  "rate_limited",
  "unreachable",
  "timeout",
  "upstream_error",
  "invalid_response",
  "response_too_large",
  "credential_missing",
  "no_route",
  "all_routes_failed",
  "unsupported_operation",
  "proxy_error",
  "forbidden",
  "refused",
  "protocol_error",
  "unknown_error",
]);
