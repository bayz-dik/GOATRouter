/**
 * Loader hooks: resolve `node:child_process` to a module that refuses to spawn — Phase 9K Task 7.
 *
 * Installed by `tests/offline-recursion.test.mjs` **before** it imports `scripts/offline-check.mjs`, so
 * the check's `import { execFileSync } from "node:child_process"` binds to the refusing stub rather than
 * the real function.
 *
 * **Resolution-time substitution is the only mechanism that works, and it must be the synchronous one.**
 * Two measured constraints shaped this file:
 *
 *   * monkey-patching is not enough. ESM named imports are live bindings into the exporting module's own
 *     slots, so assigning to the namespace object — `cp.execFileSync = …` — leaves every existing
 *     `import { execFileSync }` pointing at the original. Tried three ways (patch before the import, patch
 *     after it, patch from an `--import` preload); all three still started a real process;
 *   * it must be `module.registerHooks`, **not** `module.register`. `register()` runs the hooks on a
 *     dedicated worker thread, and this project's mutation diagnostics bound the child's `RLIMIT_NPROC` to
 *     contain a possible fork storm — under which the worker cannot start and the whole file dies with
 *     `ERR_WORKER_INIT_FAILED: EAGAIN` before a single test runs. A regression that only works when the
 *     process has thread headroom to spare is not one you can run under containment, and containment is
 *     the entire point here. `registerHooks` is synchronous and in-thread, so it needs no headroom at all.
 *
 * @see tests/helpers/blocked-child-process.mjs for why the capability is removed rather than avoided.
 */

import { registerHooks } from "node:module";

const BLOCKED = new URL("./blocked-child-process.mjs", import.meta.url).href;

/** Install the substitution. Idempotent enough to call once per test process; call it before any import. */
export function blockChildProcessModule() {
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "node:child_process" || specifier === "child_process") {
        return { url: BLOCKED, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
}
