/**
 * Deterministic fuzz harness — Phase 9I Task 1.
 *
 * Zero dependencies, by lock: the fuzzers are plain Node scripts using `node:crypto` only
 * for seeding, never for per-draw randomness.
 *
 * The design is driven by one requirement above all others: **a failure must be replayable
 * from its seed alone, in a different process, tomorrow.** A crash found at iteration 3,812
 * of a 5,000-iteration run is worthless if the input that caused it cannot be regenerated.
 * That rules out `Math.random()`, anything reading the clock or the pid, and
 * `crypto.randomBytes` at draw time. So: the seed is hashed once to build state, and every
 * subsequent draw is a pure function of that state.
 *
 * The harness is deliberately paranoid in three places, each because the alternative is a
 * suite that lies:
 *
 *   1. It keeps going after a failure. A boundary that breaks on one hostile shape usually
 *      breaks on several; stopping at the first turns one run into ten edit-rerun cycles.
 *   2. It attributes `unhandledRejection` and `uncaughtException` to the iteration that was
 *      running. Node's default for an escaped rejection is to kill the process, which would
 *      look like a host problem rather than the boundary defect it is.
 *   3. It refuses to run at all if a generated input — or a reported error — carries
 *      credential-shaped data. Failing inputs get written to the regression corpus and
 *      committed (Task 3), so a boundary that echoed a provider key back inside an error
 *      message would otherwise put that key in git history.
 *
 * A slow iteration is a **failure**, not a performance note: unbounded time on a hostile
 * input is a denial of service, so the per-iteration budget records the input the same way
 * a thrown error does.
 */

import { createHash } from "node:crypto";

/** Largest single generated input, in bytes. A generator bug must not exhaust memory. */
export const MAX_INPUT_BYTES = 1024 * 1024;

/**
 * Per-iteration wall-clock budget. Task 3's contract for every boundary target is that no
 * iteration exceeds 250 ms.
 */
export const DEFAULT_ITERATION_BUDGET_MS = 250;

/** Total wall-clock budget. Bounded so a fuzz run can never become an unbounded job. */
export const DEFAULT_TIME_BUDGET_MS = 300_000;

/**
 * Credential shapes, verbatim from the Phase 9I plan's Task 1 lock.
 *
 * Applied per-string with `^`/`$` anchors on the hex arm, so 63 and 65 hex characters are
 * *not* matched — the corpus legitimately needs long hex-ish strings, and a scan eager
 * enough to block them would get switched off, which is worse than no scan.
 */
const CREDENTIAL_RE = /sk-|Bearer |BEGIN [A-Z ]*PRIVATE KEY|^[0-9a-f]{64}$/;

export class FuzzError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "FuzzError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function rotl(value, bits) {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

/**
 * xoshiro128** over a SHA-256 seed expansion.
 *
 * The seed's *type* is part of the hash input, so `createRng(1)` and `createRng("1")` are
 * different streams. Without that, `String(seed)` would silently collapse them and a
 * numeric seed recorded in a transcript could replay as a different sequence.
 */
export function createRng(seed) {
  if (seed === undefined || seed === null) {
    throw new FuzzError("fuzz_options", "createRng requires a seed");
  }

  const digest = createHash("sha256").update(`bayz-fuzz:${typeof seed}:${String(seed)}`).digest();
  const state = new Uint32Array(4);
  for (let i = 0; i < 4; i += 1) state[i] = digest.readUInt32LE(i * 4);

  // All-zero state is a fixed point for xoshiro; SHA-256 makes it practically impossible,
  // but a generator that silently returns zeros forever is worth one branch to rule out.
  if ((state[0] | state[1] | state[2] | state[3]) === 0) state[0] = 0x9e3779b9;

  function nextUint32() {
    const result = Math.imul(rotl(Math.imul(state[1], 5) >>> 0, 7), 9) >>> 0;
    const t = (state[1] << 9) >>> 0;

    state[2] = (state[2] ^ state[0]) >>> 0;
    state[3] = (state[3] ^ state[1]) >>> 0;
    state[1] = (state[1] ^ state[2]) >>> 0;
    state[0] = (state[0] ^ state[3]) >>> 0;
    state[2] = (state[2] ^ t) >>> 0;
    state[3] = rotl(state[3], 11);

    return result;
  }

  const rng = {
    nextUint32,
    /** Float in [0, 1). 2**32 divisor keeps the upper bound exclusive. */
    next() {
      return nextUint32() / 0x1_0000_0000;
    },
    /** Integer in [min, max], inclusive at both ends. */
    int(min, max) {
      const lo = Math.ceil(min);
      const hi = Math.floor(max);
      if (hi <= lo) return lo;
      const span = hi - lo + 1;
      return lo + (nextUint32() % span);
    },
    bool() {
      return (nextUint32() & 1) === 1;
    },
    bytes(count) {
      const out = Buffer.allocUnsafe(count);
      for (let i = 0; i < count; i += 1) out[i] = nextUint32() & 0xff;
      return out;
    },
    pick(values) {
      if (!Array.isArray(values) || values.length === 0) {
        throw new FuzzError("fuzz_options", "pick requires a non-empty array");
      }
      return values[rng.int(0, values.length - 1)];
    },
    /** A fresh independent stream, so a generator can branch without disturbing the parent. */
    fork(label) {
      return createRng(`${label}:${nextUint32()}`);
    },
  };

  return rng;
}

