import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const REPORT = join(root, "docs/superpowers/2026-08-27-bayz-supply-chain-report.md");
const GATE = join(root, "scripts/supply-chain-gate.mjs");

const gate = await import(join(root, "scripts/supply-chain-gate.mjs"));
const { computeClosure } = await import(join(root, "scripts/dependency-closure.mjs"));

/**
 * Supply-chain report and gate — Phase 9K Task 8.
 *
 * This is the phase's own gate, so the thing most worth defending is not "the document is well
 * formed" but **the document cannot be talked into passing**. Two rules carry that weight:
 *
 *   1. Every `PASS` resolves to something on disk with real assertions behind it.
 *   2. Three rows are re-measured live, and a live failure blocks whatever the prose says.
 *
 * Everything else here is shape checking, which matters only because a malformed report is the
 * cheapest way to make a gate read as silent.
 *
 * Running the gate's own `--enforce` from a test would re-run `npm audit` per test, so the live-path
 * assertions call `assess` directly with synthesised inputs. The one full CLI run below uses
 * `--no-audit` for the same reason, and asserts that the skip is recorded as `UNVERIFIED` rather than
 * quietly dropped.
 */

const MANDATORY_ROWS = [
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

function reportText() {
  assert.ok(existsSync(REPORT), `the supply-chain report is missing at ${REPORT}`);
  return readFileSync(REPORT, "utf8");
}

/** A row synthesised for the negative cases, so a rule can be proven to fire. */
function rowsWith(overrides = []) {
  const rows = MANDATORY_ROWS.map((item) => ({
    item,
    status: "PASS",
    evidence: "test:tests/pack.test.mjs",
    notes: "synthetic",
  }));
  for (const override of overrides) {
    const index = rows.findIndex((row) => row.item === override.item);
    if (index === -1) rows.push(override);
    else rows[index] = { ...rows[index], ...override };
  }
  return {
    rows,
    malformed: [],
    device: "synthetic device",
    statedRuntimeCount: computeClosure(JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"))).external.length,
    missing: false,
  };
}

const CLEAN_LIVE = [
  { id: "licence inventory", status: "PASS", detail: "synthetic" },
  { id: "audit", status: "PASS", detail: "synthetic" },
  { id: "tarball secret scan", status: "PASS", detail: "synthetic" },
];

test("the report exists and names the device, runtime, and commit it was written from", () => {
  const text = reportText();
  assert.match(text, /^- Device: .+$/m, "the header does not name the device");
  assert.match(text, /^- Node: v24\.19\.0 \(arm64\)/m, "the header does not record the Node version measured");
  assert.match(text, /^- Commit: [0-9a-f]{7,40}$/m, "the header does not record the commit");
});

test("all ten mandatory rows are present, exactly once, and no extra row exists", () => {
  const parsed = gate.readReport(REPORT);
  const items = parsed.rows.map((row) => row.item);
  for (const item of MANDATORY_ROWS) {
    assert.equal(items.filter((entry) => entry === item).length, 1, `row '${item}' should appear exactly once, found ${items.filter((entry) => entry === item).length}`);
  }
  assert.deepEqual(
    items.filter((item) => !MANDATORY_ROWS.includes(item)),
    [],
    "the verdict table carries a row the plan does not name",
  );
  assert.equal(parsed.malformed.length, 0, `malformed rows: ${parsed.malformed.join("; ")}`);
});

test("every row is exactly one of PASS, FAIL, UNVERIFIED, N/A", () => {
  const parsed = gate.readReport(REPORT);
  for (const row of parsed.rows) {
    assert.ok(gate.STATUSES.has(row.status), `${row.item}: ${JSON.stringify(row.status)} is not a status`);
  }
});

test("every PASS carries an evidence reference that resolves to a file with real assertions", () => {
  /*
   * The load-bearing test. A `PASS` citing a file that does not exist, or an empty one, is a claim
   * with nothing behind it — and pointing at an empty test file is the cheapest way to launder a
   * verdict, which is why the assertion count is checked rather than only the path.
   */
  const parsed = gate.readReport(REPORT);
  const passes = parsed.rows.filter((row) => row.status === "PASS");
  assert.ok(passes.length > 0, "no row is PASS, so this test would be vacuous");

  for (const row of passes) {
    assert.match(row.evidence, gate.EVIDENCE_RE, `${row.item}: evidence ${JSON.stringify(row.evidence)} is not a valid reference shape`);

    const [kind, target] = row.evidence.split(":");
    if (kind === "test" || kind === "transcript") {
      const path = target.split("::")[0];
      const absolute = join(root, path);
      assert.ok(existsSync(absolute), `${row.item}: evidence path ${path} does not exist`);
      const body = readFileSync(absolute, "utf8");
      assert.ok(body.trim().length > 0, `${row.item}: evidence ${path} is empty`);
      if (kind === "test") {
        const assertions = (body.match(/\bassert\b/g) ?? []).length;
        assert.ok(assertions >= 5, `${row.item}: evidence ${path} contains only ${assertions} assertion(s)`);
      }
    }
  }
});

test("the stated runtime dependency count matches the closure walk, not a copied constant", () => {
  /*
   * The plan requires the report to state the runtime dependency count *and* for it to match the
   * computation. A hand-written number is exactly the kind of fact that stays true for one commit.
   */
  const parsed = gate.readReport(REPORT);
  const computed = computeClosure(JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"))).external.length;
  assert.equal(parsed.statedRuntimeCount, computed, `the report states ${parsed.statedRuntimeCount}, the closure walk computes ${computed}`);
});

test("the report records signing as UNVERIFIED for an unsigned local build, and says why", () => {
  const parsed = gate.readReport(REPORT);
  const signature = parsed.rows.find((row) => row.item === "signature");
  assert.equal(signature.status, "UNVERIFIED", "the signature row must not claim PASS for an unsigned local build");
  assert.match(signature.notes, /unsigned/i, "the signature row does not say the build is unsigned");
  // "Unsigned" and "forged" are different outcomes, and the report is where that must be legible.
  assert.match(reportText(), /unsigned.*(?:not|never).*(?:forged|invalid|tampered)|(?:forged|invalid).*(?:distinct|different).*unsigned/is, "the report does not distinguish unsigned from forged");
});

test("every UNVERIFIED row states a reason", () => {
  /*
   * `UNVERIFIED` is an honest verdict only when it says what was not done. A bare one is
   * indistinguishable from having forgotten — the same reasoning the audit policy applies to an
   * expired deferral.
   */
  const parsed = gate.readReport(REPORT);
  for (const row of parsed.rows.filter((entry) => entry.status === "UNVERIFIED")) {
    assert.ok(row.notes.trim().length > 20, `${row.item}: UNVERIFIED with no substantive reason (${JSON.stringify(row.notes)})`);
  }
});

test("the report states plainly that a reproducible build is not claimed", () => {
  const text = reportText();
  /*
   * Not a global regex: `RegExp.prototype.test` on a `/g` pattern advances `lastIndex`, so reusing one
   * across lines silently skips every other match — a filter that misses half the corpus reads as a
   * clean result.
   */
  const lines = text.split("\n").filter((line) => /reproducible build/i.test(line));
  assert.ok(lines.length > 0, "the report does not address reproducibility at all");
  for (const line of lines) {
    assert.match(
      line,
      /\b(no|not|never|cannot|does not|refuse|without)\b/i,
      `the report appears to claim a reproducible build: ${line.trim()}`,
    );
  }
});

test("the gate composes the subordinate checks instead of reimplementing their policy", () => {
  /*
   * The plan's Locks: one definition of "runtime" repo-wide. If this gate grew its own closure walk,
   * its own allowed-licence set or its own secret patterns, the two would drift and the drifting copy
   * would be the one guarding the release.
   */
  const source = readFileSync(GATE, "utf8");
  for (const dependency of ["./dependency-closure.mjs", "./license-inventory.mjs", "./pack.mjs"]) {
    assert.ok(source.includes(dependency), `the gate does not import ${dependency}`);
  }
  assert.ok(!/ALLOWED_RUNTIME_LICENSES\s*=/.test(source), "the gate defines its own allowed-licence set");
  assert.ok(!/SECRET_PATTERNS\s*=/.test(source), "the gate defines its own secret patterns");
  assert.ok(!/sk-\[A-Za-z0-9/.test(source), "the gate carries a copied credential regex");
});

test("--report exits 0 and prints both the documented rows and the live re-measurement", () => {
  const result = spawnSync(process.execPath, [GATE, "--report", "--no-audit"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `--report should exit 0, got ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /documented rows:/);
  assert.match(result.stdout, /live re-measurement/);
  assert.match(result.stdout, /supply-chain gate: REPORT/);
  // The skipped audit must be visible as UNVERIFIED, never absent and never a pass.
  assert.match(result.stdout, /UNVERIFIED\s+audit/, "--no-audit did not record the audit as UNVERIFIED");
});

test("--enforce exits 0 against the current report, and prints the non-blocking UNVERIFIED rows", () => {
  const result = spawnSync(process.execPath, [GATE, "--enforce", "--no-audit"], { cwd: root, encoding: "utf8" });
  assert.match(result.stdout, /UNVERIFIED but not blocking, by the documented decision:/);
  assert.match(result.stdout, /unsigned local build is normal and is NOT a pass/);
  assert.equal(result.status, 0, `--enforce should pass on the current honest report, got ${result.status}\n${result.stdout}\n${result.stderr}`);
});

test("no flag, both flags, and an unknown flag all exit 2", () => {
  /*
   * "Report and enforce" has two plausible meanings — print then fail, or print instead of failing —
   * and guessing one would let a release script believe it enforced when it only reported.
   */
  for (const argv of [[], ["--report", "--enforce"], ["--enfore"], ["--report", "--wat"]]) {
    const result = spawnSync(process.execPath, [GATE, ...argv], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 2, `argv ${JSON.stringify(argv)} should exit 2, got ${result.status}`);
    assert.match(result.stderr, /usage: node scripts\/supply-chain-gate\.mjs/);
  }
});

test("a FAIL row blocks", () => {
  const verdict = gate.assess(rowsWith([{ item: "SBOM", status: "FAIL", notes: "synthetic failure" }]), CLEAN_LIVE);
  assert.ok(
    verdict.blocking.some((entry) => entry.startsWith("SBOM: FAIL")),
    `a FAIL row did not block: ${JSON.stringify(verdict.blocking)}`,
  );
});

test("a live FAIL blocks even when the report claims PASS, and the disagreement is named", () => {
  /*
   * **The assertion this gate exists for.** A report is a record of a measurement, not a substitute
   * for one. If editing the prose could pass the gate, the gate is prose.
   */
  const live = [
    { id: "licence inventory", status: "FAIL", detail: "simulated-copyleft@1.0.0 is AGPL-3.0" },
    { id: "audit", status: "PASS", detail: "synthetic" },
    { id: "tarball secret scan", status: "PASS", detail: "synthetic" },
  ];
  const verdict = gate.assess(rowsWith(), live);
  assert.ok(
    verdict.blocking.some((entry) => entry.includes("live licence inventory: FAIL")),
    "a live licence failure did not block",
  );
  assert.ok(
    verdict.violations.some((entry) => entry.includes("claims PASS but the live check fails")),
    "the report/live disagreement was not reported as an integrity violation",
  );
});

test("a live secret-scan hit blocks", () => {
  const live = [
    { id: "licence inventory", status: "PASS", detail: "synthetic" },
    { id: "audit", status: "PASS", detail: "synthetic" },
    { id: "tarball secret scan", status: "FAIL", detail: "package/planted: Bearer token" },
  ];
  const verdict = gate.assess(rowsWith(), live);
  assert.ok(verdict.blocking.some((entry) => entry.includes("live tarball secret scan: FAIL")), "a planted secret did not block");
});

test("the live secret scan is not vacuous: it catches a planted credential in real artifact bytes", async () => {
  /*
   * A positive control. A scan that silently matched nothing would report PASS forever, which is worse
   * than no scan because it reads as protection. The gate composes `scanBytesForSecrets`, so proving
   * that composition still detects is the assertion — not re-testing the patterns, which
   * `tests/pack.test.mjs` owns.
   */
  const { scanBytesForSecrets } = await import(join(root, "scripts/pack.mjs"));
  const hits = scanBytesForSecrets([{ name: "package/planted", content: Buffer.from(`Bearer ${"a".repeat(24)}`) }]);
  assert.ok(hits.length > 0, "the composed secret scan does not catch a planted Bearer token");
});

test("an UNVERIFIED signature does not block, and neither does an UNVERIFIED audit", () => {
  /*
   * The documented asymmetry. A local release candidate is legitimately unsigned, and an audit
   * without registry access legitimately cannot report. A gate that blocked on either would be
   * unpassable on the only device that has this repository, and an unpassable gate gets routed around.
   */
  const verdict = gate.assess(
    rowsWith([
      { item: "signature", status: "UNVERIFIED", notes: "unsigned local build; keyless OIDC needs a hosted run" },
      { item: "audit", status: "UNVERIFIED", notes: "registry unreachable on this host" },
    ]),
    CLEAN_LIVE,
  );
  assert.deepEqual(verdict.blocking, [], `an exempt UNVERIFIED row blocked: ${JSON.stringify(verdict.blocking)}`);
  assert.equal(verdict.advisory.length, 2, "the exempt rows were not reported as advisory");
});

test("an UNVERIFIED row with no documented exemption blocks", () => {
  const verdict = gate.assess(rowsWith([{ item: "offline", status: "UNVERIFIED", notes: "nobody ran it" }]), CLEAN_LIVE);
  assert.ok(
    verdict.blocking.some((entry) => entry.includes("offline: UNVERIFIED")),
    "an unexempted UNVERIFIED row did not block",
  );
});

test("an UNVERIFIED row with no stated reason is an integrity violation", () => {
  const verdict = gate.assess(rowsWith([{ item: "signature", status: "UNVERIFIED", notes: "" }]), CLEAN_LIVE);
  assert.ok(
    verdict.violations.some((entry) => entry.includes("UNVERIFIED with no stated reason")),
    "a reasonless UNVERIFIED was accepted",
  );
});

test("a missing mandatory row is a violation, not a silent pass", () => {
  /*
   * The vacuity guard. Every per-row rule would pass by having nothing to check — which is exactly how
   * 9K Task 6's determinism test stopped noticing a deleted artifact class.
   */
  const parsed = rowsWith();
  parsed.rows = parsed.rows.filter((row) => row.item !== "tarball secret scan");
  const verdict = gate.assess(parsed, CLEAN_LIVE);
  assert.ok(
    verdict.violations.some((entry) => entry.includes("no 'tarball secret scan' row")),
    "a dropped mandatory row was not reported",
  );
});

test("a PASS with no evidence reference is a violation", () => {
  const verdict = gate.assess(rowsWith([{ item: "SBOM", status: "PASS", evidence: "", notes: "" }]), CLEAN_LIVE);
  assert.ok(
    verdict.violations.some((entry) => entry.includes("PASS without a valid evidence reference")),
    "an unevidenced PASS was accepted",
  );
});

test("a stated runtime count that disagrees with the closure walk is a violation", () => {
  const parsed = rowsWith();
  parsed.statedRuntimeCount = parsed.statedRuntimeCount + 1;
  const verdict = gate.assess(parsed, CLEAN_LIVE, { statedRuntimeCountExpected: gate.runtimeExternalCount(root) });
  assert.ok(
    verdict.violations.some((entry) => entry.includes("runtime dependencies but the closure walk computes")),
    "a drifted dependency count was accepted",
  );
});

test("a missing report blocks rather than reading as nothing wrong", () => {
  const verdict = gate.assess(gate.readReport(join(root, "docs/superpowers/does-not-exist.md")), CLEAN_LIVE);
  assert.ok(verdict.violations.some((entry) => entry.includes("is missing at")), "a missing report was not reported");
});

test("the report documents the gate policy, including which UNVERIFIED rows do not block", () => {
  const text = reportText();
  assert.match(text, /## Gate policy/, "there is no gate policy section");
  assert.match(text, /--report/, "the policy does not describe --report");
  assert.match(text, /--enforce/, "the policy does not describe --enforce");
  assert.match(text, /exits?\s+\*{0,2}2\*{0,2}\b/, "the policy does not state the usage exit code");
});
