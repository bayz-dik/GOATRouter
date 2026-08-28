import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Guards on the release-blocking client compatibility gate — 9H Task 6.
 *
 * The gate is the last thing between an unverified client and a declared release, so the
 * property that matters is not "it runs" but **"it refuses when it should"**. Every test here
 * is written from that direction: the interesting failure mode is a gate that passes.
 *
 * `assess()` is exercised directly against synthetic matrices, because driving the real
 * document only ever tests today's state — and today's state is "blocked", so a gate hardcoded
 * to fail would pass every check against it.
 */

const GATE = fileURLToPath(new URL("../scripts/client-gate.mjs", import.meta.url));
const lib = await import("../scripts/client-gate-lib.mjs");
const { CORE_3, MANDATORY, assess, readMatrix } = lib;

function run(args) {
  return spawnSync(process.execPath, [GATE, ...args], { encoding: "utf8", timeout: 120000 });
}

/** A synthetic matrix: every Core 3 client, every mandatory capability, one status. */
function uniform(status, note = "a reason long enough to be usable") {
  const clients = new Map();
  for (const client of CORE_3) {
    const row = new Map();
    for (const capability of MANDATORY) {
      row.set(capability, { status, note });
    }
    clients.set(client, row);
  }
  return clients;
}

test("--report exits 0 and lists the current blocking cells", () => {
  const result = run(["--report"]);
  assert.equal(result.status, 0, `--report must always exit 0, got ${result.status}`);
  assert.match(result.stdout, /Core 3 status/);
  // The three Core 3 clients must each appear, or the report is hiding one.
  for (const client of CORE_3) {
    assert.match(result.stdout, new RegExp(client), `--report omits ${client}`);
  }
  assert.match(result.stdout, /--report always exits 0/);
});

test("--enforce exits non-zero today, because antigravity is UNVERIFIED", () => {
  /*
   * This is the plan's own acceptance criterion, and it is deliberately an assertion rather
   * than a known-failure note: `antigravity` is not installed on this host, so all 17 of its
   * cells are UNVERIFIED and a release must be blocked. If this test ever fails, either the
   * client was verified for real (in which case update it) or something promoted cells
   * without evidence (in which case the gate just earned its keep).
   */
  const result = run(["--enforce"]);
  assert.equal(result.status, 1, "--enforce must block while Core 3 cells are UNVERIFIED");
  assert.match(result.stderr, /RELEASE BLOCKED/);
  assert.match(result.stdout, /antigravity/);
});

test("both modes report the same blocking count", () => {
  // A gate whose report disagrees with its enforcement is worse than no report.
  const report = run(["--report"]);
  const enforce = run(["--enforce"]);
  const countOf = (text) => /Blocking cells \((\d+)\)/.exec(text)?.[1];
  assert.equal(countOf(report.stdout), countOf(enforce.stdout));
  assert.ok(Number(countOf(report.stdout)) > 0, "the current state must show blockers");
});

test("no mode, or both modes, is a usage error rather than a silent pass", () => {
  // Exit 2, not 0: a CI step that typo'd the flag must not be read as "release permitted".
  assert.equal(run([]).status, 2);
  assert.equal(run(["--report", "--enforce"]).status, 2);
  assert.equal(run(["--enfroce"]).status, 2, "a misspelled flag must not silently pass");
});

test("a fully verified matrix would permit release", () => {
  // The positive case, proved on a synthetic matrix: the gate is not hardcoded to fail.
  const { blockers } = assess(uniform("VERIFIED"));
  assert.deepEqual(blockers, []);
});

