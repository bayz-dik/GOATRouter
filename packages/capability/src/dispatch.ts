import { satisfies, type ClientScope } from "@bayz/identity";
import { CapabilityError } from "./errors.js";
import { CAPABILITY_NAME_PATTERN, lookupCapability } from "./registry.js";

/**
 * How many tool calls one model response may ask for.
 *
 * Matches `MAX_TOOL_CALLS` in `@bayz/router`'s 9B tool parsing deliberately: two
 * different bounds on the same wire array would mean one layer accepted a batch the
 * other refused, and the disagreement would be the interesting case for an attacker.
 */
export const DISPATCH_CALLS_MAX = 8;

/** 32 KiB per argument blob and per capability output, matching 9B. */
export const DISPATCH_ARGUMENT_MAX_BYTES = 32 * 1024;

/**
 * How deep a tool chain may recurse.
 *
 * A capability may itself dispatch — that is what makes an agentic tool useful — so
 * without a bound a model can drive unbounded recursion, and each level holds a
 * request, a stack frame, and possibly an upstream socket. Four is enough for a real
 * chain (call → refine → call → summarize) and small enough that the worst case is
 * boring.
 */
export const DISPATCH_DEPTH_MAX = 4;

/**
 * The authenticated caller, as dispatch sees it.
 *
 * Structurally identical to the server's `BayzPrincipal`, and deliberately *not* an
 * import of it: `@bayz/capability` depends on `@bayz/identity` only, so the package
 * cannot reach a request, a route, or a credential even by accident. `scopes` is a
 * `ReadonlySet` because authority is a fixed set decided at authentication time —
 * nothing downstream of that point may add to it.
 */
export type DispatchPrincipal = {
  readonly id: string;
  readonly scopes: ReadonlySet<ClientScope>;
};

/** Why a call was refused. Fixed codes; a client can branch on these. */
export type DispatchRefusalCode =
  | "invalid_tool_call"
  | "invalid_tool_arguments"
  | "tool_arguments_too_large"
  | "unknown_capability"
  | "capability_forbidden"
  | "capability_failed"
  | "dispatch_depth_exceeded";

/**
 * The result of one call.
 *
 * `name` is present on both variants so a client can correlate a refusal with the call
 * it made. It is safe to carry because it is only ever a value that matched
 * `CAPABILITY_NAME_PATTERN` — at most 64 lowercase ASCII characters — and is replaced
 * by a fixed placeholder otherwise. That is the one piece of model-supplied text that
 * crosses this boundary, and it is bounded and character-restricted before it does.
 *
 * Nothing else from the model appears: not the arguments, not the handler's own error
 * message. A refusal reaches an operator's structured log and, in Task 3, a client
 * response, so echoing model text would hand an upstream a way to plant instructions
 * in a place a human or a downstream agent later reads.
 */
export type DispatchOutcome =
  | {
      readonly status: "ok";
      readonly id: string;
      readonly name: string;
      readonly output: unknown;
    }
  | {
      readonly status: "refused";
      readonly id: string;
      readonly name: string;
      readonly code: DispatchRefusalCode;
      /** Which pipeline stage refused. The diagnosis, in place of model text. */
      readonly stage: string;
    };

export type DispatchToolCallsOptions = {
  readonly principal: DispatchPrincipal;
  /** The raw `tool_calls` array from the upstream response. Fully untrusted. */
  readonly calls: unknown;
  /** Current recursion level, 1 for a top-level dispatch. */
  readonly depth?: number;
};

/** Reported when the model's name was unusable, so nothing unbounded is echoed. */
const UNNAMED = "unknown";
/** Reported when the model's call id was unusable but an outcome still needs an address. */
const UNIDENTIFIED = "call_unidentified";

const CALL_KEYS: ReadonlySet<string> = new Set(["id", "type", "function", "index"]);
const CALL_FUNCTION_KEYS: ReadonlySet<string> = new Set(["name", "arguments"]);
const CALL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * An own-property object with an ordinary prototype.
 *
 * The prototype check is the load-bearing half. `Object.create({ function: … })` looks
 * like a valid call to any code that reads `entry.function`, while `Object.keys` sees
 * nothing — so a key-set check alone would pass an envelope whose fields all arrive
 * through the prototype chain.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return false;
    }
  }
  return true;
}

function refuse(
  id: string,
  name: string,
  code: DispatchRefusalCode,
  stage: string,
): DispatchOutcome {
  return { status: "refused", id, name, code, stage };
}

