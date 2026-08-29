#!/usr/bin/env node
/**
 * Boundary fuzz runner — 9I Task 3.
 *
 * Runs all thirteen targets at their pinned seeds and prints `ok N` / `FAIL N` per target, so a
 * report row can cite `smoke:fuzz#N`. **Check numbers are contractual**, as in
 * `client-conformance.mjs`: the matrix and the resilience report cite them, so a new target is
 * appended rather than inserted.
 *
 * Writes any failing input to `scripts/fuzz/corpus/regression/` — credential-scanned first,
 * which the harness enforces by refusing to even record a failure whose input or error text
 * carries a credential shape.
 *
 * Exits non-zero on any failure.
 *
 * Usage:
 *   node scripts/fuzz-run.mjs                 # all targets, 5,000 iterations each
 *   node scripts/fuzz-run.mjs --quick         # 500 each, for a fast sanity pass
 *   node scripts/fuzz-run.mjs --only=sse,url  # a subset
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Relaunch under tsx: every target imports the real TypeScript sources directly, because
 * fuzzing a compiled copy would fuzz whatever was last built rather than what is in the tree.
 */
if (!process.env.BAYZ_FUZZ_LOADER) {
  const relaunch = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, BAYZ_FUZZ_LOADER: "1" },
  });
  process.exit(relaunch.status ?? 1);
}

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REGRESSION_DIR = join(HERE, "fuzz", "corpus", "regression");

const { fuzz } = await import("./fuzz/harness.mjs");
const { rss: rssOf } = await import("./fuzz/targets/shared.mjs");

/** Contractual order. Append only. */
const TARGET_NAMES = Object.freeze([
  "api-schema",
  "authorization",
  "sse",
  "tool-args",
  "provider-response",
  "provider-config",
  "proxy-config",
  "socks5",
  "telemetry",
  "storage-envelope",
  "migration",
  "url",
  "identifier",
]);

/** Per-target RSS growth bound from the plan. */
const MAX_RSS_GROWTH_BYTES = 64 * 1024 * 1024;

const args = process.argv.slice(2);
const quick = args.includes("--quick");
const onlyArg = args.find((a) => a.startsWith("--only="));
const only = onlyArg === undefined ? undefined : new Set(onlyArg.slice("--only=".length).split(","));

let checkNumber = 0;
const failures = [];

function check(label, ok, detail) {
  checkNumber += 1;
  if (ok) {
    console.log(`  ok   ${String(checkNumber).padStart(2)}  ${label}`);
  } else {
    console.log(`  FAIL ${String(checkNumber).padStart(2)}  ${label}${detail === undefined ? "" : ` — ${detail}`}`);
    failures.push({ number: checkNumber, label, detail });
  }
}

/** Persist a failing input so the next run starts from a regression, not a fresh guess. */
function saveRegression(targetName, failure) {
  mkdirSync(REGRESSION_DIR, { recursive: true });
  const path = join(REGRESSION_DIR, `${targetName}-${failure.iteration}.json`);
  writeFileSync(
    path,
    `${JSON.stringify({ target: targetName, iteration: failure.iteration, kind: failure.kind, error: failure.error, input: failure.input }, null, 2)}\n`,
  );
  return path;
}

console.log("BAYZ boundary fuzz");
console.log(`  node ${process.version}, ${process.arch}, ${quick ? "quick" : "full"} mode`);
console.log("");

for (const name of TARGET_NAMES) {
  if (only !== undefined && !only.has(name)) continue;

  const module = await import(`./fuzz/targets/${name}.mjs`);
  const target = module.target;
  const iterations = quick ? Math.min(500, target.iterations) : target.iterations;

  // Settle allocations from module load before the growth baseline, so a target's own fixtures
  // are not charged to the loop.
  global.gc?.();
  const rssBefore = rssOf();
  const started = Date.now();

  const result = await fuzz({
    ...target,
    iterations,
    // Generous, since a slow target must be reported as slow rather than silently truncated.
    timeBudgetMs: 900_000,
  });

  global.gc?.();
  const growth = rssOf() - rssBefore;
  const elapsed = Date.now() - started;

  console.log(`${name} (seed ${result.seed})`);

  check(
    `${name}: ${iterations} iterations completed`,
    result.completed === iterations && !result.truncated,
    `completed ${result.completed}${result.truncated ? ", time-capped" : ""}`,
  );

  check(`${name}: no boundary failure`, result.failures.length === 0, result.failures.length > 0 ? `${result.failures.length} failures; first: ${result.failures[0].error}` : undefined);

  check(
    `${name}: RSS growth under 64 MiB`,
    growth < MAX_RSS_GROWTH_BYTES,
    `grew ${(growth / 1048576).toFixed(1)} MiB`,
  );

  for (const failure of result.failures.slice(0, 5)) {
    const path = saveRegression(name, failure);
    console.log(`       saved ${path}`);
    console.log(`       iteration ${failure.iteration} (${failure.kind}): ${failure.error.slice(0, 200)}`);
  }

  if (typeof module.summary === "function") {
    console.log(`       ${module.summary()}`);
  }
  console.log(`       ${elapsed} ms, ${(growth / 1048576).toFixed(1)} MiB RSS growth`);

  module.cleanup?.();
  console.log("");
}

console.log(`${checkNumber - failures.length}/${checkNumber} checks passed`);
if (failures.length > 0) {
  console.log("");
  for (const failure of failures) console.log(`  FAIL ${failure.number}  ${failure.label}`);
  console.log("fuzz: FAIL");
  process.exit(1);
}
console.log("fuzz: PASS");
