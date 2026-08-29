#!/usr/bin/env node
/**
 * The platform release gate — Phase 9J Task 8.
 *
 * Answers one question: may this release claim the platforms it is about to claim?
 *
 * The asymmetry in here is the whole design, so it is worth stating plainly:
 *
 *   - A `FAIL` anywhere blocks **unconditionally**. Someone looked, it did not work; shipping anyway
 *     would be shipping a known defect.
 *   - An `UNVERIFIED` on the **primary** platform blocks. That is the device this release is
 *     qualified on, so a hole there is a real hole.
 *   - An `UNVERIFIED` on any **other** platform does **not** block. This repository has, by design,
 *     no access to five of its seven platforms. A gate that can never pass is a gate that gets
 *     bypassed or ignored, which is strictly worse than one that reports honestly. The correct
 *     outcome is a *narrower support claim*, so the gate prints the exact list of platforms that must
 *     not be described as supported.
 *
 * `--report` always exits 0 and prints the state. `--enforce` exits non-zero when blocked.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MATRIX_PATH = join(ROOT, "docs/superpowers/2026-08-27-bayz-platform-matrix.md");

/** The device this release is qualified on. Matches `tests/platform-matrix.test.mjs`. */
export const PRIMARY = "Termux/Android ARM64";

/**
 * Columns a release must have observed on the primary platform.
 *
 * Held here rather than read from the matrix header, so removing a column from the document cannot
 * silently shrink what "complete" means — `evaluate` checks the matrix still supplies all of them.
 */
export const MANDATORY_COLUMNS = [
  "install",
  "first boot",
  "schema create",
  "chat",
  "stream",
  "proxy",
  "dashboard serve",
  "restart",
  "upgrade from v1",
  "data dir permissions",
  "uninstall",
];

const STATUS_RE = /^(PASS|FAIL|UNVERIFIED|N\/A)\b/;

/**
 * Parse the matrix table into `{ columns, rows }`.
 *
 * Throws when no table is found: a gate that reads a broken file as "nothing wrong" is worse than no
 * gate at all.
 */
export function parseMatrix(text) {
  const lines = text.split("\n");
  const headerIndex = lines.findIndex((line) => line.startsWith("| platform |"));
  if (headerIndex === -1) {
    throw new Error("platform gate: no matrix table found (expected a row starting '| platform |')");
  }

  const cellsOf = (line) =>
    line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());

  const columns = cellsOf(lines[headerIndex]).slice(1);

  const rows = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.startsWith("|")) break;
    const cells = cellsOf(line);
    const [platform, ...rest] = cells;
    rows.push({
      platform,
      cells: rest.map((cell, index) => {
        const status = STATUS_RE.exec(cell)?.[1] ?? cell;
        return {
          column: columns[index] ?? `column ${index}`,
          status,
          // Kept for the report; never used in a decision.
          evidence: cell.slice(status.length).trim().replace(/^\((.*)\)$/, "$1"),
        };
      }),
    });
  }

  if (rows.length === 0) {
    throw new Error("platform gate: the matrix table has no platform rows");
  }
  return { columns, rows };
}

/**
 * Decide. Returns `{ blocked, reasons, notices, unsupported, supported }`.
 *
 * `reasons` are blocking; `notices` are not. Keeping them separate is what lets the report show a
 * legitimately incomplete matrix without implying a failure.
 */
