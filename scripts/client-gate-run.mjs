/**
 * Reporting and enforcement for `scripts/client-gate.mjs` — 9H Task 6.
 *
 * Policy, parsing, and assessment live in `scripts/client-gate-lib.mjs`; this file only
 * renders the verdict and sets the exit code.
 */
const { BLOCKING, CORE_3, MANDATORY, assess, readMatrix } = await import("./client-gate-lib.mjs");

function pad(value, width) {
  return String(value).padEnd(width);
}

function printSummary(summary) {
  console.log("\nCore 3 status (all 17 capabilities are mandatory):\n");
  console.log(
    `  ${pad("client", 14)} ${pad("VERIFIED", 9)} ${pad("PARTIAL", 8)} ${pad("BLOCKED", 8)} ${pad("UNVERIFIED", 11)} ${pad("N/A", 4)} MISSING`,
  );
  console.log(
    `  ${"-".repeat(14)} ${"-".repeat(9)} ${"-".repeat(8)} ${"-".repeat(8)} ${"-".repeat(11)} ${"-".repeat(4)} -------`,
  );
  for (const row of summary) {
    console.log(
      `  ${pad(row.client, 14)} ${pad(row.verified, 9)} ${pad(row.partial, 8)} ${pad(row.blocked, 8)} ${pad(row.unverified, 11)} ${pad(row.na, 4)} ${row.missing}`,
    );
  }
}

function printBlockers(blockers) {
  if (blockers.length === 0) {
    console.log("\nNothing blocks a release: every Core 3 mandatory capability is VERIFIED,");
    console.log("PARTIAL with a named limitation, or N/A because the client has no such surface.");
    return;
  }
  console.log(`\nBlocking cells (${blockers.length}):\n`);
  console.log(`  ${pad("client", 14)} ${pad("capability", 23)} ${pad("status", 11)} why`);
  console.log(`  ${"-".repeat(14)} ${"-".repeat(23)} ${"-".repeat(11)} ${"-".repeat(40)}`);
  for (const entry of blockers) {
    // Truncated for the table; the matrix carries the full reason. A gate that dumped
    // 300-character notes would be unreadable exactly when it matters most.
    const why = entry.note.replace(/\s+/g, " ").slice(0, 74);
    console.log(`  ${pad(entry.client, 14)} ${pad(entry.capability, 23)} ${pad(entry.status, 11)} ${why}`);
  }
}

export async function main(argv) {
  const enforce = argv.includes("--enforce");
  const report = argv.includes("--report");

  if (enforce && report) {
    console.error("client-gate: pass either --report or --enforce, not both");
    process.exitCode = 2;
    return;
  }
  if (!enforce && !report) {
    console.error("client-gate: pass --report (always exits 0) or --enforce (exits non-zero when blocked)");
    process.exitCode = 2;
    return;
  }

  console.log(`BAYZ client compatibility gate — ${enforce ? "--enforce" : "--report"}`);
  console.log("Reads docs/superpowers/2026-08-27-bayz-client-compatibility-matrix.md.");
  console.log("Blocks on BLOCKED (tried, failed) and UNVERIFIED (never tried); PARTIAL and");
  console.log("N/A pass, because each carries evidence or a stated absence of surface.");

  const clients = readMatrix();
  const { blockers, summary } = assess(clients);
  printSummary(summary);
  printBlockers(blockers);

  if (!enforce) {
    console.log("\n--report always exits 0. Use --enforce to gate a release.");
    return;
  }

  if (blockers.length > 0) {
    console.error(`\nRELEASE BLOCKED: ${blockers.length} Core 3 mandatory cell(s) are not release-ready.`);
    console.error("This is the gate doing its job. Verify the cells against the real clients —");
    console.error("scripts/verify-opencode.mjs, scripts/verify-hermes.mjs,");
    console.error("scripts/verify-antigravity.mjs — or record an honest BLOCKED with a reason.");
    console.error("Editing the matrix to say VERIFIED without a transcript will fail");
    console.error("tests/matrix-integrity.test.mjs, which resolves every citation on disk.");
    process.exitCode = 1;
    return;
  }

  console.log("\nRELEASE PERMITTED by the client compatibility gate.");
}
