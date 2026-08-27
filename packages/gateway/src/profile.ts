import { isClientScope, satisfies, type ClientScope } from "@bayz/identity";
import { CLIENT_CAPABILITIES, type ClientCapability, type ClientQuirk } from "./capabilities.js";
import { CLIENT_QUIRKS } from "./capabilities.js";
import { GatewayError } from "./errors.js";

export type ClientProtocol = "openai" | "anthropic";

export type ClientProfile = {
  readonly protocol: ClientProtocol;
  readonly capabilities: ReadonlySet<ClientCapability>;
  readonly quirks: ReadonlySet<ClientQuirk>;
};

export type DeriveProfileInput = {
  path: string;
  accept: string | undefined;
  body: unknown;
  grantedScopes: ReadonlySet<string>;
};

/** A path longer than this is a probe, not a route. */
const MAX_PATH_LENGTH = 2048;
/** A legitimate chat body has well under this many top-level keys. */
const MAX_BODY_KEYS = 256;

/**
 * Which scope each capability requires.
 *
 * This table is the enforcement point for "capability is the intersection of
 * request intent and granted scope". Deriving a capability the identity cannot
 * back with a scope would let a request talk BAYZ into work it is not authorized
 * for, so intent alone never produces a capability.
 */
const REQUIRED_SCOPE: Readonly<Record<ClientCapability, ClientScope>> = Object.freeze({
  chat: "chat.completions",
  "chat.stream": "chat.completions",
  "models.list": "models.read",
  tools: "chat.completions",
  "tools.parallel": "chat.completions",
  cancel: "chat.completions",
  "usage.read": "usage.read",
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * A set that cannot be mutated after derivation.
 *
 * `Object.freeze` on a `Set` leaves `add` and `delete` working, so a caller could
 * quietly widen a profile's capabilities after the scope check ran. Replacing the
 * mutators is what actually makes the profile a decision rather than a suggestion.
 */
function sealedSet<T>(values: Iterable<T>): ReadonlySet<T> {
  const set = new Set<T>(values);
  const refuse = (): never => {
    throw new GatewayError("invalid_profile", "profile-frozen");
  };
  Object.defineProperties(set, {
    add: { value: refuse, configurable: false, writable: false },
    delete: { value: refuse, configurable: false, writable: false },
    clear: { value: refuse, configurable: false, writable: false },
  });
  return Object.freeze(set);
}

/**
 * Strip the query string and any trailing slash.
 *
 * Real clients append both. Matching the raw path would make `/v1/models?x=1`
 * an unknown route and silently drop a legitimate request's capabilities.
 */
function canonicalPath(raw: string): string {
  const withoutQuery = raw.split(/[?#]/, 1)[0] ?? "";
  const trimmed = withoutQuery.replace(/\/+$/, "");
  return trimmed.length === 0 ? "/" : trimmed;
}

function protocolFor(path: string): ClientProtocol {
  // The Anthropic messages endpoint is the only non-OpenAI protocol BAYZ speaks.
  // Everything else defaults to OpenAI because that is the wire format the router
  // and every provider already use.
  return path === "/v1/messages" ? "anthropic" : "openai";
}

/**
 * What the request is asking for, before any authorization is considered.
 *
 * Deliberately derived from the protocol path, the Accept header, and the body
 * shape. Never from a product name: there is no branch here that could behave
 * differently for one client than for another sending the same bytes, and a
 * source-scan test in `adversarial.test.ts` enforces that.
 */
function intentOf(
  path: string,
  accept: string | undefined,
  body: Record<string, unknown> | undefined,
): Set<ClientCapability> {
  const intent = new Set<ClientCapability>();

  if (path === "/v1/models") {
    intent.add("models.list");
    return intent;
  }

  if (path.startsWith("/api/usage/")) {
    intent.add("usage.read");
    return intent;
  }

  if (path !== "/v1/chat/completions" && path !== "/v1/messages") {
    return intent;
  }

  if (body === undefined) {
    return intent;
  }

  intent.add("chat");
  // Cancellation is not something a client opts into: any request can be aborted
  // by disconnecting, and the capability records that BAYZ honours it.
  intent.add("cancel");

  // `stream: true` is the request's actual intent. Requiring the Accept header as
  // well would reject a compliant client, since real clients are inconsistent
  // about advertising `text/event-stream`.
  if (body.stream === true) {
    intent.add("chat.stream");
  }

  const tools = body.tools;
  if (Array.isArray(tools) && tools.length > 0) {
    intent.add("tools");
    if (body.parallel_tool_calls === true) {
      // Only meaningful alongside tools; on its own it is a client sending a flag
      // for a feature it did not request.
      intent.add("tools.parallel");
    }
  }

  // `accept` is read so that a future protocol negotiation has the value, but it
  // never widens a capability on its own — see the test that asserts an
  // event-stream Accept without `stream: true` yields no streaming.
  void accept;

  return intent;
}

function quirksOf(body: Record<string, unknown> | undefined): Set<ClientQuirk> {
  const quirks = new Set<ClientQuirk>();
  if (body === undefined) {
    return quirks;
  }
  // Observed behaviour, not a guess: several OpenAI-compatible clients send
  // `max_tokens` as a JSON string. Normalization converts it; the quirk records
  // that the conversion was needed.
  if (typeof body.max_tokens === "string") {
    quirks.add("max-tokens-string");
  }
  return quirks;
}

export function deriveProfile(input: DeriveProfileInput): ClientProfile {
  if (typeof input.path !== "string" || input.path.length > MAX_PATH_LENGTH) {
    throw new GatewayError("invalid_request", "path");
  }
  if (input.accept !== undefined && typeof input.accept !== "string") {
    throw new GatewayError("invalid_request", "accept");
  }

  const granted = new Set<ClientScope>();
  for (const scope of input.grantedScopes) {
    if (!isClientScope(scope)) {
      throw new GatewayError("invalid_profile", "granted-scope");
    }
    granted.add(scope);
  }

  const body = isPlainObject(input.body) ? input.body : undefined;
  if (body !== undefined && Object.keys(body).length > MAX_BODY_KEYS) {
    // Refused rather than iterated: a 10,000-key body is an attack on the parser,
    // and walking it to find out is the cost the attacker wanted.
    throw new GatewayError("invalid_request", "body-keys");
  }

  const path = canonicalPath(input.path);
  const intent = intentOf(path, input.accept, body);

  const capabilities: ClientCapability[] = [];
  for (const capability of CLIENT_CAPABILITIES) {
    if (intent.has(capability) && satisfies(granted, REQUIRED_SCOPE[capability])) {
      capabilities.push(capability);
    }
  }

  return Object.freeze({
    protocol: protocolFor(path),
    capabilities: sealedSet(capabilities),
    quirks: sealedSet(quirksOf(body)),
  });
}

/** The declared quirk vocabulary, re-exported for callers that validate config. */
export { CLIENT_QUIRKS };
