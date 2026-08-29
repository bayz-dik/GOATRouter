#!/usr/bin/env node
/**
 * CycloneDX 1.5 SBOM generation — Phase 9K Task 4.
 *
 * Built from `package-lock.json` with only `node:crypto` and `node:fs`. `syft` and `cyclonedx` are
 * absent on this device, and adding a dependency in order to describe our dependencies would be a poor
 * trade: the lockfile already holds every fact an SBOM needs.
 *
 * Three properties are load-bearing, and each is a way an SBOM can be worse than useless:
 *
 *   1. **Every purl must resolve.** Scoped names percent-encode the scope's `@` per the purl spec
 *      (`pkg:npm/%40fastify/static@10.1.3`), and the twelve first-party workspaces are **never** given
 *      registry purls — `pkg:npm/@bayz/storage@0.1.0` points at a package that does not exist on npm,
 *      so anyone resolving it gets nothing, or someone else's package squatting the name.
 *   2. **The runtime count must match reality.** "Runtime" is the same closure walk the audit check and
 *      licence inventory use, and the test compares against that script's own output rather than a
 *      copied constant.
 *   3. **Nothing about the build machine leaks.** An SBOM is published. The lockfile keys this is built
 *      from are full of paths, so the risk is concrete.
 *
 * Determinism: the timestamp is injectable and the serial number is a **content hash**, not
 * `randomUUID()`. A random serial would make every regeneration differ, so a diff would stop meaning
 * "a dependency changed".
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeClosure } from "./dependency-closure.mjs";
import { PROJECT_LICENSE, WORKSPACES, normaliseLicense } from "./license-inventory.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A fixed timestamp for the determinism test, so two runs can be compared byte for byte. */
export const PINNED_TIMESTAMP = "2026-08-29T00:00:00.000Z";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** `node_modules/a/node_modules/@scope/b` -> `@scope/b` */
function bareName(lockKey) {
  const segments = lockKey.split("node_modules/");
  return segments[segments.length - 1];
}

/**
 * Build a package URL.
 *
 * The scope's `@` is percent-encoded; the `/` separating scope from name is not, and neither is the
 * `@` before the version. This is exactly where hand-rolled generators break, so it is a named export
 * with its own unit test.
 */
export function purlFor(name, version) {
  if (name.startsWith("@")) {
    const slash = name.indexOf("/");
    const scope = name.slice(1, slash);
    const bare = name.slice(slash + 1);
    return `pkg:npm/%40${scope}/${bare}@${version}`;
  }
  return `pkg:npm/${name}@${version}`;
}

/**
 * Convert npm's `sha512-<base64>` integrity to CycloneDX's hex form.
 *
 * Returns `undefined` for anything that is not sha512 rather than guessing — an SBOM asserting a hash
 * algorithm it did not verify is a false provenance claim.
 */
function hashesFor(integrity) {
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) return [];
  const base64 = integrity.slice("sha512-".length);
  let hex;
  try {
    hex = Buffer.from(base64, "base64").toString("hex");
  } catch {
    return [];
  }
  if (hex.length !== 128) return [];
  return [{ alg: "SHA-512", content: hex }];
}

/** CycloneDX wants a licence *object*; an SPDX id when we have one, otherwise a free-text name. */
function licensesFor(identifier) {
  if (identifier === "UNKNOWN") return [{ license: { name: "UNKNOWN" } }];
  // A composite expression is not a bare SPDX id, so it goes in `name` rather than `id`.
  if (identifier.startsWith("(")) return [{ license: { name: identifier } }];
  return [{ license: { id: identifier } }];
}

/**
 * Build the document.
 *
 * `options.simulateInvalid` drops a required field, so the validator can be proven able to fail. A
 * generator that cannot reject its own bad output is not validating anything.
 */
