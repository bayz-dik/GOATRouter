#!/usr/bin/env node
/**
 * Release packaging — Phase 9J Task 4.
 *
 * **The problem this solves, measured rather than assumed.** `npm pack --workspace @bayz/server
 * --dry-run` on the pre-9J tree produced a 120.1 kB tarball of **57 files including all 29
 * `test/*.ts` files**, because `apps/server/package.json` had no `files` field. And `@bayz/server`
 * declares ten `@bayz/*` dependencies at version `0.1.0` — versions that exist only as workspace
 * symlinks in this checkout. **That tarball cannot install anywhere**: nothing resolves those names.
 *
 * **The packaging decision, stated before the code.** BAYZ ships as a *single self-contained
 * artifact*: one tarball whose `@bayz/*` code is compiled into bundles with the internal imports
 * resolved, and whose `package.json` declares only the external packages the bundle actually
 * imports. The alternative — publishing nine interdependent packages — needs a registry, version
 * coordination across ten manifests, and abandoning `private: true`. Phase 9 wants none of those, and
 * publishing is out of scope while the GitHub prohibition stands.
 *
 * Run directly it builds, verifies, and reports. Imported, it exposes each step so
 * `tests/pack.test.mjs` can assert the artifact's properties and prove the checks bite.
 */

import { buildSync } from "esbuild";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The artifact's package name. Not `@bayz/server`: what ships is the router, not one workspace. */
export const ARTIFACT_NAME = "bayz-router";

/**
 * Documented size bound: 2 MiB.
 *
 * The dashboard asset is the bulk of the artifact. The bound exists so a stray directory —
 * `node_modules`, a fuzz corpus, a database — shows up as a size failure even if it slips past every
 * name rule.
 */
export const SIZE_BOUND_BYTES = 2 * 1024 * 1024;

/**
 * Packages left as runtime imports rather than compiled in.
 *
 * Fastify resolves plugins by identity and reads their `package.json` metadata at runtime, so
 * inlining it turns plugin registration into a debugging problem to save a few hundred kilobytes.
 * Everything else — `react`, `react-dom`, `zod`, and all ten `@bayz/*` packages — is bundled.
 */
export const EXTERNAL_PACKAGES = ["@fastify/static", "fastify"];

export function workspaceManifestPaths(root = REPO_ROOT) {
  const paths = [];
  for (const dir of ["apps", "packages"]) {
    const base = join(root, dir);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = `${dir}/${entry.name}/package.json`;
      if (existsSync(join(root, manifest))) paths.push(manifest);
    }
  }
  return paths.sort();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/* ---------------------------------------------------------------- bundling */

/**
 * Bundle the server with `@bayz/*` inlined and the external packages left as imports.
 *
 * `esbuild` is already in the tree — both `tsx` and `vite` depend on it — and is declared as a root
 * **dev** dependency, so `scripts/dependency-closure.mjs` keeps reporting a native-free *runtime*
 * closure. It is the same compiler that already produces the dashboard bundle, so nothing new
 * arrives on the release path.
 *
 * `buildSync` rather than `build`: `tests/pack.test.mjs` builds the artifact once at module scope and
 * every assertion reads it, so an async build would put an `await` in front of every test.
 */
function bundleServer({ root, outFile }) {
  const result = buildSync({
    entryPoints: [join(root, "apps/server/src/index.ts")],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    outfile: outFile,
    external: [...EXTERNAL_PACKAGES, "node:*"],
    logLevel: "silent",
  });
  if (result.errors.length > 0) {
    throw new Error(`bundling failed: ${result.errors.map((entry) => entry.text).join("; ")}`);
  }
  return result;
}

/**
 * The `bin` entry, deliberately separate from the server bundle.
 *
 * Importing the server *starts* it: `apps/server/src/index.ts` builds the runtime and opens SQLite at
 * module scope, before `listen`, so a broken credential store refuses startup rather than serving
 * traffic. That is correct for a daemon and wrong for `--version`, which the plan requires to print
 * without touching the filesystem or opening a database. This entry answers the question first and
 * imports the server only when there is a server to run.
 *
 * The version is a build-time literal because reading `package.json` would be a filesystem access.
 *
 * It also defaults `BAYZ_DASHBOARD_ROOT` to the packaged dashboard. `apps/server/src/config.ts`
 * resolves that default relative to its own module URL (`../../dashboard/dist/`), which is right in
 * the workspace and wrong in the artifact's flat layout. Setting it here keeps the artifact's shape
 * out of the runtime source, and an operator's own value still wins.
 */
