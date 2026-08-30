import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const DOCUMENT = join(root, "docs/superpowers/2026-08-27-bayz-feature-completeness-gate.md");
const GATE = join(root, "scripts/feature-gate.mjs");

const gate = await import(join(root, "scripts/feature-gate.mjs"));
const evidence = await import(join(root, "scripts/evidence.mjs"));

/**
 * Feature completeness gate integrity — Phase 9L Task 2.
 *
 * The gate document is the last thing anyone reads before deciding BAYZ is done, which makes it the
 * document with the strongest incentive to be optimistic. So the machine decides, not the author.
 *
 * The tests that carry weight are the four that mechanise spec §16's list of what is *insufficient*
 * for a `PASS`, and each is asserted twice: against the real document, and against a synthesised row
 * built to trip it. Without the second half, a policy hardcoded to accept everything would pass every
 * test here — the same trap 9H Task 6 and 9K Task 8 both had to avoid.
 */

/** A full synthetic row set, all passing, so a single override is the only thing under test. */
function rowsWith(overrides = []) {
  const rows = gate.FEATURES.map((feature) => ({
    feature,
    subprogram: "Phase 1",
    backend: "PASS",
    ui: "PASS",
    // `Phase 1` has a smoke script, so the default citation must be a smoke one.
    evidence: `smoke:api#${gate.FEATURES.indexOf(feature) + 1}`,
    overall: "PASS",
  }));
  for (const override of overrides) {
    const index = rows.findIndex((row) => row.feature === override.feature);
    if (index === -1) rows.push(override);
    else rows[index] = { ...rows[index], ...override };
  }
  return { rows, malformed: [], device: "synthetic device", missing: false, path: DOCUMENT, text: "" };
}

/** Notes long enough to satisfy the reason rule, for every feature. */
function notesFor(rows) {
  return new Map(
    rows.map((row) => [
      row.feature,
      "A synthetic reason, long enough to be substantive rather than a placeholder standing in for one.",
    ]),
  );
}

function runGate(args) {
  return spawnSync(process.execPath, [GATE, ...args], { cwd: root, encoding: "utf8" });
}

/* --------------------------------------------------------------- the document */

test("the document exists and names the device and runtime it was written from", () => {
  assert.ok(existsSync(DOCUMENT), `the feature gate document is missing at ${DOCUMENT}`);
  const text = readFileSync(DOCUMENT, "utf8");
  assert.match(text, /^- Device: .+$/m, "the header does not name the device");
  assert.match(text, /^- Node: v24\.19\.0 \(arm64\)/m, "the header does not record the Node version measured");
});

test("all 29 §17 features appear exactly once, and no extra row exists", () => {
  /*
   * The vacuity guard, and the reason the row set is pinned in two places. Every per-row rule below
   * would pass by having nothing to check, so a dropped feature is the cheapest way to make this
   * document green — and "how many features does BAYZ have" is precisely the question a dropped row
   * quietly changes the answer to.
   */
  assert.equal(gate.FEATURES.length, 29, `the inventory should hold 29 features, holds ${gate.FEATURES.length}`);

  const parsed = gate.readGate(DOCUMENT);
  assert.deepEqual(parsed.malformed, [], `malformed rows: ${parsed.malformed.join("; ")}`);

  const names = parsed.rows.map((row) => row.feature);
  for (const feature of gate.FEATURES) {
    assert.equal(names.filter((name) => name === feature).length, 1, `'${feature}' should appear exactly once`);
  }
  assert.deepEqual(
    names.filter((name) => !gate.FEATURES.includes(name)),
    [],
    "the table carries a row the spec does not name",
  );
});

test("the §25.5 amendment's two rows are present, and named separately", () => {
  // Asserted by name rather than by count: the amendment took the inventory from 27 to 29, and a
  // count check alone would be satisfied by any two rows.
  const names = gate.readGate(DOCUMENT).rows.map((row) => row.feature);
  assert.ok(names.includes("Free-first model discovery"), "the free-first discovery row is missing");
  assert.ok(names.includes("Free-only routing"), "the free-only routing row is missing");
});

test("every status cell is exactly one of PASS, FAIL, UNVERIFIED, N/A", () => {
  const parsed = gate.readGate(DOCUMENT);
  for (const row of parsed.rows) {
    for (const [column, status] of [["backend", row.backend], ["UI reachability", row.ui], ["overall", row.overall]]) {
      assert.ok(gate.STATUSES.has(status), `${row.feature}/${column}: ${JSON.stringify(status)} is not a status`);
    }
  }
});

test("every overall PASS carries an evidence reference that resolves", async () => {
  const parsed = gate.readGate(DOCUMENT);
  const passes = parsed.rows.filter((row) => row.overall === "PASS");
  assert.ok(passes.length > 0, "no row is PASS, so this test would be vacuous");

  for (const row of passes) {
    const result = await evidence.resolveEvidence(row.evidence);
    assert.equal(result.ok, true, `${row.feature}: ${row.evidence} — ${result.reason}`);
  }
});

