import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const pack = await import(join(root, "scripts/pack.mjs"));

/**
 * Release packaging — 9J Task 4.
 *
 * **The measured baseline, and the defect this task exists to fix.**
 * `npm pack --workspace @bayz/server --dry-run` on the pre-9J tree produced a 120.1 kB tarball of
 * **57 files including all 29 `test/*.ts` files**, because `apps/server/package.json` has no `files`
 * field. Worse, `@bayz/server` depends on `@bayz/storage`, `@bayz/router` and eight more at version
 * `0.1.0` — versions that exist only as workspace symlinks. **That tarball cannot install anywhere**:
 * those dependencies resolve against no registry.
 *
 * So BAYZ ships as a **single self-contained artifact**, not nine published packages, and the
 * assertions below are about that artifact rather than about a file list. Two of them carry most of
 * the weight: no `@bayz/*` or `file:` dependency survives into it, and the secret scan runs on the
 * **extracted bytes** — because a tarball shipping every test file is exactly how a fixture
 * credential reaches a user's disk.
 */

/** Built once and shared: packing is the expensive step and every test reads the same artifact. */
const built = pack.buildArtifact({ root, outDir: mkdtempSync(join(tmpdir(), "bayz-pack-")) });
const entries = pack.readTarEntries(built.tarballPath);
const files = entries.map((entry) => entry.name).sort();
const manifest = JSON.parse(pack.entryText(entries, "package/package.json"));

