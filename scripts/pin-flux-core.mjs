#!/usr/bin/env node
/**
 * Re-pin the Flux Core V2 visual lock — Phase 9L Task 5.
 *
 * The lock exists because Flux Core V2 is **visually LOCKED** by spec §18: its appearance is the
 * owner's decision, not an implementation detail, and the way a visual lock breaks is not a rewrite
 * but a small tasteful improvement nobody thought needed asking about. `tests/phase9-locks.test.mjs`
 * fails on any drift, and this script is the only sanctioned way to accept one.
 *
 * **Run this only alongside a documented bug fix.** Never to make a failing test pass, never for
 * polish, and never as part of "tidying up" — if the reason cannot be written down as a defect, the
 * correct action is to revert the change to the Flux files instead.
 *
 * Usage:
 *   node scripts/pin-flux-core.mjs --check    verify the pin, exit non-zero on drift (what CI wants)
 *   node scripts/pin-flux-core.mjs --write    rewrite the manifest from disk
 *
 * `--write` is not the default. A script whose bare invocation silently accepts whatever is on disk
 * is a lock with a bypass button, and the bypass is what gets pressed at 2am.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "docs/superpowers/flux-core-v2-manifest.json");

/** Recursive file walk restricted to the extensions that can change what a user sees. */
function walk(dir, extensions) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full, extensions));
    else if (extensions.some((extension) => entry.endsWith(extension))) found.push(full);
  }
  return found;
}

/**
 * The locked file set.
 *
 * Discovered from disk rather than listed, so a file added to `flux/` is covered the moment it
 * exists. The test pins the *set* as well as each hash, so an addition fails loudly instead of
 * sliding in under a still-matching manifest.
 */
export function lockedFiles() {
  const files = walk(join(ROOT, "apps/dashboard/src/flux"), [".ts", ".tsx", ".css"]).map((path) =>
    relative(ROOT, path).split("\\").join("/"),
  );
  const slot = "apps/dashboard/src/FluxCoreSlot.tsx";
  if (existsSync(join(ROOT, slot))) files.push(slot);
  return files.sort();
}

export function hashOf(relativePath) {
  return createHash("sha256").update(readFileSync(join(ROOT, relativePath))).digest("hex");
}

export function buildManifest() {
  const files = {};
  for (const path of lockedFiles()) files[path] = hashOf(path);
  return {
    lock: "Flux Core V2 visual lock (Phase 9 spec §18)",
    note: "Re-pin ONLY alongside a documented bug fix, never for polish. See scripts/pin-flux-core.mjs.",
    algorithm: "sha256",
    files,
  };
}

function main(argv) {
  const write = argv.includes("--write");
  const check = argv.includes("--check");
  if (write === check) {
    process.stderr.write("usage: node scripts/pin-flux-core.mjs (--check | --write)\n");
    return 2;
  }

  const current = buildManifest();

  if (write) {
    writeFileSync(MANIFEST, `${JSON.stringify(current, null, 2)}\n`);
    process.stdout.write(`pinned ${Object.keys(current.files).length} Flux Core V2 files\n`);
    return 0;
  }

  if (!existsSync(MANIFEST)) {
    process.stderr.write(`flux lock: no manifest at ${relative(ROOT, MANIFEST)}\n`);
    return 1;
  }
  const pinned = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const problems = [];
  for (const path of Object.keys(pinned.files)) {
    if (!existsSync(join(ROOT, path))) problems.push(`${path}: pinned but missing`);
    else if (hashOf(path) !== pinned.files[path]) problems.push(`${path}: changed`);
  }
  for (const path of Object.keys(current.files)) {
    if (!(path in pinned.files)) problems.push(`${path}: present but not pinned`);
  }

  if (problems.length > 0) {
    process.stderr.write(`flux lock: ${problems.length} problem(s)\n`);
    for (const problem of problems) process.stderr.write(`  ${problem}\n`);
    return 1;
  }
  process.stdout.write(`flux lock: ${Object.keys(pinned.files).length} files pinned and unchanged\n`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
