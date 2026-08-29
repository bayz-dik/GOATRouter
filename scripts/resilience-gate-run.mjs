/**
 * Resilience gate rendering and exit codes — 9I Task 7.
 *
 * Imports from `./resilience-gate-lib.mjs`, never from `./resilience-gate.mjs`: the 9H gate had a
 * circular import from exactly that mistake, and the entry point runs its argument parsing at module
 * scope, so importing it from here would re-run that parsing.
 */

import { ADVISORY_SECTIONS, BLOCKING_SECTIONS, REPORT_PATH, assess, readReport } from "./resilience-gate-lib.mjs";

export async function run({ enforce, path = REPORT_PATH }) {
  const parsed = readReport(path);

  if (parsed.rows.length === 0 && parsed.reason.startsWith("report not found")) {
    console.error(`resilience-gate: ${parsed.reason}`);
    // Missing report is a blocking condition under --enforce and a visible error under --report.
    return enforce ? 1 : 0;
  }

  const { violations, blocking, tally } = assess(parsed);

  console.log("BAYZ resilience gate");
  console.log(`  report: ${path.replace(`${process.cwd()}/`, "")}`);
  console.log(`  device: ${parsed.device ?? "NOT NAMED"}`);
  console.log(
    `  rows:   ${parsed.rows.length} — ${tally.PASS} PASS, ${tally.FAIL} FAIL, ${tally.UNVERIFIED} UNVERIFIED, ${tally["N/A"]} N/A`,
  );
  console.log("");
  console.log(`  blocking sections when UNVERIFIED: ${[...BLOCKING_SECTIONS].join(", ")}`);
  console.log(`  advisory sections (UNVERIFIED permitted): ${[...ADVISORY_SECTIONS].join(", ")}`);
  console.log("");

  const bySection = new Map();
  for (const row of parsed.rows) {
    if (!bySection.has(row.section)) bySection.set(row.section, []);
    bySection.get(row.section).push(row);
  }

  for (const [section, rows] of bySection) {
    const counts = rows.reduce((acc, row) => ({ ...acc, [row.status]: (acc[row.status] ?? 0) + 1 }), {});
    const label = BLOCKING_SECTIONS.has(section) ? "blocking" : ADVISORY_SECTIONS.has(section) ? "advisory" : "informational";
    console.log(
      `  ${section} (${label}): ${Object.entries(counts)
        .map(([status, count]) => `${count} ${status}`)
        .join(", ")}`,
    );
  }

  /*
   * Non-blocking UNVERIFIED rows are printed explicitly. The whole point of an advisory verdict is
   * that somebody decided it may pass — that decision has to be visible, or the gate becomes a place
   * where inconvenient results go to be forgotten.
   */
  const advisoryUnverified = parsed.rows.filter((row) => row.status === "UNVERIFIED" && ADVISORY_SECTIONS.has(row.section));
  if (advisoryUnverified.length > 0) {
    console.log("");
    console.log("  UNVERIFIED but not blocking, by the documented decision:");
    for (const row of advisoryUnverified) console.log(`    - ${row.section}/${row.item}${row.notes ? ` — ${row.notes}` : ""}`);
  }

  if (violations.length > 0) {
    console.log("");
    console.log(`  report integrity violations (${violations.length}):`);
    for (const entry of violations) console.log(`    - ${entry}`);
  }

  if (blocking.length > 0) {
    console.log("");
    console.log(`  release-blocking rows (${blocking.length}):`);
    for (const entry of blocking) console.log(`    - ${entry}`);
  }

  console.log("");

  if (!enforce) {
    // `--report` is informational by contract and always exits 0, even with violations listed above.
    console.log("resilience-gate: report only, no enforcement");
    return 0;
  }

  /*
   * A malformed report blocks as firmly as a failing row. An unreadable report cannot be evidence
   * that anything passed, and treating "cannot parse" as "nothing wrong" would be the single easiest
   * way to route around this gate.
   */
  if (violations.length > 0 || blocking.length > 0) {
    console.log(`resilience-gate: BLOCKED — ${blocking.length} blocking row(s), ${violations.length} integrity violation(s)`);
    return 1;
  }

  console.log("resilience-gate: PASS");
  return 0;
}
