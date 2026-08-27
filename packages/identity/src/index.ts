export {
  IdentityError,
  asIdentityError,
  type IdentityErrorCode,
} from "./errors.js";
export {
  CLIENT_SCOPES,
  DEFAULT_CLIENT_SCOPES,
  assertScopes,
  isClientScope,
  satisfies,
  type ClientScope,
} from "./scopes.js";
export {
  DEFAULT_AUDIT_RETENTION,
  assertIdentityId,
  createIdentityRepository,
  type CreateIdentityInput,
  type CreateIdentityRepositoryOptions,
  type IdentityAuditAction,
  type IdentityAuditInput,
  type IdentityAuditOutcome,
  type IdentityAuditRecord,
  type IdentityRepository,
  type IdentityView,
  type UpdateIdentityInput,
} from "./repository.js";
export {
  createIdentityManager,
  type CreateIdentityManagerOptions,
  type IdentityLogger,
  type IdentityManager,
} from "./manager.js";