export function evaluate(matrix) {
  const reasons = [];
  const notices = [];

  // Any FAIL, anywhere. Checked first because nothing else can excuse it.
  for (const row of matrix.rows) {
    for (const cell of row.cells) {
      if (cell.status === "FAIL") {
        reasons.push(`${row.platform}: ${cell.column} is FAIL${cell.evidence === "" ? "" : ` (${cell.evidence})`}`);
      }
    }
  }

  const primary = matrix.rows.find((row) => row.platform === PRIMARY);
  if (primary === undefined) {
    /*
     * The vacuity guard. Every primary-row rule below would pass by having nothing to check, which is
     * exactly how a gate stops gating without anyone noticing.
     */
    reasons.push(`the primary platform row (${PRIMARY}) is missing from the matrix`);
  } else {
    // Every mandatory column must exist. A column dropped from the document would otherwise make the
    // primary row "complete" by shrinking the definition.
    for (const column of MANDATORY_COLUMNS) {
      if (!primary.cells.some((cell) => cell.column === column)) {
        reasons.push(`the matrix has no '${column}' column, which is mandatory for ${PRIMARY}`);
      }
    }

    for (const cell of primary.cells) {
      if (!MANDATORY_COLUMNS.includes(cell.column)) continue;
      if (cell.status === "UNVERIFIED") {
        reasons.push(`${PRIMARY}: ${cell.column} is UNVERIFIED, and this is the qualifying device`);
      }
      if (cell.status === "N/A") {
        // Not blocking, but never silent: `N/A` must not become a way to dodge measurement.
        notices.push(`${PRIMARY}: ${cell.column} is N/A — confirm the capability genuinely does not exist here`);
      }
      if (cell.status === "PASS" && cell.evidence === "") {
        reasons.push(`${PRIMARY}: ${cell.column} claims PASS with no evidence reference`);
      }
    }
  }

  const supported = [];
  const unsupported = [];
  for (const row of matrix.rows) {
    const mandatory = row.cells.filter((cell) => MANDATORY_COLUMNS.includes(cell.column));
    const complete = mandatory.length > 0 && mandatory.every((cell) => cell.status === "PASS" || cell.status === "N/A");
    if (complete) {
      supported.push(row.platform);
    } else {
      unsupported.push(row.platform);
      if (row.platform !== PRIMARY) {
        const unverified = mandatory.filter((cell) => cell.status === "UNVERIFIED").length;
        notices.push(`${row.platform}: ${unverified}/${mandatory.length} mandatory cells UNVERIFIED — no evidence exists`);
      }
    }
  }

  return { blocked: reasons.length > 0, reasons, notices, unsupported, supported };
}

/**
 * Render the verdict.
 *
 * Deterministic on purpose — no timestamp, no set iteration — so two releases can be diffed.
 */
export function formatReport(verdict, matrix) {
  const lines = [];
  lines.push(`platform gate: ${verdict.blocked ? "BLOCKED" : "REPORT"}`);
  lines.push("");
  lines.push(`primary platform: ${PRIMARY}`);
  lines.push(`platforms in matrix: ${matrix.rows.length}`);
  lines.push(`mandatory columns: ${MANDATORY_COLUMNS.length}`);
  lines.push("");

  lines.push("per-platform mandatory-cell counts:");
  for (const row of matrix.rows) {
    const mandatory = row.cells.filter((cell) => MANDATORY_COLUMNS.includes(cell.column));
    const tally = { PASS: 0, FAIL: 0, UNVERIFIED: 0, "N/A": 0 };
    for (const cell of mandatory) tally[cell.status] = (tally[cell.status] ?? 0) + 1;
    lines.push(
      `  ${row.platform.padEnd(22)} PASS ${tally.PASS}  FAIL ${tally.FAIL}  UNVERIFIED ${tally.UNVERIFIED}  N/A ${tally["N/A"]}`,
    );
  }
  lines.push("");

  lines.push(`verified platforms (may be claimed as supported): ${verdict.supported.join(", ") || "(none)"}`);
  lines.push("");
  lines.push("do not claim support for these platforms:");
  for (const platform of verdict.unsupported) lines.push(`  - ${platform}`);
  lines.push("");

  if (verdict.notices.length > 0) {
    lines.push("notices (not blocking):");
    for (const notice of verdict.notices) lines.push(`  - ${notice}`);
    lines.push("");
  }

  if (verdict.reasons.length > 0) {
    lines.push("BLOCKING:");
    for (const reason of verdict.reasons) lines.push(`  - ${reason}`);
    lines.push("");
  }

  return lines.join("\n");
}

function main(argv) {
  const enforce = argv.includes("--enforce");
  const matrix = parseMatrix(readFileSync(MATRIX_PATH, "utf8"));
  const verdict = evaluate(matrix);

  process.stdout.write(`${formatReport(verdict, matrix)}\n`);

  if (!enforce) {
    // A report never blocks; its job is to make the state legible, including a state that would fail.
    process.stdout.write("platform gate: REPORT (use --enforce to gate a release)\n");
    return 0;
  }
  if (verdict.blocked) {
    process.stderr.write("platform gate: FAIL\n");
    return 1;
  }
  process.stdout.write("platform gate: PASS\n");
  return 0;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
