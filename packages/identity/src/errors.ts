export type IdentityErrorCode =
  | "invalid_scope"
  | "invalid_identity_id"
  | "invalid_identity_config"
  | "identity_already_exists"
  | "identity_not_found"
  | "identity_revoked"
  | "identity_expired"
  | "key_invalid";

/**
 * Fixed, caller-independent messages.
 *
 * Same rule as `@bayz/providers` and `@bayz/storage`: a presented key, a display
 * name, and a rejected scope payload are all attacker-controlled text that may be
 * logged, so none of it is interpolated into an error.
 */
const MESSAGES: Record<IdentityErrorCode, string> = {
  invalid_scope: "invalid_scope: the scope set was rejected",
  invalid_identity_id: "invalid_identity_id: the identity id is not a valid slug",
  invalid_identity_config: "invalid_identity_config: the identity record was rejected",
  identity_already_exists:
    "identity_already_exists: an identity with that id is already registered",
  identity_not_found: "identity_not_found: no identity is registered with that id",
  identity_revoked: "identity_revoked: this identity has been revoked",
  identity_expired: "identity_expired: this identity has expired",
  key_invalid: "key_invalid: the presented key was rejected",
};

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;
  readonly stage: string | undefined;

  constructor(code: IdentityErrorCode, stage?: string) {
    super(stage ? `${MESSAGES[code]} (stage: ${stage})` : MESSAGES[code]);
    this.name = "IdentityError";
    this.code = code;
    this.stage = stage;
  }
}

/**
 * Translate an arbitrary throw into an IdentityError.
 *
 * The original value is discarded rather than attached as `cause`, because a
 * structured logger serializes `cause` and would reintroduce the very text the
 * fixed message exists to withhold.
 */
export function asIdentityError(
  code: IdentityErrorCode,
  stage: string | undefined,
  cause: unknown,
): IdentityError {
  if (cause instanceof IdentityError) {
    return cause;
  }
  return new IdentityError(code, stage);
}
