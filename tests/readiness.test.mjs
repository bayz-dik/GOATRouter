import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

const readiness = await import(join(ROOT, "scripts/readiness.mjs"));
const evidence = await import(join(ROOT, "scripts/evidence.mjs"));

/**
 * Release readiness statement integrity — Phase 9L Task 6.
 *
 * The statement is generated, and this file is what makes "generated" mean something. Three classes
 * of check:
 *
 * 1. **Byte identity.** Regenerating must reproduce the committed file exactly. Same rule 9K's
 *    licence inventory uses, and for the same reason: a document that merely *looks* generated can be
 *    hand-edited into agreeing with nothing, and the edit is invisible in review.
 * 2. **Content the plan requires.** Every gate verdict, the complete `UNVERIFIED` list, the residual
 *    risks, the withheld platforms and clients, and the push conditions — each asserted present and
 *    non-empty, because a section that silently rendered zero rows would still look like a document.
 * 3. **Non-vacuity.** The generator reads five subprograms' parsers. If one returned nothing the
 *    statement would be confidently empty, so each source is asserted to have produced real content.
 */

const STATEMENT = readiness.STATEMENT_PATH;

function statement() {
  assert.ok(existsSync(STATEMENT), `the readiness statement is missing. Run: node scripts/readiness.mjs --write`);
  return readFileSync(STATEMENT, "utf8");
}

test("regenerating the statement reproduces the committed file byte for byte", async () => {
  /*
   * The load-bearing test. It fails in two situations and both are correct failures: somebody edited
   * the statement by hand, or a gate moved and the statement was not regenerated. In the second case
   * the committed document is *stale*, which is exactly the failure mode a readiness statement has.
   */
  const fresh = await readiness.statementText();
  assert.equal(
    statement(),
    fresh,
    "the committed statement differs from a fresh generation. Do not edit it by hand: run `node scripts/readiness.mjs --write`.",
  );
});

test("the statement is deterministic across two generations in the same process", async () => {
  // Without this, byte identity above could be satisfied by a document that happens to match once.
  // No timestamp, no `Date.now()`, no set-iteration order is allowed to leak into the output.
  const first = await readiness.statementText();
  const second = await readiness.statementText();
  assert.equal(first, second, "two generations differ, so something non-deterministic leaked into the renderer");
});

test("every gate verdict appears, with a verdict from the closed vocabulary", async () => {
  const verdicts = await readiness.allVerdicts();
  assert.equal(verdicts.rows.length, 6, `expected six composed gates, got ${verdicts.rows.length}`);

  const subprograms = verdicts.rows.map((row) => row.subprogram);
  for (const expected of ["9F", "9H", "9I", "9J", "9K", "9L"]) {
    assert.ok(subprograms.includes(expected), `no verdict row for ${expected}`);
  }

  const text = statement();
  for (const row of verdicts.rows) {
    assert.ok(["PASS", "BLOCKED"].includes(row.verdict), `${row.label}: ${row.verdict} is not a verdict`);
    assert.ok(text.includes(row.label), `the statement does not mention the ${row.label} gate`);
  }
});

test("a BLOCKED gate states its reasons, and a PASS gate has none", async () => {
  const verdicts = await readiness.allVerdicts();
  for (const row of verdicts.rows) {
    if (row.verdict === "BLOCKED") {
      assert.ok(row.reasons.length > 0, `${row.label} is BLOCKED with no reason — that is unfalsifiable`);
    } else {
      assert.deepEqual(row.reasons, [], `${row.label} is PASS but carries reasons: ${row.reasons.join("; ")}`);
    }
  }
});

test("every gate verdict row cites resolvable evidence, so a PASS row is not a bare claim", async () => {
  /*
   * The regression this test exists for. The first generated statement rendered every gate row with
   * `—` in the reasons cell and no citation anywhere, which made three `PASS` rows — 9J, 9K and the
   * derived 9F — positive verdicts carrying no evidence at all. `tests/no-fabrication.test.mjs`'s
   * repo-wide sweep caught them, and through it `scripts/offline-check.mjs` failed.
   *
   * Asserted here rather than left to the sweep because the sweep reports a *symptom* in a generated
   * file, and the fix for a generated file is never in the file. This test fails on the generator,
   * which is the only place the defect can be repaired.
   *
   * Every row is required to cite, not only the passing ones: the evidence a gate's verdict rests on
   * is the same document and the same policy test whichever way the verdict came out, and a rule that
   * only demanded citations from `PASS` rows would quietly stop applying the moment a row flipped.
   */
  const verdicts = await readiness.allVerdicts();
  const text = statement();

  for (const row of verdicts.rows) {
    assert.ok(
      typeof row.evidence === "string" && row.evidence.length > 0,
      `the ${row.label} (${row.subprogram}) row carries no evidence citation — a verdict nobody can look up`,
    );
    const resolved = await evidence.resolveEvidence(row.evidence);
    assert.ok(resolved.ok, `${row.label}: ${row.evidence} does not resolve — ${resolved.reason}`);
    assert.ok(
      text.includes(row.evidence),
      `the statement's ${row.label} row does not render its ${row.evidence} citation`,
    );
  }
});

