import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEPTH_VARIABLE,
  GUARD_VARIABLE,
  childDepth,
  isInsideOfflineCheck,
  nestedInvocationRefusal,
} from "../scripts/offline-nesting.mjs";
import { blockedSpawnAttempts } from "./helpers/blocked-child-process.mjs";
import { blockChildProcessModule } from "./helpers/block-spawning-hook.mjs";

/*
 * **Remove the ability to spawn before loading the code under test.**
 *
 * Counting attempts through an injected seam is only safe while every child actually goes through the
 * seam. A mutation that adds a direct `execFileSync` — K24f in this phase's mutation set — spawns outside
 * the stub, and what it spawns is the root suite, which contains this file: the mutation reproduces the
 * fork bomb the test exists to prevent. It did, and it killed a verification session.
 *
 * So `node:child_process` is resolved to a module whose every spawning function throws. Three details are
 * load-bearing, and each was measured rather than assumed:
 *
 *   * a **loader hook**, not a monkey-patch — `import { execFileSync } from "node:child_process"` is a live
 *     binding into the real module's slot, and patching the namespace object (before the import, after it,
 *     or from an `--import` preload) leaves that binding pointing at the original in all three cases;
 *   * **`registerHooks`**, not `register` — the latter runs hooks on a worker thread, which cannot start
 *     when the mutation diagnostics cap `RLIMIT_NPROC` to contain a fork storm (`ERR_WORKER_INIT_FAILED:
 *     EAGAIN`, no tests run at all). See `tests/helpers/block-spawning-hook.mjs`;
 *   * the check imported **dynamically, after** the hook is installed. A static import is resolved during
 *     linking, before any statement here executes, so the hook would arrive too late to affect it.
 */
blockChildProcessModule();
const { main } = await import("../scripts/offline-check.mjs");
/** The substituted module, as any code in this process now sees it. Asserted directly below. */
const childProcess = await import("node:child_process");

/**
 * Offline-check recursion regression — Phase 9K Task 7.
 *
 * **The property under test is a fork bomb, and this file proves it without creating one.**
 *
 * The cycle is real: `scripts/offline-check.mjs` runs the root suite → the root suite contains
 * `tests/offline.test.mjs` → that file invokes the check, twice (plainly and with
 * `--simulate-no-guard`). Two children per level is 2^n. On this Termux/proot device the host does not
 * fail it politely — it stops being able to fork and the whole process tree dies by signal, which looks
 * exactly like an unexplained external kill. It took down two verification sessions, and a third with
 * RSS and process-count abort thresholds bolted on: by the time a sampler notices, the kill has already
 * happened. **A live reproduction is therefore not an acceptable verification method for this repository**,
 * and no test in this file starts a process.
 *
 * What replaces it: `scripts/offline-check.mjs` funnels every child through one injectable seam, and
 * `main()` takes its environment as an argument. This harness substitutes a *counting stub* for the seam
 * and a *tiny synthetic child* for the root suite — a deliberately hostile one that always re-invokes the
 * check and never skips — then drives the real control flow and counts the descendants the real code
 * **attempts**. Growth is measured; nothing is spawned.
 *
 * The two halves that make the measurement trustworthy:
 *
 *   1. a **positive control** (`the harness detects unbounded recursion when the refusal is absent`) runs
 *      the same counting stub against a vulnerable implementation and shows the counter blowing its cap
 *      with the 1, 2, 4, 8 doubling — so a green result here means the refusal held, not that the harness
 *      is blind. This is the assertion the live probe used to provide, at no risk;
 *   2. a **seam-integrity** test asserts `execFileSync` is called in exactly one place, because a future
 *      direct call would spawn outside the counter and silently void every measurement above.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK_SOURCE = join(ROOT, "scripts/offline-check.mjs");

/**
 * Hard ceiling on *attempted* descendants in one simulated run.
 *
 * A correct run attempts two. Anything approaching this number is exponential growth, and the harness
 * stops there by throwing rather than by continuing to count: this is a simulation, but an unbounded loop
 * in a test is still an unbounded loop.
 */
