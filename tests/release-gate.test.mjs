/**
 * The aggregate release gate — Phase 9L Task 3.
 *
 * **This file proves a runner that runs this file, and it starts no processes.**
 *
 * The cycle is real and it is the same shape 9K Task 7 lost three verification sessions to:
 * `scripts/release-gate.mjs` runs `node --test tests/*.test.mjs` **and** `scripts/offline-check.mjs`,
 * which itself runs the root suite — so a test in this directory that spawned the runner would
 * re-enter the entire verification tree, and on this Termux/proot device the tree does not fail
 * politely, it dies by signal. A live reproduction is therefore not an acceptable verification method
 * here.
 *
 * What replaces it, exactly as `tests/offline-recursion.test.mjs` established:
 *
 *   1. `node:child_process` is **resolved to a module whose every spawning function throws**, before
 *      the runner is imported. Not a monkey-patch: `import { spawnSync } from "node:child_process"` is
 *      a live binding into the real module's slot, so assigning to the namespace object leaves it
 *      pointing at the original. Only resolution-time substitution reaches it. This means a future
 *      mutation that adds a direct `execFileSync` cannot create the fork bomb — it gets a thrown
 *      `BAYZ_SPAWN_BLOCKED` and a recorded attempt.
 *   2. The runner's `main()` takes its spawn seam, environment, log sink, and root as arguments, so the
 *      real control flow is driven with a **recording stub** in place of every child.
 *
 * Nothing in this file spawns, and one test asserts that by reading the blocked-attempt log.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { blockedSpawnAttempts } from "./helpers/blocked-child-process.mjs";
import { blockChildProcessModule } from "./helpers/block-spawning-hook.mjs";

blockChildProcessModule();
const gate = await import("../scripts/release-gate.mjs");

/**
 * A spawn stub that records what it was asked to run and returns a chosen outcome per step.
 *
 * The default `stdout` is **empty**, which is load-bearing rather than lazy: the clean-tree step's
 * verdict is the emptiness of `git status --porcelain`, so a stub that echoed anything at all would
 * report every synthetic run as having uncommitted work.
 */
function recordingSpawn(outcomes = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    const key = `${command} ${(args ?? []).join(" ")}`;
    calls.push({ command, args: args ?? [], env: options?.env ?? {}, key });
    const chosen = Object.entries(outcomes).find(([needle]) => key.includes(needle))?.[1];
    return { status: chosen?.status ?? 0, stdout: chosen?.stdout ?? "", stderr: chosen?.stderr ?? "", signal: null, error: null };
  };
  return { spawn, calls };
}

function capture() {
  const lines = [];
  return { log: (line) => lines.push(line), error: (line) => lines.push(line), text: () => lines.join("\n") };
}

/**
 * Every non-smoke script a full plan requires on disk.
 *
 * Listed here so a synthetic root exercising the *pass* path is complete. Leaving one out does not
 * make the run pass with a gap — it makes the runner report a `FAIL` for the missing file, which is
 * the behaviour a separate test asserts deliberately.
 */
const REQUIRED_CHECK_SCRIPTS = ["fuzz-run.mjs", "dependency-closure.mjs", "lockfile-check.mjs", "offline-check.mjs"];

/** A synthetic repository with a chosen set of smoke scripts and gate scripts present. */
function syntheticRoot({ smokes = [], gates = [], checks = REQUIRED_CHECK_SCRIPTS, tests = ["a.test.mjs"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "bayz-release-gate-"));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "tests"));
  for (const name of smokes) writeFileSync(join(root, "scripts", `${name}-smoke.mjs`), "// smoke\n");
  for (const name of [...gates, ...checks]) writeFileSync(join(root, "scripts", name), "// script\n");
  for (const name of tests) writeFileSync(join(root, "tests", name), "// test\n");
  return root;
}

test("every smoke script on disk is discovered, so a new one is never silently left out", () => {
  const discovered = gate.discoverSmokeScripts();
  // Measured against the real repository: discovery is the property, not a fixture's echo.
  assert.ok(discovered.includes("api"), "api-smoke.mjs was not discovered");
  assert.ok(discovered.includes("load") && discovered.includes("soak"), "the long-class scripts were not discovered");
  assert.deepEqual([...discovered].sort(), discovered, "discovery must be sorted so a run is reproducible");
});