function binSource({ version }) {
  return `#!/usr/bin/env node
// GOAT ROUTER ${version} — generated by scripts/pack.mjs. Do not edit.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = ${JSON.stringify(version)};
const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  // No filesystem access and no database: printing a version must not create a data directory.
  process.stdout.write(VERSION + "\\n");
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    [
      "bayz " + VERSION,
      "",
      "Usage: bayz [--version] [--help]",
      "",
      "Configuration is by environment variable:",
      "  BAYZ_HOST             bind address (default 127.0.0.1)",
      "  BAYZ_PORT             bind port (default 20128)",
      "  BAYZ_DATA_DIR         data directory (see the install guide for the default chain)",
      "  BAYZ_DASHBOARD_ROOT   static dashboard root (defaults to the packaged bundle)",
      "",
    ].join("\\n"),
  );
  process.exit(0);
}

// The packaged dashboard sits beside this file. An operator-supplied value is never overridden.
if (process.env.BAYZ_DASHBOARD_ROOT === undefined) {
  process.env.BAYZ_DASHBOARD_ROOT = join(dirname(fileURLToPath(import.meta.url)), "dashboard");
}

await import("./server.mjs");
`;
}

/* ------------------------------------------------------------ tar, by hand */

/**
 * Write a deterministic gzipped ustar archive.
 *
 * Hand-rolled because the alternative is `execFile("tar", …)`, and `tar` is on the non-portable
 * binary list `tests/portability.test.mjs` enforces for user-run scripts: GNU tar, bsdtar, and the
 * tar bundled with Windows disagree about flags and about which metadata they record. Adding a
 * dependency for it would grow the runtime tree to save sixty lines.
 *
 * Every field recording *where and when the archive was built* is zeroed — mtime, uid, gid, uname,
 * and gname. Without that, two packs of identical inputs differ and a digest over the tarball
 * measures the clock rather than the contents.
 *
 * `options.mtime` exists **only so a test can inject non-determinism** and prove the byte-identity
 * comparison detects it. Production never passes it. A determinism claim that cannot be made to fail
 * on demand is not a claim, and this is the parameter that makes it falsifiable.
 */
function tarHeader({ name, size, mode, mtime }) {
  const header = Buffer.alloc(512);
  const write = (value, offset, length) => header.write(value.padEnd(length, "\0"), offset, length, "ascii");
  const octal = (value, offset, length) =>
    header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");

  if (Buffer.byteLength(name) > 100) throw new Error(`entry name too long for ustar: ${name}`);
  write(name, 0, 100);
  octal(mode, 100, 8);
  octal(0, 108, 8); // uid
  octal(0, 116, 8); // gid
  octal(size, 124, 12);
  octal(mtime ?? 0, 136, 12); // mtime — zero in production; injectable only for the determinism test
  write("        ", 148, 8); // checksum field starts as spaces, per the format
  write("0", 156, 1); // type: regular file
  write("", 157, 100); // linkname
  write("ustar", 257, 6);
  write("00", 263, 2);
  write("", 265, 32); // uname
  write("", 297, 32); // gname
  octal(0, 329, 8); // devmajor
  octal(0, 337, 8); // devminor
  write("", 345, 155); // prefix

  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

/**
 * Pack `entries` into a gzipped tar at `outPath`.
 *
 * `options.mtime` is a **test-only** non-determinism injection point; see `tarHeader`.
 *
 * The gzip call passes `mtime: 0` for documentation value rather than for effect. Measured on this
 * Node (v24.19.0): `zlib.gzipSync` emits a zero MTIME field whatever `mtime` is set to — `0`, a real
 * epoch second, a `Date`, or the option omitted entirely all produce `00000000` at bytes 4–7. So the
 * gzip header is *already* deterministic here and an assertion over those four bytes proves nothing
 * about this packer. **That is exactly the vacuous assertion a mutation exposed**: setting the gzip
 * mtime to the real clock left the suite green.
 *
 * The tar header mtime is where non-determinism actually lives on this platform, and it is what the
 * determinism test now drives.
 */
export function writeTarGz(entries, outPath, { mtime } = {}) {
  const parts = [];
  for (const entry of entries) {
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content);
    parts.push(tarHeader({ name: entry.name, size: content.length, mode: entry.mode ?? 0o644, mtime }));
    parts.push(content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) parts.push(Buffer.alloc(padding));
  }
  // Two zero blocks terminate the archive.
  parts.push(Buffer.alloc(1024));
  writeFileSync(outPath, gzipSync(Buffer.concat(parts), { level: 9, mtime: 0 }));
  return outPath;
}