/**
 * Best-effort id for reporting, before the envelope has been validated.
 *
 * A refusal still has to be addressable — a client that cannot match an outcome to its
 * call learns only that *something* failed. The id is accepted for reporting only when
 * it matches the bounded pattern, so an unusable one becomes a fixed placeholder
 * rather than arbitrary model text.
 */
function reportableId(entry: unknown): string {
  if (!isPlainObject(entry)) {
    return UNIDENTIFIED;
  }
  const id = entry.id;
  return typeof id === "string" && CALL_ID_PATTERN.test(id) ? id : UNIDENTIFIED;
}

/** Same rule for the name: reportable only if it could have been a capability. */
function reportableName(entry: unknown): string {
  if (!isPlainObject(entry)) {
    return UNNAMED;
  }
  const fn = entry.function;
  if (!isPlainObject(fn)) {
    return UNNAMED;
  }
  const name = fn.name;
  return typeof name === "string" && CAPABILITY_NAME_PATTERN.test(name) ? name : UNNAMED;
}

/**
 * Is this a granted scope set we are willing to authorize from?
 *
 * Fails closed on anything that is not a real `Set`. An array, a plain object, a
 * string, or `undefined` are each things a permissive implementation could read as
 * "scopes unknown, so allow" — the same class of bug as a missing `default:` in an
 * authorization switch. A `Set` is also what makes `satisfies` meaningful: `.has` on
 * an array is not a function, and on an object literal it would walk the prototype.
 */
function usableScopes(principal: unknown): ReadonlySet<ClientScope> | undefined {
  if (typeof principal !== "object" || principal === null) {
    return undefined;
  }
  const scopes = (principal as { scopes?: unknown }).scopes;
  return scopes instanceof Set ? (scopes as ReadonlySet<ClientScope>) : undefined;
}

/**
 * Validate the one call envelope and hand back the name and raw arguments string.
 *
 * Unknown keys are refused rather than ignored. Ignoring them is safe *today* and a
 * silent hole the moment any future field on this object is read — a call carrying
 * `{ scopes: ["admin"] }` must be a hard refusal, not a field nobody looked at yet.
 */
function readEnvelope(
  entry: unknown,
): { name: string; args: string } | { stage: string } {
  if (!isPlainObject(entry)) {
    return { stage: "dispatch-call-shape" };
  }
  if (!hasOnlyKeys(entry, CALL_KEYS)) {
    return { stage: "dispatch-call-unknown-key" };
  }
  if (entry.type !== "function") {
    return { stage: "dispatch-call-type" };
  }
  if (typeof entry.id !== "string" || !CALL_ID_PATTERN.test(entry.id)) {
    return { stage: "dispatch-call-id" };
  }

  const fn = entry.function;
  if (!isPlainObject(fn)) {
    return { stage: "dispatch-call-function-shape" };
  }
  if (!hasOnlyKeys(fn, CALL_FUNCTION_KEYS)) {
    return { stage: "dispatch-call-function-unknown-key" };
  }
  if (typeof fn.name !== "string") {
    return { stage: "dispatch-call-name" };
  }
  // `arguments` stays the opaque JSON string the OpenAI contract defines. An object
  // here would mean somebody already parsed it, and the parse stage is where the byte
  // cap and the shape guard live.
  if (typeof fn.arguments !== "string" || fn.arguments.length === 0) {
    return { stage: "dispatch-arguments-type" };
  }
  return { name: fn.name, args: fn.arguments };
}

/**
 * Dispatch one model-emitted tool call.
 *
 * The pipeline, in this order, and the order is the security property:
 *
 * ```text
 * depth → envelope → byte cap → JSON parse → shape → lookup → scope → parse → run
 * ```
 *
 * **Scope is checked before `parse`.** A handler's `parse` walks a structure the model
 * authored, so it is attacker-reachable code; running it for a caller who has no right
 * to the capability would put untrusted input through the least-exercised code path in
 * the system on behalf of somebody who should already have been turned away. It also
 * means a handler can be written knowing every input it sees came from an authorized
 * caller.
 */
