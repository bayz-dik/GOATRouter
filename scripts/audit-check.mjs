#!/usr/bin/env node
/**
 * Vulnerability audit against a written acceptance policy — Phase 9K Task 1.
 *
 * Policy: `docs/superpowers/2026-08-27-bayz-supply-chain-policy.md`.
 *
 * Three decisions are worth stating because they are what make this a gate rather than a ritual:
 *
 *   1. **"Runtime" has one definition repo-wide.** The closure comes from
 *      `scripts/dependency-closure.mjs`, the same walk the SBOM and the licence inventory use. A
 *      second, subtly different idea of which packages ship is how a real advisory gets triaged into
 *      the wrong bucket.
 *   2. **Dev-only findings never block.** `vite` alone reaches 53 platform-restricted and 2
 *      install-scripted packages, none of which ship. Blocking on those would train the operator to
 *      ignore red.
 *   3. **An unreachable registry exits 0 as `UNVERIFIED`.** A gate that cannot distinguish "clean"
 *      from "unknown" is worse than no gate, because it teaches its operator that red means "retry on
 *      better wifi". `UNVERIFIED` is reported as its own state and never counted as a pass.
 *
 * Uses `execFile` with an argument array, never a shell string, per the 9J portability rules.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeClosure } from "./dependency-closure.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const BLOCKING_SEVERITIES = new Set(["critical", "high"]);
const RECORDED_SEVERITIES = new Set(["moderate", "low"]);

/**
 * Normalise `npm audit --json` into `{ unverified, findings }`.
 *
 * Anything that is not a recognisable report — an error object, undefined, a missing
 * `vulnerabilities` map — is `unverified`. It is deliberately *not* treated as an empty report: an
 * empty report means "clean", and mistaking "I could not look" for "there is nothing there" is the
 * exact failure this whole script is shaped around.
 */
export function parseAudit(report) {
  if (report === undefined || report === null || typeof report !== "object") {
    return { unverified: true, reason: "audit output was not parseable JSON", findings: [] };
  }
  if (report.error !== undefined) {
    const summary = typeof report.error === "object" ? (report.error.summary ?? report.error.code) : report.error;
    return { unverified: true, reason: String(summary), findings: [] };
  }
  if (typeof report.vulnerabilities !== "object" || report.vulnerabilities === null) {
    return { unverified: true, reason: "audit output carried no vulnerabilities map", findings: [] };
  }

  const findings = [];
  for (const [name, entry] of Object.entries(report.vulnerabilities)) {
    const advisories = (Array.isArray(entry.via) ? entry.via : [])
      .filter((via) => typeof via === "object" && via !== null)
      .map((via) => ({
        title: String(via.title ?? "(untitled advisory)"),
        severity: String(via.severity ?? entry.severity),
        url: String(via.url ?? ""),
        range: String(via.range ?? entry.range ?? ""),
      }));
    findings.push({
      name,
      severity: String(entry.severity),
      range: String(entry.range ?? ""),
      direct: entry.isDirect === true,
      fixAvailable: entry.fixAvailable ?? false,
      advisories,
    });
  }
  return { unverified: false, reason: undefined, findings };
}

/**
 * Apply the policy.
 *
 * `runtimePackages` is a set of bare package names in the runtime closure. A finding is blocking only
 * when it is both a blocking severity *and* in that set.
 */
export function classify(parsed, runtimePackages) {
  if (parsed.unverified) {
    return {
      unverified: true,
      reason: parsed.reason,
      blocking: [],
      recorded: [],
      devOnly: [],
      runtimeCount: runtimePackages.size,
      exitCode: 0,
    };
  }

  const blocking = [];
  const recorded = [];
  const devOnly = [];

  for (const finding of parsed.findings) {
    if (!runtimePackages.has(finding.name)) {
      devOnly.push(finding);
      continue;
    }
    if (BLOCKING_SEVERITIES.has(finding.severity)) {
      blocking.push(finding);
    } else if (RECORDED_SEVERITIES.has(finding.severity)) {
      recorded.push(finding);
    }
    // `info` in the runtime closure needs no action per the policy table.
  }

  return {
    unverified: false,
    reason: undefined,
    blocking,
    recorded,
    devOnly,
    runtimeCount: runtimePackages.size,
    exitCode: blocking.length > 0 ? 1 : 0,
  };
}

