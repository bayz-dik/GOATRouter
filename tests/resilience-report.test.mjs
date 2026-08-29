import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const REPORT = join(root, "docs/superpowers/2026-08-27-bayz-resilience-report.md");
const GATE = join(root, "scripts/resilience-gate.mjs");

const lib = await import(join(root, "scripts/resilience-gate-lib.mjs"));

/**
 * Resilience report and gate — 9I Task 7.
 *
 * Two jobs. The report tests assert the *real* report is well-formed and complete: every fuzz
 * target, chaos scenario, load point and soak metric present, one verdict each, evidence behind
 * every PASS, a transcript behind every capacity figure, the device named.
 *
 * The gate tests drive the gate against **synthetic reports**, not only today's. A gate checked only
 * against the current file would pass even if it were hardcoded to succeed — the same trap 9H Task 6
 * avoided, and the reason that gate's tests are still worth their length.
 */

function report() {
  assert.ok(existsSync(REPORT), `the resilience report is missing at ${REPORT}`);
  return readFileSync(REPORT, "utf8");
}

function runGate(args, cwd = root) {
  return spawnSync(process.execPath, [GATE, ...args], { cwd, encoding: "utf8" });
}

// ---------------------------------------------------------------- the report

test("the resilience report exists and names the device in its header", () => {
  const text = report();
  assert.match(text, /^- Device: .*Termux\/Android ARM64/m, "the header does not name the device");
  assert.match(text, /^- Commit: [0-9a-f]{7,40}/m, "the header does not record a commit");
});

test("every row carries exactly one of the four verdicts", () => {
  const parsed = lib.readReport(REPORT);
  assert.ok(parsed.rows.length > 0, "the report parsed to zero rows");
  assert.deepEqual(parsed.malformed, [], `malformed rows: ${parsed.malformed?.join("; ")}`);
  for (const row of parsed.rows) {
    assert.ok(lib.STATUSES.has(row.status), `${row.section}/${row.item} has status ${row.status}`);
  }
});

test("all thirteen fuzz targets appear as rows", () => {
  const parsed = lib.readReport(REPORT);
  const fuzz = parsed.rows.filter((row) => row.section === "fuzz");
  const targets = [
    "api-schema",
    "tool-args",
    "provider-response",
    "sse",
    "identifier",
    "url",
    "provider-config",
    "proxy-config",
    "authorization",
    "telemetry",
    "storage-envelope",
    "migration",
    "socks5",
  ];
  for (const target of targets) {
    assert.ok(
      fuzz.some((row) => row.item.includes(target)),
      `fuzz target ${target} has no row`,
    );
  }
  assert.ok(fuzz.length >= 13, `expected at least 13 fuzz rows, found ${fuzz.length}`);
});

test("all eleven chaos scenarios appear as rows", () => {
  const parsed = lib.readReport(REPORT);
  const chaos = parsed.rows.filter((row) => row.section === "chaos");
  assert.ok(chaos.length >= 11, `expected at least 11 chaos rows, found ${chaos.length}`);
  for (const fragment of ["mid-request", "mid-stream", "malformed", "reset", "timeout", "proxy", "DNS", "revok", "restart", "WAL", "disk"]) {
    assert.ok(
      chaos.some((row) => row.item.toLowerCase().includes(fragment.toLowerCase())),
      `no chaos row mentions ${fragment}`,
    );
  }
});

test("every load point the plan names appears as a row", () => {
  const parsed = lib.readReport(REPORT);
  const load = parsed.rows.filter((row) => row.section === "load");
  for (const level of [1, 8, 32, 128, 256]) {
    assert.ok(
      load.some((row) => new RegExp(`\\b${level}\\b`).test(row.item)),
      `no load row for concurrency ${level}`,
    );
  }
});