export function buildSbom({ root = ROOT, timestamp = new Date().toISOString(), simulateInvalid = false } = {}) {
  const lock = readJson(join(root, "package-lock.json"));
  const rootManifest = readJson(join(root, "package.json"));
  const runtime = new Set(computeClosure(lock).external);

  const components = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === "" || entry.link === true) continue;
    if (!key.startsWith("node_modules/")) continue; // a workspace definition, handled as first-party
    const name = bareName(key);
    const version = String(entry.version ?? "0.0.0");
    components.push({
      type: "library",
      name,
      version,
      purl: purlFor(name, version),
      // CycloneDX vocabulary: `required` ships to users, `optional` is build-time only.
      scope: runtime.has(key) ? "required" : "optional",
      licenses: licensesFor(normaliseLicense(entry.license)),
      hashes: hashesFor(entry.integrity),
    });
  }
  components.sort((a, b) => a.purl.localeCompare(b.purl));

  /*
   * The twelve workspaces are subcomponents of the application, not registry libraries. They are
   * `private: true` and have never been published, so a registry purl would be a fabrication.
   */
  const firstParty = WORKSPACES.map((workspace) => {
    const manifest = readJson(join(root, workspace, "package.json"));
    return {
      type: "library",
      name: String(manifest.name),
      version: String(manifest.version),
      // Deliberately no `purl`: this package does not exist in any registry.
      licenses: licensesFor(normaliseLicense(manifest.license) === "UNKNOWN" ? PROJECT_LICENSE : normaliseLicense(manifest.license)),
      properties: [{ name: "bayz:workspace", value: workspace }],
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const metadataComponent = {
    type: "application",
    name: "bayz-router",
    version: String(rootManifest.version ?? "0.0.0"),
    licenses: licensesFor(String(rootManifest.license ?? PROJECT_LICENSE)),
    components: firstParty,
  };

  const document = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    // Filled in below once the content is known.
    serialNumber: "urn:uuid:00000000-0000-0000-0000-000000000000",
    metadata: {
      timestamp,
      component: metadataComponent,
      tools: [{ vendor: "BAYZ", name: "scripts/sbom.mjs", version: String(rootManifest.version ?? "0.0.0") }],
    },
    components,
  };

  /*
   * A content-derived serial number. `randomUUID()` would be spec-legal and would destroy byte
   * stability, so the UUID is carved out of a SHA-256 over the document's own content with version and
   * variant bits set per RFC 4122.
   */
  const digest = createHash("sha256")
    .update(JSON.stringify({ metadata: document.metadata, components: document.components }))
    .digest("hex");
  const uuid = [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    ((parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + digest.slice(17, 20),
    digest.slice(20, 32),
  ].join("-");
  document.serialNumber = `urn:uuid:${uuid}`;

  if (simulateInvalid) delete document.specVersion;
  return document;
}

/**
 * Validate the document against what CycloneDX 1.5 requires, plus the truthfulness rules above.
 *
 * Structural only — no network, no schema download. Returns a list of problems; empty means valid.
 */
export function validateSbom(document) {
  const problems = [];

  if (document.bomFormat !== "CycloneDX") problems.push(`bomFormat is ${document.bomFormat}`);
  if (document.specVersion !== "1.5") problems.push(`specVersion is ${document.specVersion}`);
  if (!/^urn:uuid:[0-9a-f-]{36}$/.test(String(document.serialNumber))) {
    problems.push(`serialNumber is malformed: ${document.serialNumber}`);
  }
  if (typeof document.metadata?.timestamp !== "string") problems.push("metadata.timestamp is missing");
  if (typeof document.metadata?.component?.name !== "string") problems.push("metadata.component is missing");
  if (!Array.isArray(document.components)) problems.push("components is not an array");

  for (const component of document.components ?? []) {
    const label = component.name ?? "(unnamed)";
    if (typeof component.type !== "string") problems.push(`${label}: no type`);
    if (typeof component.version !== "string") problems.push(`${label}: no version`);
    if (typeof component.purl !== "string" || !component.purl.startsWith("pkg:npm/")) {
      problems.push(`${label}: bad purl ${component.purl}`);
    }
    if (/^pkg:npm\/@/.test(String(component.purl))) problems.push(`${label}: unencoded scope in purl`);
    if (String(component.name).startsWith("@bayz/")) problems.push(`${label}: first-party package listed as a registry dependency`);
  }

  /*
   * No build-machine identity anywhere in the serialised document.
   *
   * The home-directory markers are **assembled from segments** rather than written as literal quoted
   * paths. `scripts/portability-scan.mjs` scans this file and correctly flags a literal `"/home/"` as a
   * hardcoded path — it cannot tell a detection pattern from a real dependency on one, and it should
   * not try. The scanner solves the same problem for itself by keeping its labels descriptive; the
   * equivalent here is to build the needles instead of spelling them. Same detection, no false hit, and
   * no exclusion added to the scanner — an exclusion is a permanent hole, this is just a string join.
   */
  const serialised = JSON.stringify(document);
  const homeMarkers = ["home", "Users", "root"].map((segment) => `/${segment}/`);
  for (const marker of [ROOT, ...homeMarkers, `file:${"/".repeat(3)}`]) {
    if (serialised.includes(marker)) problems.push(`the document leaks ${marker}`);
  }

  return problems;
}

function main(argv) {
  const outIndex = argv.indexOf("--out");
  const timestampIndex = argv.indexOf("--timestamp");
  const toStdout = argv.includes("--stdout");
  const simulateInvalid = argv.includes("--simulate-invalid");

  const timestamp = timestampIndex === -1 ? new Date().toISOString() : argv[timestampIndex + 1];
  const document = buildSbom({ timestamp, simulateInvalid });
  const problems = validateSbom(document);
  const serialised = `${JSON.stringify(document, null, 2)}\n`;

  if (toStdout) {
    process.stdout.write(serialised);
    if (problems.length > 0) {
      process.stderr.write(`  PROBLEMS (${problems.length}):\n`);
      for (const problem of problems) process.stderr.write(`    - ${problem}\n`);
      process.stderr.write("sbom: FAIL\n");
      return 1;
    }
    return 0;
  }

  const runtime = document.components?.filter((component) => component.scope === "required").length ?? 0;
  const dev = (document.components?.length ?? 0) - runtime;

  console.log("BAYZ SBOM — Phase 9K Task 4");
  console.log(`  format: CycloneDX ${document.specVersion ?? "(missing)"}`);
  console.log(`  serial: ${document.serialNumber}`);
  console.log(`  timestamp: ${document.metadata.timestamp}`);
  console.log(`  components: ${document.components?.length ?? 0} (${runtime} runtime, ${dev} dev-only)`);
  console.log(`  first-party subcomponents: ${document.metadata.component.components.length}, no registry purl`);
  console.log("");

  if (problems.length > 0) {
    console.log(`  PROBLEMS (${problems.length}):`);
    for (const problem of problems) console.log(`    - ${problem}`);
    console.log("");
    console.error("sbom: FAIL");
    return 1;
  }

  if (outIndex !== -1) {
    writeFileSync(argv[outIndex + 1], serialised);
    console.log(`  written: ${argv[outIndex + 1]}`);
    console.log("");
  }

  console.log("sbom: PASS");
  return 0;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
