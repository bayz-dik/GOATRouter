export type CapabilityErrorCode =
  | "invalid_capability_name"
  | "invalid_capability_handler"
  | "invalid_capability_scope"
  | "capability_already_registered"
  | "capability_registry_full"
  | "unknown_capability";

/**
 * Fixed, caller-independent messages.
 *
 * The same rule as `@bayz/identity` and `@bayz/gateway`, and it matters more here than
 * anywhere else in the tree: every value this package rejects arrives from **model
 * output**. A message that interpolated the offending capability name would take
 * attacker-authored text and write it into an operator's structured log, which is the
 * exact instruction-smuggling path 9G exists to close. The name is discarded; the
 * `stage` says where the refusal happened.
 */
const MESSAGES: Record<CapabilityErrorCode, string> = {
  invalid_capability_name: "invalid_capability_name: the capability name was rejected",
  invalid_capability_handler:
    "invalid_capability_handler: the capability handler was rejected",
  invalid_capability_scope:
    "invalid_capability_scope: the required scope is not a known client scope",
  capability_already_registered:
    "capability_already_registered: a capability with that name is already registered",
  capability_registry_full:
    "capability_registry_full: the capability registry is at its bound",
  unknown_capability: "unknown_capability: no capability is registered with that name",
};

export class CapabilityError extends Error {
  readonly code: CapabilityErrorCode;
  readonly stage: string | undefined;

  constructor(code: CapabilityErrorCode, stage?: string) {
    super(stage ? `${MESSAGES[code]} (stage: ${stage})` : MESSAGES[code]);
    this.name = "CapabilityError";
    this.code = code;
    this.stage = stage;
  }
}

/**
 * Translate an arbitrary throw into a `CapabilityError`.
 *
 * The original value is dropped rather than attached as `cause`, because a structured
 * logger serializes `cause` and would reintroduce the model text the fixed message
 * exists to withhold. A handler's own `parse` throwing an `Error` whose message quotes
 * the bad argument is the realistic version of that leak.
 */
export function asCapabilityError(
  code: CapabilityErrorCode,
  stage: string | undefined,
  cause: unknown,
): CapabilityError {
  if (cause instanceof CapabilityError) {
    return cause;
  }
  return new CapabilityError(code, stage);
}
