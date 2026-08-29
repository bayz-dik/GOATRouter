import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classify, parseAudit, summarise } from "../scripts/audit-check.mjs";

/**
 * The vulnerability audit policy and check — Phase 9K Task 1.
 *
 * Two things are asserted here, and they are different in kind.
 *
 * The **policy document** is asserted because a severity policy that lives in someone's head is not a
 * policy. The test pins the parts that would otherwise erode: the runtime-versus-dev distinction, the
 * per-severity action, the maximum age of a deferral, who may grant an exception, and the requirement
 * that an exception be written down rather than remembered.
 *
 * The **check** is asserted against synthetic audit payloads rather than the live registry, because a
 * test whose verdict depends on today's advisory database is not a test. The live run happens in the
 * task gate; here we prove the logic can actually fail.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POLICY = join(ROOT, "docs/superpowers/2026-08-27-bayz-supply-chain-policy.md");
const CHECK = join(ROOT, "scripts/audit-check.mjs");

function policy() {
  assert.ok(existsSync(POLICY), `${POLICY} does not exist`);
  return readFileSync(POLICY, "utf8");
}

/** A minimal `npm audit --json` shape: enough fields for the classifier, no more. */
function auditPayload(entries) {
  const vulnerabilities = {};
  const totals = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const entry of entries) {
    vulnerabilities[entry.name] = {
      name: entry.name,
      severity: entry.severity,
      isDirect: entry.isDirect ?? false,
      range: entry.range ?? "<=0.0.0",
      via: entry.via ?? [{ title: `${entry.name} advisory`, severity: entry.severity, url: "https://example.invalid" }],
      effects: entry.effects ?? [],
      fixAvailable: entry.fixAvailable ?? false,
    };
    totals[entry.severity] += 1;
    totals.total += 1;
  }
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: totals } };
}

test("the policy states an action for every severity", () => {
  const text = policy();
  for (const severity of ["critical", "high", "moderate", "low"]) {
    assert.ok(text.includes(`\`${severity}\``), `the policy does not mention ${severity}`);
  }
  // The two that block must say so in the same breath as the word.
  assert.match(text, /`critical`[^|]*\|[^|]*[Bb]locks the release/, "critical is not stated as blocking");
  assert.match(text, /`high`[^|]*\|[^|]*[Bb]locks the release/, "high is not stated as blocking");
});

test("the policy separates the runtime closure from dev-only dependencies", () => {
  /*
   * The load-bearing distinction: a dev-only advisory never ships. Without this written down, either
   * every `vite` advisory blocks a release (and the gate gets ignored) or nothing does.
   */
  const text = policy();
  assert.match(text, /dev-only|devDependencies/, "the policy does not mention dev-only dependencies");
  assert.match(text, /runtime closure/, "the policy does not name the runtime closure");
  assert.match(
    text,
    /scripts\/dependency-closure\.mjs/,
    "the policy does not tie 'runtime' to the one closure computation",
  );
});

test("the policy sets a maximum tolerated age for a deferral", () => {
  const text = policy();
  assert.match(text, /review date/i, "the policy has no review date concept");
  assert.match(text, /\b\d+ days\b/, "the policy states no maximum age");
  // An expired deferral must not be a silent pass.
  assert.match(text, /expired deferral|review date has passed/i, "the policy does not say what an expired deferral means");
});

test("the policy names who decides an exception and requires it in writing", () => {
  const text = policy();
  assert.match(text, /repository owner/i, "the policy does not name who approves an exception");
  assert.match(
    text,
    /written into this document/i,
    "the policy does not require the exception to be written into the document",
  );
  // Whitespace-tolerant: the sentence wraps across lines in the document.
  assert.match(text, /not\s+an\s+exception/i, "the policy does not say an unwritten exception is void");
});

test("the policy documents the network-unavailable path", () => {
  const text = policy();
  assert.match(text, /UNVERIFIED: audit requires registry access/, "the policy does not quote the UNVERIFIED message");
  assert.match(text, /exits 0/, "the policy does not state that an unreachable registry exits 0");
  assert.match(text, /never counted as a pass/i, "the policy does not say UNVERIFIED is not a pass");
});

