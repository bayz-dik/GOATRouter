import { CLIENT_SCOPES, type ClientScope } from "@bayz/identity";

/**
 * The authenticated caller behind a request.
 *
 * Deliberately not the key, not a token, and not a database row: a handler needs
 * to know *who* and *what they may do*, and giving it anything more would create a
 * path from a route back to a credential. `scopes` is a set so a handler cannot
 * reorder or extend it meaningfully, and `id` is a slug safe to log.
 */
export type BayzPrincipal = {
  readonly id: string;
  readonly scopes: ReadonlySet<ClientScope>;
};

/**
 * The identity the Phase 6 `api:token` maps to.
 *
 * Backward compatibility matters here: an operator upgrading into Phase 9 must not
 * find their existing token suddenly unable to manage anything. The token keeps
 * working and carries `admin`, and 9C's registry adds *additional* identities
 * rather than replacing this one. The id is a fixed slug rather than a derived
 * value so it is safe to write into an audit row and a log line.
 */
export const BOOTSTRAP_IDENTITY_ID = "bootstrap-admin";

const ADMIN_SCOPES: ReadonlySet<ClientScope> = Object.freeze(
  new Set<ClientScope>(["admin"]),
);

export function bootstrapPrincipal(): BayzPrincipal {
  return Object.freeze({ id: BOOTSTRAP_IDENTITY_ID, scopes: ADMIN_SCOPES });
}

/**
 * Every scope, for a caller that legitimately holds all of them.
 *
 * Used only by tests and by tooling that needs to enumerate the surface; the
 * bootstrap principal holds `admin` instead, because `admin` is one grant to
 * reason about rather than ten.
 */
export const ALL_SCOPES: ReadonlySet<ClientScope> = Object.freeze(
  new Set<ClientScope>(CLIENT_SCOPES),
);

/**
 * Resolve a presented bearer value to a principal.
 *
 * 9C replaces the injected resolver with the real identity registry. The seam
 * exists now because 9A's scope checks are meaningless if the only caller is an
 * all-powerful token — the gateway's intersection rule needs a genuinely limited
 * principal to be tested against.
 */
export type IdentityResolver = (presented: string) => BayzPrincipal | undefined;
