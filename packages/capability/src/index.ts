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