function workspaceManifest(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

test("the artifact declares no @bayz/* and no file: dependency", () => {
  /*
   * **The defect the measured baseline actually has.**
   *
   * A `@bayz/storage: 0.1.0` dependency in a release artifact is unresolvable — that version exists
   * only as a workspace link in this checkout. A `file:` or `link:` specifier is the same failure
   * wearing a different hat: it points at a path on the machine that built it.
   */
  const declared = { ...(manifest.dependencies ?? {}), ...(manifest.optionalDependencies ?? {}) };

  for (const [name, range] of Object.entries(declared)) {
    assert.ok(!name.startsWith("@bayz/"), `the artifact depends on the workspace package ${name}`);
    assert.doesNotMatch(range, /^(file:|link:|portal:|\.{1,2}\/)/, `${name} resolves to a local path: ${range}`);
    assert.doesNotMatch(range, /^(git|github|https?):/, `${name} resolves to a remote source: ${range}`);
  }

  assert.equal(manifest.devDependencies, undefined, "the artifact carries devDependencies");
  assert.equal(manifest.workspaces, undefined, "the artifact carries a workspaces field");
});

test("the artifact declares exactly the external packages its own bundle imports", () => {
  /*
   * Stronger than the plan's "declares exactly the five", and deliberately so.
   *
   * The plan lists `fastify`, `@fastify/static`, `react`, `react-dom`, `zod` — the five *directly
   * declared* external dependencies across the workspaces. But `react`, `react-dom` and `zod` are
   * compiled **into** the bundles: vite inlines React and the schema code into the dashboard asset,
   * and the server imports `@bayz/contracts` only with `import type`, which erases. Measured on the
   * built output, the artifact's runtime imports are `fastify` and `@fastify/static` and nothing
   * else.
   *
   * Declaring the other three would install `react`, `react-dom`, `scheduler` and `zod` — four
   * packages, 86 in the closure instead of 82 — that nothing can ever load. That is not a harmless
   * over-declaration: every installed package is supply-chain surface, and a dependency nothing
   * imports is one nobody will notice going bad.
   *
   * So the assertion is derived, not copied: the declared set must equal the set of bare specifiers
   * the shipped bundles actually import. A sixth genuinely-needed dependency being *missed* fails
   * here too, which "exactly the five" would not have caught.
   */
  const imported = pack.bundleExternalImports(entries);
  const declared = Object.keys(manifest.dependencies ?? {}).sort();

  assert.deepEqual(declared, imported, "the declared dependencies do not match what the bundle imports");
  assert.deepEqual(declared, ["@fastify/static", "fastify"], "the measured runtime import set changed");

  // And every declared name must be one of the five the workspaces declare — a new external
  // dependency must arrive through a workspace manifest, not through the packaging script.
  const five = ["@fastify/static", "fastify", "react", "react-dom", "zod"];
  for (const name of declared) {
    assert.ok(five.includes(name), `${name} is declared by the artifact but by no workspace package`);
  }
});

test("the declared version ranges come from the workspace manifests, not the packaging script", () => {
  /*
   * A hardcoded `"fastify": "^5.0.0"` in `pack.mjs` would drift the moment the workspace bumped its
   * range, and the artifact would then install a version the tests never ran against.
   */
  const server = workspaceManifest("apps/server/package.json");
  for (const [name, range] of Object.entries(manifest.dependencies)) {
    assert.equal(range, server.dependencies[name], `${name} range differs from apps/server/package.json`);
  }
});

test("the tarball contents are exactly the intended set", () => {
  /*
   * Pinned as an exact list. A tarball is the one artifact where "roughly the right files" is not
   * good enough — every extra file is shipped to every user forever, and the 57-file baseline is the
   * regression being pinned.
   *
   * `package/LICENSE` joined the set in 9K Task 3, when the owner chose Apache-2.0 and a real
   * `LICENSE` file appeared at the repository root. `scripts/pack.mjs` already shipped it
   * conditionally; before 9K there was no file to ship, so the artifact declared `UNLICENSED`.
   * Redistribution under Apache-2.0 clause 4(a) requires the licence copy to travel with the
   * artifact, so this entry is a requirement rather than a convenience.
   *
   * The two `assets/index-*` names carry vite's content hash, so they move whenever the dashboard
   * source does — and they are still written out literally rather than globbed, because deriving them
   * from `apps/dashboard/dist` would make those two entries assert nothing. Re-pinned here for the
   * Usage-screen shell integration (`Shell.tsx`, `src/usage/`, the widened `styles.css`), which is a
   * source change and therefore a legitimate hash move; the count, the paths, and every other entry
   * are unchanged. A re-pin that added or dropped a file would show up as a length change.
   */
  assert.deepEqual(files, [
    "package/LICENSE",
    "package/README.md",
    "package/dist/bayz.mjs",
    "package/dist/dashboard/assets/index-CG1SpnTD.css",
    "package/dist/dashboard/assets/index-DNsUQghD.js",
    "package/dist/dashboard/index.html",
    "package/dist/server.mjs",
    "package/package.json",
  ]);
});

test("no test file, no TypeScript source, and no tsconfig ships", () => {
  /*
   * The baseline shipped 29 test files and 26 `.ts` sources. Each of the shapes below is checked by
   * pattern rather than relying on the exact list above, so a file added to the staging step is
   * caught by whichever rule it violates rather than only by the list going stale.
   */
  for (const name of files) {
    assert.ok(!/(^|\/)test\//.test(name), `a test directory ships: ${name}`);
    assert.ok(!name.includes(".test."), `a test file ships: ${name}`);
    assert.ok(!name.endsWith(".ts") && !name.endsWith(".tsx"), `TypeScript source ships: ${name}`);
    assert.ok(!name.endsWith("tsconfig.json"), `a tsconfig ships: ${name}`);
    assert.ok(!name.includes("-smoke"), `a smoke script ships: ${name}`);
    assert.ok(!name.includes("/corpus/"), `a fuzz corpus file ships: ${name}`);
    assert.ok(!name.startsWith("package/docs/"), `documentation ships: ${name}`);
    assert.ok(!name.includes("/.git"), `a git file ships: ${name}`);
    assert.ok(!name.endsWith(".db") && !name.endsWith(".db-wal") && !name.endsWith(".db-shm"), `a database ships: ${name}`);
    assert.ok(!name.endsWith(".env") && !name.includes("/.env"), `an env file ships: ${name}`);
    assert.ok(!name.endsWith(".key") && !name.endsWith(".pem"), `key material ships: ${name}`);
  }
});

test("a secret scan over the extracted bytes finds nothing", () => {
  /*
   * **Asserted on the bytes, not the file list.**
   *
   * A release artifact leaking a test fixture credential is the worst outcome this phase can produce,
   * and the measured baseline — which ships every test file — is precisely how it would happen. So
   * every entry's content is scanned, including the compiled bundles, where a fixture constant that
   * survived tree-shaking would be invisible to any filename rule.
   */
  const patterns = [
    [/sk-[A-Za-z0-9_-]{8,}/, "an sk- style credential"],
    [/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/, "a Bearer token"],
    [/\b[0-9a-f]{64}\b/, "a 64-hex literal (API token or root key shape)"],
    [/BEGIN [A-Z ]*PRIVATE KEY/, "a private key"],
    [/hunter2/, "the Phase 2 password fixture"],
    [/PROMPT_CONTENT_SENTINEL|COMPLETION_CONTENT_SENTINEL|PROVIDER_CREDENTIAL_SENTINEL/, "a Phase 8 usage sentinel"],
    [/PROXY_CREDENTIAL_SENTINEL|BAYZ_AUTHORIZATION_SENTINEL|UPSTREAM_ERROR_BODY_SENTINEL/, "a Phase 8 usage sentinel"],
    [/API-SMOKE-PROMPT-|API-SMOKE-COMPLETION-|PROMPT-ROUTER-SMOKE-/, "a smoke fixture sentinel"],
    [/AIza[0-9A-Za-z_-]{20,}/, "a Google API key"],
  ];

  for (const entry of entries) {
    const text = entry.content.toString("utf8");
    for (const [pattern, label] of patterns) {
      const match = pattern.exec(text);
      assert.equal(match, null, `${entry.name} contains ${label}: ${match?.[0]?.slice(0, 24) ?? ""}`);
    }
  }
});

test("the secret scan is not vacuous", () => {
  /*
   * The artifact is clean, so the artifact cannot demonstrate that the scan detects anything. Fed a
   * synthetic entry carrying each shape instead.
   */
  const planted = [
    "sk-abcdefghijklmnop",
    "Bearer aaaaaaaaaaaaaaaaaaaa",
    "a".repeat(64).replace(/a/g, "0"),
    "-----BEGIN RSA PRIVATE KEY-----",
    "hunter2",
    "PROMPT_CONTENT_SENTINEL_7f3a91",
  ];
  for (const secret of planted) {
    const hits = pack.scanBytesForSecrets([{ name: "package/planted", content: Buffer.from(secret) }]);
    assert.ok(hits.length > 0, `the scan missed a planted ${JSON.stringify(secret.slice(0, 16))}`);
  }
  assert.deepEqual(pack.scanBytesForSecrets(entries), [], "the real artifact has a secret-scan hit");
});

test("the tarball is under its documented size bound", () => {
  /*
   * 2 MiB. The artifact is a bundled server plus a prebuilt dashboard, and the dashboard asset is the
   * bulk of it. The bound exists so a stray directory — `node_modules`, a corpus, a database — shows
   * up as a size failure even if it slips past every name rule.
   */
  const bound = 2 * 1024 * 1024;
  const size = statSync(built.tarballPath).size;
  assert.ok(size < bound, `the tarball is ${size} bytes, over the ${bound} byte bound`);
  assert.ok(size > 50 * 1024, `the tarball is only ${size} bytes, which cannot contain a bundled server`);
});

test("the bin entry resolves and --version prints without opening a database", () => {
  /*
   * The plan's requirement, and the reason `dist/bayz.mjs` exists separately from `dist/server.mjs`:
   * the server entry builds the runtime and opens SQLite at import time, so `--version` on it would
   * create a data directory as a side effect of asking a question.
   *
   * Verified behaviourally rather than by inspection: `BAYZ_DATA_DIR` points at a path that does not
   * exist, and the assertion is that it still does not exist afterwards.
   */
  const staging = mkdtempSync(join(tmpdir(), "bayz-bin-"));
  const dataDir = join(staging, "never-created");

  const binField = manifest.bin;
  assert.equal(typeof binField, "object", "the artifact declares no bin object");
  const binPath = binField.bayz;
  assert.equal(typeof binPath, "string", "the artifact declares no bayz bin entry");
  assert.ok(files.includes(`package/${binPath.replace(/^\.\//, "")}`), `the bin entry ${binPath} is not in the tarball`);

  const extracted = pack.extractTo(built.tarballPath, staging);
  const script = join(extracted, binPath);
  assert.ok(existsSync(script), `the extracted bin ${script} is missing`);

  const output = execFileSync(process.execPath, [script, "--version"], {
    encoding: "utf8",
    env: { ...process.env, BAYZ_DATA_DIR: dataDir },
  });

  assert.equal(output.trim(), manifest.version, `--version printed ${JSON.stringify(output)}`);
  assert.equal(existsSync(dataDir), false, "--version created the data directory");

  rmSync(staging, { recursive: true, force: true });
});

test("the version is embedded, not read from disk at runtime", () => {
  /*
   * `--version` must not touch the filesystem, so it cannot read its own `package.json`. The version
   * is injected at build time; this asserts the literal is present in the bin and that the bin does
   * not reach for a manifest.
   */
  const bin = pack.entryText(entries, "package/dist/bayz.mjs");
  assert.ok(bin.includes(manifest.version), "the bin does not carry the version literal");
  assert.doesNotMatch(bin, /readFileSync\([^)]*package\.json/, "the bin reads its own package.json");
});

test("the licence claim matches the repository's actual state", () => {
  /*
   * **9K Task 3 owns the licence, and it blocks on a user decision that has not been made.** There is
   * no `LICENSE` file in the repository and no `license` field in any of the nine workspace manifests.
   *
   * So the artifact declares `UNLICENSED`, which is the SPDX-recognised marker for "no licence
   * granted" — and it is *true* right now. Inventing `MIT` to satisfy the plan's "a `license` field is
   * present" would be a false statement about a legal fact, which is worse than the honest absence.
   *
   * The rule asserted is a **consistency rule**, so this test does not have to change when 9K lands:
   * if a root `LICENSE` exists, the artifact must carry a matching identifier and ship the file; if
   * not, the artifact must say `UNLICENSED` and ship no licence file at all.
   */
  const rootLicense = join(root, "LICENSE");
  const rootManifest = workspaceManifest("package.json");

  if (existsSync(rootLicense)) {
    assert.equal(
      manifest.license,
      rootManifest.license,
      "the artifact's licence identifier disagrees with the repository's",
    );
    assert.ok(manifest.license !== undefined && manifest.license !== "UNLICENSED", "a LICENSE file exists but the artifact claims no licence");
    assert.ok(files.includes("package/LICENSE"), "a LICENSE file exists but does not ship in the artifact");
  } else {
    assert.equal(manifest.license, "UNLICENSED", "no LICENSE file exists, so the artifact must not claim a licence");
    assert.equal(rootManifest.license, undefined, "the root manifest declares a licence with no LICENSE file to back it");
    assert.ok(!files.some((name) => /LICEN[SC]E/i.test(name)), "a licence file ships that the repository does not have");
  }
});

test("the workspace packages stay private", () => {
  // Nothing is being published, and `private: true` is what stops an accidental `npm publish`.
  for (const path of pack.workspaceManifestPaths(root)) {
    const entry = workspaceManifest(path);
    assert.equal(entry.private, true, `${path} is not private`);
  }
});

test("apps/server declares a files field so a per-workspace pack cannot ship tests", () => {
  /*
   * The single-artifact decision means `npm pack --workspace @bayz/server` is **not** the release
   * path — but it is a command a developer will run, and the measured 57-file / 120.1 kB baseline is a
   * real defect regardless of which path ships. Adding `files: ["src"]` takes it to 27 files /
   * 44.4 kB with zero `test/` entries.
   *
   * The resulting tarball still cannot install anywhere, because the ten `@bayz/*` dependencies
   * remain unresolvable — that is inherent to a workspace package and is exactly why the single
   * artifact exists. This narrows the accident; it does not turn a workspace into a release.
   */
  const server = workspaceManifest("apps/server/package.json");
  assert.ok(Array.isArray(server.files) && server.files.length > 0, "apps/server/package.json has no files field");
  for (const pattern of server.files) {
    assert.ok(!pattern.includes("test"), `the files field includes tests: ${pattern}`);
  }

  const dryRun = execFileSync("npm", ["pack", "--workspace", "@bayz/server", "--dry-run"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(!/\btest\//.test(dryRun), "a per-workspace pack still ships test files");
});

test("the tarball is byte-identical across two packs", () => {
  /*
   * Determinism is a 9K concern, but it is cheap to establish here and it is what makes a digest
   * meaningful later.
   */
  const second = pack.buildArtifact({ root, outDir: mkdtempSync(join(tmpdir(), "bayz-pack-2-")) });
  const a = readFileSync(built.tarballPath);
  const b = readFileSync(second.tarballPath);
  assert.equal(a.length, b.length, "two packs produced different sizes");
  assert.ok(a.equals(b), "two packs of identical inputs are not byte-identical");
  rmSync(second.tarballPath, { force: true });
});

test("the byte-identity comparison detects an injected nondeterministic timestamp", () => {
  /*
   * **The assertion that makes the determinism claim falsifiable, and the reason it looks like this.**
   *
   * The first version of this test asserted the four gzip MTIME bytes were zero and called that
   * proof. A mutation exposed it as vacuous: removing `mtime: 0` from the `gzipSync` call left the
   * suite green. Measured on Node v24.19.0, `zlib.gzipSync` writes a **zero** MTIME field regardless
   * of what `mtime` is set to — `0`, a real epoch second, a `Date`, or the option omitted all produce
   * `00000000`. The bytes were constant for reasons that had nothing to do with this packer, so the
   * assertion could never fail.
   *
   * The tar entry header is where a nondeterministic writer actually shows up on this platform. So
   * rather than asserting a constant, this drives `writeTarGz` with a real clock value and asserts
   * the byte comparison **notices** — a positive control for the test above. If someone reintroduces
   * a timestamp into the tar headers, that test starts failing, and this one proves it would.
   */
  const dir = mkdtempSync(join(tmpdir(), "bayz-determinism-"));
  const sample = [{ name: "package/x", content: Buffer.from("same bytes every time") }];

  const zeroed = pack.writeTarGz(sample, join(dir, "zeroed.tgz"));
  const zeroedAgain = pack.writeTarGz(sample, join(dir, "zeroed-again.tgz"));
  assert.ok(
    readFileSync(zeroed).equals(readFileSync(zeroedAgain)),
    "two packs with zeroed metadata are not byte-identical",
  );

  // Two different injected timestamps must produce two different archives, and neither may match the
  // deterministic one. That is the failure the production packer avoids by zeroing the field.
  const stampedEarly = pack.writeTarGz(sample, join(dir, "early.tgz"), { mtime: 1_600_000_000 });
  const stampedLate = pack.writeTarGz(sample, join(dir, "late.tgz"), { mtime: 1_700_000_000 });

  assert.ok(
    !readFileSync(stampedEarly).equals(readFileSync(stampedLate)),
    "the archive bytes do not change with the entry timestamp, so the comparison cannot detect a clock",
  );
  assert.ok(
    !readFileSync(zeroed).equals(readFileSync(stampedEarly)),
    "a timestamped archive is byte-identical to the deterministic one",
  );

  // And the injected value is genuinely in the header where a real writer would put it.
  const stampedRaw = gunzipSync(readFileSync(stampedEarly));
  const stampedMtime = Number.parseInt(
    stampedRaw.subarray(136, 148).toString("ascii").replace(/\0.*$/, "").trim(),
    8,
  );
  assert.equal(stampedMtime, 1_600_000_000, "the injected mtime did not reach the tar header");

  rmSync(dir, { recursive: true, force: true });
});

test("the production packer writes zero into every timestamp and identity field", () => {
  /*
   * Now meaningful, because the test above proved these fields are writable and that a non-zero value
   * changes the archive bytes. Asserted over **every** entry rather than the first, since a writer
   * that stamped only some entries would still break reproducibility.
   */
  const raw = gunzipSync(readFileSync(built.tarballPath));
  let checked = 0;
  for (let offset = 0; offset + 512 <= raw.length; offset += 512) {
    const header = raw.subarray(offset, offset + 512);
    if (header[0] === 0) break;
    const field = (start, length) => header.subarray(start, start + length).toString("ascii").replace(/\0.*$/, "").trim();
    assert.equal(Number.parseInt(field(136, 12), 8), 0, `mtime is not zero on entry ${field(0, 100)}`);
    assert.equal(Number.parseInt(field(108, 8), 8), 0, `uid is not zero on entry ${field(0, 100)}`);
    assert.equal(Number.parseInt(field(116, 8), 8), 0, `gid is not zero on entry ${field(0, 100)}`);
    assert.equal(field(265, 32), "", `uname is set on entry ${field(0, 100)}`);
    assert.equal(field(297, 32), "", `gname is set on entry ${field(0, 100)}`);
    checked += 1;
    const size = Number.parseInt(field(124, 12), 8) || 0;
    offset += Math.ceil(size / 512) * 512;
  }
  assert.equal(checked, entries.length, `checked ${checked} tar headers but the artifact has ${entries.length} entries`);
});

test("the packaging script exits 0 and reports what it built", () => {
  const output = execFileSync(process.execPath, [join(root, "scripts/pack.mjs")], { cwd: root, encoding: "utf8" });
  assert.match(output, /release packaging/i);
  assert.match(output, /files/i);
  assert.match(output, /pack: PASS/);
});

test("the release:pack npm script runs the packaging script", () => {
  const rootManifest = workspaceManifest("package.json");
  assert.equal(rootManifest.scripts["release:pack"], "node scripts/pack.mjs");
});

test("esbuild stays a dev dependency and out of the runtime closure", () => {
  /*
   * The bundler has an install script and platform-restricted optional binaries, which is exactly the
   * shape 9J Task 2 exists to keep out of what ships. Promoting it to an explicit root
   * `devDependencies` entry — rather than relying on the transitive hoist from `tsx` — means the
   * release path does not depend on npm's hoisting decisions, and the closure guard still sees it as
   * dev-only.
   */
  const rootManifest = workspaceManifest("package.json");
  assert.equal(rootManifest.dependencies, undefined, "the root manifest gained runtime dependencies");
  assert.ok(rootManifest.devDependencies.esbuild !== undefined, "esbuild is not declared as a dev dependency");
  assert.match(rootManifest.devDependencies.esbuild, /^\d+\.\d+\.\d+$/, "esbuild is not pinned to an exact version");

  // Asserted against the real closure walk rather than a copied constant, so the two cannot drift.
  const closure = execFileSync(process.execPath, [join(root, "scripts/dependency-closure.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(closure, /dependency closure: PASS/, "the runtime closure guard no longer passes");
  // Updated in 9K Task 1 with the `@fastify/static@8 -> ^10.1.3` security upgrade, which removed
  // twelve external packages (the `glob@11` chain) and added none. See tests/dependency-closure.test.mjs.
  assert.match(closure, /84 total = 10 workspace links \+ 74 external/, `the closure size changed:\n${closure}`);
  assert.ok(!/^\s+- node_modules\/esbuild/m.test(closure), "esbuild reached the runtime closure");
});

test("the packaging script fails closed on a violation", () => {
  /*
   * `--self-test` injects violations into the staging set and asserts each is refused. A packaging
   * script that only ever runs against a clean tree would exit 0 even if every check were a no-op —
   * the same reasoning as the 9J Task 2 closure guard's own self-test.
   */
  const output = execFileSync(process.execPath, [join(root, "scripts/pack.mjs"), "--self-test"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(output, /self-test: PASS/, `self-test did not pass:\n${output}`);
  assert.ok(!output.includes("FAIL"), `a self-test case was not refused:\n${output}`);
});
