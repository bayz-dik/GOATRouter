import { ProviderError } from "./errors.js";

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Provider ids share the alphabet of a scoped-secret segment on purpose: the id
 * becomes part of the physical secret name `provider:<id>:api_key`, so any
 * character that could break out of a scope must be impossible here too. The
 * check runs before any SQL, which is why constraint violations are a backstop
 * rather than control flow.
 */
export function assertProviderId(id: unknown): string {
  if (
    typeof id !== "string" ||
    !PROVIDER_ID_RE.test(id) ||
    id.includes("..") ||
    id.endsWith("-")
  ) {
    throw new ProviderError("invalid_provider_id", "provider-id");
  }
  return id;
}

export function isProviderId(id: unknown): id is string {
  try {
    assertProviderId(id);
    return true;
  } catch {
    return false;
  }
}
