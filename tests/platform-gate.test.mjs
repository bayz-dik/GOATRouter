import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PRIMARY, evaluate, formatReport, parseMatrix } from "../scripts/platform-gate.mjs";

/**
 * The platform release gate — Phase 9J Task 8.
 *
 * The gate answers one question: may this release claim the platforms it is about to claim?
 *
 * Its shape is deliberate. A `FAIL` anywhere blocks unconditionally — a platform observed broken is
 * the one thing no release should paper over. But an `UNVERIFIED` on a platform **that does not
 * exist here** must not block, because blocking on a machine nobody has would turn the gate into
 * theatre: it would be permanently red, so it would be permanently ignored or permanently bypassed.
 * What it does instead is print the exact list of platforms that must not be described as supported.
 *
 * The primary platform is held to the opposite standard: an `UNVERIFIED` mandatory cell on the device
 * this release is qualified on is a genuine hole and does block.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(ROOT, "scripts/platform-gate.mjs");
const MATRIX = join(ROOT, "docs/superpowers/2026-08-27-bayz-platform-matrix.md");

/** Run the gate as a script, the way CI and a release would. */
function runGate(args) {
  try {
    const stdout = execFileSync(process.execPath, [GATE, ...args], { encoding: "utf8" });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.status ?? 1, stdout: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/** A matrix file built from rows, for the cases the real matrix cannot currently exhibit. */
function syntheticMatrix(rows) {
  const header =
    "| platform | install | first boot | schema create | chat | stream | proxy | dashboard serve | restart | upgrade from v1 | data dir permissions | uninstall |\n" +
    "|---|---|---|---|---|---|---|---|---|---|---|---|\n";
  const body = rows.map((row) => `| ${row.platform} | ${row.cells.join(" | ")} |`).join("\n");
  const dir = mkdtempSync(join(tmpdir(), "bayz-gate-"));
  const path = join(dir, "matrix.md");
  writeFileSync(path, `# synthetic\n\n## Matrix\n\n${header}${body}\n`);
  return path;
}

const ELEVEN = (value) => Array.from({ length: 11 }, () => value);

test("the parser reads every platform row and cell from the real matrix", () => {
  const matrix = parseMatrix(readFileSync(MATRIX, "utf8"));
  assert.equal(matrix.columns.length, 11, `expected 11 columns, got ${matrix.columns.length}`);
  assert.deepEqual(
    matrix.rows.map((row) => row.platform),
    ["Linux x64", "Linux ARM64", "Termux/Android ARM64", "Windows x64", "Windows ARM64", "macOS x64", "macOS ARM64"],
  );
  // Statuses are parsed away from their evidence, so a gate decision never depends on prose.
  for (const row of matrix.rows) {
    for (const cell of row.cells) {
      assert.match(cell.status, /^(PASS|FAIL|UNVERIFIED|N\/A)$/, `${row.platform}: bad status ${cell.status}`);
    }
  }
});

test("--report exits 0 and prints the current state", () => {
  /*
   * A report must never block. Its job is to make the state legible — including a state that would
   * fail enforcement — so `--report` on a matrix full of holes still exits 0.
   */
  const result = runGate(["--report"]);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /platform gate: REPORT/);
  assert.match(result.stdout, new RegExp(PRIMARY.replace(/[/]/g, "\\/")));
});

test("--enforce passes on the real matrix, because the primary platform is complete", () => {
  // The current true state: the Termux row is fully observed, so enforcement passes.
  const result = runGate(["--enforce"]);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /platform gate: PASS/);
});

test("the gate prints the platforms that must not be called supported", () => {
  /*
   * The most useful thing the gate emits. This list is what the README support section is allowed to
   * claim, and it is the reason an UNVERIFIED non-primary row does not need to block: the honest
   * outcome is a narrower support claim, not a blocked release.
   */
  const result = runGate(["--report"]);
  assert.match(result.stdout, /do not claim support/i);
  for (const platform of ["Linux x64", "Linux ARM64", "Windows x64", "Windows ARM64", "macOS x64", "macOS ARM64"]) {
    assert.ok(result.stdout.includes(platform), `${platform} is missing from the unsupported list`);
  }
  // And the primary platform must NOT be in that list.
  const unsupportedBlock = result.stdout.slice(result.stdout.search(/do not claim support/i));
  assert.ok(!unsupportedBlock.includes(PRIMARY), "the primary platform was listed as unsupported");
});

test("any FAIL blocks enforcement, on any platform", () => {
  /*
   * Unconditional, and the one rule with no exception. A platform observed broken is worse than one
   * never tried: someone looked, it did not work, and shipping anyway would be shipping a known
   * defect.
   */
  const path = syntheticMatrix([
    { platform: PRIMARY, cells: ELEVEN("PASS (smoke:install#1)") },
    { platform: "Linux x64", cells: ["FAIL (transcript:linux-x64-run)", ...ELEVEN("UNVERIFIED").slice(1)] },
  ]);
  const verdict = evaluate(parseMatrix(readFileSync(path, "utf8")));
  assert.equal(verdict.blocked, true);
  assert.ok(
    verdict.reasons.some((reason) => /FAIL/.test(reason) && reason.includes("Linux x64")),
    `reasons did not name the failing platform: ${JSON.stringify(verdict.reasons)}`,
  );
});

