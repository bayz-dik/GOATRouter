/**
 * Offline-check nesting predicates — Phase 9K Task 7.
 *
 * **Why this is its own module with no side effects and no spawning.**
 *
 * `scripts/offline-check.mjs` runs the root suite; the root suite contains `tests/offline.test.mjs`;
 * that file runs the check. The cycle is real and the only thing that breaks it is a nesting refusal.
 * Previously that refusal was a bare `if` at the point of use inside the check's `main()`, and the
 * matching skip predicate was a *second, hand-copied* implementation inside the test file. Two copies
 * of a fork-bomb break is one copy too many: they can drift, and neither could be exercised without
 * spawning the very process tree they exist to prevent.
 *
 * So the decisions live here as pure functions of an environment object. They can be asserted directly,
 * in-process, with no children at all — which is the only acceptable way to test this property. The live
 * reproduction is **not** an acceptable verification method: it is a real fork bomb, it killed two
 * sessions on this Termux/proot device, and abort thresholds did not save the third.
 *
 * @see tests/offline-recursion.test.mjs for the bounded, spawn-free regression harness.
 */

/**
 * Set by the check on **every** child it spawns, guarded or not.
 *
 * A presence marker, not a counter, and that is deliberate: `tests/offline.test.mjs` legitimately
 * *forces* this variable to a literal (`"1"`, `"2"`) when it asserts the refusal, so any accounting that
 * relied on the value increasing monotonically would be defeated by its own test suite. Presence is the
 * only property a caller cannot usefully lie about — setting it can only ever cause *more* refusal.
 */
export const DEPTH_VARIABLE = "BAYZ_OFFLINE_CHECK_DEPTH";

/**
 * Set by `scripts/offline-guard.mjs` when the preload loads.
 *
 * Cannot be the nesting break on its own: the check's `--simulate-no-guard` path exists precisely to run
 * with no guard, so a break keyed only on this variable does not exist on that branch.
 */
export const GUARD_VARIABLE = "BAYZ_OFFLINE_GUARD";

/**
 * Should `scripts/offline-check.mjs` refuse to do any work?
 *
 * Keyed on `DEPTH_VARIABLE` **only**, and not on the guard marker. Running the check under an armed
 * guard (`node --import scripts/offline-guard.mjs scripts/offline-check.mjs`) is an unusual but
 * perfectly legitimate top-level invocation, and refusing it would be refusing a run that is not nested
 * at all.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ depth: string } | null} the refusal with the marker value that triggered it, or `null`.
 */
export function nestedInvocationRefusal(env) {
  const depth = env?.[DEPTH_VARIABLE];
  return depth === undefined ? null : { depth };
}

/**
 * Is the current process running somewhere underneath `scripts/offline-check.mjs`?
 *
 * Broader than {@link nestedInvocationRefusal} on purpose. This answers a *test's* question — "would
 * spawning the check from here re-enter it?" — and a suite process running under the guard is inside a
 * check even in the hypothetical case where the depth marker failed to propagate. Two independent
 * markers, either sufficient, because the cost of a false negative is a fork bomb and the cost of a
 * false positive is a skipped test.
 *
 * @param {Record<string, string | undefined>} env
 */
export function isInsideOfflineCheck(env) {
  return env?.[GUARD_VARIABLE] === "active" || env?.[DEPTH_VARIABLE] !== undefined;
}

/**
 * The marker value to place in a child's environment.
 *
 * Increments so a transcript can show how deep a run got, but nothing depends on the number: the
 * refusal is on presence. A non-numeric inherited value degrades to `1` rather than `NaN`, so a
 * corrupted marker still marks.
 *
 * @param {Record<string, string | undefined>} env the **parent** environment
 */
export function childDepth(env) {
  const inherited = Number(env?.[DEPTH_VARIABLE] ?? "0");
  return String((Number.isFinite(inherited) ? inherited : 0) + 1);
}
