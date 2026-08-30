#!/usr/bin/env node
/**
 * Offline test proof — Phase 9K Task 7.
 *
 * Runs the unit suites with `scripts/offline-guard.mjs` preloaded, so a green result means **no unit test
 * depends on the internet**. A suite that quietly reaches a network fails in someone else's CI, behaves
 * differently offline, and may be passing because a remote service answered rather than because the code
 * is correct.
 *
 * **The guard is verified before the suites are trusted.** A run that passes because the preload silently
 * failed to load is indistinguishable from a run that passes because nothing reached out — so this script
 * first proves the guard blocks a known-bad destination, and refuses to report `PASS` if it does not.
 * `--simulate-no-guard` exercises that refusal.
 *
 * **Bounded on purpose.** Workspace suites run one at a time. Fanning them out exhausts the futex table
 * on the Termux/proot device this project is developed on, which is why `npm run runtime:verify` cannot
 * run here as a single command.
 *
 * **Nesting is refused outright, and that is a hard safety property rather than tidiness.** This script
 * runs the root suite, the root suite contains `tests/offline.test.mjs`, and that file runs this script —
 * two invocations per level, so an unbroken cycle is a fork bomb that doubles at every depth. The
 * decision now lives in `scripts/offline-nesting.mjs` as a pure predicate, shared with the test file
 * instead of hand-copied into it, and is regression-tested **without spawning anything** by
 * `tests/offline-recursion.test.mjs`. The live reproduction is not an acceptable verification method: it
 * is a real fork bomb, and on this host it takes the whole session down with it.
 *
 * **Every child process goes through one injectable seam** (`spawn`, defaulting to `execFileSync`). That
 * is what makes the bounded regression possible: the harness substitutes a counting stub and a synthetic
 * child, drives the real control flow, and measures the descendants this script *attempts* — so the
 * fork-bomb property is asserted without a single real fork.
 *
 * The install and upgrade smokes are deliberately **out of scope**: they install a real tarball from the
 * npm registry, so requiring them to run offline would be requiring them to stop testing installation.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEPTH_VARIABLE, childDepth, nestedInvocationRefusal } from "./offline-nesting.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = join(ROOT, "scripts/offline-guard.mjs");

/**
 * Re-entry marker, propagated into every child process this script spawns.
 *
 * Not a nicety. `tests/offline.test.mjs` invokes this script twice — once plainly and once with
 * `--simulate-no-guard` — and this script runs that test as part of the root suite, so each level spawns
 * two of the next: unbounded 2^n growth that the operating system stops by refusing to fork, killing the
 * whole tree. The test's `BAYZ_OFFLINE_GUARD` break does not cover the `--simulate-no-guard` path, whose
 * entire purpose is to run *without* that variable set. This marker is independent of the guard, so it
 * holds on both paths.
 */
const DEPTH = DEPTH_VARIABLE;

/**
 * The suites run offline, in order, one at a time.
 *
 * `root` is the `.mjs` suite at the repository root; the rest are workspaces. Each entry is run as its
 * own process so a crash in one is attributable and bounded.
 */
const SUITES = [
  { id: "root", label: "root tests/*.test.mjs", args: ["--test", "tests/*.test.mjs"] },
  { id: "contracts", label: "@bayz/contracts", workspace: "@bayz/contracts" },
  { id: "security", label: "@bayz/security", workspace: "@bayz/security" },
  { id: "storage", label: "@bayz/storage", workspace: "@bayz/storage" },
  { id: "telemetry", label: "@bayz/telemetry", workspace: "@bayz/telemetry" },
  { id: "identity", label: "@bayz/identity", workspace: "@bayz/identity" },
  { id: "capability", label: "@bayz/capability", workspace: "@bayz/capability" },
  { id: "providers", label: "@bayz/providers", workspace: "@bayz/providers" },
  { id: "proxy", label: "@bayz/proxy", workspace: "@bayz/proxy" },
  { id: "gateway", label: "@bayz/gateway", workspace: "@bayz/gateway" },
  { id: "router", label: "@bayz/router", workspace: "@bayz/router" },
  { id: "server", label: "@bayz/server", workspace: "@bayz/server" },
];

/**
 * The one place this script starts a child process.
 *
 * Wraps `execFileSync`'s throw-on-non-zero into a plain result, and exists as a named seam so
 * `tests/offline-recursion.test.mjs` can count attempted descendants instead of creating them. Every
 * caller below goes through it; a new direct `execFileSync` call would be a hole in the regression, which
 * is why that test also asserts this is the only spawning construct in the file.
 *
 * @returns {{ ok: boolean, output: string }}
 */
