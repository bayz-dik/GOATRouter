#!/usr/bin/env node
/**
 * Licence inventory — Phase 9K Task 3.
 *
 * The project licence is **Apache-2.0**, chosen by the repository owner. Two claims live here and
 * conflating them is how a licence claim becomes untrue:
 *
 *   1. **BAYZ's own licence, stated consistently.** A canonical `LICENSE` at the root, the same SPDX
 *      identifier in the root manifest and in all twelve workspace manifests. One package silently
 *      disagreeing is how a distributed tarball ends up lying.
 *   2. **Third-party licences, inventoried truthfully.** Read from `package-lock.json`, never
 *      rewritten. A package with no discoverable identifier is `UNKNOWN` and blocks if it ships.
 *
 * The document is **generated**, never hand-edited, so it cannot drift from the tree. A test asserts
 * that regenerating reproduces the committed bytes exactly.
 *
 * "Runtime" is the same closure walk the audit check and the SBOM use — `scripts/dependency-closure.mjs`.
 * A second idea of which packages ship is how a copyleft dependency gets triaged into the wrong bucket.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeClosure } from "./dependency-closure.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = join(ROOT, "docs/superpowers/2026-08-27-bayz-license-inventory.md");

export const PROJECT_LICENSE = "Apache-2.0";

/**
 * Permissive identifiers acceptable in the **runtime** closure.
 *
 * The plan's list, plus `BlueOak-1.0.0`, which is added deliberately and explained in the generated
 * document. Five runtime packages carry it (`glob@13`, `minimatch@10`, `minipass@7`, `path-scurry@2`,
 * `lru-cache@11`), all reached through the `@fastify/static@10` upgrade that 9K Task 1 made for a
 * high-severity advisory. It is a permissive, non-reciprocal, SPDX-registered licence with no
 * copyleft or source-disclosure obligation, so allowing it is truthful. Allowing it *silently* would
 * not be.
 */
export const ALLOWED_RUNTIME_LICENSES = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "CC0-1.0",
  "Unlicense",
  "BlueOak-1.0.0",
]);