test("a critical or high finding in the runtime closure blocks", () => {
  // The whole point of the check. Both severities, so neither can be dropped silently.
  for (const severity of ["critical", "high"]) {
    const verdict = classify(parseAudit(auditPayload([{ name: "fastify", severity }])), new Set(["fastify"]));
    assert.equal(verdict.blocking.length, 1, `${severity} did not block`);
    assert.equal(verdict.blocking[0].name, "fastify");
    assert.equal(verdict.exitCode, 1, `${severity} did not produce a non-zero exit`);
  }
});

test("a critical finding reachable only from devDependencies does not block", () => {
  /*
   * `vite` is the real case: it pulls in every install-scripted and platform-restricted package in the
   * tree and none of them ship. Blocking on those would make the gate noise.
   */
  const verdict = classify(parseAudit(auditPayload([{ name: "vite", severity: "critical" }])), new Set(["fastify"]));
  assert.equal(verdict.blocking.length, 0, "a dev-only critical blocked the release");
  assert.equal(verdict.devOnly.length, 1);
  assert.equal(verdict.devOnly[0].name, "vite");
  assert.equal(verdict.exitCode, 0);
});

test("a moderate or low runtime finding is recorded but does not block", () => {
  const verdict = classify(
    parseAudit(auditPayload([{ name: "fastify", severity: "moderate" }, { name: "glob", severity: "low" }])),
    new Set(["fastify", "glob"]),
  );
  assert.equal(verdict.blocking.length, 0);
  assert.equal(verdict.recorded.length, 2, "the moderate and low findings were not recorded");
  assert.equal(verdict.exitCode, 0);
});

test("a clean audit exits 0 with a summary rather than silence", () => {
  const verdict = classify(parseAudit(auditPayload([])), new Set(["fastify"]));
  assert.equal(verdict.exitCode, 0);
  assert.equal(verdict.blocking.length, 0);
  const text = summarise(verdict);
  // The counts are what make a clean run auditable; "no output" and "nothing found" must differ.
  assert.match(text, /blocking \(critical\/high in the runtime closure\): 0/, `summary lacked the blocking count: ${text}`);
  assert.match(text, /audit: PASS/, `summary lacked the verdict: ${text}`);
});

test("an unreachable registry is UNVERIFIED, not clean and not a failure", () => {
  /*
   * The distinction the policy insists on. `parseAudit` is given the shape npm actually produces when
   * it cannot reach the registry: no `vulnerabilities` object at all.
   */
  const parsed = parseAudit({ error: { code: "ENOTFOUND", summary: "getaddrinfo ENOTFOUND registry.npmjs.org" } });
  assert.equal(parsed.unverified, true, "an errored audit was not marked unverified");

  const verdict = classify(parsed, new Set(["fastify"]));
  assert.equal(verdict.exitCode, 0, "an unreachable registry failed the gate");
  assert.equal(verdict.unverified, true);
  const text = summarise(verdict);
  assert.match(text, /UNVERIFIED: audit requires registry access/, `summary did not report UNVERIFIED: ${text}`);
  assert.ok(!/\bclean\b/i.test(text), `an unverified audit was described as clean: ${text}`);
});

test("unparseable audit output is UNVERIFIED rather than read as empty", () => {
  // Fail open here, but visibly: an empty parse must never look like a clean tree.
  const parsed = parseAudit(undefined);
  assert.equal(parsed.unverified, true);
  const verdict = classify(parsed, new Set());
  assert.equal(verdict.unverified, true);
  assert.equal(verdict.exitCode, 0);
});

test("the check runs as a script and exits 0 on the real tree", () => {
  /*
   * The live run. It exits 0 whether the registry is reachable or not — clean or `UNVERIFIED` — and
   * this test asserts the exit code and that the output commits to one of those two states rather
   * than printing nothing.
   */
  const stdout = execFileSync(process.execPath, [CHECK], { encoding: "utf8" });
  assert.match(stdout, /audit: (PASS|UNVERIFIED)/, `the check printed no verdict: ${stdout}`);
  assert.match(stdout, /runtime closure: \d+/, "the check did not state the closure size it used");
});
