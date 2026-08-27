import { GatewayError } from "./errors.js";

/**
 * What a client can ask BAYZ to do, expressed as capability rather than identity.
 *
 * This vocabulary is the whole reason `packages/gateway` exists. A new client with
 * a name nobody has heard of works if it speaks a supported protocol and asks for
 * supported capabilities; it needs no BAYZ source change and no entry in a list.
 * Note what is absent: nothing here can read a credential or perform management,
 * so the gateway cannot express such a request at all.
 */
export const CLIENT_CAPABILITIES = Object.freeze([
  "chat",
  "chat.stream",
  "models.list",
  "tools",
  "tools.parallel",
  "cancel",
  "usage.read",
] as const);

export type ClientCapability = (typeof CLIENT_CAPABILITIES)[number];

/**
 * Genuine wire-format divergence, and nothing else.
 *
 * A quirk is not a feature flag and not a product switch. Each one exists because
 * a real client was observed sending something the strict parser would reject, and
 * each is documented with that observation. `max-tokens-string` is here because
 * several OpenAI-compatible clients send `max_tokens` as a JSON string.
 */
export const CLIENT_QUIRKS = Object.freeze(["max-tokens-string"] as const);

export type ClientQuirk = (typeof CLIENT_QUIRKS)[number];

/** Sets, not object lookups, so `__proto__` cannot resolve through a prototype. */
const CAPABILITY_SET: ReadonlySet<string> = new Set<string>(CLIENT_CAPABILITIES);
const QUIRK_SET: ReadonlySet<string> = new Set<string>(CLIENT_QUIRKS);

export function isClientCapability(value: unknown): value is ClientCapability {
  return typeof value === "string" && CAPABILITY_SET.has(value);
}

export function isClientQuirk(value: unknown): value is ClientQuirk {
  return typeof value === "string" && QUIRK_SET.has(value);
}

export function assertClientCapability(value: unknown): ClientCapability {
  if (!isClientCapability(value)) {
    throw new GatewayError("invalid_capability", "capability");
  }
  return value;
}

export function assertClientQuirk(value: unknown): ClientQuirk {
  if (!isClientQuirk(value)) {
    throw new GatewayError("invalid_quirk", "quirk");
  }
  return value;
}
