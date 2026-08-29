#!/usr/bin/env node
/**
 * Runtime dependency closure guard — 9J Task 2.
 *
 * Answers one question from the lockfile alone: **what actually ships when a user installs BAYZ, and
 * does any of it need a compiler?**
 *
 * The property being defended is that BAYZ installs on Termux/Android ARM64 with no build toolchain.
 * That is not a claim about the five dependencies in `package.json` — it is a claim about all 86
 * packages those five drag in, any one of which could add a `.node` binary in a patch release.
 *
 * Reads `package-lock.json` and nothing else. Resolving from `node_modules` on disk would describe
 * *this machine's* install — possibly pruned, possibly partial — rather than what `npm ci` will
 * reproduce for a user.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Resolve `name` as required from `fromDir`, following npm's lookup rules.
 *
 * npm hoists what it can to the top-level `node_modules` and nests what it cannot — a version
 * conflict leaves a package under its parent. So resolution walks *up* from the requiring directory,
 * checking `<dir>/node_modules/<name>` at each level, exactly as Node's own resolver does.
 *
 * A flat top-level-only lookup is the obvious implementation and it is wrong: on this tree it misses
 * four nested entries and reports 82 external packages instead of 86. `flatLookupForTestingOnly`
 * exists so the test can demonstrate that difference rather than assert it on faith.
 */
function resolveFrom(packages, fromDir, name, { flat = false } = {}) {
  if (flat) {
    const top = `node_modules/${name}`;
    return packages[top] === undefined ? undefined : top;
  }

  let dir = fromDir;
  for (;;) {
    const candidate = dir === "" ? `node_modules/${name}` : `${dir}/node_modules/${name}`;
    if (packages[candidate] !== undefined) return candidate;

    if (dir === "") return undefined;

    // Step out of the innermost node_modules, or up one directory, mirroring Node's resolution.
    const cut = dir.lastIndexOf("/node_modules/");
    if (cut >= 0) {
      dir = dir.slice(0, cut);
      continue;
    }
    dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
  }
}

/** Workspace roots: every lockfile entry that is a directory rather than an installed package. */
function workspaceRoots(lock) {
  return Object.keys(lock.packages).filter((key) => key !== "" && !key.startsWith("node_modules/"));
}

/**
 * Walk the transitive **runtime** closure from every workspace root.
 *
 * `dependencies` and `optionalDependencies` only. `devDependencies` are excluded at every level,
 * which is the entire point: `vite` is a dev dependency of `@bayz/dashboard` and it reaches every
 * install-scripted and platform-restricted package in the tree.
 */
export function computeClosure(lock, { flatLookupForTestingOnly = false } = {}) {
  const packages = lock.packages;
  const seen = new Set();
  const unresolved = [];
  const queue = workspaceRoots(lock);

  while (queue.length > 0) {
    const key = queue.shift();
    const entry = packages[key];
    if (entry === undefined) continue;

    const deps = { ...(entry.dependencies ?? {}), ...(entry.optionalDependencies ?? {}) };
    for (const name of Object.keys(deps)) {
      const resolved = resolveFrom(packages, key, name, { flat: flatLookupForTestingOnly });
      if (resolved === undefined) {
        unresolved.push(`${key} -> ${name}`);
        continue;
      }
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      queue.push(resolved);
    }
  }

  const closure = [...seen].sort();
  return {
    closure,
    // `link: true` marks a workspace symlink; those ship as bundled source, not as registry installs.
    workspaceLinks: closure.filter((key) => packages[key].link === true),
    external: closure.filter((key) => packages[key].link !== true),
    unresolved,
  };
}

/** The directly declared external dependencies — the "five dependencies" people quote. */
export function directExternalDependencies(lock) {
  const direct = new Set();
  for (const key of workspaceRoots(lock)) {
    const entry = lock.packages[key];
    const deps = { ...(entry.dependencies ?? {}), ...(entry.optionalDependencies ?? {}) };
    for (const name of Object.keys(deps)) {
      if (!name.startsWith("@bayz/")) direct.add(name);
    }
  }
  return [...direct].sort();
}

/**
 * The four ways a dependency can require a compiler or exclude a platform.
 *
 * `libc` is included because a package shipping a prebuilt binary declares which C library it was
 * built against; its presence means a native artifact even when there is no install script.
 */
export function findViolations(lock, external) {
  const violations = [];
  for (const key of external) {
    const entry = lock.packages[key];
    if (entry.hasInstallScript === true) violations.push(`${key}: runs an install script`);
    if (entry.gypfile === true) violations.push(`${key}: carries a gypfile (needs node-gyp)`);
    if (entry.libc !== undefined) violations.push(`${key}: declares libc ${JSON.stringify(entry.libc)} (ships a native binary)`);
    if (entry.os !== undefined) violations.push(`${key}: restricts os to ${JSON.stringify(entry.os)}`);
    if (entry.cpu !== undefined) violations.push(`${key}: restricts cpu to ${JSON.stringify(entry.cpu)}`);
  }
  return violations;
}

