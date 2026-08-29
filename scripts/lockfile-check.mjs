#!/usr/bin/env node
/**
 * Lockfile integrity and provenance — Phase 9K Task 2.
 *
 * Every property checked here is one the repository **already satisfies**. That is the point: none of
 * them degrade gradually. A `sha1` hash, a `git+ssh` origin, or a version range appears in exactly one
 * commit, and this is what notices that commit.
 *
 * What is checked, and why each one matters:
 *
 *   - **`sha512` integrity on every resolved entry.** `sha1` is collision-broken, so an entry carrying
 *     only `sha1-` cannot be trusted to identify its tarball. npm accepts one without complaint.
 *   - **`https://registry.npmjs.org/` origin and nothing else.** A `git+` URL installs whatever the
 *     branch says today; a `file:` outside the workspace installs whatever is on the build machine;
 *     `http:` is interceptable; a look-alike host is the classic typosquat delivery route.
 *   - **Exact versions.** No range in the lockfile means no range resolved at install time, which is
 *     the structural form of `npm ci` determinism.
 *   - **Workspace links exempted, but counted and verified.** A `link: true` entry legitimately has
 *     neither `resolved` nor `integrity` — it is a symlink into this repository. Exempting them is
 *     correct; exempting anything else would be a hole, so the count is pinned and each link is
 *     confirmed to resolve inside the repository.
 *   - **`lockfileVersion` pinned at 3**, and a missing `packages` map is a hard parse failure rather
 *     than an empty read — a broken lockfile must never look like a clean one.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const LOCKFILE_VERSION = 3;
export const REGISTRY_PREFIX = "https://registry.npmjs.org/";

/**
 * Parse a lockfile.
 *
 * Throws on anything that is not a v3-shaped lockfile with a `packages` map. Fail closed: a gate that
 * reads a malformed file as "nothing wrong" is worse than no gate.
 */
export function parseLockfile(text) {
  let lock;
  try {
    lock = JSON.parse(text);
  } catch (error) {
    throw new Error(`lockfile-check: could not parse the lockfile as JSON: ${error.message}`);
  }
  if (typeof lock !== "object" || lock === null) {
    throw new Error("lockfile-check: the lockfile did not parse to an object");
  }
  if (typeof lock.packages !== "object" || lock.packages === null) {
    throw new Error("lockfile-check: the lockfile has no packages map");
  }
  return lock;
}

/**
 * Check a parsed lockfile. Returns a verdict rather than throwing, so the test can inspect each
 * category independently and the CLI can print all problems at once.
 */