/**
 * Walk any value and report the first credential-shaped string found, or null.
 *
 * Object *keys* are scanned as well as values: a key is just as committed as a value once
 * the failing input is written to the corpus. Depth and visited-set bounds keep a hostile
 * generated shape (deep nesting, cycles) from turning the scan itself into the hang it is
 * meant to prevent.
 */
export function findCredentialShape(value, depth = 0, seen = new Set()) {
  if (depth > 64) return null;

  if (typeof value === "string") {
    return CREDENTIAL_RE.test(value) ? value.slice(0, 24) : null;
  }
  if (value === null || typeof value !== "object") return null;

  if (seen.has(value)) return null;
  seen.add(value);

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return findCredentialShape(Buffer.from(value).toString("latin1"), depth + 1, seen);
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const hit = findCredentialShape(entry, depth + 1, seen);
      if (hit) return hit;
    }
    return null;
  }

  for (const [key, entry] of Object.entries(value)) {
    const keyHit = findCredentialShape(key, depth + 1, seen);
    if (keyHit) return keyHit;
    const hit = findCredentialShape(entry, depth + 1, seen);
    if (hit) return hit;
  }
  return null;
}

/** Byte size of a generated input, for the 1 MiB cap. */
function inputBytes(value) {
  if (typeof value === "string") return Buffer.byteLength(value);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value.length;
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 0 : Buffer.byteLength(encoded);
  } catch {
    // Circular or non-serialisable: not measurable, so not capped. The cap exists to stop
    // memory exhaustion from a runaway generator, and a cycle is not a size problem.
    return 0;
  }
}

function describeError(error) {
  if (error instanceof Error) {
    const code = error.code === undefined ? "" : ` [${String(error.code)}]`;
    return `${error.name}${code}: ${error.message}`;
  }
  if (typeof error === "string") return error;
  try {
    return `non-error thrown: ${JSON.stringify(error)}`;
  } catch {
    return "non-error thrown: <unserialisable>";
  }
}