test("UNVERIFIED and BLOCKED both block; PARTIAL and N/A do not", () => {
  /*
   * The distinction Task 1 refused to collapse, enforced here. `UNVERIFIED` (never tried)
   * blocks for the same reason `BLOCKED` (tried, failed) does — an unknown is not a smaller
   * risk than a known failure. `PARTIAL` carries evidence plus a named limitation and `N/A`
   * means the surface does not exist, so neither is an unknown.
   */
  assert.equal(assess(uniform("UNVERIFIED")).blockers.length, CORE_3.length * MANDATORY.length);
  assert.equal(assess(uniform("BLOCKED")).blockers.length, CORE_3.length * MANDATORY.length);
  assert.deepEqual(assess(uniform("PARTIAL")).blockers, []);
  assert.deepEqual(assess(uniform("N/A")).blockers, []);
});

test("a single blocking cell anywhere in the Core 3 blocks the release", () => {
  // Off-by-one insurance: a gate that only checked the first client, or only the first
  // capability, would pass this suite's uniform cases and fail here.
  for (const client of CORE_3) {
    for (const capability of [MANDATORY[0], MANDATORY.at(-1), MANDATORY[8]]) {
      const clients = uniform("VERIFIED");
      clients.get(client).set(capability, { status: "UNVERIFIED", note: "not attempted at all" });
      const { blockers } = assess(clients);
      assert.equal(blockers.length, 1, `${client}/${capability} did not block`);
      assert.equal(blockers[0].client, client);
      assert.equal(blockers[0].capability, capability);
    }
  }
});

test("a missing cell blocks, and a missing Core 3 row blocks hardest", () => {
  /*
   * Silence must never read as success. A capability with no row at all is the easiest way
   * for a claim to disappear — delete the line and the gate stops complaining — so an absent
   * cell is a blocker in its own right.
   */
  const missingCell = uniform("VERIFIED");
  missingCell.get("hermes").delete("cancel");
  const cellResult = assess(missingCell);
  assert.equal(cellResult.blockers.length, 1);
  assert.equal(cellResult.blockers[0].status, "MISSING");

  const missingRow = uniform("VERIFIED");
  missingRow.delete("antigravity");
  const rowResult = assess(missingRow);
  assert.equal(rowResult.blockers.length, 1);
  assert.equal(rowResult.blockers[0].capability, "(entire row)");
  assert.equal(rowResult.blockers[0].client, "antigravity");
});

test("a non-Core-3 client cannot block, and cannot rescue either", () => {
  // `generic-openai` is fully verified and is NOT release-blocking; a Core 3 client being
  // unverified must not be offset by it.
  const clients = uniform("VERIFIED");
  const generic = new Map();
  for (const capability of MANDATORY) {
    generic.set(capability, { status: "UNVERIFIED", note: "not a Core 3 client" });
  }
  clients.set("generic-openai", generic);
  assert.deepEqual(assess(clients).blockers, [], "a non-Core-3 client must not block");

  clients.get("opencode").set("chat", { status: "BLOCKED", note: "observed failure" });
  assert.equal(assess(clients).blockers.length, 1, "a Core 3 failure must still block");
});

test("the gate reads all three Core 3 rows out of the real matrix", () => {
  // Guards against a parser that silently matches nothing: every Core 3 row must be found
  // with a full set of mandatory capabilities.
  const clients = readMatrix();
  for (const client of CORE_3) {
    const row = clients.get(client);
    assert.notEqual(row, undefined, `the matrix has no ${client} row`);
    for (const capability of MANDATORY) {
      assert.ok(row.has(capability), `${client} is missing the ${capability} cell`);
    }
  }
});

test("the gate does not read prose tables as status rows", () => {
  /*
   * The matrix contains capability-keyed tables that are documentation, not verdicts — the
   * "what a VERIFIED here would mean" legend and the per-client transcript tables. If the
   * parser took those as statuses it would invent verdicts, so each Core 3 row must hold
   * exactly the 17 mandatory capabilities and nothing else.
   */
  const clients = readMatrix();
  for (const client of CORE_3) {
    const keys = [...clients.get(client).keys()].sort();
    assert.deepEqual(keys, [...MANDATORY].sort(), `${client} row has unexpected keys: ${keys.join(", ")}`);
  }
});