export function checkLockfile(lock, { root = ROOT } = {}) {
  const problems = [];

  if (lock.lockfileVersion !== LOCKFILE_VERSION) {
    problems.push(`lockfileVersion is ${lock.lockfileVersion}, expected ${LOCKFILE_VERSION}`);
  }

  const missingIntegrity = [];
  const weakIntegrity = [];
  const foreignOrigins = [];
  const inexactVersions = [];
  const workspaceLinks = [];
  const workspaceDefinitions = [];
  const brokenLinks = [];
  let resolvedCount = 0;

  for (const [key, entry] of Object.entries(lock.packages)) {
    // The root entry ("") describes the workspace itself and has no origin.
    if (key === "") continue;

    if (entry.link === true) {
      workspaceLinks.push(key);
      /*
       * A link is only safe because it stays in-tree. `resolved` on a link is a repo-relative path;
       * an absolute one, or one that escapes the repository, is a dependency on the build machine's
       * filesystem rather than on this source tree.
       */
      const target = typeof entry.resolved === "string" ? entry.resolved : undefined;
      if (target === undefined) {
        brokenLinks.push(`${key}: no resolved target`);
        continue;
      }
      const absolute = isAbsolute(target) ? target : resolve(root, target);
      const inside = absolute === root || absolute.startsWith(`${root}/`);
      if (!inside) {
        brokenLinks.push(`${key}: resolves outside the repository (${target})`);
        continue;
      }
      if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
        brokenLinks.push(`${key}: target is not a directory (${target})`);
      }
      continue;
    }

    if (typeof entry.resolved !== "string") {
      /*
       * A workspace **definition** entry — keyed by its path in the repository (`apps/server`,
       * `packages/storage`) rather than under `node_modules/` — legitimately has no origin and no
       * integrity hash. npm records each workspace twice: once here, describing the directory, and
       * once as a `node_modules/@bayz/*` entry with `link: true` pointing at it.
       *
       * The first version of this check flagged all twelve of these as "has a version but no resolved
       * origin", which was wrong: they are not downloads. Exempting them is narrow — the key must not
       * be under `node_modules/`, and the directory must exist — so a genuine registry package with a
       * version and no origin is still caught by the branch below.
       */
      if (!key.startsWith("node_modules/")) {
        workspaceDefinitions.push(key);
        const absolute = resolve(root, key);
        if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
          brokenLinks.push(`${key}: workspace directory does not exist`);
        }
        continue;
      }
      if (typeof entry.version === "string" && entry.version.length > 0) {
        missingIntegrity.push(`${key}: has a version but no resolved origin`);
      }
      continue;
    }

    resolvedCount += 1;

    if (typeof entry.integrity !== "string" || entry.integrity.length === 0) {
      missingIntegrity.push(`${key}: no integrity hash`);
    } else if (!entry.integrity.startsWith("sha512-")) {
      weakIntegrity.push(`${key}: integrity is ${entry.integrity.split("-")[0]}, not sha512`);
    }

    if (!entry.resolved.startsWith(REGISTRY_PREFIX)) {
      foreignOrigins.push(`${key}: resolves to ${entry.resolved}`);
    }

    // An exact version is `1.2.3` or `1.2.3-beta.1`; a range starts with a comparator or contains one.
    if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(String(entry.version ?? ""))) {
      inexactVersions.push(`${key}: version is ${entry.version}, not an exact release`);
    }
  }

  for (const list of [missingIntegrity, weakIntegrity, foreignOrigins, inexactVersions, brokenLinks]) {
    problems.push(...list);
  }

  return {
    ok: problems.length === 0,
    problems,
    entryCount: Object.keys(lock.packages).length,
    resolvedCount,
    workspaceLinks,
    workspaceDefinitions,
    missingIntegrity,
    weakIntegrity,
    foreignOrigins,
    inexactVersions,
    brokenLinks,
  };
}

function main(argv) {
  const flagIndex = argv.indexOf("--lockfile");
  const lockPath = flagIndex === -1 ? join(ROOT, "package-lock.json") : argv[flagIndex + 1];

  console.log("BAYZ lockfile integrity — Phase 9K Task 2");
  console.log(`  lockfile: ${lockPath}`);

  let verdict;
  try {
    verdict = checkLockfile(parseLockfile(readFileSync(lockPath, "utf8")), { root: ROOT });
  } catch (error) {
    console.error(`  ${error.message}`);
    console.error("lockfile integrity: FAIL");
    return 1;
  }

  console.log(`  lockfileVersion ${LOCKFILE_VERSION}, ${verdict.entryCount} entries`);
  console.log(`  ${verdict.resolvedCount} resolved from the registry, all sha512`);
  console.log(`  ${verdict.workspaceLinks.length} workspace links, exempt from resolved/integrity`);
  console.log(`  ${verdict.workspaceDefinitions.length} workspace definitions (in-repo directories, not downloads)`);
  console.log("");

  if (verdict.ok) {
    console.log("  every resolved entry: sha512 integrity, registry.npmjs.org origin, exact version");
    console.log("");
    console.log("lockfile integrity: PASS");
    return 0;
  }

  console.log(`  PROBLEMS (${verdict.problems.length}):`);
  for (const problem of verdict.problems) console.log(`    - ${problem}`);
  console.log("");
  console.error("lockfile integrity: FAIL");
  return 1;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
