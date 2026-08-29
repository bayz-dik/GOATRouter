import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ARTIFACT_CLASSES, scanForBuildMachineIdentity } from "../scripts/build-determinism.mjs";

/**
 * Build determinism, honestly bounded — Phase 9K Task 6.
 *
 * The spec forbids claiming reproducible builds, and this suite is written to respect that rather than
 * work around it. Two very different properties are measured, and conflating them is exactly the
 * overclaim the plan warns about:
 *
 *   1. **Determinism per artifact class, measured and reported.** Some classes are genuinely
 *      byte-stable and asserted as such. Where a class is not — or where the toolchain makes no
 *      promise — the script reports `UNVERIFIED` and exits **0**. A red test for a property the
 *      toolchain never promised would be dishonest noise, not a finding.
 *   2. **No build-machine identity in shipped bytes.** This one is achievable, matters for privacy,
 *      and is asserted hard: absolute paths, home directories, usernames, and hostnames must not
 *      appear in anything that ships.
 *
 * A measured correction to the plan's premise, recorded rather than papered over: **there are no
 * `tsc`-emitted files to compare.** Every workspace builds with `tsc --noEmit` — type checking only —
 * and the shipped JavaScript comes from `esbuild` (the server bundle, via `scripts/pack.mjs`) and
 * `vite` (the dashboard). The per-package `dist` directories the plan names, and `apps/server/dist`, do
 * not exist. Asserting byte-identity over an empty set of files would be the purest form of vacuous
 * test, so the emitted-output class is reported `N/A` with the reason, and determinism is measured where
 * output actually is.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts/build-determinism.mjs");
const REPORT = join(ROOT, "docs/superpowers/2026-08-27-bayz-build-determinism.md");

function run(args = []) {
  try {
    return { status: 0, output: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" }) };
  } catch (error) {
    return { status: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/**
 * The artifact classes that must be reported, pinned **here** rather than read from the script.
 *
 * This list exists because a mutation exposed a real weakness. Deleting a class from
 * `ARTIFACT_CLASSES` left the "every class has a verdict" test green, because that test iterated the
 * very list the mutation had shortened — a self-referential check that cannot notice a deletion. The
 * expected set now lives in the test, so dropping a class from the script fails here by name.
 */
const EXPECTED_CLASS_IDS = [
  "tsc-emitted-output",
  "release-tarball",
  "dashboard-bundle",
  "sbom",
  "build-machine-identity",
];

test("the reported artifact classes are exactly the expected set", () => {
  assert.deepEqual(
    ARTIFACT_CLASSES.map((artifactClass) => artifactClass.id).sort(),
    [...EXPECTED_CLASS_IDS].sort(),
    "an artifact class was added or removed without updating the expected set",
  );
});

test("every artifact class has an explicit verdict, none left implicit", () => {
  /*
   * The plan's requirement: "an explicit verdict per artifact class". A class silently omitted is how
   * an unmeasured artifact gets mistaken for a measured one. Driven from `EXPECTED_CLASS_IDS`, not from
   * the script's own list, so a deletion cannot make this pass by shrinking the loop.
   */
  const result = run();
  assert.equal(result.status, 0, result.output);

  for (const id of EXPECTED_CLASS_IDS) {
    const line = new RegExp(`${id}\\s*:\\s*(PASS|UNVERIFIED|N/A|FAIL)`, "i");
    assert.match(result.output, line, `no verdict for artifact class ${id}:\n${result.output}`);
  }
});

test("the tarball is byte-identical across two packs", () => {
  /*
   * The one determinism claim BAYZ genuinely earns, inherited from 9J: `scripts/pack.mjs` pins tar and
   * gzip metadata, so two packs of an unchanged tree produce identical bytes. Asserted here against the
   * real packer rather than restated from the 9J notes.
   */
  const result = run(["--class", "release-tarball"]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /release-tarball\s*:\s*PASS/i, result.output);
  assert.match(result.output, /identical/i, result.output);
});

