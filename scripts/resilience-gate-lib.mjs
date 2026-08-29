/**
 * Resilience report reader and policy — 9I Task 7.
 *
 * The gate's decisions live here so `resilience-gate.mjs` stays readable as policy and
 * `resilience-gate-run.mjs` stays readable as presentation.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPORT_PATH = join(ROOT, "docs/superpowers/2026-08-27-bayz-resilience-report.md");

/** The four verdicts a row may carry. Anything else is a malformed report, not a new status. */
export const STATUSES = new Set(["PASS", "FAIL", "UNVERIFIED", "N/A"]);

/**
 * Evidence reference shapes, from the plan verbatim:
 *   `smoke:<name>#<n>` · `test:<path>` · `transcript:<path>`
 *
 * A `PASS` without one of these is a claim with nothing behind it, which is the failure mode this
 * whole phase exists to prevent.
 *
 * A contiguous range (`smoke:chaos#31-44`) is accepted as one reference because a scenario really
 * does span numbered checks. A **comma list** is not: `smoke:load#4,9,14,19,24` was in the first
 * draft of the report and this regex rejected it, correctly — one row asserting five unrelated check
 * numbers makes the citation unfalsifiable, since no single check can be looked up to confirm or
 * refute it. The row now cites the first check and states the pattern in its notes.
 */
export const EVIDENCE_RE = /^(smoke:[a-z-]+#\d+(?:-\d+)?|test:[\w./-]+|transcript:[\w./-]+)$/;

/**
 * What counts as a **capacity figure** — a measured quantity, needing a transcript.
 *
 * Narrower than "the notes contain a digit", which was the first version and which flagged
 * `limit 4, queue 2` — a *configuration* value, not a measurement. The distinction is real: a
 * configured limit is verifiable by reading the code, while a latency or a throughput exists only in
 * the run that produced it and is meaningless without the device, timestamp and command beside it.
 *
 * So: a number carrying a unit (ms, s, req/s, MiB, KiB, GiB), or a thousands-separated count, or the
 * word `p50`/`p95`/`p99` — all of which can only come from a measurement.
 */
export const CAPACITY_FIGURE_RE = /\b\d[\d,.]*\s*(?:ms|s|req\/s|[KMG]iB)\b|\bp(?:50|95|99)\b|\b\d{1,3}(?:,\d{3})+\b/;

/**
 * Which sections block a release when UNVERIFIED.
 *
 * **The explicit decision the plan asks for.** Fuzz and chaos UNVERIFIED blocks: those are
 * correctness and failure-handling properties, and "we did not check" is indistinguishable from "it
 * is broken" for a security boundary. Load and soak UNVERIFIED does **not** block, because both are
 * capacity measurements whose feasibility depends on the host — this ARM64 phone cannot mount a
 * bounded filesystem or hold a two-hour run reliably, and a gate that refused every release from
 * such a host would be routed around within a week. The gate names this rather than leaving it
 * implicit, and prints the non-blocking UNVERIFIED rows so nobody can claim they were hidden.
 */
export const BLOCKING_SECTIONS = new Set(["fuzz", "chaos"]);
export const ADVISORY_SECTIONS = new Set(["load", "soak"]);

/**
 * Parse the report into rows.
 *
 * Deliberately strict about shape: a row that does not parse is reported as malformed rather than
 * skipped. A gate that silently ignores what it cannot read is a gate that passes an empty file.
 */
export function readReport(path = REPORT_PATH) {
  if (!existsSync(path)) {
    return { ok: false, reason: `report not found at ${path}`, rows: [], device: undefined };
  }

  const text = readFileSync(path, "utf8");
  const device = /^- Device: (.+)$/m.exec(text)?.[1];

  const rows = [];
  const malformed = [];
  let section;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();

    const heading = /^##\s+(.+)$/.exec(line);
    if (heading !== null) {
      // Section keys are the first word, lowercased: "## Fuzz targets" → "fuzz".
      section = heading[1].trim().split(/\s+/)[0].toLowerCase();
      continue;
    }

    if (!line.startsWith("|") || section === undefined) continue;

    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 3) continue;
    // Header and separator rows.
    if (/^-+$/.test(cells[0]) || cells[0].toLowerCase() === "item") continue;

    const [item, status, evidence, ...rest] = cells;
    const notes = rest.join(" | ");

    if (!STATUSES.has(status)) {
      malformed.push(`${section}/${item}: status ${JSON.stringify(status)} is not one of ${[...STATUSES].join(", ")}`);
      continue;
    }

    rows.push({ section, item, status, evidence, notes });
  }

  return { ok: malformed.length === 0, reason: malformed.join("; "), rows, device, malformed };
}

/**
 * Every rule the report must satisfy, evaluated together.
 *
 * Returned as a list of violations rather than a boolean so `--report` can show all of them at once;
 * a gate that stops at the first problem makes fixing a report an iterative guessing game.
 */
export function assess(parsed) {
  const violations = [];
  const blocking = [];

  if (parsed.device === undefined) {
    violations.push("the report header does not name the device");
  }

  if (parsed.malformed !== undefined && parsed.malformed.length > 0) {
    for (const entry of parsed.malformed) violations.push(`malformed row — ${entry}`);
  }

  if (parsed.rows.length === 0) {
    violations.push("the report contains no rows");
  }

  for (const row of parsed.rows) {
    const where = `${row.section}/${row.item}`;

    if (row.status === "PASS" && !EVIDENCE_RE.test(row.evidence)) {
      violations.push(`${where}: PASS without a valid evidence reference (got ${JSON.stringify(row.evidence)})`);
    }

    /*
     * A capacity figure needs a transcript, not merely any evidence. A load or soak number cited
     * from a test file would be a number with no device, no timestamp and no command behind it.
     */
    if (ADVISORY_SECTIONS.has(row.section) && row.status === "PASS" && CAPACITY_FIGURE_RE.test(row.notes) && !row.evidence.startsWith("transcript:")) {
      violations.push(`${where}: carries a capacity figure without a transcript: reference`);
    }

    if (row.status === "FAIL") {
      blocking.push(`${where}: FAIL`);
    }

    if (row.status === "UNVERIFIED" && BLOCKING_SECTIONS.has(row.section)) {
      blocking.push(`${where}: UNVERIFIED in a blocking section (${row.section})`);
    }
  }

  const tally = { PASS: 0, FAIL: 0, UNVERIFIED: 0, "N/A": 0 };
  for (const row of parsed.rows) tally[row.status] += 1;

  return { violations, blocking, tally };
}
