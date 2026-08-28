import { isClientScope, type ClientScope } from "@bayz/identity";
import { CapabilityError } from "./errors.js";

/**
 * What a capability name may look like.
 *
 * Lowercase ASCII, a letter first, then letters, digits, `_`, `.`, and `-`, three to
 * sixty-four characters. Narrow on purpose, and the narrowness is doing security work
 * rather than cosmetic work:
 *
 * - **ASCII only** means a Cyrillic or fullwidth homoglyph of a registered name cannot
 *   be registered, so a reviewer reading a diff sees the same bytes the registry holds.
 * - **No `/`, `\`, or `:`** means a name can never be mistaken for a path or a URL by
 *   anything downstream that concatenates it.
 * - **No whitespace or control characters** means a name cannot carry a NUL that
 *   truncates in a C-string consumer, or a newline that forges a log line.
 * - **Bounded length** means a hostile 10 MiB name is refused before it is hashed,
 *   compared, or logged.
 *
 * Exported as a constant so a later widening has to change a value the suite asserts.
 */
export const CAPABILITY_NAME_PATTERN = /^[a-z][a-z0-9_.-]{2,63}$/;

/**
 * How many capabilities may be registered.
 *
 * Bounded for the same reason every other Bayz bound exists: the registry is walked by
 * `registeredCapabilityNames()`, and an embedder registering in a loop would otherwise
 * grow it without limit. 128 is far above any plausible real set — the shipped set is
 * empty — so the bound cannot be hit by legitimate use.
 */
export const CAPABILITY_REGISTRY_MAX = 128;

/**
 * Names that are refused even though the pattern admits them.
 *
 * `constructor` and `prototype` are lowercase ASCII, so the pattern above accepts
 * them — and lookup would be safe, because a `Map` has no prototype-chain resolution.
 * They are refused anyway, for the consumer that does not exist yet: the moment
 * anything builds an object keyed by capability name (a tool schema list handed to a
 * model, a JSON summary for the dashboard), `{ constructor: … }` corrupts that object
 * and `{ prototype: … }` shadows a function property. Refusing at registration costs
 * one comparison and removes the class of bug rather than the instance.
 *
 * The `__`-prefixed hazards — `__proto__`, `__defineGetter__` — are already refused
 * because the pattern requires a leading letter. They are listed anyway so a later
 * widening of the pattern cannot silently re-admit them.
 */
const RESERVED_CAPABILITY_NAMES: ReadonlySet<string> = new Set([
  "constructor",
  "prototype",
  "__proto__",
  "__definegetter__",
  "__definesetter__",
  "__lookupgetter__",
  "__lookupsetter__",
]);

/**
 * One thing the router is allowed to do on a model's behalf.
 *
 * `parse` and `run` are separate on purpose. `parse` turns untrusted model JSON into a
 * validated input or throws; `run` receives only a value that survived `parse`. A single
 * `run(raw: unknown)` would put validation inside every handler, where one handler
 * forgetting it is a silent hole.
 *
 * `requiredScope` is a `ClientScope` from `@bayz/identity` — the same ten-word
 * vocabulary the HTTP routes use. That is deliberate: authority is expressed in one
 * language, so a capability cannot invent a permission the identity system has never
 * heard of, and none of those ten words authorizes reading a secret.
 */
export type CapabilityHandler<I, O> = {
  readonly name: string;
  readonly requiredScope: ClientScope;
  /** Validate untrusted input. Throws on mismatch; never coerces. */
  parse(raw: unknown): I;
  /** Perform the operation. Only ever called with a `parse` result. */
  run(input: I): Promise<O>;
};

/**
 * The registry.
 *
 * A `Map`, not an object literal, and that is a security decision rather than a style
 * one. With `{}` as the store, a model-supplied name of `toString`, `constructor`, or
 * `__proto__` resolves through the prototype chain to a truthy builtin, and a
 * dispatcher would treat that as a found capability and call it. A `Map` has no
 * prototype-chain lookup, so an unregistered name returns `undefined` — full stop.
 *
 * Process-wide, like the router's outbound semaphore. A per-caller registry would be a
 * capability set the caller could influence, which is the opposite of the goal.
 */
