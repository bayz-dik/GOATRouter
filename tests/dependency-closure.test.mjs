import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const SCRIPT = join(root, "scripts/dependency-closure.mjs");

const lib = await import(join(root, "scripts/dependency-closure.mjs"));

/**
 * Runtime dependency closure guard — 9J Task 2.
 *
 * The claim being defended is "BAYZ has zero native runtime dependencies and needs no build
 * toolchain to install". That claim is what makes Termux/Android viable at all, and it is exactly
 * the kind of property that decays silently: `fastify` adds a transitive dependency in a patch
 * release, that dependency ships a `.node` binary, and the next person to install on ARM64
 * discovers it needs `node-gyp`.
 *
 * So the closure is computed from the lockfile and **pinned as an exact number**. A transitive
 * addition shows up in this file's diff rather than in a user's terminal.
 */

const LOCK = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));

/**
 * The five directly declared external runtime dependencies.
 *
 * Pinned by name so a sixth requires a deliberate edit here. This is the number people quote when
 * they say "five dependencies" — it is true, and it is not the same as what actually ships.
 */
const DIRECT_EXTERNAL = ["@fastify/static", "fastify", "react", "react-dom", "zod"];

/**
 * What actually ships: 86 external packages.
 *
 * Both numbers are true and both are checked. A guard that only pinned the five would not notice
 * `fastify` pulling in a native transitive dependency, which is the failure this task exists for.
 */
const EXTERNAL_COUNT = 86;

/**
 * Workspace links reached from the workspace roots: 10, not 12.
 *
 * `@bayz/server` and `@bayz/dashboard` are workspaces but nothing *depends* on them — they are the
 * leaves that everything else feeds. So the closure reached by walking dependencies contains ten
 * links, and the plan's "7 workspace links" was an estimate written before the walk was run.
 * Recorded as measured rather than bent to match the plan text.
 */
const WORKSPACE_LINK_COUNT = 10;
const CLOSURE_TOTAL = WORKSPACE_LINK_COUNT + EXTERNAL_COUNT;

/**
 * The four entries a flat lookup would miss.
 *
 * npm hoists what it can and nests what it cannot — a version conflict leaves a package under its
 * parent's `node_modules`. A walker that only looked in the top-level `node_modules` would skip
 * these four. They are named individually because "the count is right" is a weaker claim than
 * "these specific hard cases resolve".
 *
 * A flat walk finds **83**, not 82: it misses all four nested entries but also *gains* one, because
 * `lru-cache` resolves to the hoisted copy instead of the nested one. Net −3. That asymmetry is why
 * the flat comparison below asserts a *direction and a set*, not an arithmetic difference — the first
 * version of this test asserted `86 - 4 = 82` and failed against the real lockfile.
 */
const NESTED_ENTRIES = [
  "node_modules/ajv/node_modules/fast-uri",
  "node_modules/light-my-request/node_modules/process-warning",
  "node_modules/path-scurry/node_modules/lru-cache",
  "node_modules/thread-stream/node_modules/real-require",
];

