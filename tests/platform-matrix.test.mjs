import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const MATRIX = join(root, "docs/superpowers/2026-08-27-bayz-platform-matrix.md");

/**
 * Platform support matrix — 9J Task 1.
 *
 * The whole point of this file is to stop the matrix becoming decorative. A support claim is the
 * easiest thing in a release to fake: the code looks portable, so somebody writes `PASS` in a
 * Windows column and a user on Windows discovers otherwise.
 *
 * So the load-bearing assertion here is not "every cell is filled" but **a `PASS` requires a
 * transcript from that platform**. Everything else follows from it.
 */

/** The plan's seven rows, verbatim. */
const PLATFORMS = [
  "Linux x64",
  "Linux ARM64",
  "Termux/Android ARM64",
  "Windows x64",
  "Windows ARM64",
  "macOS x64",
  "macOS ARM64",
];

/** The plan's eleven columns, verbatim. */
const COLUMNS = [
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

const STATUSES = new Set(["PASS", "FAIL", "UNVERIFIED", "N/A"]);
const EVIDENCE_RE = /^(smoke:[a-z-]+#\d+(?:-\d+)?|test:[\w./-]+|transcript:[\w./-]+)$/;

/**
 * The primary platform: the only one this repository can produce first-hand evidence for.
 *
 * Named here rather than inferred, because "which device is this release actually qualified on" is a
 * decision, not a detail.
 */
const PRIMARY = "Termux/Android ARM64";

function matrix() {
  assert.ok(existsSync(MATRIX), `the platform matrix is missing at ${MATRIX}`);
  return readFileSync(MATRIX, "utf8");
}

/**
 * Parse the matrix into `{ platform, column, status, evidence }` cells.
 *
 * Table-driven rather than regex-per-claim: the document's own header row defines the column order,
 * so a column inserted in the document without updating this parser shows up as a mismatch instead
 * of silently shifting every value one place left.
 */
function parseCells(text) {
  const lines = text.split("\n").map((line) => line.trim());
  const headerIndex = lines.findIndex((line) => line.startsWith("| platform") || line.startsWith("| Platform"));
  assert.ok(headerIndex >= 0, "the matrix has no platform table header");

  const header = lines[headerIndex]
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim().toLowerCase());

  const cells = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.startsWith("|")) break;
    const values = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (values.length !== header.length) continue;
    const platform = values[0];
    for (let index = 1; index < values.length; index += 1) {
      // A cell is `STATUS` or `STATUS (evidence)`.
      const raw = values[index];
      const match = /^([A-Z/]+)(?:\s+\((.+)\))?$/.exec(raw);
      cells.push({
        platform,
        column: header[index],
        raw,
        status: match?.[1],
        evidence: match?.[2],
      });
    }
  }
  return { header, cells };
}

test("the platform matrix exists and names the device behind the primary row", () => {
  const text = matrix();
  assert.match(text, /^- Primary device: /m, "the header does not name the primary device");
  assert.match(text, /Termux\/Android ARM64/, "the primary device is not the Termux device");
  assert.match(text, /Node v24\.19\.0/, "the header does not record the Node version measured on it");
});

test("all seven platform rows are present", () => {
  const { cells } = parseCells(matrix());
  const seen = new Set(cells.map((cell) => cell.platform));
  for (const platform of PLATFORMS) {
    assert.ok(seen.has(platform), `platform row missing: ${platform}`);
  }
  assert.equal(seen.size, PLATFORMS.length, `expected exactly ${PLATFORMS.length} rows, found ${[...seen].join(", ")}`);
});

test("all eleven columns are present, in the plan's order", () => {
  const { header } = parseCells(matrix());
  const columns = header.slice(1);
  assert.deepEqual(
    columns,
    COLUMNS,
    `columns do not match the plan: expected ${COLUMNS.join(", ")} but found ${columns.join(", ")}`,
  );
});

test("every cell is exactly one of PASS, FAIL, UNVERIFIED, N/A", () => {
  const { cells } = parseCells(matrix());
  assert.equal(cells.length, PLATFORMS.length * COLUMNS.length, `expected ${PLATFORMS.length * COLUMNS.length} cells, parsed ${cells.length}`);
  for (const cell of cells) {
    assert.ok(
      cell.status !== undefined && STATUSES.has(cell.status),
      `${cell.platform}/${cell.column}: ${JSON.stringify(cell.raw)} is not one of ${[...STATUSES].join(", ")}`,
    );
  }
});