test("every soak metric the plan names appears as a row", () => {
  const parsed = lib.readReport(REPORT);
  const soak = parsed.rows.filter((row) => row.section === "soak");
  for (const metric of ["heap", "RSS", "handle", "timer", "descriptor", "WAL", "telemetry", "integrity"]) {
    assert.ok(
      soak.some((row) => row.item.toLowerCase().includes(metric.toLowerCase())),
      `no soak row for ${metric}`,
    );
  }
});

test("every PASS carries an evidence reference matching the required shape", () => {
  const parsed = lib.readReport(REPORT);
  for (const row of parsed.rows.filter((entry) => entry.status === "PASS")) {
    assert.match(row.evidence, lib.EVIDENCE_RE, `${row.section}/${row.item}: evidence ${JSON.stringify(row.evidence)} does not match the required shape`);
  }
});

test("no capacity figure appears without a transcript reference on the same row", () => {
  const parsed = lib.readReport(REPORT);
  for (const row of parsed.rows) {
    if (!lib.ADVISORY_SECTIONS.has(row.section)) continue;
    if (row.status !== "PASS") continue;
    /*
     * A *measured* figure, not any digit. `limit 4, queue 2` is configuration — verifiable by
     * reading the code — while a latency or throughput exists only in the run that produced it.
     * The first version of this test used `/\d/` and flagged the configuration rows.
     */
    if (!lib.CAPACITY_FIGURE_RE.test(row.notes)) continue;
    assert.ok(
      row.evidence.startsWith("transcript:"),
      `${row.section}/${row.item} states a figure (${row.notes}) with evidence ${row.evidence} — a capacity number needs a transcript`,
    );
  }
});

test("a measured figure is distinguished from a configured limit", () => {
  /*
   * Pins the distinction itself, because it is the kind of rule that quietly rots into either
   * "everything needs a transcript" (noise) or "nothing does" (no provenance).
   */
  for (const measured of ["p50 26.5 ms", "43.0 req/s", "peak 3.97 MiB", "18,741 requests", "second-half slope +2.1 KiB/sample"]) {
    assert.ok(lib.CAPACITY_FIGURE_RE.test(measured), `${JSON.stringify(measured)} should count as a capacity figure`);
  }
  for (const configured of ["limit 4, queue 2", "tolerance 256", "bound 200", "gate of 4"]) {
    assert.ok(!lib.CAPACITY_FIGURE_RE.test(configured), `${JSON.stringify(configured)} should not count as a capacity figure`);
  }
});

test("an evidence reference may span a range but not list unrelated checks", () => {
  /*
   * `smoke:chaos#31-44` is one scenario across contiguous checks — verifiable. A comma list is not:
   * a row citing five scattered numbers cannot be confirmed or refuted by looking up any one of
   * them. The report's first draft contained exactly that and the gate rejected it.
   */
  assert.ok(lib.EVIDENCE_RE.test("smoke:chaos#31-44"), "a contiguous range should be accepted");
  assert.ok(lib.EVIDENCE_RE.test("smoke:fuzz#1"), "a single check should be accepted");
  assert.ok(!lib.EVIDENCE_RE.test("smoke:load#4,9,14,19,24"), "a comma list should be rejected");
  assert.ok(!lib.EVIDENCE_RE.test("smoke:load#4 and #9"), "prose should be rejected");
});

test("every cited evidence path resolves on disk", () => {
  const parsed = lib.readReport(REPORT);
  const missing = [];
  for (const row of parsed.rows) {
    const match = /^(?:test|transcript):(.+)$/.exec(row.evidence);
    if (match === null) continue;
    if (!existsSync(join(root, match[1]))) missing.push(`${row.section}/${row.item} → ${match[1]}`);
  }
  assert.deepEqual(missing, [], `evidence paths that do not exist: ${missing.join(", ")}`);
});