test("a class the toolchain does not promise is UNVERIFIED, not a failure", () => {
  /*
   * The honesty requirement, and the assertion that keeps this suite from becoming a lie in either
   * direction: an `UNVERIFIED` verdict must exit 0. `vite` makes no byte-reproducibility promise, so
   * failing the build over it would be claiming a standard the tool never offered.
   */
  const result = run(["--class", "dashboard-bundle"]);
  assert.equal(result.status, 0, `an unverified class failed the run:\n${result.output}`);
  assert.match(result.output, /dashboard-bundle\s*:\s*(PASS|UNVERIFIED)/i, result.output);
  assert.match(result.output, /not guaranteed|bundler determinism/i, result.output);
});

test("the report never claims reproducible builds", () => {
  /*
   * A wording guard. "Reproducible build" is a term of art with a specific, much stronger meaning than
   * "two runs here matched", and using it loosely misleads exactly the security-conscious reader who
   * would look for it.
   */
  const result = run();
  assert.ok(!/reproducible build/i.test(result.output), `the output claims reproducible builds:\n${result.output}`);

  assert.ok(existsSync(REPORT), `${REPORT} does not exist`);
  const report = readFileSync(REPORT, "utf8");
  // The report may *disclaim* the term; it may not assert it. Every mention must be a negation.
  for (const match of report.matchAll(/[^.\n]*reproducible build[^.\n]*/gi)) {
    assert.match(
      match[0],
      /\b(not|no|never|does not|cannot|without)\b/i,
      `the report asserts reproducible builds: ${match[0].trim()}`,
    );
  }
});

test("no shipped artifact contains an absolute build path", () => {
  /*
   * The privacy half, and the part that genuinely matters. The tarball is scanned rather than the
   * source tree, because the bundler is what would embed a path.
   */
  const result = run(["--class", "build-machine-identity"]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /build-machine-identity\s*:\s*PASS/i, result.output);
});

test("the identity scan catches a planted path, so a pass is meaningful", () => {
  /*
   * The positive control. Without it, a scan that silently matched nothing would report `PASS` forever
   * — the failure mode that makes a security check worse than none, since it reads as protection.
   */
  const planted = [
    `const buildRoot = "${ROOT}";`,
    'const home = "/home/someone/project";',
    'const macHome = "/Users/someone/project";',
    "const builder = 'built by ci-runner-7 at /var/lib/jenkins';",
  ].join("\n");

  const hits = scanForBuildMachineIdentity(planted, { root: ROOT, username: "someone", hostname: "ci-runner-7" });
  assert.ok(hits.length >= 3, `the scan missed planted identity: ${JSON.stringify(hits)}`);
  assert.ok(
    hits.some((hit) => hit.includes("absolute build path")),
    `the scan did not name the absolute path: ${JSON.stringify(hits)}`,
  );

  // And it must not fire on ordinary shipped code.
  const clean = 'import { join } from "node:path";\nconst dir = join(base, "assets");\n';
  assert.deepEqual(scanForBuildMachineIdentity(clean, { root: ROOT, username: "someone", hostname: "ci-runner-7" }), []);
});

test("the report states what was measured, on which toolchain, and what remains unknown", () => {
  const report = readFileSync(REPORT, "utf8");
  // Pinning the toolchain in prose matters: a different Node or npm may legitimately differ.
  assert.match(report, /Node/, "the report does not name the Node version measured");
  assert.match(report, /v?24/, "the report does not pin the Node major version");
  assert.match(report, /esbuild/, "the report does not mention the bundler that produces shipped JS");
  assert.match(report, /vite/i, "the report does not mention the dashboard bundler");
  assert.match(report, /UNVERIFIED/, "the report does not use the UNVERIFIED verdict");
  assert.match(report, /noEmit/, "the report does not record that tsc emits nothing");
});

test("the script exits 0 when every class is PASS, N/A, or UNVERIFIED", () => {
  // The overall contract: this script measures and reports. It is not a gate, and must not behave like
  // one — `scripts/supply-chain-gate.mjs` owns blocking.
  const result = run();
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /build determinism: (PASS|MEASURED)/i, result.output);
});
