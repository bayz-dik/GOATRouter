export type GatewayErrorCode =
  | "invalid_capability"
  | "invalid_quirk"
  | "invalid_profile"
  | "invalid_request"
  | "capability_unsupported";

/**
 * Fixed messages, as in every other Bayz package.
 *
 * A gateway error is produced from a request body and headers, which are entirely
 * caller-controlled, so nothing from the input is interpolated into the message.
 */
const MESSAGES: Record<GatewayErrorCode, string> = {
  invalid_capability: "invalid_capability: the capability name was rejected",
  invalid_quirk: "invalid_quirk: the quirk name is not declared",
  invalid_profile: "invalid_profile: the client profile was rejected",
  invalid_request: "invalid_request: the request could not be normalized",
  capability_unsupported:
    "capability_unsupported: the client is not granted that capability",
};

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly stage: string | undefined;

  constructor(code: GatewayErrorCode, stage?: string) {
    super(stage ? `${MESSAGES[code]} (stage: ${stage})` : MESSAGES[code]);
    this.name = "GatewayError";
    this.code = code;
    this.stage = stage;
  }
}

export function asGatewayError(
  code: GatewayErrorCode,
  stage: string | undefined,
  cause: unknown,
): GatewayError {
  if (cause instanceof GatewayError) {
    return cause;
  }
  return new GatewayError(code, stage);
}