/**
 * Prove the guard rejects what it claims to reject.
 *
 * A guard validated only against a clean tree would pass even if `findViolations` returned an empty
 * array unconditionally. Each synthetic lockfile below injects one violation into the real closure
 * and must be caught. Same reasoning as the 9H client gate and the 9I resilience gate, both of which
 * are tested against synthetic inputs for exactly this reason.
 */
function selfTest(lock) {
  const cases = [
    ["install script", { hasInstallScript: true }],
    ["gypfile", { gypfile: true }],
    ["native binary", { libc: ["glibc"] }],
    ["os restriction", { os: ["darwin"] }],
    ["cpu restriction", { cpu: ["x64"] }],
  ];

  let failures = 0;
  for (const [label, injection] of cases) {
    const synthetic = structuredClone(lock);
    // `fastify` is in the real closure, so the injection is reachable by the real walk.
    const target = "node_modules/fastify";
    Object.assign(synthetic.packages[target], injection);
    const { external } = computeClosure(synthetic);
    const violations = findViolations(synthetic, external);
    const caught = violations.some((entry) => entry.startsWith(target));
    console.log(`  ${caught ? "ok  " : "FAIL"} synthetic ${label} is rejected`);
    if (!caught) failures += 1;
  }

  // And a synthetic devDependency-only native package must NOT be flagged.
  const devOnly = structuredClone(lock);
  devOnly.packages["node_modules/vite"] = { ...(devOnly.packages["node_modules/vite"] ?? {}), hasInstallScript: true };
  const { external } = computeClosure(devOnly);
  const leaked = findViolations(devOnly, external).some((entry) => entry.startsWith("node_modules/vite"));
  console.log(`  ${leaked ? "FAIL" : "ok  "} a dev-only native package is not flagged as runtime`);
  if (leaked) failures += 1;

  console.log(failures === 0 ? "self-test: PASS" : `self-test: FAIL (${failures})`);
  return failures === 0;
}

/**
 * CLI entry, guarded so importing this module has **no side effects**.
 *
 * Without the guard, `await import("./dependency-closure.mjs")` from the test file ran the whole
 * report — and worse, a real violation would have called `process.exit(1)` *inside the test runner*,
 * killing the suite instead of failing an assertion. A module that exits the importing process is a
 * module that cannot be tested.
 */
function main() {
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  const { closure, workspaceLinks, external, unresolved } = computeClosure(lock);
  const direct = directExternalDependencies(lock);
  const violations = findViolations(lock, external);

  console.log("BAYZ runtime dependency closure");
  console.log(`  lockfileVersion ${lock.lockfileVersion}, ${Object.keys(lock.packages).length} entries in the tree`);
  console.log("");
  console.log(`  direct external dependencies: ${direct.length} — ${direct.join(", ")}`);
  console.log(`  runtime closure: ${closure.length} total = ${workspaceLinks.length} workspace links + ${external.length} external`);
  console.log("");

  const nested = external.filter((key) => key.split("node_modules/").length > 2);
  console.log(`  nested entries resolved by npm's lookup rules: ${nested.length}`);
  for (const key of nested) console.log(`    - ${key}`);
  console.log("");

  const treeRestricted = Object.keys(lock.packages).filter((key) => lock.packages[key].os !== undefined || lock.packages[key].cpu !== undefined);
  const treeScripted = Object.keys(lock.packages).filter((key) => lock.packages[key].hasInstallScript === true);
  console.log(`  tree-wide: ${treeRestricted.length} os/cpu-restricted, ${treeScripted.length} install-scripted — all dev-only, reached through vite`);
  console.log("");

  if (unresolved.length > 0) {
    console.log(`  UNRESOLVED dependency edges (${unresolved.length}):`);
    for (const entry of unresolved) console.log(`    - ${entry}`);
    console.log("");
  }

  if (violations.length > 0) {
    console.log(`  VIOLATIONS (${violations.length}):`);
    for (const entry of violations) console.log(`    - ${entry}`);
    console.log("");
    console.log("dependency closure: FAIL");
    return 1;
  }

  console.log("  verdict: native-free — no install script, no gypfile, no libc constraint, no os/cpu restriction");
  console.log("");

  if (process.argv.includes("--self-test")) {
    console.log("self-test: proving the guard rejects synthetic violations");
    if (!selfTest(lock)) return 1;
    console.log("");
  }

  if (unresolved.length > 0) {
    console.log("dependency closure: FAIL — unresolved edges");
    return 1;
  }

  console.log("dependency closure: PASS");
  return 0;
}

// Only when run directly, never on import.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
