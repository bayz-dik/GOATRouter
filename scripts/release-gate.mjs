#!/usr/bin/env node
/**
 * The aggregate release gate — Phase 9L Task 3.
 *
 * One command that answers "is BAYZ actually done?" It **composes** the five subordinate gates and
 * the full verification set rather than reimplementing any of their rules, so every rule lives in
 * exactly one place. This file contributes no new policy about clients, resilience, platforms,
 * supply chain, or features; it contributes the *composition*, the duration classes, and the
 * refusal to treat an absent check as a pass.
 *
 * ## What it runs
 *
 * Six composed gates: `client-gate` (9H), `resilience-gate` (9I), `platform-gate` (9J),
 * `supply-chain-gate` (9K), `feature-gate` (9L Task 2), and the **9F security posture check**.
 *
 * Plus the verification set the plan names: `npm run runtime:verify`; every `scripts/*-smoke.mjs`
 * **discovered from disk**, so a new smoke script is included automatically instead of forgotten;
 * `node --test tests/*.test.mjs`; `fuzz-run.mjs`; `dependency-closure.mjs`; `lockfile-check.mjs`;
 * `offline-check.mjs`; `git diff --check`; and a clean-tree check.
 *
 * ## Duration classes, decided explicitly
 *
 * Dynamic discovery picks up `load-smoke.mjs` and `soak-smoke.mjs`, whose default soak duration is
 * 10 minutes and whose long mode is 2 hours. **A gate that takes hours is a gate that gets skipped
 * by whoever is in a hurry, which makes it worthless.** So every smoke script is classified:
 *
 *   - `fast` — the sixteen scripts a release can afford to re-measure on every run.
 *   - `long` — `load` and `soak`, run only under `--enforce --full`.
 *
 * A discovered script in neither class is a **`FAIL`, not a default**: a new smoke script must be
 * placed in a class deliberately, because an unclassified script is one nobody decided about. A
 * script named in the map that no longer exists on disk is equally a `FAIL` — the map is then stale,
 * and a stale map is how a class silently stops covering anything.
 *
 * An `--enforce` run without `--full` prints, prominently, that the long set was **not** executed
 * and that any load or soak row therefore rests on a previous transcript. The run does not silently
 * inherit an old measurement as if it were fresh.
 *
 * ## Two refusals that are the point of the file
 *
 * **A missing gate script is a `FAIL`, never a skip.** An absent gate that read as a pass would be
 * the single cheapest way to ship an unverified release: delete the file that says no.
 *
 * **This script refuses to run inside itself.** It runs `offline-check.mjs`, which runs the root
 * suite, which contains `tests/*.test.mjs` — and a test that spawned this runner would re-enter the
 * whole tree, two children per level. That is not hypothetical on this device: 9K Task 7 lost three
 * verification sessions to exactly that shape, and the process tree dies by signal rather than
 * failing politely. The break is a depth marker set on **every** child, checked before any work,
 * mirroring `scripts/offline-nesting.mjs`. `tests/release-gate.test.mjs` therefore asserts the
 * policy in-process against the exported pure functions and spawns nothing at all.
 *
 * ## Exit contract
 *
 *   --report   run the fast set, print the table, exit 0 even when it would fail
 *   --enforce  exit non-zero unless every composed gate and every step passed
 *   --plan     print the classification and step list, run nothing, exit 0
 *   --full     with --enforce, additionally run the long class
 *   --no-audit passed through to the supply-chain gate for a run with no registry
 *
 * No mode, two modes, or an unknown flag exits 2. "Report and enforce" has two plausible meanings —
 * print then fail, or print instead of failing — and guessing one would let a release script believe
 * it enforced when it only reported. Same contract as every other gate in this repository.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Set on every child this runner spawns. Presence, not depth, is the refusal — the same reasoning
 * `scripts/offline-nesting.mjs` records: setting it can only ever cause *more* refusal, so it is the
 * one property a caller cannot usefully lie about.
 */
export const DEPTH_VARIABLE = "BAYZ_RELEASE_GATE_DEPTH";

