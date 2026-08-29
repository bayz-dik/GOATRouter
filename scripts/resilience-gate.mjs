#!/usr/bin/env node
/**
 * Resilience gate — 9I Task 7.
 *
 * Reads `docs/superpowers/2026-08-27-bayz-resilience-report.md` and decides whether the resilience
 * evidence permits a release. Split entry/lib/run for the same reason the 9H client gate was: the
 * policy must stay small enough to read as policy.
 *
 * Exit contract, deliberately identical in shape to `scripts/client-gate.mjs` so an operator does
 * not have to learn two conventions:
 *
 *   --report   always exit 0, print every row and the tally
 *   --enforce  exit 1 if any row is FAIL, or if any *fuzz or chaos* row is UNVERIFIED
 *   no flag / both flags / unknown flag  exit 2
 *
 * 9L runs this with `--enforce`.
 */

const args = process.argv.slice(2);
const report = args.includes("--report");
const enforce = args.includes("--enforce");
const unknown = args.filter((entry) => entry !== "--report" && entry !== "--enforce");

if (unknown.length > 0 || report === enforce) {
  /*
   * Both flags is an error rather than a precedence question. "Report and enforce" has two plausible
   * meanings — print then fail, or print instead of failing — and guessing one would let a release
   * script believe it enforced when it only reported.
   */
  console.error("usage: node scripts/resilience-gate.mjs (--report | --enforce)");
  console.error("");
  console.error("  --report   list every resilience row and exit 0");
  console.error("  --enforce  exit non-zero if any row is FAIL, or any fuzz/chaos row is UNVERIFIED");
  process.exit(2);
}

const { run } = await import("./resilience-gate-run.mjs");
process.exit(await run({ enforce }));
