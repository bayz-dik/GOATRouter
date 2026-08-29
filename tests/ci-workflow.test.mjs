import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The platform-matrix CI workflow — Phase 9J Task 7.
 *
 * The workflow exists to fill the matrix rows this device cannot: Linux x64, Linux ARM64,
 * Windows x64, macOS x64, macOS ARM64. It is **committed and inert** — Phase 9 prohibits adding or
 * pushing to a GitHub remote, and a workflow file does nothing until pushed.
 *
 * So these tests cannot assert that CI *ran*. They assert the two things that are checkable locally
 * and that actually matter:
 *
 *   1. the workflow would exercise the real gates on every runner it claims, and
 *   2. it carries no secret, no token, no publish step, and no push — because an unreviewed workflow
 *      that later gets pushed is exactly how a local-only repository leaks credentials.
 *
 * A test asserting "CI is green" here would be a lie: there is no remote.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_PATH = join(ROOT, ".github/workflows/platform-matrix.yml");
const NOTES_PATH = join(ROOT, "docs/superpowers/2026-08-27-bayz-ci-notes.md");

/** Runners the plan names. `ubuntu-24.04-arm` is GitHub's hosted ARM64 Linux image. */
const EXPECTED_RUNNERS = ["ubuntu-latest", "ubuntu-24.04-arm", "windows-latest", "macos-latest", "macos-13"];

/** Every gate the workflow must run, so a green CI means the same thing as a green local run. */
const EXPECTED_COMMANDS = [
  "npm ci",
  "node scripts/dependency-closure.mjs",
  "node scripts/portability-scan.mjs",
  "node scripts/pack.mjs",
  "node scripts/install-smoke.mjs",
  "node scripts/upgrade-smoke.mjs",
];

function workflow() {
  assert.ok(existsSync(WORKFLOW_PATH), `${WORKFLOW_PATH} does not exist`);
  return readFileSync(WORKFLOW_PATH, "utf8");
}

test("the workflow exists and names every runner the matrix needs", () => {
  const text = workflow();
  for (const runner of EXPECTED_RUNNERS) {
    assert.ok(text.includes(runner), `the workflow does not name the runner ${runner}`);
  }
});

test("the workflow runs every gate, so a green run means what a green local run means", () => {
  const text = workflow();
  for (const command of EXPECTED_COMMANDS) {
    assert.ok(text.includes(command), `the workflow does not run ${command}`);
  }
});

test("the workflow carries no secret, no token, no publish, and no push", () => {
  /*
   * The load-bearing test. This file is committed to a repository with no remote; if a remote is
   * ever added, this workflow becomes live. A secret reference, a registry token, or a publish step
   * sitting in it would then act without anyone re-reading it.
   */
  const text = workflow();
  const forbidden = [
    "secrets.",
    "NPM_TOKEN",
    "GITHUB_TOKEN",
    "npm publish",
    "git push",
    "actions/create-release",
    "softprops/action-gh-release",
  ];
  for (const needle of forbidden) {
    assert.ok(!text.includes(needle), `the workflow contains a forbidden reference: ${needle}`);
  }
});

test("the workflow has no push or schedule trigger", () => {
  // `workflow_dispatch` only: it must never fire by itself, even after a remote is added.
  const text = workflow();
  assert.ok(text.includes("workflow_dispatch"), "the workflow has no manual trigger");
  assert.ok(!/^\s+push:/m.test(text), "the workflow has a push trigger");
  assert.ok(!/^\s+pull_request:/m.test(text), "the workflow has a pull_request trigger");
  assert.ok(!/^\s+schedule:/m.test(text), "the workflow has a schedule trigger");
});

test("the workflow requests read-only permissions", () => {
  // Least privilege by default: nothing here needs to write to a repository.
  const text = workflow();
  assert.match(text, /permissions:\s*\n\s+contents:\s*read/, "the workflow does not pin contents: read");
});

test("the workflow parses as YAML with the expected structure", () => {
  /*
   * Parsed rather than pattern-matched, because a workflow that does not parse is a workflow that
   * silently never runs. `yaml` is not a dependency of this repository and adding one to lint a file
   * would be worse than the problem, so this is a deliberately narrow structural read: the keys the
   * other tests rely on must be real keys at the right depth, not substrings in a comment.
   */
  const text = workflow();
  const lines = text.split("\n");

  const topLevel = lines.filter((line) => /^[a-z_]+:/.test(line)).map((line) => line.split(":")[0]);
  assert.deepEqual(topLevel, ["name", "on", "permissions", "jobs"], `unexpected top-level keys: ${topLevel}`);

  // The runner list must be a real `matrix.os` array, not prose.
  const matrixBlock = /matrix:\s*\n((?:\s+.*\n)+?)\s+steps:/.exec(text)?.[1] ?? "";
  for (const runner of EXPECTED_RUNNERS) {
    assert.ok(matrixBlock.includes(runner), `${runner} is not inside the matrix block`);
  }

  // Every `run:` line must be a step under a job, so no command is orphaned in a comment.
  const runLines = lines.filter((line) => /^\s+(- )?run: /.test(line));
  assert.ok(runLines.length >= EXPECTED_COMMANDS.length, `only ${runLines.length} run steps found`);
});

test("the CI notes state which platforms have no runner at all", () => {
  /*
   * The workflow covers five runners. Two matrix rows have **no** hosted runner: Windows ARM64 and
   * Termux/Android. Termux is this device, so it is filled by real local runs; Windows ARM64 cannot
   * be filled by anyone here, and the notes must say so rather than let a reader assume CI covers
   * everything.
   */
  assert.ok(existsSync(NOTES_PATH), `${NOTES_PATH} does not exist`);
  const notes = readFileSync(NOTES_PATH, "utf8");

  assert.match(notes, /Windows ARM64/, "the notes do not mention Windows ARM64");
  assert.match(notes, /Termux/, "the notes do not mention Termux");
  assert.match(notes, /no hosted runner/i, "the notes do not state that a runner is missing");
  assert.match(notes, /UNVERIFIED/, "the notes do not say Windows ARM64 stays UNVERIFIED");
  assert.match(notes, /inert|not pushed|unpushed/i, "the notes do not record that the workflow is inert");
});

test("committing the workflow does not upgrade any matrix cell", () => {
  /*
   * The anti-cheat. A workflow that has never run is not evidence, so no cell may cite it. The
   * matrix's own evidence grammar only accepts `smoke:`, `test:`, and `transcript:` citations, and
   * this asserts nothing has started citing the workflow file instead.
   */
  const matrix = readFileSync(join(ROOT, "docs/superpowers/2026-08-27-bayz-platform-matrix.md"), "utf8");
  assert.ok(!matrix.includes("platform-matrix.yml"), "a matrix cell cites the unpushed workflow as evidence");
  assert.ok(!/\bci:/.test(matrix), "a matrix cell cites CI as evidence");

  // The five CI-only platforms must still be entirely UNVERIFIED, since CI has never run.
  for (const platform of ["Linux x64", "Linux ARM64", "Windows x64", "macOS x64", "macOS ARM64"]) {
    const row = matrix.split("\n").find((line) => line.startsWith(`| ${platform} |`));
    assert.ok(row !== undefined, `no matrix row for ${platform}`);
    assert.ok(
      !row.includes("PASS"),
      `${platform} claims a PASS, but it has no runner and no local evidence: ${row}`,
    );
  }
});
