#!/usr/bin/env node
/**
 * Release verification — Phase 9K Task 5.
 *
 * Verifies a release directory against its `SHA256SUMS` manifest, and the manifest against a detached
 * signature when one is present.
 *
 * **The distinction this script exists to preserve: unsigned is not the same as forged.**
 *
 *   - no signature file            -> `UNVERIFIED: no signature present`, exit **0**
 *   - signature present and valid  -> `signature: VERIFIED`, exit 0
 *   - signature present and bad    -> `signature: INVALID`, exit **1**
 *
 * If those collapsed into one outcome, an attacker who strips a signature would get the same treatment
 * as an honest local build — precisely the confusion signing exists to prevent. A local BAYZ build on
 * this Termux host is unsigned, and that is a normal, reportable state; a *bad* signature never is.
 *
 * Digest checking runs first and independently, because it needs no key and no tool. A digest mismatch
 * is a failure on its own: the signature covers the manifest, so the manifest must still be checked
 * against the actual bytes on disk. Signing a manifest that does not pin the payload would let someone
 * swap the artifact and keep a valid signature.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DIGEST_MANIFEST, parseManifest } from "./sign-release.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Is `tool` runnable? A missing tool becomes `UNVERIFIED`, never `INVALID`. */
function toolAvailable(tool) {
  try {
    execFileSync(tool, ["version"], { stdio: "ignore" });
    return true;
  } catch (error) {
    return error.code !== "ENOENT";
  }
}

function main(argv) {
  const flag = (name, fallback) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1];
  };

  const dir = resolve(flag("--dir", join(ROOT, "packaging/out")));
  const pubkey = flag("--pubkey", undefined);
  const tool = flag("--tool", "openssl");

  console.log("BAYZ release verification — Phase 9K Task 5");
  console.log(`  release directory: ${relative(ROOT, dir) || dir}`);
  console.log("");

  const manifestPath = join(dir, DIGEST_MANIFEST);
  if (!existsSync(manifestPath)) {
    console.error(`  ${DIGEST_MANIFEST} is missing — nothing to verify against`);
    console.error("verify-release: FAIL");
    return 1;
  }

  let entries;
  try {
    entries = parseManifest(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    console.error(`  ${DIGEST_MANIFEST} is malformed: ${error.message}`);
    console.error("verify-release: FAIL");
    return 1;
  }

  /*
   * Digests first. This half is deliberately independent of signing: it needs no key, no tool, and no
   * network, and it is what a user can reproduce with `sha256sum -c SHA256SUMS`.
   */
  const problems = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (!existsSync(path)) {
      problems.push(`missing: ${entry.name} is named in the manifest but absent from the directory`);
      continue;
    }
    const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (actual !== entry.digest) {
      problems.push(`digest mismatch: ${entry.name}\n      manifest: ${entry.digest}\n      actual:   ${actual}`);
      continue;
    }
    console.log(`  ok  ${entry.digest.slice(0, 16)}… ${entry.name}`);
  }
  console.log("");

  for (const problem of problems) console.log(`  FAIL  ${problem}`);
  if (problems.length > 0) console.log("");

  /*
   * The signature half. Absent is reported as `UNVERIFIED` and does not by itself fail; present and
   * bad is `INVALID` and always fails.
   */
  const sigPath = `${manifestPath}.sig`;
  let signatureFailed = false;

  if (!existsSync(sigPath)) {
    console.log("UNVERIFIED: no signature present");
    console.log("  The digests above were checked; the artifact is unsigned.");
    console.log("  Local BAYZ builds are unsigned by design. Hosted releases are signed keylessly");
    console.log("  through GitHub OIDC — see docs/release-verification.md.");
  } else if (pubkey === undefined) {
    console.log("UNVERIFIED: a signature is present but no --pubkey was supplied");
    console.log("  Cannot decide whether it is valid, so no claim is made either way.");
  } else if (!toolAvailable(tool)) {
    console.log(`UNVERIFIED: ${tool} not available, cannot check the signature`);
  } else {
    try {
      execFileSync(
        tool,
        ["pkeyutl", "-verify", "-pubin", "-inkey", pubkey, "-rawin", "-in", manifestPath, "-sigfile", sigPath],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      console.log("  signature: VERIFIED");
    } catch {
      // Reached whenever openssl exits non-zero: a forged, truncated, or wrong-key signature.
      console.log("  signature: INVALID");
      console.log("    A signature file exists and does not verify against the supplied key.");
      console.log("    This is NOT the same as an unsigned build. Do not install this artifact.");
      signatureFailed = true;
    }
  }
  console.log("");

  if (problems.length > 0 || signatureFailed) {
    console.error("verify-release: FAIL");
    return 1;
  }

  console.log(`verify-release: PASS (${entries.length} file(s) match the manifest)`);
  return 0;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