/** @param {Record<string, string | undefined>} env */
export function nestedInvocationRefusal(env) {
  const depth = env?.[DEPTH_VARIABLE];
  return depth === undefined ? null : { depth };
}

/** @param {Record<string, string | undefined>} env the parent environment */
export function childDepth(env) {
  const inherited = Number(env?.[DEPTH_VARIABLE] ?? "0");
  return String((Number.isFinite(inherited) ? inherited : 0) + 1);
}

/**
 * The six composed gates.
 *
 * `security posture` is not a gate script of its own, and that is deliberate rather than an
 * omission: 9F's posture ladder is proven by `scripts/security-smoke.mjs` — a real listener refusing
 * to start without TLS on a `lan` bind, an `admin` scope refused over the wire, a concurrency cap
 * measured against a real burst — and that script is already in the fast class. Running it twice
 * would add 13 s to every gate run to re-measure the same thing, so the row is *derived from that
 * step's outcome*. The file must still exist, or the row is a `FAIL`.
 */
export const COMPOSED_GATES = Object.freeze([
  { id: "client", subprogram: "9H", script: "scripts/client-gate.mjs", args: ["--enforce"] },
  { id: "resilience", subprogram: "9I", script: "scripts/resilience-gate.mjs", args: ["--enforce"] },
  { id: "platform", subprogram: "9J", script: "scripts/platform-gate.mjs", args: ["--enforce"] },
  { id: "supply-chain", subprogram: "9K", script: "scripts/supply-chain-gate.mjs", args: ["--enforce"] },
  { id: "feature", subprogram: "9L", script: "scripts/feature-gate.mjs", args: ["--enforce"] },
  { id: "security posture", subprogram: "9F", script: "scripts/security-smoke.mjs", derivedFrom: "smoke:security" },
]);

/**
 * The duration class of every smoke script, by the name between `scripts/` and `-smoke.mjs`.
 *
 * Held here rather than inferred, because "how long does this take" is not derivable from the source
 * and a guess would put a two-hour soak in the fast set on the first day somebody renamed a file.
 */
export const SMOKE_CLASSES = Object.freeze({
  api: "fast",
  chaos: "fast",
  "custom-provider": "fast",
  dashboard: "fast",
  identity: "fast",
  injection: "fast",
  install: "fast",
  load: "long",
  provider: "fast",
  proxy: "fast",
  "proxy-ux": "fast",
  router: "fast",
  security: "fast",
  soak: "long",
  storage: "fast",
  stream: "fast",
  upgrade: "fast",
  usage: "fast",
});

/** Discover the smoke scripts on disk. Dynamic so a new script is never silently left out. */
export function discoverSmokeScripts(root = ROOT) {
  return readdirSync(join(root, "scripts"))
    .filter((name) => name.endsWith("-smoke.mjs"))
    .map((name) => name.slice(0, -"-smoke.mjs".length))
    .sort();
}

/**
 * Printed by every run that did not execute the long class.
 *
 * Held as a constant so `tests/release-gate.test.mjs` asserts the exact text a run emits, rather than
 * a paraphrase of it. The wording is deliberately unmissable: the failure mode is an operator reading
 * a green `--enforce` and believing load and soak were measured in that run when they were not.
 */
export const LONG_CLASS_NOT_RUN_BANNER = Object.freeze([
  "",
  "  ############################################################################",
  "  # THE LONG CLASS WAS NOT EXECUTED: load and soak did not run in this pass. #",
  "  # Any load or soak row therefore rests on a PREVIOUS transcript, not on a  #",
  "  # measurement taken now. Run --enforce --full to re-measure them.          #",
  "  ############################################################################",
]);

/**
 * Classify the discovered scripts and report both directions of disagreement with the map.
 *
 * `unclassified` is a discovered script with no class — a decision nobody made. `stale` is a
 * classified script that is not on disk — a map that has stopped describing the repository. Both are
 * violations; neither is a skip.
 */
