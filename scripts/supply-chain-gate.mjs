#!/usr/bin/env node
/**
 * The supply-chain release gate — Phase 9K Task 8.
 *
 * Answers one question: does the supply-chain evidence permit a release?
 *
 * **It composes the subordinate checks rather than reimplementing them.** The licence rule lives in
 * `scripts/license-inventory.mjs`, the vulnerability policy in `scripts/audit-check.mjs`, the secret
 * scan in `scripts/pack.mjs`, the closure walk in `scripts/dependency-closure.mjs`. A second copy of
 * any of those rules would be a copy that drifts, and the one that drifts is always the one guarding
 * the claim that matters.
 *
 * **The document cannot out-claim the live measurement.** Every row in
 * `docs/superpowers/2026-08-27-bayz-supply-chain-report.md` is read, but three of them are also
 * *re-measured here*, and a live failure blocks regardless of what the row says. A report is a record
 * of a measurement, not a substitute for one, and a gate that trusted the prose could be passed by
 * editing the prose.
 *
 * The asymmetries are the design, so they are stated rather than buried:
 *
 *   - A `FAIL` row blocks **unconditionally**. Somebody looked and it did not work.
 *   - A live `UNKNOWN`/disallowed runtime licence, a live `critical`/`high` runtime advisory, or a
 *     live secret-scan hit blocks, **even if the report says `PASS`**.
 *   - An `UNVERIFIED` **signature** does **not** block. A local release candidate is legitimately
 *     unsigned; conflating "unsigned" with "broken" would make the gate unpassable on the only device
 *     that has it, and it would also blur the distinction 9K Task 5 exists to preserve — unsigned and
 *     forged are not the same outcome. The gate prints the distinction so it cannot read as a pass.
 *   - An `UNVERIFIED` **audit** does not block either, for the reason Task 1 established: a gate that
 *     cannot tell "clean" from "could not look" teaches its operator that red means "retry on better
 *     wifi".
 *   - A row that is `UNVERIFIED` with **no stated reason** *is* an integrity violation. `UNVERIFIED`
 *     is an honest verdict only when it says what was not done.
 *
 * `--report` always exits 0 and prints the state, including a state that would fail.
 * `--enforce` exits non-zero when blocked. No flag, both flags, or an unknown flag exits 2 — "report
 * and enforce" has two plausible meanings and guessing one would let a release script believe it
 * enforced when it only reported. Same contract as `scripts/resilience-gate.mjs`, so an operator does
 * not have to learn two conventions.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { computeClosure } from "./dependency-closure.mjs";
import { buildInventory, findViolations as findLicenseViolations } from "./license-inventory.mjs";
import { ARTIFACT_NAME, readTarEntries, scanBytesForSecrets } from "./pack.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPORT_PATH = join(ROOT, "docs/superpowers/2026-08-27-bayz-supply-chain-report.md");

/** The four verdicts a row may carry. Anything else is a malformed report, not a new status. */
export const STATUSES = new Set(["PASS", "FAIL", "UNVERIFIED", "N/A"]);

/**
 * The ten rows the plan names. Every one must be present.
 *
 * Held here rather than derived from whatever the document happens to contain, because a row quietly
 * dropped from the report is exactly how a check stops being gated without anyone noticing — the
 * failure mode 9K Task 6 already hit once, where a test iterated the same list a mutation had
 * shortened.
 */
export const MANDATORY_ROWS = [
  "audit",
  "lockfile integrity",
  "licence inventory",
  "SBOM",
  "digests",
  "signature",
  "determinism",
  "offline",
  "native-free closure",
  "tarball secret scan",
];

/**
 * Rows whose `UNVERIFIED` is accepted by a documented decision rather than blocking.
 *
 * Both are cases where "not verified" is the *correct* state on this host, not a gap in the work:
 * a local build is unsigned by design, and `npm audit` needs a registry this device may not have.
 */
export const ADVISORY_UNVERIFIED_ROWS = new Set(["signature", "audit", "determinism"]);

/**
 * Evidence reference shapes, from the plan verbatim:
 *   `smoke:<name>#<n>` · `test:<path>` · `test:<path>::<name>` · `transcript:<path>`
 *
 * **This is the fourth copy of this regex in the repository** (9H, 9I, 9J and now here), because each
 * subprogram was specified to stand alone. 9L Task 1 consolidates all four into
 * `scripts/evidence.mjs` and deletes the copies; the duplication is recorded here rather than left
 * for someone to discover, since four copies of one rule will drift and the drifting copy will be the
 * one guarding the claim that matters.
 */