export function readTarEntries(tarballPath) {
  const raw = gunzipSync(readFileSync(tarballPath));
  const entries = [];
  let offset = 0;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header[0] === 0) break;
    const field = (start, length) =>
      header.subarray(start, start + length).toString("ascii").replace(/\0.*$/, "").trim();
    const name = field(0, 100);
    const size = Number.parseInt(field(124, 12), 8) || 0;
    offset += 512;
    entries.push({ name, content: raw.subarray(offset, offset + size) });
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

export function entryText(entries, name) {
  const entry = entries.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`no such tarball entry: ${name}`);
  return entry.content.toString("utf8");
}

export function extractTo(tarballPath, destination) {
  for (const entry of readTarEntries(tarballPath)) {
    const target = join(destination, entry.name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.content);
  }
  return join(destination, "package");
}

/* ------------------------------------------------------------------ checks */

/**
 * The bare specifiers the shipped bundles import.
 *
 * Read from the built output rather than from any manifest, because that is where the truth lives.
 * `react`, `react-dom` and `zod` are directly declared external dependencies of the workspaces and
 * are **compiled into** the bundles: vite inlines React and the schema code into the dashboard asset,
 * and `apps/server` imports `@bayz/contracts` only with `import type`, which erases entirely.
 *
 * Declaring those three anyway would install `react`, `react-dom`, `scheduler` and `zod` — 86
 * packages in the closure instead of 82 — that nothing can ever load. Every installed package is
 * supply-chain surface, and one nothing imports is one nobody will notice going bad.
 */
export function bundleExternalImports(entries) {
  const found = new Set();
  const pattern =
    /(?:^|[\s;,{}])(?:import|export)[^;]{0,400}?from\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

  for (const entry of entries) {
    if (!entry.name.endsWith(".mjs") && !entry.name.endsWith(".js")) continue;
    const text = entry.content.toString("utf8");
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (specifier === undefined) continue;
      if (specifier.startsWith("node:")) continue;
      // Relative and absolute specifiers are internal to the artifact.
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
      const parts = specifier.split("/");
      found.add(specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]);
    }
  }
  return [...found].sort();
}

const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9_-]{8,}/, "sk- credential"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/, "Bearer token"],
  [/\b[0-9a-f]{64}\b/, "64-hex literal"],
  [/BEGIN [A-Z ]*PRIVATE KEY/, "private key"],
  [/hunter2/, "password fixture"],
  [/PROMPT_CONTENT_SENTINEL|COMPLETION_CONTENT_SENTINEL|PROVIDER_CREDENTIAL_SENTINEL/, "usage sentinel"],
  [/PROXY_CREDENTIAL_SENTINEL|BAYZ_AUTHORIZATION_SENTINEL|UPSTREAM_ERROR_BODY_SENTINEL/, "usage sentinel"],
  [/API-SMOKE-PROMPT-|API-SMOKE-COMPLETION-|PROMPT-ROUTER-SMOKE-/, "smoke sentinel"],
  [/AIza[0-9A-Za-z_-]{20,}/, "Google API key"],
];

/**
 * Scan the artifact's **bytes**, not its file list.
 *
 * A release tarball leaking a fixture credential is the worst outcome this phase can produce, and the
 * measured baseline — 29 test files shipped — is exactly how it happens. Scanning content also
 * catches a constant that survived tree-shaking into a bundle, which no filename rule would see.
 */
export function scanBytesForSecrets(entries) {
  const hits = [];
  for (const entry of entries) {
    const text = entry.content.toString("utf8");
    for (const [pattern, label] of SECRET_PATTERNS) {
      const match = pattern.exec(text);
      if (match !== null) hits.push(`${entry.name}: ${label} (${match[0].slice(0, 24)})`);
    }
  }
  return hits;
}