export function classifySmokeScripts(discovered) {
  const fast = [];
  const long = [];
  const unclassified = [];
  for (const name of discovered) {
    const cls = SMOKE_CLASSES[name];
    if (cls === "fast") fast.push(name);
    else if (cls === "long") long.push(name);
    else unclassified.push(name);
  }
  const stale = Object.keys(SMOKE_CLASSES)
    .filter((name) => !discovered.includes(name))
    .sort();
  return { fast, long, unclassified, stale };
}

/**
 * Build the ordered step list.
 *
 * Pure: takes the discovered scripts and the flags, returns steps and violations. Every decision this
 * runner makes about *what* to run is therefore assertable without spawning anything, which is the
 * only safe way to test a runner whose job includes running the suite that contains its own test.
 *
 * @param {{ smokeScripts: string[], full?: boolean, noAudit?: boolean, root?: string }} options
 */
export function buildPlan({ smokeScripts, full = false, noAudit = false, root = ROOT }) {
  const classes = classifySmokeScripts(smokeScripts);
  const violations = [];

  for (const name of classes.unclassified) {
    violations.push(
      `scripts/${name}-smoke.mjs is in no duration class — classify it 'fast' or 'long' in SMOKE_CLASSES; an unclassified script is one nobody decided about`,
    );
  }
  for (const name of classes.stale) {
    violations.push(`SMOKE_CLASSES names '${name}' but scripts/${name}-smoke.mjs does not exist — the map is stale`);
  }

  const steps = [];

  steps.push({ id: "runtime:verify", label: "npm run runtime:verify", kind: "verify", command: "npm", args: ["run", "runtime:verify"] });

  for (const name of classes.fast) {
    steps.push({
      id: `smoke:${name}`,
      label: `node scripts/${name}-smoke.mjs`,
      kind: "smoke-fast",
      command: process.execPath,
      args: [join(root, "scripts", `${name}-smoke.mjs`)],
    });
  }

  steps.push({
    id: "suite",
    label: "node --test tests/*.test.mjs",
    kind: "suite",
    command: process.execPath,
    args: ["--test", ...testFiles(root)],
  });

  for (const [id, label, file, args] of [
    ["fuzz", "node scripts/fuzz-run.mjs", "scripts/fuzz-run.mjs", []],
    ["dependency-closure", "node scripts/dependency-closure.mjs", "scripts/dependency-closure.mjs", []],
    ["lockfile-check", "node scripts/lockfile-check.mjs", "scripts/lockfile-check.mjs", []],
    ["offline-check", "node scripts/offline-check.mjs", "scripts/offline-check.mjs", []],
  ]) {
    steps.push({ id, label, kind: "check", command: process.execPath, args: [join(root, file), ...args], requires: file });
  }

  steps.push({ id: "diff-check", label: "git diff --check", kind: "check", command: "git", args: ["diff", "--check"] });
  steps.push({ id: "clean-tree", label: "git status --porcelain (must be empty)", kind: "tree", command: "git", args: ["status", "--porcelain"] });

  for (const gate of COMPOSED_GATES) {
    if (gate.derivedFrom !== undefined) {
      steps.push({ id: `gate:${gate.id}`, label: `${gate.script} (derived from ${gate.derivedFrom})`, kind: "gate-derived", gate, requires: gate.script });
      continue;
    }
    const args = gate.id === "supply-chain" && noAudit ? [...gate.args, "--no-audit"] : gate.args;
    steps.push({
      id: `gate:${gate.id}`,
      label: `node ${gate.script} ${args.join(" ")}`,
      kind: "gate",
      gate,
      command: process.execPath,
      args: [join(root, gate.script), ...args],
      requires: gate.script,
    });
  }

  if (full) {
    for (const name of classes.long) {
      steps.push({
        id: `smoke:${name}`,
        label: `node scripts/${name}-smoke.mjs`,
        kind: "smoke-long",
        command: process.execPath,
        args: [join(root, "scripts", `${name}-smoke.mjs`)],
      });
    }
  }

  return { steps, violations, classes, full };
}