test("no two features cite the same evidence", () => {
  /*
   * One transcript proving one thing cannot prove two. Asserted against the real document because a
   * duplicate here is the shape a copy-pasted row takes, and it would otherwise read as two proven
   * features.
   */
  const parsed = gate.readGate(DOCUMENT);
  const seen = new Map();
  for (const row of parsed.rows.filter((entry) => entry.overall === "PASS")) {
    const owner = seen.get(row.evidence);
    assert.equal(owner, undefined, `${row.feature} and ${owner} both cite ${row.evidence}`);
    seen.set(row.evidence, row.feature);
  }
});

test("every non-PASS verdict has a documented reason of real substance", () => {
  const parsed = gate.readGate(DOCUMENT);
  const notes = gate.readNotes(parsed.text);
  for (const row of parsed.rows) {
    const hasNonPass = [row.backend, row.ui, row.overall].some((status) => status !== "PASS");
    if (!hasNonPass) continue;
    const note = notes.get(row.feature);
    assert.notEqual(note, undefined, `${row.feature} carries a non-PASS verdict with no notes section`);
    // Forty characters for the same reason the matrix uses twelve: it is past the length at which
    // "not applicable" or "see above" fits, which are the two ways this section goes empty while
    // looking filled.
    assert.ok(note.length >= 40, `${row.feature}: the documented reason is too thin: ${JSON.stringify(note)}`);
  }
});

test("every N/A UI reachability states why the feature has no user-facing action", () => {
  /*
   * `N/A` is the one verdict that can be used to *avoid* measuring, which is why the document's own
   * legend says so. Eleven rows use it, each for a real reason — automatic behaviour, deployment
   * configuration, a client-facing protocol surface, or an operator shell action — and each reason
   * has to be written down or the column becomes a way to skip the check it exists to perform.
   */
  const parsed = gate.readGate(DOCUMENT);
  const notes = gate.readNotes(parsed.text);
  const naRows = parsed.rows.filter((row) => row.ui === "N/A");
  assert.ok(naRows.length > 0, "no row uses N/A, so this test would be vacuous");

  for (const row of naRows) {
    const note = notes.get(row.feature) ?? "";
    assert.match(
      note,
      /N\/A/,
      `${row.feature}: UI reachability is N/A but the notes never address that column`,
    );
  }
});

