/**
 * Shared contract for every Phase 9I boundary fuzz target — Task 3.
 *
 * The contract the plan states, restated as code so no target can quietly weaken it:
 * a boundary must **reject or accept**. Never crash, never hang, never throw a non-BAYZ
 * error, never mutate global state.
 *
 * "Never throw a non-BAYZ error" is the sharp end. A `TypeError: Cannot read properties of
 * undefined` escaping a validator means the validator did not validate — it fell over on the
 * way to deciding, and whatever it was protecting was reached with unchecked input. Likewise
 * a `RangeError` from an unguarded array length, or an `ERR_INTERNAL_ASSERTION` from Node
 * itself. Those are the defects this phase exists to find, so they are recorded as failures
 * rather than tolerated as "well, it did reject it".
 */

/** Error class names that are a legitimate BAYZ rejection. */
export const BAYZ_ERROR_NAMES = Object.freeze(
  new Set([
    "RouterError",
    "GatewayError",
    "ProviderError",
    "ProxyError",
    "StorageError",
    "TelemetryError",
    "IdentityError",
    "CapabilityError",
  ]),
);

/**
 * Engine errors that must never escape a boundary.
 *
 * `TypeError` and `RangeError` are included by *name* because that is how they arrive from a
 * validator that dereferenced something it had not checked.
 */
export const ENGINE_ERROR_NAMES = Object.freeze(new Set(["TypeError", "RangeError", "ReferenceError", "SyntaxError"]));

export const ENGINE_ERROR_CODES = Object.freeze(
  new Set(["ERR_INTERNAL_ASSERTION", "ERR_OUT_OF_RANGE", "ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_VALUE", "ERR_ASSERTION"]),
);

/**
 * Assert a caught error is a legitimate BAYZ rejection with a code from the owning
 * package's vocabulary.
 *
 * Rethrows a descriptive Error when it is not, so the harness records it as a failure with
 * the input attached.
 */
export function expectBayzError(error, allowedCodes, context) {
  if (!(error instanceof Error)) {
    throw new Error(`${context}: threw a non-Error value (${typeof error})`);
  }

  const code = typeof error.code === "string" ? error.code : undefined;

  if (ENGINE_ERROR_CODES.has(code ?? "")) {
    throw new Error(`${context}: engine error escaped the boundary: ${error.name} [${code}]`);
  }
  if (!BAYZ_ERROR_NAMES.has(error.name)) {
    // Named explicitly rather than lumped in: an engine error is a different diagnosis from
    // a stray custom error, and the report should say which.
    const kind = ENGINE_ERROR_NAMES.has(error.name) ? "engine error" : "non-BAYZ error";
    throw new Error(`${context}: ${kind} escaped the boundary: ${error.name}: ${error.message}`);
  }
  if (code === undefined) {
    throw new Error(`${context}: ${error.name} carried no code`);
  }
  if (!allowedCodes.has(code)) {
    throw new Error(`${context}: ${error.name} used the unexpected code ${JSON.stringify(code)}`);
  }
  return code;
}

/**
 * Run `fn`, tolerating a BAYZ rejection and re-raising anything else.
 *
 * Returns `{ accepted: true, value }` or `{ accepted: false, code }` so a target can assert
 * something about the accepted value when it matters.
 */
export function rejectOrAccept(fn, allowedCodes, context) {
  try {
    return { accepted: true, value: fn() };
  } catch (error) {
    return { accepted: false, code: expectBayzError(error, allowedCodes, context) };
  }
}

/** Same, for an async boundary. */
export async function rejectOrAcceptAsync(fn, allowedCodes, context) {
  try {
    return { accepted: true, value: await fn() };
  } catch (error) {
    return { accepted: false, code: expectBayzError(error, allowedCodes, context) };
  }
}

/**
 * Snapshot the globals a boundary must not touch.
 *
 * `Object.prototype` is the one that matters: the whole point of refusing `__proto__` keys is
 * that a parsed body must not be able to add a property every object in the process then
 * inherits. A target that fuzzes prototype-pollution shapes and never checks this would miss
 * the exact defect it was aiming at.
 */
export function globalStateSnapshot() {
  return {
    objectProtoKeys: Object.getOwnPropertyNames(Object.prototype).sort().join(","),
    arrayProtoKeys: Object.getOwnPropertyNames(Array.prototype).sort().join(","),
    polluted: JSON.stringify({
      // Read through a fresh object: if a boundary polluted Object.prototype, these become
      // visible on every object in the process.
      polluted: {}.polluted,
      injected: {}.injected,
      isAdmin: {}.isAdmin,
      toString: typeof {}.toString,
    }),
  };
}

export function assertGlobalStateUnchanged(before, context) {
  const after = globalStateSnapshot();
  for (const key of Object.keys(before)) {
    if (after[key] !== before[key]) {
      throw new Error(`${context}: global state mutated (${key})`);
    }
  }
}

/** Current RSS in bytes, for the per-target growth bound. */
export function rss() {
  return process.memoryUsage.rss();
}