const registry = new Map<string, CapabilityHandler<unknown, unknown>>();

function assertName(name: unknown): string {
  if (typeof name !== "string" || !CAPABILITY_NAME_PATTERN.test(name)) {
    throw new CapabilityError("invalid_capability_name", "register-name");
  }
  if (RESERVED_CAPABILITY_NAMES.has(name)) {
    throw new CapabilityError("invalid_capability_name", "register-reserved");
  }
  return name;
}

/**
 * Register a capability.
 *
 * Refuses rather than replaces on a duplicate. Replacing would let a later import swap
 * the handler behind a name an operator already reviewed, with nothing reporting it —
 * and "the capability set is what the code says" is the invariant the whole design
 * rests on.
 *
 * Note what this function does *not* do: it does not filter names for words like
 * `credential` or `secret`. A blocklist would make the guarantee "we blocked that
 * spelling", which invites the next spelling. The real guarantee is that a capability
 * exists only because a human wrote a registration and another human reviewed it, and
 * no such registration reads a secret.
 */
export function registerCapability<I, O>(handler: CapabilityHandler<I, O>): void {
  if (typeof handler !== "object" || handler === null) {
    throw new CapabilityError("invalid_capability_handler", "register-handler");
  }
  const name = assertName((handler as { name?: unknown }).name);

  if (typeof handler.parse !== "function" || typeof handler.run !== "function") {
    // A handler without both is unusable, and the failure would otherwise surface at
    // dispatch time as a `TypeError` on a request an attacker chose the timing of.
    throw new CapabilityError("invalid_capability_handler", "register-shape");
  }
  if (!isClientScope((handler as { requiredScope?: unknown }).requiredScope)) {
    /*
     * A scope outside the vocabulary would sit in the registry looking maximally
     * locked down while being unreviewable: no identity can hold it, and `satisfies`
     * throws on an unknown required scope, so the first dispatch would be a 500
     * rather than a clean refusal.
     */
    throw new CapabilityError("invalid_capability_scope", "register-scope");
  }
  if (registry.has(name)) {
    throw new CapabilityError("capability_already_registered", "register-duplicate");
  }
  if (registry.size >= CAPABILITY_REGISTRY_MAX) {
    // Refused, not evicted. Evicting would silently remove a capability something is
    // relying on, and the eviction order would be attacker-influenced.
    throw new CapabilityError("capability_registry_full", "register-bound");
  }

  registry.set(name, handler as unknown as CapabilityHandler<unknown, unknown>);
}

/**
 * Look up a capability by a name that came from model output.
 *
 * Takes `unknown` and returns `undefined` rather than throwing, because the name is
 * whatever the upstream emitted: a number, an object, `null`, a symbol. A throw here
 * would turn "the model sent nonsense" into a 500 on a path an attacker controls,
 * where the honest answer is simply that no such capability exists.
 */
export function lookupCapability(
  name: unknown,
): CapabilityHandler<unknown, unknown> | undefined {
  if (typeof name !== "string") {
    return undefined;
  }
  // No normalization, no trimming, no case folding. Every one of those would widen
  // what matches a registered name, and the registry is the authority on its own keys.
  return registry.get(name);
}

/**
 * Every registered name.
 *
 * Returns a fresh array so a caller cannot mutate the live key set — pushing a name
 * into a live view would make a capability *appear* to exist, and splicing one out
 * would hide it from the suite's secret-name tripwire.
 */
export function registeredCapabilityNames(): string[] {
  return [...registry.keys()];
}

/**
 * Empty the registry.
 *
 * Exists for tests and for a configuration reload, exactly like
 * `resetOutboundConcurrency`. The registry is process-wide, so explicit reset is the
 * only honest way to assert "nothing is registered by default".
 */
export function resetCapabilities(): void {
  registry.clear();
}