export function spawnSync(file, args, options) {
  try {
    return { ok: true, output: execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }) };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/** Strip the guard preload from a `NODE_OPTIONS` value, leaving any other flags intact. */
function withoutGuard(nodeOptions) {
  return (nodeOptions ?? "")
    .split(/\s+/)
    .filter((token, index, tokens) => {
      if (token === "--import" && tokens[index + 1]?.includes("offline-guard")) return false;
      return !token.includes("offline-guard");
    })
    .join(" ")
    .trim();
}

/**
 * Prove the guard actually blocks something.
 *
 * Without this, a preload that failed to load would yield a green run and a false conclusion — the
 * failure mode that makes a security control worse than none, because it reads as proof.
 *
 * When `withGuard` is false the child's environment is **scrubbed** of any inherited guard preload.
 * Otherwise this check would inherit the guard from its own parent when the suite is itself running under
 * the guard, `--simulate-no-guard` would silently see an active guard, and the refusal path it exists to
 * exercise would never be reached.
 */
function guardIsActive({ withGuard, parentEnv, spawn }) {
  const dir = mkdtempSync(join(tmpdir(), "bayz-offline-probe-"));
  const probe = join(dir, "probe.mjs");
  writeFileSync(
    probe,
    `try {
       await fetch("https://example.invalid/");
       console.log("REACHED");
     } catch (error) {
       console.log(error.code === "BAYZ_OFFLINE_GUARD" ? "GUARDED" : "OTHER:" + error.message);
     }`,
  );

  const env = { ...parentEnv };
  if (withGuard) {
    env.NODE_OPTIONS = `${withoutGuard(env.NODE_OPTIONS)} --import ${GUARD}`.trim();
  } else {
    env.NODE_OPTIONS = withoutGuard(env.NODE_OPTIONS);
    delete env.BAYZ_OFFLINE_GUARD;
  }

  return spawn(process.execPath, [probe], { env }).output.includes("GUARDED");
}

function runSuite(suite, { withGuard, parentEnv, spawn }) {
  /*
   * `NODE_OPTIONS` carries the preload into the child, which matters for the workspace suites: those run
   * through `npm run test`, so the flag has to survive an npm hop rather than sit on our own argv.
   *
   * `NODE_TEST_CONTEXT` and `NODE_TEST_WORKER_ID` are **deleted**, and that is not tidying. When this
   * script is invoked from inside `node --test` (which `tests/offline.test.mjs` does), those variables are
   * inherited, and the nested `node --test` sees itself as an already-running test worker: it reports
   * success in 0s having executed nothing, with no pass/fail counts at all. The suite then "passed
   * offline" without a single test running — a completely vacuous green. Scrubbing them makes the nested
   * run real, and `counts()` returning numbers is asserted by the test so this cannot regress silently.
   */
  const env = { ...parentEnv };
  env.NODE_OPTIONS = withGuard
    ? `${withoutGuard(env.NODE_OPTIONS)} --import ${GUARD}`.trim()
    : withoutGuard(env.NODE_OPTIONS);
  if (!withGuard) delete env.BAYZ_OFFLINE_GUARD;
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  // Mark the child as being inside an offline check, on both the guarded and the unguarded path, so a
  // nested invocation refuses instead of forking another level.
  env[DEPTH] = childDepth(parentEnv);

  const started = Date.now();
  const result =
    suite.workspace === undefined
      ? spawn(process.execPath, suite.args, { cwd: ROOT, env })
      : spawn("npm", ["run", "test", "--workspace", suite.workspace], { cwd: ROOT, env });
  return { ...result, seconds: Math.round((Date.now() - started) / 1000) };
}

/** Pull the test totals out of `node --test` output, so the report carries real numbers. */
function counts(output) {
  const pass = /^. pass (\d+)$/m.exec(output)?.[1];
  const fail = /^. fail (\d+)$/m.exec(output)?.[1];
  return pass === undefined ? "" : ` (${pass} pass, ${fail ?? "0"} fail)`;
}

/** Name the tests that tripped the guard, so they can be fixed rather than tolerated. */
function guardViolations(output) {
  const violations = new Set();
  for (const match of output.matchAll(/offline guard: (\S+) to off-host address "([^"]+)"/g)) {
    violations.add(`${match[1]} -> ${match[2]}`);
  }
  return [...violations];
}