async function dispatchOne(
  entry: unknown,
  principal: DispatchPrincipal,
  depth: number,
): Promise<DispatchOutcome> {
  const id = reportableId(entry);
  const reported = reportableName(entry);

  /*
   * Depth first, before anything else is even inspected.
   *
   * An invalid depth — `NaN`, zero, a negative, a fraction — is treated as *past* the
   * bound rather than coerced to 1. Coercing would let a buggy or hostile handler
   * reset the recursion budget on every hop, which turns the bound into decoration.
   */
  if (!Number.isInteger(depth) || depth < 1 || depth > DISPATCH_DEPTH_MAX) {
    return refuse(id, reported, "dispatch_depth_exceeded", "dispatch-depth-bound");
  }

  const envelope = readEnvelope(entry);
  if ("stage" in envelope) {
    return refuse(id, reported, "invalid_tool_call", envelope.stage);
  }

  // Measured in bytes, not `.length`. A cap on UTF-16 code units admits roughly three
  // times the intended payload for CJK or emoji text.
  if (Buffer.byteLength(envelope.args, "utf8") > DISPATCH_ARGUMENT_MAX_BYTES) {
    return refuse(id, reported, "tool_arguments_too_large", "dispatch-arguments-bytes");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(envelope.args);
  } catch {
    return refuse(id, reported, "invalid_tool_arguments", "dispatch-arguments-json");
  }
  if (!isPlainObject(raw)) {
    // A bare scalar or array is not an argument set. Forwarding one would push the
    // same type confusion into every handler, where each would have to re-derive this
    // guard and one would forget.
    return refuse(id, reported, "invalid_tool_arguments", "dispatch-arguments-object");
  }

  const handler = lookupCapability(envelope.name);
  if (handler === undefined) {
    /*
     * The model cannot name a capability into existence.
     *
     * This refusal is structural: no lookup matched because nothing registered that
     * name. It is not a blocklist hit, which is why `read_provider_credentials` and
     * `fetch_pr0vider_k3ys` fail identically and for the same reason.
     */
    return refuse(id, reported, "unknown_capability", "dispatch-lookup");
  }

  const granted = usableScopes(principal);
  if (granted === undefined || !satisfies(granted, handler.requiredScope)) {
    return refuse(id, reported, "capability_forbidden", "dispatch-scope");
  }

  let input: unknown;
  try {
    input = handler.parse(raw);
  } catch {
    // The handler's own message is discarded, not chained. A `parse` that quotes the
    // offending argument in its message is the realistic version of a leak here.
    return refuse(id, reported, "invalid_tool_arguments", "dispatch-parse");
  }

  let output: unknown;
  try {
    output = await handler.run(input);
  } catch {
    return refuse(id, reported, "capability_failed", "dispatch-run");
  }

  /*
   * The output is checked before it is handed back.
   *
   * In Task 3 this value becomes a `role: "tool"` message on the next turn and part of
   * an HTTP response, so a cycle or an unbounded blob would fail at serialization time
   * — past the point where a clean refusal is still possible. `undefined` is refused
   * too: a capability that returns nothing would silently become an empty tool result,
   * which reads to the model as "the tool ran and found nothing".
   */
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(output);
  } catch {
    serialized = undefined;
  }
  if (typeof serialized !== "string") {
    return refuse(id, reported, "capability_failed", "dispatch-output");
  }
  if (Buffer.byteLength(serialized, "utf8") > DISPATCH_ARGUMENT_MAX_BYTES) {
    return refuse(id, reported, "capability_failed", "dispatch-output");
  }

  return { status: "ok", id, name: handler.name, output };
}

/**
 * Dispatch a model response's tool calls.
 *
 * Per-call problems become per-call refusals rather than a thrown error, so one
 * hostile call in a batch cannot deny service to the client's real work. Only
 * *batch-level* violations throw, because there is no per-call outcome to attach them
 * to — an over-bound batch is refused wholesale rather than truncated, since running
 * the first eight and dropping the rest is both a partial execution nobody asked for
 * and an unreportable outcome for what was dropped.
 *
 * Calls run sequentially. Concurrency here would multiply whatever resource the
 * capabilities touch by the batch size at exactly the moment a hostile response is
 * trying to, and the 9F outbound cap bounds sockets rather than handler work.
 */
export async function dispatchToolCalls(
  options: DispatchToolCallsOptions,
): Promise<DispatchOutcome[]> {
  const { principal, calls } = options;
  const depth = options.depth ?? 1;

  if (!Array.isArray(calls) || calls.length === 0) {
    throw new CapabilityError("invalid_tool_call", "dispatch-calls-shape");
  }
  if (calls.length > DISPATCH_CALLS_MAX) {
    // Refused before a single element is inspected, so a 10,000-entry flood costs one
    // length comparison.
    throw new CapabilityError("too_many_tool_calls", "dispatch-calls-bound");
  }

  const outcomes: DispatchOutcome[] = [];
  for (const entry of calls) {
    outcomes.push(await dispatchOne(entry, principal, depth));
  }
  return outcomes;
}