export const EVIDENCE_RE = /^(smoke:[a-z-]+#\d+(?:-\d+)?|test:[\w./-]+(?:::[^|]+)?|transcript:[\w./-]+)$/;

/**
 * Parse the report's verdict table into rows.
 *
 * Strict about shape on purpose: a line that looks like a row but does not parse is reported as
 * malformed rather than skipped. A gate that silently ignores what it cannot read is a gate that
 * passes an empty file.
 */
export function readReport(path = REPORT_PATH) {
  if (!existsSync(path)) {
    return { rows: [], malformed: [], device: undefined, statedRuntimeCount: undefined, missing: true };
  }

  const text = readFileSync(path, "utf8");
  const device = /^- Device: (.+)$/m.exec(text)?.[1];
  const statedRuntimeCount = Number(/^- Runtime dependency count: (\d+) external packages$/m.exec(text)?.[1]);

  const rows = [];
  const malformed = [];
  let inTable = false;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();

    if (line.startsWith("| item ")) {
      inTable = true;
      continue;
    }
    if (!line.startsWith("|")) {
      inTable = false;
      continue;
    }
    if (!inTable) continue;
    if (/^\|[\s:|-]+\|$/.test(line)) continue;

    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 4) {
      malformed.push(`row ${JSON.stringify(line.slice(0, 60))} has ${cells.length} cells, expected 4`);
      continue;
    }

    const [item, status, evidence, ...rest] = cells;
    if (!STATUSES.has(status)) {
      malformed.push(`${item}: status ${JSON.stringify(status)} is not one of ${[...STATUSES].join(", ")}`);
      continue;
    }
    rows.push({ item, status, evidence, notes: rest.join(" | ") });
  }

  return { rows, malformed, device, statedRuntimeCount, missing: false };
}

/**
 * Re-measure the three properties the plan names as blocking, from the live tree.
 *
 * Each returns `PASS`, `FAIL` or `UNVERIFIED` plus a human detail. `UNVERIFIED` means *the check
 * could not run here*, which is never treated as a pass and never treated as a failure.
 */