function tick() {
  // setImmediate lands after the microtask queue drains, which is when Node emits
  // unhandledRejection — so a floating rejection from the iteration just finished is
  // attributed to that iteration rather than leaking into the next one.
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Run `iterations` generated inputs through `run`.
 *
 * Returns `{ name, seed, iterations, completed, truncated, durationMs, failures }` where
 * `iterations` is what was *requested* and `completed` is what actually ran — reporting the
 * requested count as though it had run is the specific dishonesty this shape prevents.
 *
 * Throws `FuzzError` — rather than recording a failure — for problems that make the whole
 * run untrustworthy: bad options, an oversized input, or credential-shaped data anywhere.
 */
export async function fuzz(options) {
  const { name, seed, iterations, generate, run } = options ?? {};
  const iterationBudgetMs = options?.iterationBudgetMs ?? DEFAULT_ITERATION_BUDGET_MS;
  const timeBudgetMs = options?.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;

  if (typeof name !== "string" || name.length === 0) {
    throw new FuzzError("fuzz_options", "fuzz requires a non-empty name");
  }
  if (seed === undefined || seed === null) {
    throw new FuzzError("fuzz_options", `fuzz(${name}) requires a seed`);
  }
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new FuzzError("fuzz_options", `fuzz(${name}) requires a positive integer iteration count`);
  }
  if (typeof generate !== "function") {
    throw new FuzzError("fuzz_options", `fuzz(${name}) requires a generate function`);
  }
  if (typeof run !== "function") {
    throw new FuzzError("fuzz_options", `fuzz(${name}) requires a run function`);
  }

  const rng = createRng(seed);
  const failures = [];
  const startedAt = Date.now();

  let currentIteration = -1;
  let currentInput;
  let escaped = null;

  const record = (failure) => {
    // Scan before keeping: Task 3 writes failing inputs to a committed corpus, so an error
    // message echoing a secret must abort the run rather than be saved.
    const hit = findCredentialShape(failure.error) ?? findCredentialShape(failure.input);
    if (hit) {
      escaped = new FuzzError(
        "credential_shape",
        `fuzz(${name}) refused a failure carrying credential-shaped data: ${JSON.stringify(hit)}`,
      );
      return;
    }
    failures.push(failure);
  };

  const onRejection = (reason) => {
    record({
      iteration: currentIteration,
      kind: "unhandledRejection",
      input: currentInput,
      error: describeError(reason),
    });
  };
  const onException = (error) => {
    record({
      iteration: currentIteration,
      kind: "uncaughtException",
      input: currentInput,
      error: describeError(error),
    });
  };

  /*
   * Take *exclusive* ownership of both events for the duration of the run, then put the
   * previous listeners back byte-for-byte.
   *
   * Merely adding a listener is not enough. Node's default for an escaped rejection is to
   * kill the process, and `node --test` installs its own handler that fails the enclosing
   * test — so a floating rejection from a fuzzed boundary would be reported as a harness
   * failure (or a dead process) instead of the boundary defect it is. Attribution is the
   * whole point of these two hooks, and attribution requires being the only listener.
   *
   * Restoration is not optional: leaving the process without its original handlers would
   * silently disarm crash reporting for everything that runs after a fuzz target.
   */
  const priorRejection = process.listeners("unhandledRejection");
  const priorException = process.listeners("uncaughtException");
  process.removeAllListeners("unhandledRejection");
  process.removeAllListeners("uncaughtException");
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);

  let completed = 0;
  let truncated = false;

  try {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      if (Date.now() - startedAt >= timeBudgetMs) {
        truncated = true;
        break;
      }

      currentIteration = iteration;
      currentInput = undefined;

      const input = generate(rng, { iteration, name, seed });

      const size = inputBytes(input);
      if (size > MAX_INPUT_BYTES) {
        throw new FuzzError(
          "input_too_large",
          `fuzz(${name}) generated a ${size}-byte input at iteration ${iteration}, over the ${MAX_INPUT_BYTES}-byte cap`,
          { iteration, size },
        );
      }

      const hit = findCredentialShape(input);
      if (hit) {
        throw new FuzzError(
          "credential_shape",
          `fuzz(${name}) generated credential-shaped data at iteration ${iteration}: ${JSON.stringify(hit)}`,
          { iteration },
        );
      }

      currentInput = input;

      const iterationStart = Date.now();
      try {
        const outcome = run(input, { iteration, name, seed, rng });
        if (outcome && typeof outcome.then === "function") {
          // Race the budget rather than awaiting blindly: a boundary that hangs must be
          // reported with its input, not left to consume the whole run.
          let timer;
          const budget = new Promise((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new FuzzError("iteration_budget", `iteration exceeded the ${iterationBudgetMs} ms budget`)),
              iterationBudgetMs,
            );
          });
          try {
            await Promise.race([outcome, budget]);
          } finally {
            clearTimeout(timer);
            // The losing promise must not surface later as an unhandledRejection charged
            // to some innocent iteration.
            if (outcome && typeof outcome.catch === "function") outcome.catch(() => {});
          }
        }

        const elapsed = Date.now() - iterationStart;
        if (elapsed > iterationBudgetMs) {
          record({
            iteration,
            kind: "budget",
            input,
            error: `iteration took ${elapsed} ms, over the ${iterationBudgetMs} ms budget`,
          });
        }
      } catch (error) {
        if (error instanceof FuzzError && error.code === "iteration_budget") {
          record({ iteration, kind: "budget", input, error: error.message });
        } else {
          record({ iteration, kind: "throw", input, error: describeError(error) });
        }
      }

      completed += 1;

      // Give Node a turn so anything the iteration detached surfaces now, while
      // currentIteration still points at it.
      await tick();

      if (escaped) throw escaped;
    }

    await tick();
    if (escaped) throw escaped;
  } finally {
    process.removeListener("unhandledRejection", onRejection);
    process.removeListener("uncaughtException", onException);
    for (const listener of priorRejection) process.on("unhandledRejection", listener);
    for (const listener of priorException) process.on("uncaughtException", listener);
  }

  return {
    name,
    seed,
    iterations,
    completed,
    truncated,
    durationMs: Date.now() - startedAt,
    failures,
  };
}

/** Compact one-line summary for a smoke script. */
export function summarise(result) {
  const shape = result.truncated ? `${result.completed}/${result.iterations} (time-capped)` : `${result.completed}`;
  return `${result.name}: ${shape} iterations, ${result.failures.length} failures, seed=${String(result.seed)}, ${result.durationMs} ms`;
}