test("an UNVERIFIED mandatory cell on the primary platform blocks", () => {
  // The device this release is qualified on is held to a different standard than a machine nobody has.
  const cells = ELEVEN("PASS (smoke:install#1)");
  cells[0] = "UNVERIFIED";
  const path = syntheticMatrix([{ platform: PRIMARY, cells }]);
  const verdict = evaluate(parseMatrix(readFileSync(path, "utf8")));
  assert.equal(verdict.blocked, true);
  assert.ok(
    verdict.reasons.some((reason) => reason.includes(PRIMARY) && /install/.test(reason)),
    `reasons did not name the unverified primary cell: ${JSON.stringify(verdict.reasons)}`,
  );
});

test("UNVERIFIED on a non-primary platform notifies but does not block", () => {
  /*
   * The deliberate asymmetry. Blocking here would make the gate permanently red on a repository that
   * has, by design, no access to five of its seven platforms — and a gate that can never pass is one
   * that gets bypassed, which is strictly worse than one that reports honestly.
   */
  const path = syntheticMatrix([
    { platform: PRIMARY, cells: ELEVEN("PASS (smoke:install#1)") },
    { platform: "Windows ARM64", cells: ELEVEN("UNVERIFIED") },
  ]);
  const verdict = evaluate(parseMatrix(readFileSync(path, "utf8")));
  assert.equal(verdict.blocked, false, JSON.stringify(verdict.reasons));
  assert.ok(verdict.notices.some((notice) => notice.includes("Windows ARM64")));
  assert.deepEqual(verdict.unsupported, ["Windows ARM64"]);
});

test("a primary N/A does not block, but is reported", () => {
  /*
   * `N/A` is for a capability that genuinely does not exist on a platform. It must not become a way
   * to dodge measurement, so the gate reports every one it sees rather than treating it as a pass.
   */
  const cells = ELEVEN("PASS (smoke:install#1)");
  cells[4] = "N/A";
  const path = syntheticMatrix([{ platform: PRIMARY, cells }]);
  const verdict = evaluate(parseMatrix(readFileSync(path, "utf8")));
  assert.equal(verdict.blocked, false, JSON.stringify(verdict.reasons));
  assert.ok(verdict.notices.some((notice) => /N\/A/.test(notice) && notice.includes(PRIMARY)));
});

test("a matrix with no primary row blocks rather than passing vacuously", () => {
  /*
   * The vacuity guard. Every rule above is about the primary row, so a matrix that has lost it would
   * satisfy all of them by having nothing to check — the classic way a gate silently stops gating.
   */
  const path = syntheticMatrix([{ platform: "Linux x64", cells: ELEVEN("PASS (transcript:linux-x64)") }]);
  const verdict = evaluate(parseMatrix(readFileSync(path, "utf8")));
  assert.equal(verdict.blocked, true);
  assert.ok(
    verdict.reasons.some((reason) => /primary/i.test(reason)),
    `reasons did not mention the missing primary row: ${JSON.stringify(verdict.reasons)}`,
  );
});

test("an unparseable matrix blocks rather than being read as empty", () => {
  // Fail closed. A gate that reads a broken file as "nothing wrong" is worse than no gate.
  const dir = mkdtempSync(join(tmpdir(), "bayz-gate-bad-"));
  const path = join(dir, "matrix.md");
  writeFileSync(path, "# no matrix section here\n\njust prose\n");
  assert.throws(() => parseMatrix(readFileSync(path, "utf8")), /matrix/i);
});

test("the report names every mandatory column, so a dropped column cannot hide", () => {
  /*
   * A column silently removed from the matrix would make the primary row "complete" by shrinking what
   * complete means. The gate's mandatory list is its own, and it checks the matrix supplies them all.
   */
  const path = syntheticMatrix([{ platform: PRIMARY, cells: ELEVEN("PASS (smoke:install#1)") }]);
  const trimmed = readFileSync(path, "utf8").replace(" | uninstall |", " |");
  const dir = mkdtempSync(join(tmpdir(), "bayz-gate-trim-"));
  const trimmedPath = join(dir, "matrix.md");
  writeFileSync(trimmedPath, trimmed);

  const verdict = evaluate(parseMatrix(readFileSync(trimmedPath, "utf8")));
  assert.equal(verdict.blocked, true);
  assert.ok(
    verdict.reasons.some((reason) => /uninstall/.test(reason)),
    `a dropped mandatory column did not block: ${JSON.stringify(verdict.reasons)}`,
  );
});

test("formatReport is stable enough to diff between runs", () => {
  // The report is read by humans comparing two releases; a timestamp or a set iteration order would
  // make every run look different.
  const matrix = parseMatrix(readFileSync(MATRIX, "utf8"));
  const first = formatReport(evaluate(matrix), matrix);
  const second = formatReport(evaluate(matrix), matrix);
  assert.equal(first, second);
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(first), "the report embeds a timestamp");
});

test("the README support section matches what the gate actually permits", () => {
  /*
   * The plan says this list "feeds the README support section", so the two must not drift. A README
   * claiming a platform the gate calls unsupported is the single most consequential lie this project
   * could tell a user, since they would install on a machine nobody has ever run it on.
   */
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const section = /## Platform support\n([\s\S]*?)\n## /.exec(readme)?.[1];
  assert.ok(section !== undefined, "README.md has no '## Platform support' section");

  const verdict = evaluate(parseMatrix(readFileSync(MATRIX, "utf8")));

  for (const platform of verdict.unsupported) {
    assert.ok(section.includes(platform), `README does not disclaim the unsupported platform ${platform}`);
  }
  for (const platform of verdict.supported) {
    assert.ok(section.includes(platform), `README does not name the verified platform ${platform}`);
  }
  assert.match(section, /do not claim support/i, "README does not carry the unsupported-platform warning");
});