export function measureLive({ root = ROOT, runAudit = true } = {}) {
  const measurements = [];

  // ---- runtime licences: UNKNOWN or outside the allowed set blocks ----
  try {
    const inventory = buildInventory({ root });
    const violations = findLicenseViolations(inventory);
    measurements.push({
      id: "licence inventory",
      status: violations.length === 0 ? "PASS" : "FAIL",
      detail:
        violations.length === 0
          ? `${inventory.runtimeCount} runtime packages, every identifier in the allowed set`
          : violations.map((entry) => `${entry.name}@${entry.version} is ${entry.license}`).join("; "),
    });
  } catch (error) {
    measurements.push({ id: "licence inventory", status: "UNVERIFIED", detail: `could not build the inventory: ${error.message}` });
  }

  // ---- vulnerabilities: composed by running the Task 1 gate, not by reimplementing its policy ----
  if (runAudit) {
    try {
      const stdout = execFileSync(process.execPath, [join(root, "scripts/audit-check.mjs")], {
        cwd: root,
        encoding: "utf8",
        timeout: 180_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      measurements.push({ id: "audit", status: verdictWordOf(stdout), detail: summaryLineOf(stdout) });
    } catch (error) {
      const stdout = typeof error.stdout === "string" ? error.stdout : "";
      measurements.push({
        id: "audit",
        status: stdout.includes("audit: FAIL") ? "FAIL" : "UNVERIFIED",
        detail: stdout.includes("audit: FAIL") ? summaryLineOf(stdout) : `audit-check could not complete: ${String(error.message).slice(0, 120)}`,
      });
    }
  } else {
    measurements.push({ id: "audit", status: "UNVERIFIED", detail: "audit not run (--no-audit)" });
  }

  // ---- tarball secret scan: the artifact's bytes, not its file list ----
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const tarball = join(root, "packaging/out", `${ARTIFACT_NAME}-${version}.tgz`);
  if (!existsSync(tarball)) {
    /*
     * No artifact is `UNVERIFIED`, not `PASS`. There is nothing to scan, and "nothing was found in a
     * file that does not exist" is not evidence about a release. It does not block, because building
     * the artifact is 9J's job rather than this gate's — but if the *report* claims `PASS` while no
     * artifact exists, the disagreement rule below catches the unsupported claim.
     */
    measurements.push({
      id: "tarball secret scan",
      status: "UNVERIFIED",
      detail: `no artifact at packaging/out/${ARTIFACT_NAME}-${version}.tgz — build it with 'node scripts/pack.mjs'`,
    });
  } else {
    try {
      const entries = readTarEntries(tarball);
      const hits = scanBytesForSecrets(entries);
      measurements.push({
        id: "tarball secret scan",
        status: hits.length === 0 ? "PASS" : "FAIL",
        detail: hits.length === 0 ? `${entries.length} shipped file(s) scanned, no credential-shaped bytes` : hits.join("; "),
      });
    } catch (error) {
      measurements.push({ id: "tarball secret scan", status: "UNVERIFIED", detail: `could not read the artifact: ${error.message}` });
    }
  }

  return measurements;
}

function verdictWordOf(stdout) {
  if (/^audit: PASS$/m.test(stdout)) return "PASS";
  if (/^audit: FAIL$/m.test(stdout)) return "FAIL";
  return "UNVERIFIED";
}

function summaryLineOf(stdout) {
  const runtime = /^runtime closure: .+$/m.exec(stdout)?.[0] ?? "";
  const blocking = /^blocking \(.+$/m.exec(stdout)?.[0] ?? "";
  const unverified = /^UNVERIFIED: .+$/m.exec(stdout)?.[0] ?? "";
  return [runtime, blocking, unverified].filter((part) => part !== "").join("; ");
}

/**
 * Apply the policy to the parsed report and the live measurements together.
 *
 * Returns every violation rather than the first, so `--report` can show all of them at once; a gate
 * that stops at the first problem makes fixing a report an iterative guessing game.
 */
export function assess(parsed, live, { statedRuntimeCountExpected } = {}) {
  const violations = [];
  const blocking = [];
  const advisory = [];

  if (parsed.missing) {
    violations.push(`the supply-chain report is missing at ${REPORT_PATH}`);
    return { violations, blocking, advisory, tally: { PASS: 0, FAIL: 0, UNVERIFIED: 0, "N/A": 0 } };
  }

  if (parsed.device === undefined) violations.push("the report header does not name the device");
  for (const entry of parsed.malformed) violations.push(`malformed row — ${entry}`);
  if (parsed.rows.length === 0) violations.push("the report contains no rows");

  const byItem = new Map(parsed.rows.map((row) => [row.item, row]));
  for (const item of MANDATORY_ROWS) {
    if (!byItem.has(item)) {
      /*
       * The vacuity guard. Every per-row rule below would pass by having nothing to check, which is
       * exactly how a gate stops gating.
       */
      violations.push(`the report has no '${item}' row, which is mandatory`);
    }
  }

  if (statedRuntimeCountExpected !== undefined) {
    if (!Number.isFinite(parsed.statedRuntimeCount)) {
      violations.push("the report header does not state the runtime dependency count");
    } else if (parsed.statedRuntimeCount !== statedRuntimeCountExpected) {
      violations.push(
        `the report states ${parsed.statedRuntimeCount} runtime dependencies but the closure walk computes ${statedRuntimeCountExpected}`,
      );
    }
  }

  for (const row of parsed.rows) {
    if (row.status === "PASS" && !EVIDENCE_RE.test(row.evidence)) {
      violations.push(`${row.item}: PASS without a valid evidence reference (got ${JSON.stringify(row.evidence)})`);
    }
    if (row.status === "UNVERIFIED" && row.notes.trim() === "") {
      // `UNVERIFIED` is honest only when it says what was not done; a bare one is indistinguishable
      // from having forgotten, which is the same reasoning the audit policy applies to a stale deferral.
      violations.push(`${row.item}: UNVERIFIED with no stated reason`);
    }
    if (row.status === "FAIL") {
      blocking.push(`${row.item}: FAIL${row.notes === "" ? "" : ` — ${row.notes}`}`);
    }
    if (row.status === "UNVERIFIED") {
      if (ADVISORY_UNVERIFIED_ROWS.has(row.item)) {
        advisory.push(`${row.item}: UNVERIFIED — ${row.notes}`);
      } else {
        blocking.push(`${row.item}: UNVERIFIED, and this row has no documented exemption`);
      }
    }
  }

  /*
   * The live checks. A live `FAIL` blocks whatever the row says — the document records a measurement
   * and cannot replace one. A live `UNVERIFIED` never contradicts a documented `PASS`, because "I
   * cannot check here" is not evidence against a measurement taken where it could be checked.
   */
  for (const measurement of live) {
    if (measurement.status === "FAIL") {
      blocking.push(`live ${measurement.id}: FAIL — ${measurement.detail}`);
      const row = byItem.get(measurement.id);
      if (row !== undefined && row.status === "PASS") {
        violations.push(`${measurement.id}: the report claims PASS but the live check fails — ${measurement.detail}`);
      }
    }
    if (measurement.status === "UNVERIFIED") {
      advisory.push(`live ${measurement.id}: UNVERIFIED — ${measurement.detail}`);
      const row = byItem.get(measurement.id);
      if (row !== undefined && row.status === "PASS" && measurement.id === "tarball secret scan") {
        /*
         * Narrow on purpose, and only for the secret scan: that row's evidence *is* the artifact, so a
         * `PASS` with no artifact present is a claim about bytes nobody has. The audit row is
         * deliberately exempt — its `PASS` legitimately comes from a run with registry access.
         */
        violations.push(`tarball secret scan: the report claims PASS but no artifact was available to scan — ${measurement.detail}`);
      }
    }
  }

  const tally = { PASS: 0, FAIL: 0, UNVERIFIED: 0, "N/A": 0 };
  for (const row of parsed.rows) tally[row.status] += 1;

  return { violations, blocking, advisory, tally };
}

/** Render the verdict. Deterministic — no timestamp, no set iteration — so two releases can be diffed. */
export function formatReport(parsed, live, verdict) {
  const lines = [];
  lines.push("BAYZ supply-chain gate — Phase 9K Task 8");
  lines.push(`  report: docs/superpowers/2026-08-27-bayz-supply-chain-report.md`);
  lines.push(`  device: ${parsed.device ?? "NOT NAMED"}`);
  lines.push(
    `  rows:   ${parsed.rows.length} — ${verdict.tally.PASS} PASS, ${verdict.tally.FAIL} FAIL, ${verdict.tally.UNVERIFIED} UNVERIFIED, ${verdict.tally["N/A"]} N/A`,
  );
  lines.push(`  runtime dependency count stated: ${Number.isFinite(parsed.statedRuntimeCount) ? parsed.statedRuntimeCount : "NOT STATED"}`);
  lines.push("");

  lines.push("documented rows:");
  for (const item of MANDATORY_ROWS) {
    const row = parsed.rows.find((entry) => entry.item === item);
    lines.push(`  ${(row?.status ?? "MISSING").padEnd(11)} ${item.padEnd(21)} ${row?.evidence ?? ""}`);
  }
  lines.push("");

  lines.push("live re-measurement (the document cannot out-claim these):");
  for (const measurement of live) {
    lines.push(`  ${measurement.status.padEnd(11)} ${measurement.id.padEnd(21)} ${measurement.detail}`);
  }
  lines.push("");

  if (verdict.advisory.length > 0) {
    /*
     * Printed explicitly and always. The point of an advisory verdict is that somebody decided it may
     * pass, and that decision has to be visible or the gate becomes the place inconvenient results go
     * to be forgotten.
     */
    lines.push("UNVERIFIED but not blocking, by the documented decision:");
    for (const entry of verdict.advisory) lines.push(`  - ${entry}`);
    lines.push("");
    lines.push("  An unsigned local build is normal and is NOT a pass: 'unsigned' and 'forged' are");
    lines.push("  different outcomes, and neither is 'verified'. A hosted release is signed keylessly");
    lines.push("  through GitHub OIDC — see docs/release-verification.md.");
    lines.push("");
  }

  if (verdict.violations.length > 0) {
    lines.push(`report integrity violations (${verdict.violations.length}):`);
    for (const entry of verdict.violations) lines.push(`  - ${entry}`);
    lines.push("");
  }

  if (verdict.blocking.length > 0) {
    lines.push(`release-blocking (${verdict.blocking.length}):`);
    for (const entry of verdict.blocking) lines.push(`  - ${entry}`);
    lines.push("");
  }

  return lines.join("\n");
}

/** The number the report must state: external packages in the runtime closure. */
export function runtimeExternalCount(root = ROOT) {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  return computeClosure(lock).external.length;
}

function main(argv) {
  const report = argv.includes("--report");
  const enforce = argv.includes("--enforce");
  const noAudit = argv.includes("--no-audit");
  const unknown = argv.filter((entry) => !["--report", "--enforce", "--no-audit"].includes(entry));

  if (unknown.length > 0 || report === enforce) {
    console.error("usage: node scripts/supply-chain-gate.mjs (--report | --enforce) [--no-audit]");
    console.error("");
    console.error("  --report    print every row and the live re-measurement, exit 0");
    console.error("  --enforce   exit non-zero on any FAIL, an UNKNOWN runtime licence, a critical/high");
    console.error("              runtime advisory, a tarball secret-scan hit, or a malformed report");
    console.error("  --no-audit  skip the live 'npm audit' hop (records it UNVERIFIED, never PASS)");
    return 2;
  }

  const parsed = readReport();
  const live = measureLive({ runAudit: !noAudit });
  const verdict = assess(parsed, live, { statedRuntimeCountExpected: runtimeExternalCount() });

  process.stdout.write(`${formatReport(parsed, live, verdict)}\n`);

  if (!report) {
    if (verdict.violations.length > 0 || verdict.blocking.length > 0) {
      process.stderr.write(
        `supply-chain gate: BLOCKED — ${verdict.blocking.length} blocking, ${verdict.violations.length} integrity violation(s)\n`,
      );
      return 1;
    }
    process.stdout.write("supply-chain gate: PASS\n");
    return 0;
  }

  // A report never blocks; its job is to make the state legible, including a state that would fail.
  process.stdout.write("supply-chain gate: REPORT (use --enforce to gate a release)\n");
  return 0;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
