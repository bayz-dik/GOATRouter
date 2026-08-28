export {
  CapabilityError,
  asCapabilityError,
  type CapabilityErrorCode,
} from "./errors.js";
export {
  CAPABILITY_NAME_PATTERN,
  CAPABILITY_REGISTRY_MAX,
  lookupCapability,
  registerCapability,
  registeredCapabilityNames,
  resetCapabilities,
  type CapabilityHandler,
} from "./registry.js";
export {
  DISPATCH_ARGUMENT_MAX_BYTES,
  DISPATCH_CALLS_MAX,
  DISPATCH_DEPTH_MAX,
  dispatchToolCalls,
  type DispatchOutcome,
  type DispatchPrincipal,
  type DispatchRefusalCode,
  type DispatchToolCallsOptions,
} from "./dispatch.js";
