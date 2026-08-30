/**
 * A `node:child_process` replacement in which every spawning function refuses — Phase 9K Task 7.
 *
 * **Why this module exists.** `tests/offline-recursion.test.mjs` proves a fork-bomb property by
 * intercepting the check's injectable `spawn` seam and counting attempted descendants instead of
 * creating them. That interception is sound only for as long as every child really does go through the
 * seam. A mutation that adds a direct `execFileSync` call — exactly the K24f mutation in the phase's
 * mutation set — spawns *outside* the injected stub, and because the thing it spawns is the root suite,
 * which contains this very test file, the mutation reproduces the real recursive process tree the test
 * exists to prevent. That is not a hypothetical: it is what killed the fourth verification session on
 * this device, at the sixth mutation of an otherwise bounded run.
 *
 * A test designed to prove protection against a fork bomb must not be capable of creating one, under any
 * mutation, including mutations nobody has written yet. So the capability is removed from the test process
 * rather than merely routed around: `tests/offline-recursion.test.mjs` registers a loader hook that
 * resolves `node:child_process` to this module, and any code in that process which tries to start a
 * child gets a thrown `BAYZ_SPAWN_BLOCKED` instead of a process.
 *
 * **Monkey-patching the module namespace does not work, and was measured rather than assumed.** Patching
 * `cp.execFileSync` after import, before import, or from an `--import` preload all leave
 * `import { execFileSync } from "node:child_process"` bound to the original function: ESM named imports
 * are live bindings to the module's own slot, not property lookups on the namespace object. Only
 * substituting the module at resolution time reaches them, which is why this is a loader hook and not
 * three lines of assignment.
 *
 * Every refusal is **recorded before it throws**, so a test can assert the count is zero — the difference
 * between "nothing was spawned" and "nothing tried to spawn" is the whole finding when a mutation
 * bypasses the seam.
 */

/** Attempts are recorded on the global object so the counter survives this module's own re-import. */
const ATTEMPTS = (globalThis.__bayzBlockedSpawnAttempts ??= []);

/** Every attempted child start in this process, in order. Read by the regression harness. */
export function blockedSpawnAttempts() {
  return [...ATTEMPTS];
}

export function clearBlockedSpawnAttempts() {
  ATTEMPTS.length = 0;
}

class SpawnBlockedError extends Error {
  constructor(name, args) {
    const file = typeof args[0] === "string" ? args[0] : String(args[0]);
    const argv = Array.isArray(args[1]) ? args[1] : [];
    super(
      `BAYZ_SPAWN_BLOCKED: child_process.${name}(${JSON.stringify(file)}${argv.length > 0 ? `, ${JSON.stringify(argv)}` : ""})` +
        " — this process may not start children. A regression that proves a fork-bomb break must not be" +
        " able to create one; route the child through the injectable seam instead.",
    );
    this.name = "SpawnBlockedError";
    this.code = "BAYZ_SPAWN_BLOCKED";
    this.attempted = { fn: name, file, args: argv };
  }
}

function blocked(name) {
  return function refuse(...args) {
    const error = new SpawnBlockedError(name, args);
    ATTEMPTS.push(error.attempted);
    throw error;
  };
}

/*
 * The full spawning surface, not just the one function the check happens to use today. A mutation that
 * reached for `spawnSync` or `execSync` instead would otherwise walk straight through this module.
 */
export const execFileSync = blocked("execFileSync");
export const execSync = blocked("execSync");
export const spawnSync = blocked("spawnSync");
export const spawn = blocked("spawn");
export const exec = blocked("exec");
export const execFile = blocked("execFile");
export const fork = blocked("fork");

/** Non-spawning members real callers legitimately use, so blocking spawns does not break unrelated code. */
export const ChildProcess = class ChildProcess {};

export default {
  ChildProcess,
  exec,
  execFile,
  execFileSync,
  execSync,
  fork,
  spawn,
  spawnSync,
  blockedSpawnAttempts,
  clearBlockedSpawnAttempts,
};