test("the document states the rules it is enforced by, so a reader is not reverse-engineering the gate", () => {
  const text = readFileSync(DOCUMENT, "utf8");
  assert.match(text, /## Rules/, "there is no rules section");
  assert.match(text, /UI reachability/, "the UI reachability column is never defined");
  assert.match(text, /no advisory exemption/i, "the document does not say UNVERIFIED blocks here");
  assert.match(text, /--enforce/, "the document does not name the enforcing command");
});

/* -------------------------------------------------------------- the policy */

test("a backend PASS whose UI reachability is UNVERIFIED cannot be overall PASS", () => {
  /*
   * **§16's first insufficiency, and the assertion this task exists for.** A backend that works and a
   * UI that cannot reach it is the most common way a feature gets called done, because both halves
   * look green in isolation.
   */
  const parsed = rowsWith([{ feature: "Routing", backend: "PASS", ui: "UNVERIFIED", overall: "PASS" }]);
  const verdict = gate.assess(parsed, notesFor(parsed.rows));
  assert.ok(
    verdict.blocking.some((entry) => entry.includes("Routing") && entry.includes("UI reachability UNVERIFIED")),
    `an unreachable backend reached PASS: ${JSON.stringify(verdict.blocking)}`,
  );
});

test("a backend PASS whose UI reachability is FAIL cannot be overall PASS either", () => {
  const parsed = rowsWith([{ feature: "Routing", backend: "PASS", ui: "FAIL", overall: "PASS" }]);
  const verdict = gate.assess(parsed, notesFor(parsed.rows));
  assert.ok(verdict.blocking.some((entry) => entry.includes("Routing")), "an inert UI reached PASS");
});

test("an overall PASS with a non-PASS backend blocks", () => {
  const parsed = rowsWith([{ feature: "Routing", backend: "UNVERIFIED", ui: "PASS", overall: "PASS" }]);
  const verdict = gate.assess(parsed, notesFor(parsed.rows));
  assert.ok(
    verdict.blocking.some((entry) => entry.includes("Routing: overall PASS with backend UNVERIFIED")),
    "a PASS with an unproven backend was accepted",
  );
});

test("a PASS citing only a unit test blocks when the owning subprogram ships a smoke script", () => {
  /*
   * §16's third insufficiency: "a unit test mocks the boundary that matters". The only mechanical
   * enforcement is to demand the citation form that implies a real run — and the subprogram list is
   * measured from `scripts/*-smoke.mjs`, so a subprogram that gains a script starts constraining its
   * features immediately rather than when someone remembers.
   */
  const parsed = rowsWith([
    { feature: "Routing", subprogram: "Phase 5", evidence: "test:tests/offline.test.mjs", overall: "PASS" },
  ]);
  const verdict = gate.assess(parsed, notesFor(parsed.rows));
  assert.ok(
    verdict.blocking.some((entry) => entry.includes("Routing") && entry.includes("a unit test cannot carry this row")),
    `a unit-test citation carried a smoke-backed feature: ${JSON.stringify(verdict.blocking)}`,
  );
});

test("a transcript citation is accepted where a unit test is not", () => {
  // The rule must not simply refuse everything: a transcript is a record of a real run, which is the
  // property being demanded.
  const parsed = rowsWith([
    {
      feature: "Routing",
      subprogram: "Phase 5",
      evidence: "transcript:docs/transcripts/load/load.md",
      overall: "PASS",
    },
  ]);
  const verdict = gate.assess(parsed, notesFor(parsed.rows));
  assert.ok(
    !verdict.blocking.some((entry) => entry.includes("Routing")),
    `a transcript citation was refused: ${JSON.stringify(verdict.blocking)}`,
  );
});

test("a feature whose subprogram has no smoke script may cite a unit test", () => {
  /*
   * The counter-case that keeps the rule honest. 9A, 9K and 9L ship no smoke script of their own, and
   * demanding a `smoke:` citation from a feature whose subprogram has none would be demanding
   * evidence that cannot exist — which is how a gate becomes unpassable and gets routed around.
   */
  assert.equal(gate.SMOKE_BACKED_SUBPROGRAMS["9A"], undefined, "9A now has a smoke script; revisit this test");
  const parsed = rowsWith([
    { feature: "Routing", subprogram: "9A", evidence: "test:tests/offline.test.mjs", overall: "PASS" },
  ]);
  const verdict = gate.assess(parsed, notesFor(parsed.rows));
  assert.ok(!verdict.blocking.some((entry) => entry.includes("Routing")), "a legitimate unit-test citation was refused");
});

test("a subprogram column naming two subprograms is satisfied by either having a script", () => {
  // `Phase 2 / 9F` is a real value in the document, and splitting it wrongly would either exempt a
  // smoke-backed feature or demand a script from a subprogram that has none.
  const parsed = rowsWith([
    { feature: "Routing", subprogram: "9A / 9F", evidence: "test:tests/offline.test.mjs", overall: "PASS" },
  ]);
  const verdict = gate.assess(parsed, notesFor(parsed.rows));
  assert.ok(
    verdict.blocking.some((entry) => entry.includes("Routing") && entry.includes("9F")),
    "the second subprogram's smoke script was not considered",
  );
});

test("two features citing the same evidence is an integrity violation", () => {
  const parsed = rowsWith([
    { feature: "Routing", evidence: "smoke:api#1", overall: "PASS" },
    { feature: "Combo", evidence: "smoke:api#1", overall: "PASS" },
  ]);
  const verdict = gate.assess(parsed, notesFor(parsed.rows));
  assert.ok(
    verdict.violations.some((entry) => entry.includes("one piece of evidence cannot prove two features")),
    `a shared citation was accepted: ${JSON.stringify(verdict.violations)}`,
  );
});

test("a missing mandatory row is a violation, not a silent pass", () => {
  const parsed = rowsWith();
  parsed.rows = parsed.rows.filter((row) => row.feature !== "Free-only routing");
  const verdict = gate.assess(parsed, notesFor(parsed.rows));
  assert.ok(
    verdict.violations.some((entry) => entry.includes("no 'Free-only routing' row")),
    "a dropped feature was not reported",
  );
});

test("an invented row is a violation", () => {
  const parsed = rowsWith();
  parsed.rows.push({
    feature: "Quantum tunnelling",
    subprogram: "9A",
    backend: "PASS",
    ui: "PASS",
    evidence: "test:tests/offline.test.mjs",
    overall: "PASS",
  });
  const verdict = gate.assess(parsed, notesFor(parsed.rows));
  assert.ok(
    verdict.violations.some((entry) => entry.includes("is not a §17 feature")),
    "an invented feature was accepted",
  );
});

test("a PASS with no evidence reference is a violation", () => {
  const parsed = rowsWith([{ feature: "Routing", evidence: "", overall: "PASS" }]);
  const verdict = gate.assess(parsed, notesFor(parsed.rows));
  assert.ok(
    verdict.violations.some((entry) => entry.includes("PASS without a valid evidence reference")),
    "an unevidenced PASS was accepted",
  );
});

test("a PASS whose evidence does not resolve blocks", () => {
  const parsed = rowsWith([{ feature: "Routing", evidence: "smoke:api#1", overall: "PASS" }]);
  const resolved = new Map([["smoke:api#1", { ok: false, reason: "synthetic resolution failure" }]]);
  const verdict = gate.assess(parsed, notesFor(parsed.rows), resolved);
  assert.ok(
    verdict.blocking.some((entry) => entry.includes("does not resolve")),
    "an unresolvable citation was accepted",
  );
});

test("UNVERIFIED and FAIL both block — there is no advisory exemption in this gate", () => {
  /*
   * The difference from the supply-chain gate, and it is deliberate. That gate exempts an unsigned
   * local build because unsigned is the *correct* state on this host. Here, an exempt row would be a
   * feature shipped on a promise, so `UNVERIFIED` blocks and the honest response is to fix the feature
   * or accept that the release is not GOAT-complete.
   */
  for (const status of ["UNVERIFIED", "FAIL"]) {
    const parsed = rowsWith([{ feature: "Routing", overall: status }]);
    const verdict = gate.assess(parsed, notesFor(parsed.rows));
    assert.ok(
      verdict.blocking.some((entry) => entry === `Routing: ${status}`),
      `${status} did not block: ${JSON.stringify(verdict.blocking)}`,
    );
  }
});

test("a non-PASS verdict with no documented reason is a violation", () => {
  const parsed = rowsWith([{ feature: "Routing", overall: "UNVERIFIED" }]);
  const verdict = gate.assess(parsed, new Map([["Routing", "nobody looked"]]));
  assert.ok(
    verdict.violations.some((entry) => entry.includes("no substantive documented reason")),
    "a reasonless UNVERIFIED was accepted",
  );
});

test("a missing document blocks rather than reading as nothing wrong", () => {
  const verdict = gate.assess(gate.readGate(join(root, "docs/superpowers/does-not-exist.md")));
  assert.ok(verdict.violations.some((entry) => entry.includes("is missing at")), "a missing document was not reported");
});

test("a malformed row is reported, not skipped", () => {
  // A gate that silently ignores what it cannot read is a gate that passes an empty file.
  const parsed = rowsWith();
  parsed.malformed = ["Routing: expected 6 cells, found 4"];
  const verdict = gate.assess(parsed, notesFor(parsed.rows));
  assert.ok(verdict.violations.some((entry) => entry.includes("malformed row")), "a malformed row was ignored");
});

/* ------------------------------------------------------------------ the CLI */

test("--report exits 0 and prints every row plus the not-verified list", () => {
  const result = runGate(["--report"]);
  assert.equal(result.status, 0, `--report should exit 0, got ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /feature gate: REPORT/);
  for (const feature of gate.FEATURES) {
    assert.ok(result.stdout.includes(feature), `--report omits ${feature}`);
  }
  assert.match(result.stdout, /not verified — this list is the honest release-notes content/);
});

test("--enforce exits non-zero today, which is the correct state", () => {
  /*
   * Two features genuinely are not proven: `antigravity` is a Core 3 client absent from this host, and
   * six of seven platforms have no runner. A green gate here would mean a status had been adjusted to
   * produce one, which the plan forbids in as many words.
   */
  const result = runGate(["--enforce"]);
  assert.equal(result.status, 1, `--enforce should exit 1 while anything is UNVERIFIED, got ${result.status}`);
  assert.match(result.stdout, /feature gate: FAIL/);
  assert.match(result.stdout, /Client integrations: UNVERIFIED/);
  assert.match(result.stdout, /Cross-platform qualification: UNVERIFIED/);
});

test("no flag, both flags, and an unknown flag all exit 2", () => {
  /*
   * "Report and enforce" has two plausible meanings — print then fail, or print instead of failing —
   * and guessing one would let a release script believe it enforced when it only reported. Same
   * contract as the resilience and supply-chain gates.
   */
  for (const argv of [[], ["--report", "--enforce"], ["--enfore"], ["--report", "--wat"]]) {
    const result = runGate(argv);
    assert.equal(result.status, 2, `argv ${JSON.stringify(argv)} should exit 2, got ${result.status}`);
    assert.match(result.stderr, /usage: node scripts\/feature-gate\.mjs/);
  }
});

test("the gate composes the shared evidence checker instead of reimplementing it", () => {
  // 9L Task 1's whole point: one definition of what a citation is. A fifth copy here would be the
  // copy that drifts.
  const source = readFileSync(GATE, "utf8");
  assert.match(source, /from "\.\/evidence\.mjs"/, "the gate does not import the shared evidence checker");
  assert.ok(!/EVIDENCE_RE\s*=\s*\//.test(source), "the gate defines its own evidence regex");
});