/** The root `.mjs` suite, sorted so a run is reproducible. */
function testFiles(root = ROOT) {
  return readdirSync(join(root, "tests"))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => join(root, "tests", name));
}

/**
 * Collect everything currently `UNVERIFIED`, with its reason, by reading each subordinate document
 * through **that subprogram's own parser**.
 *
 * This is composition, not a second implementation: no verdict is re-derived here, and if a parser
 * changes shape this list changes with it. The list is the honest release-notes content, which is why
 * it is printed separately and prominently rather than buried in a table of green ticks.
 */
export async function collectUnverified() {
  const entries = [];
  const push = (source, item, reason) => entries.push({ source, item, reason: (reason ?? "(no reason documented)").replace(/\s+/g, " ").trim() });

  try {
    const lib = await import("./client-gate-lib.mjs");
    // `readMatrix` returns Map<client, Map<capability, {status, note}>>; iterated through its own
    // parser rather than re-read, so a change to the matrix shape changes this list with it.
    for (const [client, capabilities] of lib.readMatrix()) {
      for (const [capability, cell] of capabilities) {
        if (cell.status === "UNVERIFIED") push(`9H ${client}`, capability, cell.note);
      }
    }
  } catch (error) {
    push("9H", "client matrix", `could not be read: ${error.message}`);
  }

  try {
    const lib = await import("./resilience-gate-lib.mjs");
    for (const row of lib.readReport().rows) {
      if (row.status === "UNVERIFIED") push(`9I ${row.section}`, row.item, row.notes);
    }
  } catch (error) {
    push("9I", "resilience report", `could not be read: ${error.message}`);
  }

  try {
    const gate = await import("./platform-gate.mjs");
    const { readFileSync } = await import("node:fs");
    const matrix = gate.parseMatrix(readFileSync(join(ROOT, "docs/superpowers/2026-08-27-bayz-platform-matrix.md"), "utf8"));
    for (const row of matrix.rows) {
      const unverified = row.cells.filter((cell) => cell.status === "UNVERIFIED").map((cell) => cell.column);
      if (unverified.length > 0) push("9J", row.platform, `${unverified.length} cell(s) UNVERIFIED: ${unverified.join(", ")}`);
    }
  } catch (error) {
    push("9J", "platform matrix", `could not be read: ${error.message}`);
  }

  try {
    const gate = await import("./supply-chain-gate.mjs");
    for (const row of gate.readReport().rows) {
      if (row.status === "UNVERIFIED") push("9K", row.item, row.notes);
    }
  } catch (error) {
    push("9K", "supply-chain report", `could not be read: ${error.message}`);
  }

  try {
    const gate = await import("./feature-gate.mjs");
    const parsed = gate.readGate();
    const notes = parsed.missing ? new Map() : gate.readNotes(parsed.text);
    for (const row of parsed.rows) {
      if (row.overall === "UNVERIFIED") push("9L feature", row.feature, (notes.get(row.feature) ?? "").split("\n")[0]);
    }
  } catch (error) {
    push("9L", "feature gate", `could not be read: ${error.message}`);
  }

  return entries;
}

/**
 * Run one step.
 *
 * `spawn` is injectable for the same reason `scripts/offline-check.mjs` injects its own: this runner
 * starts the suite that contains its test, so the test must be able to drive the real control flow
 * without any process being created.
 */