const ATTEMPT_CAP = 64;

class AttemptCapExceeded extends Error {}

/**
 * Drive the real `main()` with every child intercepted.
 *
 * The stub answers three kinds of invocation, mirroring what the real children do:
 *
 *   * the guard probe — reports `GUARDED` exactly when the guard is on the child's `NODE_OPTIONS`, which
 *     is what makes the `--simulate-no-guard` branch behave as it really does;
 *   * the root suite — the **hostile synthetic child**. It stands in for `tests/offline.test.mjs` and
 *     re-invokes the check twice with the environment the check actually handed it, *without* the skip
 *     that file performs. Dropping the skip is deliberate: it isolates the check's own refusal as the
 *     load-bearing break, so this passes only if `scripts/offline-check.mjs` is safe even when the suite
 *     it runs is maximally uncooperative;
 *   * a workspace suite — a leaf that reports plausible counts.
 *
 * @returns {{ exit: number, attempts: Array<object>, nested: Array<object>, capExceeded: boolean,
 *             stdout: string, stderr: string }}
 */
function simulate(argv, env, { maxSimulatedDepth = 12 } = {}) {
  const attempts = [];
  const nested = [];
  let capExceeded = false;
  const stdout = [];
  const stderr = [];

  function spawn(file, args, options) {
    const childEnv = options?.env ?? {};
    attempts.push({ file, args, env: childEnv, depth: childEnv[DEPTH_VARIABLE] });
    if (attempts.length > ATTEMPT_CAP) throw new AttemptCapExceeded(`${attempts.length} attempted descendants`);

    const isGuardProbe = args.length === 1 && args[0].endsWith("probe.mjs");
    if (isGuardProbe) {
      const guarded = (childEnv.NODE_OPTIONS ?? "").includes("offline-guard");
      return { ok: true, output: guarded ? "GUARDED\n" : "REACHED\n" };
    }

    const isRootSuite = args[0] === "--test" && args[1] === "tests/*.test.mjs";
    if (isRootSuite) {
      // The hostile synthetic child: tests/offline.test.mjs, minus its own skip.
      const level = Number(childEnv[DEPTH_VARIABLE] ?? "0");
      if (level < maxSimulatedDepth) {
        for (const childArgv of [["--suite", "root"], ["--suite", "root", "--simulate-no-guard"]]) {
          const out = [];
          const err = [];
          const exit = main(childArgv, {
            env: childEnv,
            spawn,
            log: (line) => out.push(line),
            error: (line) => err.push(line),
          });
          nested.push({ argv: childArgv, depth: childEnv[DEPTH_VARIABLE], exit, output: `${out.join("\n")}\n${err.join("\n")}` });
        }
      }
      return { ok: true, output: "\u2139 pass 304\n\u2139 fail 0\n" };
    }

    return { ok: true, output: "\u2139 pass 12\n\u2139 fail 0\n" };
  }

  let exit = -1;
  try {
    exit = main(argv, { env, spawn, log: (line) => stdout.push(line), error: (line) => stderr.push(line) });
  } catch (error) {
    if (!(error instanceof AttemptCapExceeded)) throw error;
    capExceeded = true;
  }
  return { exit, attempts, nested, capExceeded, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

test("a top-level offline check attempts exactly two descendants, however hostile the suite it runs", () => {
  /*
   * The headline claim, and the one the live probe was trying to establish when it killed the session.
   *
   * One guard probe, one root suite. The synthetic root suite then re-invokes the check twice at every
   * opportunity; both re-invocations must be refused *before they spawn anything*, so the total never
   * grows. Asserting the exact number rather than "small" is what makes a regression visible: a fix that
   * merely slowed the growth down would still fail here.
   */
  const result = simulate(["--suite", "root"], {});

  assert.equal(result.capExceeded, false, `the attempt cap was exceeded: ${result.attempts.length} descendants`);
  assert.equal(result.exit, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(
    result.attempts.length,
    2,
    `expected 1 guard probe + 1 suite, got ${result.attempts.length}:\n${result.attempts.map((a) => `${a.file} ${a.args.join(" ")}`).join("\n")}`,
  );
  assert.match(result.stdout, /offline check: PASS/);
});

test("every re-entry from the suite is refused, on the guarded and the unguarded path alike", () => {
  /*
   * `--simulate-no-guard` is the branch that made this task dangerous: its whole purpose is to run with no
   * guard marker, so a break keyed on `BAYZ_OFFLINE_GUARD` does not exist there. Both re-invocations are
   * asserted, by their argv, so a refusal that covered only one path fails by name.
   */
  const result = simulate(["--suite", "root"], {});

  assert.equal(result.nested.length, 2, `expected two re-entry attempts, got ${result.nested.length}`);
  const unguarded = result.nested.filter((entry) => entry.argv.includes("--simulate-no-guard"));
  assert.equal(unguarded.length, 1, "the unguarded re-entry path was not exercised");

  for (const entry of result.nested) {
    const label = entry.argv.join(" ");
    assert.equal(entry.exit, 1, `${label}: a nested invocation did not refuse:\n${entry.output}`);
    assert.match(entry.output, /nested invocation refused/i, `${label}: ${entry.output}`);
    assert.match(entry.output, /offline check: FAIL/, `${label}: ${entry.output}`);
    assert.ok(!/guard active:/.test(entry.output), `${label}: the refusal ran the guard probe first:\n${entry.output}`);
    assert.ok(!/\s(ok|FAIL)\s+root/.test(entry.output), `${label}: the nested run executed a suite:\n${entry.output}`);
  }
});

test("the depth marker reaches every suite child, so the refusal above is reachable", () => {
  /*
   * The refusal is only ever reached if the marker actually arrives. Measured on the real `env` object the
   * check hands its seam, rather than by reading the source: a comment claiming propagation and an `env`
   * that drops it are indistinguishable from the outside, and the failure mode is a fork bomb.
   *
   * Only the guarded path runs suites at all — `--simulate-no-guard` is asserted separately below, since it
   * exits at the guard verification and therefore has no suite child to carry a marker.
   */
  const result = simulate(["--suite", "root"], {});
  const suites = result.attempts.filter((attempt) => !attempt.args[0].endsWith("probe.mjs"));
  assert.ok(suites.length > 0, "no suite child was attempted");
  for (const suite of suites) {
    assert.notEqual(
      suite.depth,
      undefined,
      `${DEPTH_VARIABLE} was not propagated into ${suite.args.join(" ")}`,
    );
  }
});

test("--simulate-no-guard stops at the guard verification and never reaches a suite", () => {
  /*
   * The fourth thing the plan asks to be established: `--simulate-no-guard` cannot recursively re-enter the
   * full offline check. It cannot, and for a reason worth pinning — it scrubs the guard from its probe
   * child, sees the probe reach the network, and refuses *before* the suite loop. So this path contributes
   * exactly one descendant, the probe, and the recursion cannot start here even at depth 0.
   *
   * Asserted because it is load-bearing in the opposite direction too: if a future change made this path
   * run suites, the branch with no guard marker would become a second entry into the cycle.
   */
  const result = simulate(["--suite", "root", "--simulate-no-guard"], {});

  assert.equal(result.exit, 1, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.attempts.length, 1, `expected only the guard probe, got ${result.attempts.length} descendants`);
  assert.match(result.attempts[0].args[0], /probe\.mjs$/);
  assert.equal(result.nested.length, 0, "the unguarded path re-entered the check");
  assert.match(result.stdout, /guard active: NO/);
  assert.match(result.stderr, /offline check: FAIL/);
});

test("the harness detects unbounded recursion when the refusal is absent", () => {
  /*
   * **The positive control, and the reason the tests above mean anything.**
   *
   * A counter that never trips is indistinguishable from a counter wired to nothing — the failure mode
   * that makes a green suite worse than no suite, because it reads as proof. So the same counting
   * discipline is pointed at a vulnerable implementation of the same shape: propagate the environment,
   * spawn a guard probe and a suite, and let the suite re-enter twice with no refusal.
   *
   * Expanded **breadth-first**, one level at a time, which is the honest model of what the real thing does:
   * every process at depth n starts two at depth n+1 and they run concurrently. A depth-first walk would
   * hit the cap down a single spine and report a flat 1-per-level, understating the danger — the shape is
   * the finding, not the total.
   *
   * This reproduces the measurement the live probe died taking, for the cost of a few dozen function calls
   * and no processes at all.
   */
  const perLevel = [];
  let frontier = [{}]; // one top-level invocation
  let total = 0;
  let capExceeded = false;

  for (let level = 0; level < 12; level += 1) {
    perLevel.push(frontier.length);
    total += frontier.length;
    if (total > ATTEMPT_CAP) {
      capExceeded = true;
      break;
    }
    const next = [];
    for (const env of frontier) {
      // The vulnerable check: no `nestedInvocationRefusal` gate, so the suite it runs re-enters twice.
      const childEnv = { ...env, [DEPTH_VARIABLE]: childDepth(env) };
      next.push(childEnv, childEnv); // the run test and the refusal test
    }
    frontier = next;
  }

  assert.equal(capExceeded, true, "a check with no nesting refusal stayed bounded, so the counter proves nothing");
  assert.deepEqual(
    perLevel.slice(0, 5),
    [1, 2, 4, 8, 16],
    `expected 2^n growth per level, measured ${perLevel.join(" ")}`,
  );

  /*
   * And the mechanism that makes the depth marker useless on its own once the refusal is gone: the suite's
   * refusal test *forces* the marker to a literal, so the value stops tracking real depth. The probe that
   * killed a session observed exactly this — depths 0, 1, 1, 2, 2, 3, 3, 4, 4 — which is why the fix is a
   * refusal on presence rather than any kind of depth budget.
   */
  const forced = { ...frontier[0], [DEPTH_VARIABLE]: "1" };
  assert.equal(childDepth(forced), "2", "a forced marker must still increment, but cannot be trusted as depth");
});

test("the refusal is keyed on the marker's presence, not on a value the suite could manipulate", () => {
  /*
   * `tests/offline.test.mjs` legitimately *forces* this variable to a literal when it asserts the refusal,
   * so any accounting that assumed the value only ever increased would be defeated by this project's own
   * suite. Presence is the one property a caller cannot usefully lie about: setting it can only ever cause
   * more refusal, never less.
   */
  assert.equal(nestedInvocationRefusal({}), null, "a top-level invocation was refused");
  assert.equal(nestedInvocationRefusal({ [GUARD_VARIABLE]: "active" }), null, "running under the guard is not nesting");

  for (const value of ["1", "2", "0", "", "nonsense", "-5"]) {
    assert.notEqual(
      nestedInvocationRefusal({ [DEPTH_VARIABLE]: value }),
      null,
      `${DEPTH_VARIABLE}=${JSON.stringify(value)} did not refuse`,
    );
  }

  // A corrupted marker must still mark, rather than propagating NaN and breaking the chain.
  assert.equal(childDepth({}), "1");
  assert.equal(childDepth({ [DEPTH_VARIABLE]: "3" }), "4");
  assert.equal(childDepth({ [DEPTH_VARIABLE]: "nonsense" }), "1");
});

test("the test-side skip predicate honours both markers, since either implies nesting", () => {
  /*
   * The test file's question is broader than the check's: "would spawning the check from here re-enter
   * it?" A suite process running under an armed guard is inside a check even in the hypothetical case
   * where the depth marker failed to propagate, so either marker is sufficient. The cost of a false
   * negative is a fork bomb; the cost of a false positive is a skipped test.
   */
  assert.equal(isInsideOfflineCheck({}), false);
  assert.equal(isInsideOfflineCheck({ [GUARD_VARIABLE]: "active" }), true);
  assert.equal(isInsideOfflineCheck({ [DEPTH_VARIABLE]: "1" }), true);
  assert.equal(isInsideOfflineCheck({ [GUARD_VARIABLE]: "inactive" }), false);
});

test("the check starts child processes through exactly one seam", () => {
  /*
   * Every measurement in this file counts calls that go through `spawnSync`. A direct `execFileSync`
   * added later would spawn outside the counter, and every assertion above would keep passing while the
   * fork bomb came back. So the seam is pinned structurally: one import, one call site.
   *
   * This is now the *second* line of defence rather than the only one — the loader hook at the top of the
   * file means a bypass throws instead of forking — but it stays, and it stays first, because a structural
   * assertion names the defect ("you added a second spawn site") where the hook can only report a symptom.
   */
  const source = readFileSync(CHECK_SOURCE, "utf8");
  const calls = source.match(/execFileSync\(/g) ?? [];
  assert.equal(calls.length, 1, `execFileSync is called ${calls.length} times; every child must go through spawnSync`);
  assert.match(source, /export function spawnSync\(/, "the spawn seam is not exported for the regression harness");

  for (const forbidden of ["child_process\").spawn", "spawnSync(", "execSync("]) {
    if (forbidden === "spawnSync(") continue; // our own seam
    assert.ok(!source.includes(forbidden), `scripts/offline-check.mjs uses ${forbidden}, bypassing the seam`);
  }
});

test("this process cannot start a child at all, so no mutation of the check can fork from here", () => {
  /*
   * **The containment positive control, and the reason the counts above are safe to trust.**
   *
   * Everything else in this file measures what the check *attempts* through an injected stub. That
   * measurement is only safe while a bypass is impossible, so the bypass is made impossible and then the
   * impossibility is demonstrated: a real `execFileSync` of `/bin/true` — the most harmless child there
   * is — must throw `BAYZ_SPAWN_BLOCKED` rather than run.
   *
   * Without this assertion the loader hook could silently stop being registered (a renamed helper, a
   * refactor to a static import) and every test here would keep passing while the K24f mutation regained
   * the ability to fork the root suite. That is precisely the failure that killed a verification session.
   */
  const before = blockedSpawnAttempts().length;

  for (const fn of ["execFileSync", "spawnSync", "execSync", "spawn", "execFile", "exec", "fork"]) {
    assert.equal(typeof childProcess[fn], "function", `child_process.${fn} is missing from the blocking stub`);
    assert.throws(
      () => childProcess[fn]("/bin/true", []),
      (error) => {
        assert.equal(error.code, "BAYZ_SPAWN_BLOCKED", `child_process.${fn} was not blocked: ${error.message}`);
        return true;
      },
      `child_process.${fn} did not refuse`,
    );
  }

  const attempts = blockedSpawnAttempts().slice(before);
  assert.equal(attempts.length, 7, `expected 7 recorded refusals, got ${attempts.length}`);
  assert.deepEqual(
    attempts.map((attempt) => attempt.fn),
    ["execFileSync", "spawnSync", "execSync", "spawn", "execFile", "exec", "fork"],
    "the refusals were not recorded in order, so the counter is not tracking attempts",
  );
});

test("driving the real control flow spawns nothing, measured at the process boundary", () => {
  /*
   * The complement of the test above: having established that a real spawn *would* be caught, assert that
   * driving `main()` produces none. Measured at the `child_process` boundary rather than at the injected
   * seam, so it holds even for a code path that never consults the seam at all — which is exactly the
   * shape of the mutation that made this redesign necessary.
   */
  const before = blockedSpawnAttempts().length;
  simulate(["--suite", "root"], {});
  simulate(["--suite", "root", "--simulate-no-guard"], {});
  const attempted = blockedSpawnAttempts().slice(before);

  assert.deepEqual(
    attempted,
    [],
    `the check reached for a real child process: ${attempted.map((a) => `${a.fn} ${a.file}`).join(", ")}`,
  );
});