test("every discovered smoke script is classified fast or long — no script is left undecided", () => {
  const classes = gate.classifySmokeScripts(gate.discoverSmokeScripts());
  assert.deepEqual(classes.unclassified, [], `unclassified: ${classes.unclassified.join(", ")}`);
  assert.deepEqual(classes.stale, [], `SMOKE_CLASSES names scripts that do not exist: ${classes.stale.join(", ")}`);
  assert.deepEqual(classes.long, ["load", "soak"], "the long class must be exactly load and soak");
  assert.equal(classes.fast.length + classes.long.length, gate.discoverSmokeScripts().length);
});

test("an unclassified smoke script is a FAIL, not a default", () => {
  const plan = gate.buildPlan({ smokeScripts: [...gate.discoverSmokeScripts(), "brand-new"] });
  assert.equal(plan.classes.unclassified.length, 1);
  assert.ok(
    plan.violations.some((entry) => entry.includes("brand-new") && entry.includes("no duration class")),
    `expected a violation naming the unclassified script, got: ${plan.violations.join(" | ")}`,
  );
  // And it must not have been quietly folded into the fast set, which would be the default this rule forbids.
  assert.ok(!plan.steps.some((step) => step.id === "smoke:brand-new"), "an unclassified script was run anyway");
});

test("a classified script that no longer exists is a FAIL, because the map has gone stale", () => {
  const plan = gate.buildPlan({ smokeScripts: gate.discoverSmokeScripts().filter((name) => name !== "soak") });
  assert.ok(
    plan.violations.some((entry) => entry.includes("'soak'") && entry.includes("stale")),
    `expected a stale-map violation, got: ${plan.violations.join(" | ")}`,
  );
});

test("the long class runs only under --full, and never in a --report pass", () => {
  const fastOnly = gate.buildPlan({ smokeScripts: gate.discoverSmokeScripts(), full: false });
  const withFull = gate.buildPlan({ smokeScripts: gate.discoverSmokeScripts(), full: true });

  assert.ok(!fastOnly.steps.some((step) => step.kind === "smoke-long"), "a long-class script ran without --full");
  assert.deepEqual(
    withFull.steps.filter((step) => step.kind === "smoke-long").map((step) => step.id),
    ["smoke:load", "smoke:soak"],
  );
  /*
   * The long class runs *last*. A two-hour soak ahead of a one-second gate would mean a broken gate is
   * discovered two hours later than it needed to be.
   */
  const kinds = withFull.steps.map((step) => step.kind);
  assert.ok(kinds.lastIndexOf("gate") < kinds.indexOf("smoke-long"), "the long class must run after the gates");
});

test("all five subordinate gates plus the 9F posture check are composed", () => {
  const ids = gate.COMPOSED_GATES.map((entry) => entry.id);
  assert.deepEqual(ids, ["client", "resilience", "platform", "supply-chain", "feature", "security posture"]);

  const plan = gate.buildPlan({ smokeScripts: gate.discoverSmokeScripts() });
  for (const composed of gate.COMPOSED_GATES) {
    const step = plan.steps.find((entry) => entry.id === `gate:${composed.id}`);
    assert.ok(step !== undefined, `${composed.id} is not in the step list`);
    assert.equal(step.requires, composed.script);
    // Every real gate is composed with its own --enforce semantics, never re-implemented here.
    if (composed.derivedFrom === undefined) assert.ok(step.args.includes("--enforce"), `${composed.id} was not run with --enforce`);
  }
});

test("a missing gate script is a FAIL, never a skip", () => {
  const root = syntheticRoot();
  const outcome = gate.runStep(
    { id: "gate:client", kind: "gate", requires: "scripts/client-gate.mjs", command: "node", args: [] },
    { root, spawn: () => assert.fail("a missing gate must not be spawned") },
  );
  assert.equal(outcome.status, "FAIL");
  assert.match(outcome.detail, /does not exist — a missing check is a FAIL, never a skip/);
});

test("a step killed by a signal is a FAIL rather than an absent result", () => {
  const outcome = gate.runStep(
    { id: "suite", kind: "suite", command: "node", args: [] },
    { spawn: () => ({ status: null, signal: "SIGKILL", stdout: "", stderr: "", error: null }) },
  );
  assert.equal(outcome.status, "FAIL");
  assert.match(outcome.detail, /killed by SIGKILL/);
});