test("every UNVERIFIED row states a reason", () => {
  const parsed = lib.readReport(REPORT);
  for (const row of parsed.rows.filter((entry) => entry.status === "UNVERIFIED")) {
    assert.ok(
      row.notes.trim().length > 20,
      `${row.section}/${row.item} is UNVERIFIED with no reason (notes: ${JSON.stringify(row.notes)})`,
    );
  }
});

// ------------------------------------------------------------------ the gate

test("--report exits 0 against the real report", () => {
  const result = runGate(["--report"]);
  assert.equal(result.status, 0, `--report exited ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /BAYZ resilience gate/);
  assert.match(result.stdout, /blocking sections when UNVERIFIED/, "the gate does not state which sections block");
});

test("no flag, both flags, and an unknown flag all exit 2", () => {
  for (const args of [[], ["--report", "--enforce"], ["--nope"], ["--report", "--nope"]]) {
    const result = runGate(args);
    assert.equal(result.status, 2, `${JSON.stringify(args)} exited ${result.status}, expected 2`);
  }
});

/**
 * Synthetic-report tests.
 *
 * The gate is pointed at a temporary directory containing a hand-written report, so each policy rule
 * is exercised against a file built to trip it. Without these, a gate that always exited 0 would
 * pass every test above.
 */
function withReport(body) {
  const dir = mkdtempSync(join(tmpdir(), "bayz-resilience-gate-"));
  const docs = join(dir, "docs/superpowers");
  spawnSync("mkdir", ["-p", docs]);
  const path = join(docs, "2026-08-27-bayz-resilience-report.md");
  writeFileSync(path, body);
  return { dir, path };
}

function runAgainst(body, { enforce }) {
  const { path } = withReport(body);
  const script = join(root, "scripts/resilience-gate-probe.mjs");
  writeFileSync(
    script,
    `const { run } = await import("./resilience-gate-run.mjs");\nprocess.exit(await run({ enforce: ${enforce}, path: ${JSON.stringify(path)} }));\n`,
  );
  try {
    return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
  } finally {
    spawnSync("rm", ["-f", script]);
  }
}

const HEADER = "# report\n\n- Device: Termux/Android ARM64\n- Commit: abc1234\n\n";

test("a clean synthetic report passes --enforce", () => {
  const result = runAgainst(
    `${HEADER}## Fuzz targets\n\n| item | status | evidence | notes |\n|---|---|---|---|\n| api-schema | PASS | smoke:fuzz#1 | |\n\n## Chaos scenarios\n\n| item | status | evidence | notes |\n|---|---|---|---|\n| provider dies | PASS | smoke:chaos#1 | |\n`,
    { enforce: true },
  );
  assert.equal(result.status, 0, `expected 0, got ${result.status}: ${result.stdout}`);
});

test("a FAIL row blocks --enforce in any section", () => {
  for (const section of ["Fuzz targets", "Chaos scenarios", "Load points", "Soak metrics"]) {
    const result = runAgainst(
      `${HEADER}## ${section}\n\n| item | status | evidence | notes |\n|---|---|---|---|\n| something | FAIL | smoke:fuzz#1 | broke |\n`,
      { enforce: true },
    );
    assert.equal(result.status, 1, `a FAIL in ${section} did not block: ${result.stdout}`);
  }
});

test("UNVERIFIED blocks in fuzz and chaos but not in load and soak", () => {
  for (const section of ["Fuzz targets", "Chaos scenarios"]) {
    const result = runAgainst(
      `${HEADER}## ${section}\n\n| item | status | evidence | notes |\n|---|---|---|---|\n| something | UNVERIFIED | | not checked on this host |\n`,
      { enforce: true },
    );
    assert.equal(result.status, 1, `UNVERIFIED in ${section} should block: ${result.stdout}`);
  }
  for (const section of ["Load points", "Soak metrics"]) {
    const result = runAgainst(
      `${HEADER}## ${section}\n\n| item | status | evidence | notes |\n|---|---|---|---|\n| something | UNVERIFIED | | host cannot run it |\n`,
      { enforce: true },
    );
    assert.equal(result.status, 0, `UNVERIFIED in ${section} should not block: ${result.stdout}`);
    assert.match(result.stdout, /UNVERIFIED but not blocking/, "a non-blocking UNVERIFIED row was not printed");
  }
});