/** The twelve workspaces. The plan said nine; `apps/*` and `packages/telemetry` were missed. */
export const WORKSPACES = [
  "packages/contracts",
  "packages/security",
  "packages/storage",
  "packages/telemetry",
  "packages/identity",
  "packages/capability",
  "packages/providers",
  "packages/proxy",
  "packages/gateway",
  "packages/router",
  "apps/server",
  "apps/dashboard",
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** `node_modules/a/node_modules/@scope/b` -> `@scope/b` */
function bareName(lockKey) {
  const segments = lockKey.split("node_modules/");
  return segments[segments.length - 1];
}

/**
 * Normalise a lockfile `license` value.
 *
 * npm records either a string, or an array/object for dual-licensed packages. An expression like
 * `(MIT OR Apache-2.0)` is kept verbatim rather than reduced — picking one side would be asserting a
 * choice the project has not made.
 */
export function normaliseLicense(value) {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (Array.isArray(value) && value.length > 0) {
    const parts = value.map((entry) => (typeof entry === "string" ? entry : entry?.type)).filter(Boolean);
    if (parts.length > 0) return `(${parts.join(" OR ")})`;
  }
  if (typeof value === "object" && value !== null && typeof value.type === "string") return value.type;
  return "UNKNOWN";
}

/**
 * Build the inventory from the lockfile.
 *
 * `options.injectViolation` exists only for `--simulate-violation`, which proves the gate can fail
 * without needing a genuinely copyleft dependency in the tree.
 */
export function buildInventory({ root = ROOT, injectViolation = false } = {}) {
  const lock = readJson(join(root, "package-lock.json"));
  const closure = computeClosure(lock);
  const runtime = new Set(closure.external);

  const packages = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === "" || entry.link === true) continue;
    if (!key.startsWith("node_modules/")) continue; // workspace definition, first-party
    packages.push({
      name: bareName(key),
      version: String(entry.version ?? "0.0.0"),
      license: normaliseLicense(entry.license),
      scope: runtime.has(key) ? "runtime" : "dev",
      // Where the identifier came from, so a claim can be checked rather than trusted.
      source: `package-lock.json:${key}`,
      path: key,
    });
  }

  if (injectViolation) {
    packages.push({
      name: "simulated-copyleft",
      version: "1.0.0",
      license: "AGPL-3.0",
      scope: "runtime",
      source: "--simulate-violation",
      path: "node_modules/simulated-copyleft",
    });
  }

  packages.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));

  const firstParty = WORKSPACES.map((workspace) => {
    const manifest = readJson(join(root, workspace, "package.json"));
    return {
      name: String(manifest.name),
      version: String(manifest.version),
      license: normaliseLicense(manifest.license),
      workspace,
      source: `${workspace}/package.json`,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  return {
    packages,
    firstParty,
    runtimeCount: packages.filter((entry) => entry.scope === "runtime").length,
    devCount: packages.filter((entry) => entry.scope === "dev").length,
  };
}

/**
 * Runtime packages whose licence is not acceptable: `UNKNOWN`, or outside the allowed set.
 *
 * Dev-only packages are never violations — twelve `lightningcss` builds carry `MPL-2.0` and none of
 * them ship.
 */
export function findViolations(inventory) {
  const violations = [];
  for (const entry of inventory.packages) {
    if (entry.scope !== "runtime") continue;
    if (entry.license === "UNKNOWN" || !ALLOWED_RUNTIME_LICENSES.has(entry.license)) {
      violations.push(entry);
    }
  }
  return violations;
}

/** Counts by identifier, for the summary tables. Sorted for a stable diff. */
function tally(packages, scope) {
  const counts = new Map();
  for (const entry of packages) {
    if (entry.scope !== scope) continue;
    counts.set(entry.license, (counts.get(entry.license) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * Render the document.
 *
 * No timestamp, no absolute path, no hostname: it is a published document, and both determinism and
 * information disclosure matter. Regeneration must be byte-identical.
 */
export function renderInventory(inventory) {
  const violations = findViolations(inventory);
  const lines = [];

  lines.push("# BAYZ licence inventory");
  lines.push("");
  lines.push("> **Generated file — do not edit.** Produced by `scripts/license-inventory.mjs` from");
  lines.push("> `package-lock.json` and the workspace manifests. Regenerate with");
  lines.push("> `node scripts/license-inventory.mjs`; `tests/license-inventory.test.mjs` asserts that a fresh");
  lines.push("> generation reproduces this file byte for byte, so it cannot drift from the tree.");
  lines.push("");
  lines.push(`Project licence: **${PROJECT_LICENSE}**, chosen by the repository owner (Phase 9K Task 3).`);
  lines.push("");
  lines.push("Third-party identifiers are read from the lockfile and reported as recorded. Nothing here");
  lines.push("rewrites a dependency's licence, and no compatibility is asserted on a dependency's behalf.");
  lines.push("");

  lines.push("## BAYZ's own packages");
  lines.push("");
  lines.push("| package | version | licence | declared in |");
  lines.push("|---|---|---|---|");
  for (const entry of inventory.firstParty) {
    lines.push(`| \`${entry.name}\` | ${entry.version} | ${entry.license} | \`${entry.source}\` |`);
  }
  lines.push("");
  lines.push("All twelve are `private: true` and are not published to npm; the identifier is stated so the");
  lines.push("release artifact's own claim is verifiable, and so no package silently disagrees with the root.");
  lines.push("");

  lines.push("## Runtime closure");
  lines.push("");
  lines.push(`${inventory.runtimeCount} packages actually ship. These are the ones whose terms bind a user.`);
  lines.push("");
  lines.push("| licence | packages |");
  lines.push("|---|---|");
  for (const [license, count] of tally(inventory.packages, "runtime")) {
    lines.push(`| ${license} | ${count} |`);
  }
  lines.push("");
  lines.push("Allowed identifiers in the runtime closure:");
  lines.push("");
  lines.push(`\`${[...ALLOWED_RUNTIME_LICENSES].sort().join("`, `")}\``);
  lines.push("");
  lines.push("`BlueOak-1.0.0` was **added to that list in 9K Task 3** and is worth stating plainly. Five");
  lines.push("runtime packages carry it — `glob`, `minimatch`, `minipass`, `path-scurry`, and `lru-cache` —");
  lines.push("all reached through the `@fastify/static@10` upgrade that 9K Task 1 made to close a");
  lines.push("high-severity advisory. It is a **permissive**, non-reciprocal, SPDX-registered licence on the");
  lines.push("Blue Oak Council's permissive list, with no copyleft and no source-disclosure obligation, so");
  lines.push("allowing it is truthful rather than convenient. It was not on the plan's original list because");
  lines.push("the plan predates that upgrade, and adding it silently would have hidden a real change.");
  lines.push("");

  lines.push("## Development-only closure");
  lines.push("");
  lines.push(`${inventory.devCount} packages are reachable only from \`devDependencies\` and never ship.`);
  lines.push("");
  lines.push("| licence | packages |");
  lines.push("|---|---|");
  for (const [license, count] of tally(inventory.packages, "dev")) {
    lines.push(`| ${license} | ${count} |`);
  }
  lines.push("");
  lines.push("`MPL-2.0` appears here on twelve `lightningcss` builds, reached through `vite`. MPL-2.0 is");
  lines.push("weak copyleft and is **not** allowed in the runtime closure; it is unproblematic here because");
  lines.push("these packages are build-time only and no part of them is distributed. The distinction is the");
  lines.push("reason this inventory labels scope at all.");
  lines.push("");

  lines.push("## Verdict");
  lines.push("");
  if (violations.length === 0) {
    lines.push("No `UNKNOWN` and no disallowed licence in the runtime closure.");
  } else {
    lines.push(`**${violations.length} runtime licence violation(s):**`);
    lines.push("");
    for (const entry of violations) {
      lines.push(`- \`${entry.name}@${entry.version}\` — ${entry.license} (${entry.source})`);
    }
  }
  lines.push("");

  lines.push("## Full runtime package list");
  lines.push("");
  lines.push("| package | version | licence |");
  lines.push("|---|---|---|");
  for (const entry of inventory.packages) {
    if (entry.scope !== "runtime") continue;
    lines.push(`| \`${entry.name}\` | ${entry.version} | ${entry.license} |`);
  }
  lines.push("");

  return `${lines.join("\n")}`;
}

function main(argv) {
  const injectViolation = argv.includes("--simulate-violation");
  const toStdout = argv.includes("--stdout");

  const inventory = buildInventory({ injectViolation });
  const document = renderInventory(inventory);

  if (toStdout) {
    process.stdout.write(document);
    return 0;
  }

  const violations = findViolations(inventory);

  // The document is only written for the real tree; a simulated run must not poison it.
  if (!injectViolation) {
    writeFileSync(OUT_PATH, document);
  }

  console.log("BAYZ licence inventory — Phase 9K Task 3");
  console.log(`  project licence: ${PROJECT_LICENSE}`);
  console.log(`  LICENSE file: ${existsSync(join(ROOT, "LICENSE")) ? "present" : "MISSING"}`);
  console.log(`  first-party packages: ${inventory.firstParty.length}, all declaring ${PROJECT_LICENSE}`);
  console.log(`  runtime closure: ${inventory.runtimeCount} packages`);
  console.log(`  dev-only: ${inventory.devCount} packages`);
  console.log("");

  for (const [license, count] of tally(inventory.packages, "runtime")) {
    console.log(`    runtime ${String(count).padStart(3)} × ${license}`);
  }
  console.log("");

  const disagreeing = inventory.firstParty.filter((entry) => entry.license !== PROJECT_LICENSE);
  if (disagreeing.length > 0) {
    for (const entry of disagreeing) {
      console.error(`  ${entry.workspace} declares ${entry.license}, not ${PROJECT_LICENSE}`);
    }
    console.error("licence inventory: FAIL");
    return 1;
  }

  if (violations.length > 0) {
    console.log(`  VIOLATIONS (${violations.length}):`);
    for (const entry of violations) {
      console.log(`    - ${entry.name}@${entry.version} — ${entry.license} (${entry.source})`);
    }
    console.log("");
    console.error("licence inventory: FAIL");
    return 1;
  }

  if (!injectViolation) console.log(`  written: docs/superpowers/2026-08-27-bayz-license-inventory.md`);
  console.log("");
  console.log("licence inventory: PASS");
  return 0;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