test("the clean-tree check reads git's output, not its exit code", () => {
  // `git status --porcelain` exits 0 whether or not the tree is dirty, so an exit-code check would
  // report a clean tree for a repository full of uncommitted work.
  const dirty = gate.runStep(
    { id: "clean-tree", kind: "tree", command: "git", args: ["status", "--porcelain"] },
    { spawn: () => ({ status: 0, stdout: " M scripts/release-gate.mjs\n?? new.mjs\n", stderr: "", signal: null, error: null }) },
  );
  assert.equal(dirty.status, "FAIL");
  assert.match(dirty.detail, /2 uncommitted change\(s\)/);

  const clean = gate.runStep(
    { id: "clean-tree", kind: "tree", command: "git", args: ["status", "--porcelain"] },
    { spawn: () => ({ status: 0, stdout: "", stderr: "", signal: null, error: null }) },
  );
  assert.equal(clean.status, "PASS");
});

test("the security posture row is derived from the security smoke it is proven by, and inherits its failure", async () => {
  const smokes = gate.discoverSmokeScripts();
  const gates = gate.COMPOSED_GATES.map((entry) => entry.script.replace("scripts/", ""));
  const root = syntheticRoot({ smokes, gates });

  const failing = recordingSpawn({ "security-smoke.mjs": { status: 1, stdout: "security smoke: FAIL\n" } });
  const out = capture();
  const code = await gate.main(["--enforce"], { root, env: {}, spawn: failing.spawn, log: out.log, error: out.error });

  assert.equal(code, 1, "a failing posture smoke must block");
  assert.match(out.text(), /gate:security posture\s+0s\s+derived from smoke:security/);
  // Derived, not re-run: the smoke appears once in the spawn log, not twice.
  assert.equal(failing.calls.filter((call) => call.key.includes("security-smoke.mjs")).length, 1);
});

test("--report exits 0 even when steps fail, and --enforce exits non-zero on the same input", async () => {
  const smokes = gate.discoverSmokeScripts();
  const gates = gate.COMPOSED_GATES.map((entry) => entry.script.replace("scripts/", ""));
  const root = syntheticRoot({ smokes, gates });
  const failing = { "client-gate.mjs": { status: 1, stdout: "RELEASE BLOCKED\n" } };

  const reported = capture();
  const reportCode = await gate.main(["--report"], { root, env: {}, spawn: recordingSpawn(failing).spawn, log: reported.log, error: reported.error });
  assert.equal(reportCode, 0, "--report must always exit 0");
  assert.match(reported.text(), /release gate: REPORT/);
  assert.match(reported.text(), /blocking \(1\)/, "a report must still show what would block");

  const enforced = capture();
  const enforceCode = await gate.main(["--enforce"], { root, env: {}, spawn: recordingSpawn(failing).spawn, log: enforced.log, error: enforced.error });
  assert.equal(enforceCode, 1);
  assert.match(enforced.text(), /release gate: FAIL — 1 blocking item\(s\)/);
});

test("an --enforce run without --full states plainly that load and soak were not re-measured", async () => {
  const smokes = gate.discoverSmokeScripts();
  const gates = gate.COMPOSED_GATES.map((entry) => entry.script.replace("scripts/", ""));
  const root = syntheticRoot({ smokes, gates });

  const partial = capture();
  await gate.main(["--enforce"], { root, env: {}, spawn: recordingSpawn().spawn, log: partial.log, error: partial.error });
  for (const line of gate.LONG_CLASS_NOT_RUN_BANNER.filter((entry) => entry !== "")) {
    assert.ok(partial.text().includes(line), `the banner line ${JSON.stringify(line)} was not printed`);
  }

  const full = capture();
  const code = await gate.main(["--enforce", "--full"], { root, env: {}, spawn: recordingSpawn().spawn, log: full.log, error: full.error });
  assert.equal(code, 0);
  assert.ok(!full.text().includes("THE LONG CLASS WAS NOT EXECUTED"), "the banner was printed for a run that did execute it");
  assert.match(full.text(), /release gate: PASS \(full, including the long class\)/);
});