export function runStep(step, { root = ROOT, env = process.env, spawn = spawnSync, log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  if (step.requires !== undefined && !existsSync(join(root, step.requires))) {
    // A missing gate or check is a FAIL, never a skip: an absent gate that read as a pass would make
    // deleting the file the cheapest way to ship an unverified release.
    return { id: step.id, status: "FAIL", seconds: 0, detail: `${step.requires} does not exist — a missing check is a FAIL, never a skip` };
  }

  const started = Date.now();
  const result = spawn(step.command, step.args, {
    cwd: root,
    encoding: "utf8",
    env: { ...env, [DEPTH_VARIABLE]: childDepth(env) },
    maxBuffer: 64 * 1024 * 1024,
  });
  const seconds = Math.round((Date.now() - started) / 1000);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  if (result.error !== undefined && result.error !== null) {
    return { id: step.id, status: "FAIL", seconds, detail: `could not run: ${result.error.message}`, output };
  }
  if (result.signal !== null && result.signal !== undefined) {
    return { id: step.id, status: "FAIL", seconds, detail: `killed by ${result.signal}`, output };
  }

  // The clean-tree check has no exit code of its own: git status succeeds whether or not the tree is
  // dirty, so the verdict is the emptiness of its output.
  if (step.kind === "tree") {
    const dirty = output.trim().split("\n").filter((line) => line.trim().length > 0);
    return {
      id: step.id,
      status: dirty.length === 0 ? "PASS" : "FAIL",
      seconds,
      detail: dirty.length === 0 ? "working tree clean" : `${dirty.length} uncommitted change(s)`,
      output,
    };
  }

  const status = result.status === 0 ? "PASS" : "FAIL";
  const summary = lastMeaningfulLine(output);
  return { id: step.id, status, seconds, detail: `exit ${result.status}${summary === "" ? "" : ` — ${summary}`}`, output };
}

function lastMeaningfulLine(output) {
  const lines = output.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  return (lines.at(-1) ?? "").slice(0, 100);
}

/**
 * Decide the aggregate verdict.
 *
 * A step that failed blocks. A plan violation blocks. Nothing is advisory here: this is the final
 * gate, and an advisory row at this level would be a feature shipped on a promise.
 */
export function assess(plan, outcomes) {
  const blocking = [];
  for (const violation of plan.violations) blocking.push(violation);
  for (const outcome of outcomes) {
    if (outcome.status !== "PASS") blocking.push(`${outcome.id}: ${outcome.status} — ${outcome.detail}`);
  }
  return { blocking, blocked: blocking.length > 0 };
}

function formatPlan(plan) {
  const lines = [
    "BAYZ aggregate release gate — Phase 9L",
    `  smoke scripts discovered: ${plan.classes.fast.length + plan.classes.long.length + plan.classes.unclassified.length}`,
    `  fast class (${plan.classes.fast.length}): ${plan.classes.fast.join(", ")}`,
    `  long class (${plan.classes.long.length}): ${plan.classes.long.join(", ")}`,
  ];
  if (plan.classes.unclassified.length > 0) lines.push(`  UNCLASSIFIED (a FAIL, not a default): ${plan.classes.unclassified.join(", ")}`);
  if (plan.classes.stale.length > 0) lines.push(`  STALE map entries (a FAIL): ${plan.classes.stale.join(", ")}`);
  lines.push("", `  steps (${plan.steps.length}), in order:`);
  for (const step of plan.steps) lines.push(`    ${step.kind.padEnd(12)} ${step.label}`);
  return lines.join("\n");
}

/**
 * Entry point.
 *
 * Takes its environment and its spawn seam as arguments for the reason `scripts/offline-check.mjs`
 * does: this runner starts the suite that contains its own test, so the test has to be able to drive
 * the real control flow — including the nesting refusal and the usage errors — without any process
 * being created.
 *
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, spawn?: typeof spawnSync,
 *           log?: (line: string) => void, error?: (line: string) => void, root?: string }} [io]
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const spawn = io.spawn ?? spawnSync;
  const root = io.root ?? ROOT;
  const log = io.log ?? ((line) => process.stdout.write(`${line}\n`));
  const error = io.error ?? ((line) => process.stderr.write(`${line}\n`));

  const known = new Set(["--report", "--enforce", "--plan", "--full", "--no-audit"]);
  const unknown = argv.filter((entry) => !known.has(entry));
  const report = argv.includes("--report");
  const enforce = argv.includes("--enforce");
  const planOnly = argv.includes("--plan");
  const full = argv.includes("--full");
  const noAudit = argv.includes("--no-audit");

  const modes = [report, enforce, planOnly].filter(Boolean).length;
  if (unknown.length > 0 || modes !== 1) {
    error("usage: node scripts/release-gate.mjs (--report | --enforce | --plan) [--full] [--no-audit]");
    error("  --report    run the fast set, print every verdict, exit 0");
    error("  --enforce   exit non-zero unless every composed gate and every step passed");
    error("  --plan      print the duration classes and step list, run nothing");
    error("  --full      with --enforce, additionally run the long class (load, soak)");
    error("  --no-audit  pass --no-audit to the supply-chain gate (no registry on this host)");
    return 2;
  }

  /*
   * The nesting break, before any work. This runner starts `offline-check.mjs`, which starts the root
   * suite, which contains `tests/*.test.mjs` — so a test that spawned this file would re-enter the
   * whole tree. Refusing with a non-zero status rather than a quiet PASS is the point: a nested run
   * reporting success would be reporting a suite it never executed.
   */
  const refusal = nestedInvocationRefusal(env);
  if (refusal !== null) {
    error(`release-gate: nested invocation refused (${DEPTH_VARIABLE}=${refusal.depth}).`);
    error("  This runner starts the suite that contains its own test; re-entering forks the whole");
    error("  verification tree per level and the host kills it by signal. Nothing was run, so nothing");
    error("  is reported. Assert the policy in-process against the exported functions instead.");
    return 1;
  }

  const plan = buildPlan({ smokeScripts: discoverSmokeScripts(root), full: full && !report, noAudit, root });
  log(`${formatPlan(plan)}\n`);

  if (planOnly) {
    log("release-gate: PLAN only, nothing was run");
    return 0;
  }

  const outcomes = [];
  for (const step of plan.steps) {
    if (step.kind === "gate-derived") {
      // Composed, not re-run: the row takes the verdict of the fast-class step that already proved it.
      const source = outcomes.find((entry) => entry.id === step.gate.derivedFrom);
      const outcome = !existsSync(join(root, step.requires))
        ? { id: step.id, status: "FAIL", seconds: 0, detail: `${step.requires} does not exist — a missing check is a FAIL, never a skip` }
        : source === undefined
          ? { id: step.id, status: "FAIL", seconds: 0, detail: `no outcome for ${step.gate.derivedFrom} to derive from` }
          : { id: step.id, status: source.status, seconds: 0, detail: `derived from ${step.gate.derivedFrom} (${source.detail})` };
      outcomes.push(outcome);
      log(`  ${outcome.status.padEnd(4)} ${step.label} — ${outcome.detail}`);
      continue;
    }
    log(`  .... ${step.label}`);
    const outcome = runStep(step, { root, env, spawn });
    outcomes.push(outcome);
    log(`  ${outcome.status.padEnd(4)} ${step.label} — ${outcome.seconds}s — ${outcome.detail}`);
  }

  const verdict = assess(plan, outcomes);
  const unverified = await collectUnverified();

  const lines = ["", "verdicts:"];
  for (const outcome of outcomes) lines.push(`  ${outcome.status.padEnd(4)} ${outcome.id.padEnd(28)} ${outcome.seconds}s  ${outcome.detail}`);

  lines.push("", `currently UNVERIFIED (${unverified.length}) — this list is the honest release-notes content:`);
  for (const entry of unverified) lines.push(`  - [${entry.source}] ${entry.item}: ${entry.reason.slice(0, 160)}`);

  if (!plan.full) {
    lines.push(...LONG_CLASS_NOT_RUN_BANNER);
  }

  if (verdict.blocking.length > 0) {
    lines.push("", `blocking (${verdict.blocking.length}):`);
    for (const entry of verdict.blocking) lines.push(`  - ${entry}`);
  }

  log(`${lines.join("\n")}\n`);

  if (report) {
    log("release gate: REPORT (use --enforce to gate a release)");
    return 0;
  }
  if (verdict.blocked) {
    log(`release gate: FAIL — ${verdict.blocking.length} blocking item(s)`);
    return 1;
  }
  log(`release gate: PASS${plan.full ? " (full, including the long class)" : ""}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