test("a PASS without valid evidence blocks --enforce", () => {
  for (const evidence of ["", "somewhere", "smoke:fuzz", "test:", "http://example.com"]) {
    const result = runAgainst(
      `${HEADER}## Fuzz targets\n\n| item | status | evidence | notes |\n|---|---|---|---|\n| api-schema | PASS | ${evidence} | |\n`,
      { enforce: true },
    );
    assert.equal(result.status, 1, `PASS with evidence ${JSON.stringify(evidence)} did not block: ${result.stdout}`);
  }
});

test("a capacity figure without a transcript reference blocks --enforce", () => {
  const result = runAgainst(
    `${HEADER}## Load points\n\n| item | status | evidence | notes |\n|---|---|---|---|\n| concurrency 256 | PASS | smoke:load#1 | p99 9081 ms |\n`,
    { enforce: true },
  );
  assert.equal(result.status, 1, `a figure without a transcript did not block: ${result.stdout}`);

  const withTranscript = runAgainst(
    `${HEADER}## Load points\n\n| item | status | evidence | notes |\n|---|---|---|---|\n| concurrency 256 | PASS | transcript:docs/transcripts/load/load.md | p99 9081 ms |\n`,
    { enforce: true },
  );
  assert.equal(withTranscript.status, 0, `a figure with a transcript should pass: ${withTranscript.stdout}`);
});

test("an unrecognised status is malformed and blocks --enforce", () => {
  const result = runAgainst(
    `${HEADER}## Fuzz targets\n\n| item | status | evidence | notes |\n|---|---|---|---|\n| api-schema | GREEN | smoke:fuzz#1 | |\n`,
    { enforce: true },
  );
  assert.equal(result.status, 1, `a bogus status did not block: ${result.stdout}`);
  assert.match(result.stdout, /is not one of/, "the malformed status was not reported");
});

test("a report with no device named blocks --enforce", () => {
  const result = runAgainst(
    `# report\n\n- Commit: abc1234\n\n## Fuzz targets\n\n| item | status | evidence | notes |\n|---|---|---|---|\n| api-schema | PASS | smoke:fuzz#1 | |\n`,
    { enforce: true },
  );
  assert.equal(result.status, 1, `a report without a device did not block: ${result.stdout}`);
});

test("an empty report blocks --enforce rather than passing vacuously", () => {
  const result = runAgainst(`${HEADER}## Fuzz targets\n\nnothing here\n`, { enforce: true });
  assert.equal(result.status, 1, `an empty report did not block: ${result.stdout}`);
});

test("a missing report blocks --enforce but not --report", () => {
  const script = join(root, "scripts/resilience-gate-probe.mjs");
  const missing = join(tmpdir(), "bayz-resilience-does-not-exist.md");
  for (const [enforce, expected] of [
    [true, 1],
    [false, 0],
  ]) {
    writeFileSync(
      script,
      `const { run } = await import("./resilience-gate-run.mjs");\nprocess.exit(await run({ enforce: ${enforce}, path: ${JSON.stringify(missing)} }));\n`,
    );
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, expected, `missing report with enforce=${enforce} exited ${result.status}`);
  }
  spawnSync("rm", ["-f", script]);
});

test("--report never blocks, even on a report full of failures", () => {
  const result = runAgainst(
    `${HEADER}## Fuzz targets\n\n| item | status | evidence | notes |\n|---|---|---|---|\n| api-schema | FAIL | | |\n| sse | UNVERIFIED | | |\n`,
    { enforce: false },
  );
  assert.equal(result.status, 0, `--report exited ${result.status} on a failing report`);
  assert.match(result.stdout, /report only, no enforcement/);
});