test("the UNVERIFIED inventory is non-empty and every entry carries a reason", async () => {
  /*
   * Non-empty is asserted, not hoped for. Two features, one soak mode, two chaos scenarios, six
   * platforms and two clients are genuinely unverified today; an empty list would mean the collector
   * broke, and a broken collector reads exactly like a clean release.
   */
  const entries = await readiness.unverifiedInventory();
  assert.ok(entries.length > 20, `expected a substantial UNVERIFIED inventory, got ${entries.length}`);

  for (const entry of entries) {
    assert.ok(entry.source.length > 0, "an UNVERIFIED entry has no source");
    assert.ok(entry.item.length > 0, `an UNVERIFIED entry from ${entry.source} has no item`);
    assert.notEqual(
      entry.reason,
      "(no reason documented)",
      `${entry.source}/${entry.item} is UNVERIFIED with no documented reason — an untried cell must say why not`,
    );
  }

  // Every subprogram that withholds something must appear, so a collector that silently stopped
  // reading one report is a failure rather than a shorter list.
  const sources = entries.map((entry) => entry.source).join(" ");
  for (const subprogram of ["9H", "9I", "9J", "9L"]) {
    assert.ok(sources.includes(subprogram), `the inventory reads nothing from ${subprogram}`);
  }
});

test("the residual-risk list is parsed from spec §24 and is complete", () => {
  const risks = readiness.residualRisks();
  assert.equal(risks.error, undefined, `spec §24 could not be read: ${risks.error}`);
  assert.ok(risks.rows.length >= 10, `expected at least ten boundaries, parsed ${risks.rows.length}`);

  // Named rather than counted: a count check passes if a boundary is replaced by a duplicate.
  const boundaries = risks.rows.map((row) => row.boundary).join(" | ");
  for (const expected of ["mid-stream failover", "memory wiping", "rollback", "OS keystore", "reproducible build", "charged"]) {
    assert.ok(boundaries.includes(expected), `spec §24's '${expected}' boundary is missing from the parsed list`);
  }
  for (const row of risks.rows) {
    assert.ok(row.why.length > 10, `${row.boundary} has no substantive reason`);
    assert.match(row.owner, /9[A-L]/, `${row.boundary} names no owning subprogram`);
  }
});

test("every unsupported platform is named, and the qualifying device is not among them", async () => {
  const verdicts = await readiness.allVerdicts();
  const { unsupported, primary, supported } = verdicts.platform;
  assert.ok(unsupported.length >= 6, `expected at least six unsupported platforms, got ${unsupported.length}`);
  assert.ok(!unsupported.includes(primary), `${primary} is the qualifying device and must not be listed unsupported`);
  assert.deepEqual(supported, [primary], `only ${primary} should be supported, got ${supported.join(", ")}`);

  const text = statement();
  for (const platform of unsupported) {
    assert.ok(text.includes(platform), `the statement does not name ${platform} as unsupported`);
  }
});

test("the withheld-client list uses 9H's own BLOCKING set, not a stricter invented rule", async () => {
  /*
   * A real defect this caught. An earlier draft withheld any client that was not 100% `VERIFIED`,
   * which listed `generic-openai` — 13 VERIFIED, 2 PARTIAL — as unsupported. `PARTIAL` is acceptable
   * at release by 9H's policy: it carries evidence and a named limit. Two different policies in one
   * tree is how a summary starts contradicting the gate it summarises.
   */
  const lib = await import(join(ROOT, "scripts/client-gate-lib.mjs"));
  const verdicts = await readiness.allVerdicts();
  const withheld = new Set(verdicts.client.withheld.map((entry) => entry.client));

  for (const [client, capabilities] of lib.readMatrix()) {
    const statuses = [...capabilities.values()].map((cell) => cell.status);
    const blocks = statuses.some((status) => lib.BLOCKING.has(status));
    assert.equal(
      withheld.has(client),
      blocks,
      `${client}: withheld=${withheld.has(client)} but 9H's BLOCKING set says ${blocks}`,
    );
  }

  assert.ok(withheld.has("antigravity"), "antigravity is 17/17 UNVERIFIED and must be withheld");
  assert.ok(!withheld.has("hermes"), "hermes is 17/17 VERIFIED and must not be withheld");
});

test("all six push conditions are stated, and the statement says a push is prohibited", async () => {
  const verdicts = await readiness.allVerdicts();
  const conditions = readiness.pushConditions(verdicts);
  assert.equal(conditions.length, 6, `the plan names six conditions, got ${conditions.length}`);

  const unmet = conditions.filter((entry) => entry.met === false);
  assert.ok(unmet.length > 0, "every push condition reads as met — verify that against the gate verdicts");

  const text = statement();
  for (const entry of conditions) {
    assert.ok(text.includes(entry.condition), `the statement omits the '${entry.condition}' push condition`);
  }
  assert.match(text, /a push is prohibited/i, "the statement does not say plainly that a push is prohibited");
  assert.match(text, /No remote is configured/i, "the statement does not record that no remote exists");
});

test("the statement states that it summarises documents rather than a live run", () => {
  /*
   * The distinction Task 7 depends on. A reader who takes this document for a fresh measurement has
   * been misled by it, so the disclaimer is load-bearing text and not preamble.
   */
  const text = statement();
  assert.match(text, /runs no smoke script/i, "the statement does not say it runs nothing");
  assert.match(text, /Task 7/, "the statement does not point at where the live execution is recorded");
});

test("the statement carries every section the plan requires", () => {
  const text = statement();
  for (const heading of [
    "## Gate verdicts",
    "## Everything currently `UNVERIFIED`",
    "## Must not be described as supported",
    "## Residual risk",
    "## When a GitHub push becomes permissible",
  ]) {
    assert.ok(text.includes(heading), `the statement has no '${heading}' section`);
  }
});
