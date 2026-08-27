export {
  GatewayError,
  asGatewayError,
  type GatewayErrorCode,
} from "./errors.js";
export {
  CLIENT_CAPABILITIES,
  CLIENT_QUIRKS,
  assertClientCapability,
  assertClientQuirk,
  isClientCapability,
  isClientQuirk,
  type ClientCapability,
  type ClientQuirk,
} from "./capabilities.js";
export {
  deriveProfile,
  type ClientProfile,
  type ClientProtocol,
  type DeriveProfileInput,
} from "./profile.js";
export {
  CLIENT_PRESETS,
  isClientPresetName,
  presetFor,
  type ClientPreset,
  type ClientPresetName,
} from "./presets.js";