test("no cell is empty or a placeholder", () => {
  const { cells } = parseCells(matrix());
  /*
   * Placeholders are how a matrix rots: a `TODO` or a `-` reads as "not important yet" and survives
   * into a release. There is always a correct answer available — `UNVERIFIED` — so there is never a
   * reason for a blank.
   */
  for (const cell of cells) {
    assert.ok(cell.raw.length > 0, `${cell.platform}/${cell.column} is empty`);
    for (const placeholder of ["TODO", "TBD", "?", "-", "n/a", "pending", "WIP"]) {
      assert.notEqual(cell.raw.toLowerCase(), placeholder.toLowerCase(), `${cell.platform}/${cell.column} is a placeholder: ${cell.raw}`);
    }
  }
});

test("every PASS carries an evidence reference of the required shape", () => {
  const { cells } = parseCells(matrix());
  for (const cell of cells.filter((entry) => entry.status === "PASS")) {
    assert.ok(cell.evidence !== undefined, `${cell.platform}/${cell.column} is PASS with no evidence`);
    assert.match(
      cell.evidence,
      EVIDENCE_RE,
      `${cell.platform}/${cell.column}: evidence ${JSON.stringify(cell.evidence)} does not match the required shape`,
    );
  }
});

test("a PASS on a platform with no transcript for that platform fails", () => {
  /*
   * **The assertion this task exists for.**
   *
   * Cited evidence must come from *that platform's* own transcript directory. Without this rule the
   * Termux run's transcripts would silently justify a Windows `PASS`, which is precisely the
   * "source looks portable, therefore it works" claim the plan's Locks forbid.
   */
  const { cells } = parseCells(matrix());
  const slug = (platform) => platform.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  for (const cell of cells.filter((entry) => entry.status === "PASS")) {
    const platformSlug = slug(cell.platform);
    const match = /^(?:test|transcript|smoke):(.+)$/.exec(cell.evidence ?? "");
    assert.ok(match !== null, `${cell.platform}/${cell.column}: unparseable evidence`);

    if (cell.evidence.startsWith("transcript:")) {
      const path = match[1];
      assert.ok(existsSync(join(root, path)), `${cell.platform}/${cell.column}: transcript ${path} does not exist`);
      assert.ok(
        path.includes(platformSlug),
        `${cell.platform}/${cell.column}: transcript ${path} is not from this platform (expected the path to contain ${platformSlug})`,
      );
      continue;
    }

    /*
     * A `smoke:` or `test:` citation is only acceptable for the primary platform, and only because
     * those suites *ran here*. On any other platform the same suite has not been executed, so the
     * citation would be an assertion about a machine nobody has touched.
     */
    assert.equal(
      cell.platform,
      PRIMARY,
      `${cell.platform}/${cell.column}: PASS cites ${cell.evidence}, but a smoke/test citation only proves the platform it ran on (${PRIMARY})`,
    );

    if (cell.evidence.startsWith("test:")) {
      assert.ok(existsSync(join(root, match[1])), `${cell.platform}/${cell.column}: test path ${match[1]} does not exist`);
    }
  }
});

test("no non-primary platform claims PASS", () => {
  /*
   * A stronger statement than the previous test, and true for as long as this repository has one
   * device. When a CI runner or a real machine produces a transcript, this test is the one that has
   * to be deliberately relaxed — which is the correct place for that decision to be visible.
   */
  const { cells } = parseCells(matrix());
  const offenders = cells.filter((entry) => entry.status === "PASS" && entry.platform !== PRIMARY);
  assert.deepEqual(
    offenders.map((entry) => `${entry.platform}/${entry.column}`),
    [],
    "a non-primary platform claims PASS without a machine having produced evidence",
  );
});

test("the matrix carries a legend explaining every status", () => {
  const text = matrix();
  for (const status of STATUSES) {
    assert.ok(text.includes(status), `the legend does not mention ${status}`);
  }
  assert.match(text, /## Legend/, "there is no legend section");
  // The legend must say what UNVERIFIED means, since it is the honest default and the most used.
  assert.match(text, /UNVERIFIED[^\n]*not been (run|attempted|observed)/i, "the legend does not define UNVERIFIED as unobserved");
});

test("the matrix states which platforms must not be described as supported", () => {
  const text = matrix();
  /*
   * The matrix is the source for the README's support section (Task 8 feeds it). Stating the
   * negative explicitly is what stops "we have a Windows column" turning into "we support Windows".
   */
  assert.match(text, /must not be (described|advertised|claimed)/i, "the matrix does not state the unsupported-platform rule");
});