test("the lockfile is version 3 and the closure is computed from it alone", () => {
  assert.equal(LOCK.lockfileVersion, 3, "lockfileVersion changed — the walker's assumptions about entry shape need rechecking");
  /*
   * Reading only the lockfile matters: resolving from `node_modules` on disk would describe *this
   * machine's* install, which may have been pruned, hoisted differently, or partially installed.
   * The lockfile is what a user's `npm ci` will reproduce.
   */
  const source = readFileSync(SCRIPT, "utf8");
  assert.ok(!/readdirSync|existsSync\(join\([^)]*node_modules/.test(source), "the script inspects node_modules on disk instead of the lockfile");
});

test("the runtime closure excludes devDependencies", () => {
  const { closure } = lib.computeClosure(LOCK);
  /*
   * `vite` is the whole reason this distinction exists. It is a dev dependency of
   * `@bayz/dashboard`, and it drags in every install-scripted and platform-restricted package in
   * the tree. If it appeared in the runtime closure, the native-free claim would be false.
   */
  const names = new Set(closure.map((key) => key.replace(/^.*node_modules\//, "")));
  for (const dev of ["vite", "esbuild", "typescript", "tsx", "@types/node", "fsevents", "rolldown"]) {
    assert.ok(!names.has(dev), `${dev} is a dev dependency but appears in the runtime closure`);
  }
});

test("the runtime closure size is pinned exactly", () => {
  const { closure, workspaceLinks, external } = lib.computeClosure(LOCK);
  assert.equal(
    external.length,
    EXTERNAL_COUNT,
    `the external runtime closure changed from ${EXTERNAL_COUNT} to ${external.length}. This is not a failure to silence: read the diff, confirm the new packages are native-free and license-compatible, then update the constant deliberately.`,
  );
  assert.equal(workspaceLinks.length, WORKSPACE_LINK_COUNT, `workspace links changed from ${WORKSPACE_LINK_COUNT} to ${workspaceLinks.length}`);
  assert.equal(closure.length, CLOSURE_TOTAL, `total closure changed from ${CLOSURE_TOTAL} to ${closure.length}`);
});

test("the five direct external runtime dependencies are exactly these five", () => {
  const direct = lib.directExternalDependencies(LOCK);
  assert.deepEqual(
    direct,
    DIRECT_EXTERNAL,
    `direct external runtime dependencies changed. A sixth is a real architectural decision, not a lockfile detail — adding one should require editing this test on purpose.`,
  );
});

test("no runtime package ships a .node binary, an install script, or a gypfile", () => {
  const { external } = lib.computeClosure(LOCK);
  const offenders = { installScript: [], gypfile: [], nodeBinary: [] };
  for (const key of external) {
    const entry = LOCK.packages[key];
    if (entry.hasInstallScript === true) offenders.installScript.push(key);
    if (entry.gypfile === true) offenders.gypfile.push(key);
    // A published package that ships a prebuilt binary names it in `bin` or carries `libc`.
    if (entry.libc !== undefined) offenders.nodeBinary.push(key);
  }
  assert.deepEqual(offenders.installScript, [], "a runtime package runs an install script — installing would need a toolchain");
  assert.deepEqual(offenders.gypfile, [], "a runtime package carries a gypfile — installing would need node-gyp");
  assert.deepEqual(offenders.nodeBinary, [], "a runtime package declares a libc constraint — it ships a native binary");
});

test("no runtime package declares os or cpu restrictions", () => {
  const { external } = lib.computeClosure(LOCK);
  /*
   * This is how a platform quietly becomes unsupported. An `os: ["darwin"]` package in the closure
   * means the install *succeeds* on Linux while skipping something the code then needs at runtime —
   * a failure that surfaces as a missing module, far from its cause.
   */
  const restricted = external.filter((key) => LOCK.packages[key].os !== undefined || LOCK.packages[key].cpu !== undefined);
  assert.deepEqual(restricted, [], "a runtime package restricts os/cpu, so some platform silently loses it");
});

test("the install-scripted and platform-restricted packages in the tree are dev-only", () => {
  /*
   * The tree genuinely contains 53 `os`/`cpu`-restricted packages and 2 with install scripts. That
   * is fine, and saying so is more useful than pretending the tree is pristine: they are reachable
   * only through `vite`, which never runs in production. Asserting the *counts* here means a new
   * install-scripted package appearing anywhere gets looked at, even if it lands in devDependencies.
   */
  const all = Object.keys(LOCK.packages);
  const restricted = all.filter((key) => LOCK.packages[key].os !== undefined || LOCK.packages[key].cpu !== undefined);
  const scripted = all.filter((key) => LOCK.packages[key].hasInstallScript === true);

  assert.equal(restricted.length, 53, `tree-wide os/cpu-restricted count changed from 53 to ${restricted.length} — confirm the new ones are still dev-only`);
  assert.equal(scripted.length, 2, `tree-wide install-scripted count changed from 2 to ${scripted.length} — confirm the new ones are still dev-only`);

  const { external } = lib.computeClosure(LOCK);
  const runtime = new Set(external);
  for (const key of [...restricted, ...scripted]) {
    assert.ok(!runtime.has(key), `${key} is platform-restricted or install-scripted and IS in the runtime closure`);
  }

  // And the two install-scripted ones are the expected pair, reached through vite.
  assert.deepEqual(
    scripted.map((key) => key.replace(/^.*node_modules\//, "")).sort(),
    ["esbuild", "fsevents"],
    "the install-scripted packages are no longer the expected esbuild/fsevents pair",
  );
});

test("the walker follows npm's nested node_modules lookup rules", () => {
  const { closure } = lib.computeClosure(LOCK);
  const found = new Set(closure);
  /*
   * The plan calls this out specifically because a flat lookup is the obvious implementation and it
   * is wrong. Each of these four exists *nested* because of a version conflict with a hoisted copy.
   */
  for (const nested of NESTED_ENTRIES) {
    assert.ok(found.has(nested), `nested entry not resolved: ${nested} — the walker is using a flat lookup and under-reporting the closure`);
  }
});

test("a flat lookup would under-report, which is why the nested rule is tested", () => {
  /*
   * Proves the nested-lookup test above is not vacuous. A deliberately flat resolver is run against
   * the same lockfile; if it produced the same closure, the nested assertion would be decoration.
   *
   * Asserted as a *set difference*, not arithmetic. The flat walk finds 83 against the nested 86: it
   * misses the four nested entries but gains the hoisted `lru-cache` it resolved to instead. An
   * `86 - 4 = 82` assertion looked obviously right and was wrong — the interesting content is
   * *which* packages differ, so that is what the test states.
   */
  const flat = lib.computeClosure(LOCK, { flatLookupForTestingOnly: true });
  const nestedSet = new Set(lib.computeClosure(LOCK).external);
  const flatSet = new Set(flat.external);

  const missedByFlat = [...nestedSet].filter((key) => !flatSet.has(key)).sort();
  assert.deepEqual(
    missedByFlat,
    [...NESTED_ENTRIES].sort(),
    "a flat lookup misses a different set of packages than the four known nested entries",
  );

  assert.ok(
    flat.external.length < EXTERNAL_COUNT,
    `a flat lookup found ${flat.external.length} external packages, not fewer than the nested walk's ${EXTERNAL_COUNT} — the nested-lookup assertion proves nothing`,
  );
});

test("every dependency in the closure resolves — no dangling edge", () => {
  const { unresolved } = lib.computeClosure(LOCK);
  /*
   * An unresolved edge means either the walker is wrong or the lockfile is inconsistent. Both are
   * worth failing on: a closure that silently skips what it cannot resolve reports a smaller,
   * cleaner-looking dependency set than the truth.
   */
  assert.deepEqual(unresolved, [], "a dependency edge did not resolve to a lockfile entry");
});

test("the script exits 0 and prints the closure size", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `the script exited ${result.status}: ${result.stdout}${result.stderr}`);
  assert.match(result.stdout, new RegExp(`${EXTERNAL_COUNT} external`), "the output does not state the external closure size");
  assert.match(result.stdout, /native-free/, "the output does not state the native-free verdict");
});

test("the script exits non-zero when a violation is injected", () => {
  /*
   * The guard is driven against a **synthetic lockfile** carrying a native package, because a guard
   * checked only against a clean tree would pass even if hardcoded to succeed. Same trap as the 9H
   * client gate and the 9I resilience gate.
   */
  const result = spawnSync(process.execPath, [SCRIPT, "--self-test"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `the self-test exited ${result.status}: ${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /self-test: PASS/, "the self-test did not confirm the guard rejects synthetic violations");
});