test("--full is ignored by --report, so a report can never masquerade as a full measurement", async () => {
  const smokes = gate.discoverSmokeScripts();
  const gates = gate.COMPOSED_GATES.map((entry) => entry.script.replace("scripts/", ""));
  const root = syntheticRoot({ smokes, gates });
  const recorder = recordingSpawn();

  const out = capture();
  await gate.main(["--report", "--full"], { root, env: {}, spawn: recorder.spawn, log: out.log, error: out.error });
  assert.ok(!recorder.calls.some((call) => call.key.includes("soak-smoke.mjs")), "a --report run started the two-hour class");
  assert.ok(out.text().includes("THE LONG CLASS WAS NOT EXECUTED"), "a --report --full run did not say the long class was skipped");
});

test("the UNVERIFIED list is read through each subprogram's own parser and names the real gaps", async () => {
  const entries = await gate.collectUnverified();
  const sources = new Set(entries.map((entry) => entry.source.split(" ")[0]));
  for (const subprogram of ["9H", "9I", "9L"]) {
    assert.ok(sources.has(subprogram), `${subprogram} contributed nothing to the UNVERIFIED list`);
  }
  // The two feature rows that genuinely cannot be proven here must appear by name.
  const features = entries.filter((entry) => entry.source === "9L feature").map((entry) => entry.item);
  assert.deepEqual(features.sort(), ["Client integrations", "Cross-platform qualification"]);
  for (const entry of entries) assert.ok(entry.reason.length > 0, `${entry.item} is UNVERIFIED with no reason`);
});

test("no mode, two modes, and an unknown flag all exit 2", async () => {
  for (const argv of [[], ["--report", "--enforce"], ["--enforce", "--plan"], ["--wat"], ["--full"]]) {
    const out = capture();
    const code = await gate.main(argv, { env: {}, spawn: () => assert.fail(`${argv.join(" ")} ran something`), log: out.log, error: out.error });
    assert.equal(code, 2, `${JSON.stringify(argv)} did not exit 2`);
    assert.match(out.text(), /usage: node scripts\/release-gate\.mjs/);
  }
});

test("--plan runs nothing at all", async () => {
  const out = capture();
  const code = await gate.main(["--plan"], { env: {}, spawn: () => assert.fail("--plan spawned a child"), log: out.log, error: out.error });
  assert.equal(code, 0);
  assert.match(out.text(), /release-gate: PLAN only, nothing was run/);
  assert.match(out.text(), /fast class \(16\)/);
});

test("the runner refuses to run inside itself, and the refusal happens before any work", async () => {
  const out = capture();
  const code = await gate.main(["--enforce"], {
    env: { [gate.DEPTH_VARIABLE]: "1" },
    spawn: () => assert.fail("a nested run executed a step"),
    log: out.log,
    error: out.error,
  });
  assert.equal(code, 1, "a nested invocation must not exit 0 — a quiet PASS would report a suite it never ran");
  assert.match(out.text(), /nested invocation refused/);
});

test("every child carries the depth marker, so a grandchild refuses too", async () => {
  const smokes = gate.discoverSmokeScripts();
  const gates = gate.COMPOSED_GATES.map((entry) => entry.script.replace("scripts/", ""));
  const root = syntheticRoot({ smokes, gates });
  const recorder = recordingSpawn();

  await gate.main(["--enforce"], { root, env: {}, spawn: recorder.spawn, log: () => {}, error: () => {} });

  assert.ok(recorder.calls.length > 20, `expected the full step list to run, got ${recorder.calls.length} children`);
  for (const call of recorder.calls) {
    assert.equal(call.env[gate.DEPTH_VARIABLE], "1", `${call.key} was spawned without the depth marker`);
  }
  // And the marker increments, so a transcript can show how deep a run got.
  assert.equal(gate.childDepth({ [gate.DEPTH_VARIABLE]: "1" }), "2");
  assert.equal(gate.childDepth({ [gate.DEPTH_VARIABLE]: "not-a-number" }), "1", "a corrupted marker must still mark");
});

test("this test file started no processes", () => {
  /*
   * The difference between "nothing was spawned" and "nothing tried to spawn" is the whole finding
   * when a mutation bypasses the injected seam, so the blocked-attempt log is asserted rather than
   * assumed. A non-empty log here means some code reached `node:child_process` directly.
   */
  assert.deepEqual(blockedSpawnAttempts(), [], `something tried to spawn: ${JSON.stringify(blockedSpawnAttempts())}`);
});