const FORBIDDEN_NAME_RULES = [
  [/(^|\/)test\//, "a test directory"],
  [/\.test\./, "a test file"],
  [/\.tsx?$/, "TypeScript source"],
  [/tsconfig\.json$/, "a tsconfig"],
  [/-smoke/, "a smoke script"],
  [/\/corpus\//, "a fuzz corpus file"],
  [/^package\/docs\//, "documentation"],
  [/\/\.git/, "a git file"],
  [/\.db(-wal|-shm)?$/, "a database"],
  [/\.env$|\/\.env/, "an env file"],
  [/\.(key|pem)$/, "key material"],
  [/(^|\/)node_modules\//, "an installed dependency"],
];

export function findForbiddenEntries(entries) {
  const violations = [];
  for (const entry of entries) {
    for (const [pattern, label] of FORBIDDEN_NAME_RULES) {
      if (pattern.test(entry.name)) violations.push(`${entry.name}: ${label}`);
    }
  }
  return violations;
}

export function findManifestViolations(manifest) {
  const violations = [];
  const declared = { ...(manifest.dependencies ?? {}), ...(manifest.optionalDependencies ?? {}) };
  for (const [name, range] of Object.entries(declared)) {
    if (name.startsWith("@bayz/")) violations.push(`${name}: workspace package declared as a dependency`);
    if (/^(file:|link:|portal:|\.{1,2}\/)/.test(range)) violations.push(`${name}: local path dependency ${range}`);
    if (/^(git|github|https?):/.test(range)) violations.push(`${name}: remote source dependency ${range}`);
  }
  if (manifest.devDependencies !== undefined) violations.push("devDependencies survived into the artifact");
  if (manifest.workspaces !== undefined) violations.push("a workspaces field survived into the artifact");
  if (manifest.private === true) violations.push("the artifact is marked private, so it cannot be installed");
  return violations;
}

/**
 * The licence the artifact may claim.
 *
 * **Resolved in 9K Task 3: the repository owner chose Apache-2.0.** A canonical `LICENSE` file sits at
 * the repository root and every workspace manifest declares the same identifier, so the artifact now
 * declares `Apache-2.0` and ships the licence text — Apache-2.0 clause 4(a) requires the copy to
 * travel with any redistribution.
 *
 * Before that decision this returned `UNLICENSED`, the SPDX marker for "no licence granted", because
 * there was no `LICENSE` file and no `license` field anywhere. That was *true* at the time; inventing
 * `MIT` to satisfy a checklist would have been a false statement about a legal fact, and a false
 * licence is worse than an honest absence.
 *
 * The fallback stays deliberately: if the `LICENSE` file is ever deleted, the artifact reverts to
 * `UNLICENSED` rather than claiming a licence it cannot ship.
 */
export function resolveLicense(root = REPO_ROOT) {
  const rootManifest = readJson(join(root, "package.json"));
  const licenseFile = ["LICENSE", "LICENSE.md", "LICENSE.txt"].find((name) => existsSync(join(root, name)));
  if (licenseFile === undefined) {
    return { identifier: "UNLICENSED", file: undefined };
  }
  const identifier = rootManifest.license;
  if (typeof identifier !== "string" || identifier.length === 0) {
    throw new Error(`${licenseFile} exists but the root package.json declares no license identifier`);
  }
  return { identifier, file: licenseFile };
}

/* -------------------------------------------------------------------- build */

function collectFiles(base, prefix) {
  const out = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const child = join(base, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(child, `${prefix}/${entry.name}`));
      continue;
    }
    out.push({ name: `${prefix}/${entry.name}`, content: readFileSync(child) });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * Stage and pack. Returns the tarball path and the staged entries.
 *
 * The dashboard bundle is **required, not built here**. Building it inside packing would make every
 * pack slow and would hide a stale dashboard behind an implicit rebuild;
 * `npm run build --workspace @bayz/dashboard` owns that step and `runtime:build` already runs it.
 * `apps/dashboard/dist` is gitignored, so a fresh clone must build before packing — which is stated
 * as an error rather than papered over.
 */
export function buildArtifact({ root = REPO_ROOT, outDir } = {}) {
  const destination = outDir ?? mkdtempSync(join(tmpdir(), "bayz-artifact-"));
  mkdirSync(destination, { recursive: true });

  const rootManifest = readJson(join(root, "package.json"));
  const serverManifest = readJson(join(root, "apps/server/package.json"));
  const version = rootManifest.version;

  const dashboardDist = join(root, "apps/dashboard/dist");
  if (!existsSync(join(dashboardDist, "index.html"))) {
    throw new Error(
      "apps/dashboard/dist/index.html is missing — run: npm run build --workspace @bayz/dashboard",
    );
  }

  // The external set is validated against the workspace manifest rather than trusted, so a removed
  // dependency is an error here instead of a runtime import failure on a user's machine.
  for (const name of EXTERNAL_PACKAGES) {
    if (serverManifest.dependencies?.[name] === undefined) {
      throw new Error(`apps/server/package.json no longer declares ${name}; EXTERNAL_PACKAGES is stale`);
    }
  }

  const staging = mkdtempSync(join(tmpdir(), "bayz-staging-"));
  const serverBundle = join(staging, "server.mjs");
  bundleServer({ root, outFile: serverBundle });

  const license = resolveLicense(root);

  const manifest = {
    name: ARTIFACT_NAME,
    version,
    description: "GOAT ROUTER — local-first LLM router with an OpenAI-compatible gateway",
    license: license.identifier,
    type: "module",
    engines: { node: ">=24.0.0" },
    bin: { bayz: "./dist/bayz.mjs" },
    // Ranges are copied from the workspace manifest, never written here: a hardcoded range would
    // drift the moment the workspace bumped its own, and the artifact would then install a version
    // nothing was tested against.
    dependencies: Object.fromEntries(
      EXTERNAL_PACKAGES.map((name) => [name, serverManifest.dependencies[name]]),
    ),
  };

  const entries = [
    { name: "package/package.json", content: `${JSON.stringify(manifest, null, 2)}\n` },
    { name: "package/README.md", content: readFileSync(join(root, "README.md")) },
    { name: "package/dist/server.mjs", content: readFileSync(serverBundle) },
    { name: "package/dist/bayz.mjs", content: binSource({ version }), mode: 0o755 },
    ...collectFiles(dashboardDist, "package/dist/dashboard"),
  ];

  if (license.file !== undefined) {
    entries.push({ name: "package/LICENSE", content: readFileSync(join(root, license.file)) });
  }

  entries.sort((a, b) => (a.name < b.name ? -1 : 1));

  const tarballPath = join(destination, `${ARTIFACT_NAME}-${version}.tgz`);
  writeTarGz(entries, tarballPath);

  return { tarballPath, manifest, entries, staging, version };
}

export function verifyArtifact(tarballPath) {
  const entries = readTarEntries(tarballPath);
  const manifest = JSON.parse(entryText(entries, "package/package.json"));
  const size = statSync(tarballPath).size;

  const problems = [
    ...findManifestViolations(manifest).map((entry) => `manifest: ${entry}`),
    ...findForbiddenEntries(entries).map((entry) => `contents: ${entry}`),
    ...scanBytesForSecrets(entries).map((entry) => `secret: ${entry}`),
  ];

  const imported = bundleExternalImports(entries);
  const declared = Object.keys(manifest.dependencies ?? {}).sort();
  for (const name of imported) {
    if (!declared.includes(name)) problems.push(`manifest: the bundle imports ${name} but the artifact does not declare it`);
  }
  for (const name of declared) {
    if (!imported.includes(name)) problems.push(`manifest: ${name} is declared but nothing in the bundle imports it`);
  }

  if (size >= SIZE_BOUND_BYTES) problems.push(`size: ${size} bytes exceeds the ${SIZE_BOUND_BYTES} byte bound`);

  return { entries, manifest, size, imported, declared, problems };
}

/**
 * Prove the checks reject what they claim to reject.
 *
 * A packaging script validated only against a clean tree would exit 0 even if every check returned an
 * empty array. Each case injects one violation into the real artifact's entry set and must be caught
 * — the same reasoning as the 9J Task 2 closure guard's own self-test.
 */
function selfTest(entries, manifest) {
  const cases = [
    [
      "a workspace dependency in the manifest",
      () => findManifestViolations({ ...manifest, dependencies: { ...manifest.dependencies, "@bayz/storage": "0.1.0" } }),
    ],
    [
      "a file: dependency in the manifest",
      () => findManifestViolations({ ...manifest, dependencies: { ...manifest.dependencies, thing: "file:../thing" } }),
    ],
    ["devDependencies in the manifest", () => findManifestViolations({ ...manifest, devDependencies: { tsx: "^4" } })],
    ["a private artifact", () => findManifestViolations({ ...manifest, private: true })],
    ["a shipped test file", () => findForbiddenEntries([...entries, { name: "package/test/api.test.ts", content: Buffer.alloc(0) }])],
    ["shipped TypeScript source", () => findForbiddenEntries([...entries, { name: "package/src/index.ts", content: Buffer.alloc(0) }])],
    ["a shipped database", () => findForbiddenEntries([...entries, { name: "package/bayz.db", content: Buffer.alloc(0) }])],
    ["a shipped env file", () => findForbiddenEntries([...entries, { name: "package/.env", content: Buffer.alloc(0) }])],
    ["a shipped node_modules entry", () => findForbiddenEntries([...entries, { name: "package/node_modules/x/index.js", content: Buffer.alloc(0) }])],
    ["a planted sk- credential", () => scanBytesForSecrets([{ name: "package/planted", content: Buffer.from("sk-abcdefghijklmnop") }])],
    ["a planted Bearer token", () => scanBytesForSecrets([{ name: "package/planted", content: Buffer.from(`Bearer ${"a".repeat(20)}`) }])],
    ["a planted 64-hex literal", () => scanBytesForSecrets([{ name: "package/planted", content: Buffer.from("0".repeat(64)) }])],
    ["a planted private key", () => scanBytesForSecrets([{ name: "package/planted", content: Buffer.from("-----BEGIN RSA PRIVATE KEY-----") }])],
    ["a planted usage sentinel", () => scanBytesForSecrets([{ name: "package/planted", content: Buffer.from("PROMPT_CONTENT_SENTINEL_7f3a91") }])],
  ];

  let failures = 0;
  for (const [label, run] of cases) {
    const caught = run().length > 0;
    console.log(`  ${caught ? "ok  " : "FAIL"} ${label} is rejected`);
    if (!caught) failures += 1;
  }

  // And the real artifact must not trip any of them, or the checks are simply always-on.
  const clean =
    findManifestViolations(manifest).length === 0 &&
    findForbiddenEntries(entries).length === 0 &&
    scanBytesForSecrets(entries).length === 0;
  console.log(`  ${clean ? "ok  " : "FAIL"} the real artifact trips none of the checks`);
  if (!clean) failures += 1;

  console.log(failures === 0 ? "self-test: PASS" : `self-test: FAIL (${failures})`);
  return failures === 0;
}

function main() {
  const outDir = join(REPO_ROOT, "packaging", "out");
  let built;
  try {
    built = buildArtifact({ root: REPO_ROOT, outDir });
  } catch (error) {
    console.log("GOAT ROUTER release packaging");
    console.log(`  FAILED: ${error.message}`);
    console.log("pack: FAIL");
    return 1;
  }

  const report = verifyArtifact(built.tarballPath);

  console.log("GOAT ROUTER release packaging");
  console.log(`  artifact: ${relative(REPO_ROOT, built.tarballPath).split(sep).join("/")}`);
  console.log(`  version: ${built.version}, licence: ${report.manifest.license}`);
  console.log(`  files: ${report.entries.length}`);
  for (const entry of report.entries) {
    console.log(`    ${String(entry.content.length).padStart(7)}  ${entry.name}`);
  }
  console.log(`  size: ${report.size} bytes (bound ${SIZE_BOUND_BYTES})`);
  console.log(`  declared dependencies: ${report.declared.join(", ") || "(none)"}`);
  console.log(`  bundle imports: ${report.imported.join(", ") || "(none)"}`);
  console.log("");

  if (report.problems.length > 0) {
    console.log(`  PROBLEMS (${report.problems.length}):`);
    for (const problem of report.problems) console.log(`    - ${problem}`);
    console.log("");
    console.log("pack: FAIL");
    return 1;
  }

  if (process.argv.includes("--self-test")) {
    console.log("self-test: proving the packaging checks reject synthetic violations");
    if (!selfTest(report.entries, report.manifest)) {
      console.log("pack: FAIL");
      return 1;
    }
    console.log("");
  }

  console.log("pack: PASS");
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
