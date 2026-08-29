import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ALLOWED_RUNTIME_LICENSES, PROJECT_LICENSE, buildInventory, findViolations, normaliseLicense } from "../scripts/license-inventory.mjs";

/**
 * Licence inventory — Phase 9K Task 3.
 *
 * The project licence is **Apache-2.0**, chosen by the repository owner. Task 3's blocking decision is
 * therefore resolved and the inventory no longer records the repository's own licence as `UNKNOWN`.
 *
 * Two separate claims are tested, and conflating them is how a licence claim becomes untrue:
 *
 *   1. **BAYZ's own licence is stated consistently** — a `LICENSE` file at the root, the same SPDX
 *      identifier in the root manifest and in all twelve workspace manifests. One package silently
 *      disagreeing is exactly how a distributed tarball ends up making a false claim.
 *   2. **Third-party licences are inventoried truthfully** — read from the lockfile, never rewritten,
 *      with anything undiscoverable recorded as `UNKNOWN` and blocking if it ships.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts/license-inventory.mjs");
const INVENTORY_DOC = join(ROOT, "docs/superpowers/2026-08-27-bayz-license-inventory.md");
const LICENSE_FILE = join(ROOT, "LICENSE");

/** Every workspace that must agree on the identifier. Twelve, not the plan's nine. */
const WORKSPACES = [
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

function manifest(path) {
  return JSON.parse(readFileSync(join(ROOT, path, "package.json"), "utf8"));
}

test("the project licence is Apache-2.0", () => {
  assert.equal(PROJECT_LICENSE, "Apache-2.0");
});

test("a LICENSE file exists at the repository root and is the real Apache 2.0 text", () => {
  /*
   * Asserted by content, not just existence. A `LICENSE` file containing a placeholder or the wrong
   * licence body is worse than none: it makes a specific false promise to whoever downloads the
   * tarball. These three strings are load-bearing sentences of the canonical text.
   */
  assert.ok(existsSync(LICENSE_FILE), "LICENSE does not exist");
  const text = readFileSync(LICENSE_FILE, "utf8");
  assert.match(text, /Apache License\s*\n\s*Version 2\.0, January 2004/, "not the Apache 2.0 header");
  assert.match(text, /http:\/\/www\.apache\.org\/licenses\//, "missing the canonical licence URL");
  assert.match(text, /"AS IS" BASIS/, "missing the warranty disclaimer");
  assert.match(text, /9\. Accepting Warranty or Additional Liability/, "the text is truncated");
  // No unfilled template markers: the appendix placeholder must be either filled or removed.
  assert.ok(!/\[yyyy\]|\[name of copyright owner\]/.test(text), "the LICENSE still carries template placeholders");
});

test("the root manifest declares Apache-2.0", () => {
  assert.equal(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).license, PROJECT_LICENSE);
});

test("all twelve workspace manifests declare the same identifier", () => {
  /*
   * The plan said nine. There are twelve: ten `packages/*` plus `apps/server` and `apps/dashboard`.
   * Asserted per package with the name in the message, because "some package disagrees" is not
   * actionable.
   */
  for (const workspace of WORKSPACES) {
    assert.equal(manifest(workspace).license, PROJECT_LICENSE, `${workspace} does not declare ${PROJECT_LICENSE}`);
  }
  assert.equal(WORKSPACES.length, 12);
});

test("the inventory is generated and covers the full closure, runtime and dev labelled separately", () => {
  const inventory = buildInventory();
  assert.ok(inventory.packages.length > 200, `inventory too small: ${inventory.packages.length}`);

  const scopes = new Set(inventory.packages.map((entry) => entry.scope));
  assert.deepEqual([...scopes].sort(), ["dev", "runtime"], "packages are not labelled runtime/dev");

  for (const entry of inventory.packages) {
    assert.ok(entry.name.length > 0, "an entry has no name");
    assert.match(entry.version, /^\d/, `${entry.name} has no version`);
    assert.ok(entry.license.length > 0, `${entry.name} has no licence identifier`);
    // The plan requires the *source* of the identifier, so a claim can be checked rather than trusted.
    assert.ok(entry.source.length > 0, `${entry.name} does not record where its licence was read from`);
  }

  assert.equal(inventory.runtimeCount + inventory.devCount, inventory.packages.length);
});

test("the runtime closure carries no UNKNOWN licence", () => {
  // An UNKNOWN in the runtime closure is a distribution defect: the artifact ships code whose terms
  // nobody can state.
  const inventory = buildInventory();
  const unknown = inventory.packages.filter((entry) => entry.scope === "runtime" && entry.license === "UNKNOWN");
  assert.deepEqual(unknown.map((entry) => entry.name), [], "runtime packages with no discoverable licence");
});

test("every runtime licence is on the allowed list", () => {
  const violations = findViolations(buildInventory());
  assert.deepEqual(
    violations.map((violation) => `${violation.name}: ${violation.license}`),
    [],
    "runtime packages carry a licence outside the allowed set",
  );
});

test("the allowed set is permissive only, and copyleft in the runtime closure fails", () => {
  /*
   * The allowed set must not quietly grow to whatever happens to be in the tree. Copyleft identifiers
   * are asserted absent by name — MPL-2.0 in particular, because twelve `lightningcss` packages carry
   * it and they are dev-only. If one ever reached the runtime closure it must fail.
   */
  for (const copyleft of ["GPL-2.0", "GPL-3.0", "AGPL-3.0", "LGPL-3.0", "MPL-2.0", "SSPL-1.0"]) {
    assert.ok(!ALLOWED_RUNTIME_LICENSES.has(copyleft), `${copyleft} is on the allowed list`);
  }

  const synthetic = {
    packages: [
      { name: "evil-copyleft", version: "1.0.0", license: "AGPL-3.0", scope: "runtime", source: "synthetic" },
      { name: "fine-dev-copyleft", version: "1.0.0", license: "MPL-2.0", scope: "dev", source: "synthetic" },
      { name: "mystery", version: "1.0.0", license: "UNKNOWN", scope: "runtime", source: "synthetic" },
    ],
  };
  const violations = findViolations(synthetic);
  const names = violations.map((violation) => violation.name).sort();
  assert.deepEqual(names, ["evil-copyleft", "mystery"], `unexpected violations: ${JSON.stringify(violations)}`);
});

test("BlueOak-1.0.0 is on the allowed list, deliberately and with a written reason", () => {
  /*
   * **A real finding, recorded rather than smoothed over.**
   *
   * Five runtime packages carry `BlueOak-1.0.0`: `glob@13`, `minimatch@10`, `minipass@7`,
   * `path-scurry@2`, and `lru-cache@11` — all reached through `@fastify/static@10`, which 9K Task 1
   * upgraded to for a high-severity advisory.
   *
   * `BlueOak-1.0.0` is **not** in the plan's allowed set, because the plan was written before that
   * upgrade. It is a permissive, non-reciprocal, SPDX-registered licence on the Blue Oak Council's
   * permissive list, with no copyleft or source-disclosure obligation, so adding it is truthful rather
   * than convenient. Adding it silently would not be — hence this test and the inventory document's
   * own note.
   */
  assert.ok(ALLOWED_RUNTIME_LICENSES.has("BlueOak-1.0.0"));
  const doc = readFileSync(INVENTORY_DOC, "utf8");
  assert.match(doc, /BlueOak-1\.0\.0/, "the inventory does not mention BlueOak-1.0.0");
  assert.match(doc, /permissive/i, "the inventory does not justify BlueOak-1.0.0 as permissive");
});

test("an undiscoverable licence becomes UNKNOWN, never a guess", () => {
  /*
   * **This test exists because a mutation survived without it.** Replacing the `UNKNOWN` fallback with
   * `"MIT"` left the whole suite green: every package in this tree happens to record a licence, so
   * nothing exercised the fallback. A guessed identifier is the worst possible output here — it states
   * a legal fact nobody verified, and it does so invisibly, because `MIT` looks like every other row.
   *
   * The shapes are the ones npm actually produces: a missing field, an empty string, whitespace,
   * `null`, an empty array, and a malformed object.
   */
  for (const value of [undefined, null, "", "   ", {}, { notAType: "MIT" }, []]) {
    assert.equal(
      normaliseLicense(value),
      "UNKNOWN",
      `${JSON.stringify(value)} was resolved to a licence identifier instead of UNKNOWN`,
    );
  }

  // A recorded identifier passes through verbatim, and a dual licence stays an expression rather than
  // being reduced — picking one side would assert a choice the project has not made.
  assert.equal(normaliseLicense("MIT"), "MIT");
  assert.equal(normaliseLicense("  Apache-2.0  "), "Apache-2.0");
  assert.equal(normaliseLicense(["MIT", "Apache-2.0"]), "(MIT OR Apache-2.0)");
  assert.equal(normaliseLicense({ type: "ISC" }), "ISC");
});

test("an UNKNOWN runtime licence blocks even though the real tree has none", () => {
  // Paired with the above: `UNKNOWN` must not merely be produced, it must fail the gate.
  const violations = findViolations({
    packages: [{ name: "mystery", version: "1.0.0", license: "UNKNOWN", scope: "runtime", source: "synthetic" }],
  });
  assert.equal(violations.length, 1, "an UNKNOWN runtime licence did not block");
});

test("the twelve BAYZ workspaces appear as first-party, not as registry dependencies", () => {
  // A workspace listed as a third-party dependency would imply it was fetched from npm, which is a
  // false provenance claim about first-party code.
  const inventory = buildInventory();
  const first = inventory.firstParty.map((entry) => entry.name).sort();
  assert.equal(first.length, 12, `expected 12 first-party packages, got ${first.length}`);
  for (const entry of inventory.firstParty) {
    assert.equal(entry.license, PROJECT_LICENSE, `${entry.name} is first-party but not ${PROJECT_LICENSE}`);
  }
  for (const entry of inventory.packages) {
    assert.ok(!entry.name.startsWith("@bayz/"), `${entry.name} is listed as a third-party dependency`);
  }
});

test("the inventory document is generated, not hand-maintained, so it cannot drift", () => {
  /*
   * Regenerating must reproduce the committed document byte for byte. If it does not, the committed
   * copy is stale and its claims are about a tree that no longer exists.
   */
  const committed = readFileSync(INVENTORY_DOC, "utf8");
  const regenerated = execFileSync(process.execPath, [SCRIPT, "--stdout"], { encoding: "utf8" });
  assert.equal(regenerated, committed, "the committed inventory differs from a fresh generation");
  assert.match(committed, /Produced by `scripts\/license-inventory\.mjs`/, "the document does not say it is generated");
  assert.match(committed, /do not edit/i, "the document does not warn against hand-editing");
});

test("the inventory records no build-machine path, username, or hostname", () => {
  // It is a published document; leaking the build machine's layout is an information disclosure.
  const doc = readFileSync(INVENTORY_DOC, "utf8");
  assert.ok(!doc.includes(ROOT), "the inventory leaks the repository's absolute path");
  assert.ok(!/\/(home|Users)\//.test(doc), "the inventory leaks a home directory path");
  assert.ok(!/\/root\//.test(doc), "the inventory leaks /root");
});

test("the script exits 0 on the real tree and non-zero on a synthetic violation", () => {
  const stdout = execFileSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.match(stdout, /licence inventory: PASS/, stdout);
  assert.match(stdout, new RegExp(`project licence: ${PROJECT_LICENSE}`), "the script does not state the project licence");

  // The gate must be able to fail. `--simulate-violation` injects one runtime AGPL package.
  let status = 0;
  let output = "";
  try {
    output = execFileSync(process.execPath, [SCRIPT, "--simulate-violation"], { encoding: "utf8" });
  } catch (error) {
    status = error.status ?? 1;
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  assert.equal(status, 1, `the simulated violation did not fail the gate: ${output}`);
  assert.match(output, /licence inventory: FAIL/, output);
});