/**
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, spawn?: typeof spawnSync, log?: (line: string) => void,
 *           error?: (line: string) => void }} [io] injection seams, used by the bounded regression harness
 */
export function main(argv, io = {}) {
  const parentEnv = io.env ?? process.env;
  const spawn = io.spawn ?? spawnSync;
  const log = io.log ?? ((line) => console.log(line));
  const error = io.error ?? ((line) => console.error(line));

  const suiteIndex = argv.indexOf("--suite");
  const only = suiteIndex === -1 ? undefined : argv[suiteIndex + 1];
  const adhocIndex = argv.indexOf("--adhoc-path");
  const adhocPath = adhocIndex === -1 ? undefined : argv[adhocIndex + 1];
  const simulateNoGuard = argv.includes("--simulate-no-guard");
  const withGuard = !simulateNoGuard;

  log("BAYZ offline test proof — Phase 9K Task 7");
  log(`  node ${process.version} on ${process.platform} ${process.arch}`);
  log("  off-host egress blocked; loopback and this machine's own addresses permitted so the real-origin smokes still work");
  log("  suites run one at a time: fanning out exhausts the futex table on this device");
  log("");

  /*
   * Refuse to re-enter, before doing any work.
   *
   * This is the outer half of the fork-bomb break, and it is deliberately independent of the guard: the
   * `--simulate-no-guard` path runs with no guard marker at all, so a break keyed on the marker does not
   * exist there. Refusing with a non-zero status rather than a quiet `PASS` is the point — a nested run
   * that reported success would be reporting a suite it never executed.
   *
   * The predicate lives in `scripts/offline-nesting.mjs` so that this branch and the skip in
   * `tests/offline.test.mjs` cannot drift apart, and so both can be asserted without spawning anything.
   */
  const refusal = nestedInvocationRefusal(parentEnv);
  if (refusal !== null) {
    error(`  nested invocation refused: already inside an offline check (${DEPTH}=${refusal.depth}).`);
    error("  This script runs the suite that runs this script; re-entering forks two children per");
    error("  level and the host kills the tree. Nothing was run, so nothing is reported.");
    error("offline check: FAIL");
    return 1;
  }

  // Verify the instrument before trusting its readings.
  const active = guardIsActive({ withGuard, parentEnv, spawn });
  log(`  guard active: ${active ? "yes" : "NO"}`);
  log("");
  if (!active) {
    error("  The offline guard did not block a known-bad destination.");
    error("  A passing suite proves nothing without it, so no result is reported.");
    error("offline check: FAIL");
    return 1;
  }

  /*
   * `--suite adhoc --adhoc-path <file>` runs a single caller-supplied suite through the *real* runner.
   * It exists so `tests/offline.test.mjs` can assert the depth marker actually reaches a suite process
   * rather than trusting a comment, without that assertion having to re-enter the root suite.
   */
  const selected =
    only === "adhoc"
      ? adhocPath === undefined
        ? []
        : [{ id: "adhoc", label: `adhoc ${adhocPath}`, args: ["--test", adhocPath] }]
      : only === undefined
        ? SUITES
        : SUITES.filter((suite) => suite.id === only);
  if (selected.length === 0) {
    error(only === "adhoc" ? "  --suite adhoc requires --adhoc-path <file>" : `  unknown suite: ${only}`);
    error("offline check: FAIL");
    return 1;
  }

  let failed = false;
  const violations = new Set();
  for (const suite of selected) {
    const result = runSuite(suite, { withGuard, parentEnv, spawn });
    for (const violation of guardViolations(result.output)) violations.add(`${suite.id}: ${violation}`);

    log(`  ${result.ok ? "ok  " : "FAIL"} ${suite.label}${counts(result.output)} — ${result.seconds}s`);
    if (!result.ok) {
      failed = true;
      // Print the failing test names, not the whole log: the log is enormous and the names are the fix.
      for (const line of result.output.split("\n").filter((line) => /^✖/.test(line)).slice(0, 10)) {
        log(`        ${line.trim()}`);
      }
    }
  }
  log("");

  if (violations.size > 0) {
    log("  tests that reached for the network:");
    for (const violation of violations) log(`    - ${violation}`);
    log("");
  }

  if (failed) {
    error("offline check: FAIL");
    return 1;
  }

  log(`  ${selected.length} suite(s) passed with off-host egress blocked`);
  log("offline check: PASS");
  return 0;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