/** Render the verdict. Deterministic ordering so two runs can be diffed. */
export function summarise(verdict) {
  const lines = [];
  lines.push(`runtime closure: ${verdict.runtimeCount} packages`);

  if (verdict.unverified) {
    lines.push("audit: UNVERIFIED");
    lines.push("UNVERIFIED: audit requires registry access");
    lines.push(`  reason: ${verdict.reason}`);
    lines.push("This is not a pass. The supply-chain report records it as UNVERIFIED.");
    return lines.join("\n");
  }

  const byName = (a, b) => a.name.localeCompare(b.name);

  lines.push(`blocking (critical/high in the runtime closure): ${verdict.blocking.length}`);
  for (const finding of [...verdict.blocking].sort(byName)) {
    lines.push(`  BLOCK ${finding.name} ${finding.range} — ${finding.severity}`);
    for (const advisory of finding.advisories) lines.push(`        ${advisory.title} (${advisory.url})`);
  }

  lines.push(`recorded (moderate/low in the runtime closure): ${verdict.recorded.length}`);
  for (const finding of [...verdict.recorded].sort(byName)) {
    lines.push(`  NOTE  ${finding.name} ${finding.range} — ${finding.severity} (needs a policy entry with a review date)`);
  }

  lines.push(`dev-only (never ships, triaged separately): ${verdict.devOnly.length}`);
  for (const finding of [...verdict.devOnly].sort(byName)) {
    lines.push(`  dev   ${finding.name} ${finding.range} — ${finding.severity}`);
  }

  lines.push(verdict.blocking.length > 0 ? "audit: FAIL" : "audit: PASS");
  return lines.join("\n");
}

/** Bare package names in the runtime closure, from the shared closure walk. */
export function runtimeClosureNames() {
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  const closure = computeClosure(lock);
  const names = new Set();
  for (const path of closure.external) {
    // `node_modules/a/node_modules/@scope/b` -> `@scope/b`
    const segments = path.split("node_modules/");
    names.add(segments[segments.length - 1]);
  }
  return names;
}

/**
 * Run `npm audit --json`.
 *
 * `npm audit` exits non-zero when it finds anything, so a non-zero status is not an error — the JSON
 * on stdout is what matters. A genuine failure (no registry, no network) produces either an error
 * object in the JSON or unparseable output, and both land in `parseAudit` as `unverified`.
 */
function runAudit() {
  try {
    const stdout = execFileSync("npm", ["audit", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 32 << 20,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(stdout);
  } catch (error) {
    const stdout = typeof error.stdout === "string" ? error.stdout : "";
    if (stdout.trim().length > 0) {
      try {
        return JSON.parse(stdout);
      } catch {
        return { error: { code: "EPARSE", summary: "npm audit produced unparseable JSON" } };
      }
    }
    return {
      error: {
        code: error.code ?? "EAUDIT",
        summary: String(error.message ?? "npm audit could not be run").slice(0, 200),
      },
    };
  }
}

function main() {
  console.log("BAYZ vulnerability audit — Phase 9K Task 1");
  console.log("policy: docs/superpowers/2026-08-27-bayz-supply-chain-policy.md");
  console.log("");

  const verdict = classify(parseAudit(runAudit()), runtimeClosureNames());
  console.log(summarise(verdict));

  if (verdict.exitCode !== 0) {
    console.error("");
    console.error("A critical or high vulnerability is present in the runtime closure.");
    console.error("Fix it, or record a written exception in the policy document per its Exceptions section.");
  }
  return verdict.exitCode;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
