/**
 * GOAT ROUTER release-based self-update.
 *
 * A user who installs `bayz` from a GitHub Release has only the packaged binary
 * and the runtime data directory — there is no repository checkout. Updating
 * those users must therefore be done by this module, which talks to the
 * official GitHub Releases feed for `bayz-dik/GOATRouter`, verifies the
 * artifact's SHA256 against the published checksum BEFORE installing, re-installs
 * the verified tarball into the same npm prefix, and can roll back to the
 * previous release if the new one fails to start.
 *
 * The runtime data directory is resolved by the same resolver the server uses and
 * is simply never touched here — `npm install` replaces the installed package in
 * place and has no relationship to the data directory.
 *
 * All the pure logic (semver, release parsing, checksum verification) is exported
 * so the pack tests can exercise it directly.
 */

import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The only allowed release source. Never point at anything else. */
const REPO = "bayz-dik/GOATRouter";
/** Overridable for isolated tests. Production always uses the official endpoint. */
const API_BASE =
  process.env.BAYZ_UPDATE_API_BASE === undefined
    ? "https://api.github.com/repos/bayz-dik/GOATRouter"
    : process.env.BAYZ_UPDATE_API_BASE;
/** Overridable for isolated tests so the real github.com is never hit. */
const DOWNLOAD_BASE =
  process.env.BAYZ_UPDATE_DOWNLOAD_BASE === undefined
    ? "https://github.com/bayz-dik/GOATRouter/releases/download"
    : process.env.BAYZ_UPDATE_DOWNLOAD_BASE;
/** Overridable for isolated tests. */
const INSTALL_PREFIX = process.env.BAYZ_UPDATE_PREFIX;

const ARTIFACT_PREFIX = "bayz-router-";
const ARTIFACT_SUFFIX = ".tgz";
const CHECKSUM_FILE = "SHA256SUMS.txt";

/** A released artifact plus where to download it and its checksum. */
export type Release = {
  version: string;
  artifactName: string;
  downloadUrl: string;
  checksumUrl: string;
};

/** The previous version, captured before an update so rollback can restore it. */
export type PreviousRelease = Release;

/* ------------------------------------------------------------------ semver */

/**
 * Compare two SemVer strings numerically, not lexically.
 *
 *   compareVersions("0.1.9", "0.1.10")  -> -1
 *   compareVersions("0.9.0", "1.0.0")   -> -1
 *   compareVersions("1.2.3", "1.2.3")   ->  0
 *   compareVersions("0.2.0", "0.1.10")  ->  1
 *
 * A leading "v" is stripped so "v0.1.0" and "0.1.0" compare equal. Prerelease
 * semantics (0.1.0-alpha < 0.1.0) are honoured, because release candidates must
 * never be treated as "newer stable".
 */
export function compareVersions(a: string, b: string) {
  const parse = (raw: string) => {
    const value = String(raw).replace(/^v/, "");
    const [core, prerelease] = value.split("-");
    const parts = core.split(".").map((part) => Number.parseInt(part, 10) || 0);
    while (parts.length < 3) parts.push(0);
    return { parts, prerelease: prerelease ?? undefined };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (x.parts[i] !== y.parts[i]) return x.parts[i] < y.parts[i] ? -1 : 1;
  }
  // Identical core: a release with no prerelease is newer than one with.
  if (x.prerelease === y.prerelease) return 0;
  if (x.prerelease === undefined) return 1;
  if (y.prerelease === undefined) return -1;
  return x.prerelease < y.prerelease ? -1 : 1;
}

/** True when `candidate` is strictly newer than `current`. */
export function isNewer(candidate: string, current: string) {
  return compareVersions(candidate, current) > 0;
}

/** The most recent stable version at or below `current` — for rollback. */
function versionTag(version: string) {
  const clean = String(version).replace(/^v/, "");
  return `v${clean}`;
}

/* -------------------------------------------------------------- release api */

/** Resolve base URLs, allowing explicit overrides (used by the isolated tests). */
function bases(options: { apiBase?: string; downloadBase?: string } = {}) {
  return {
    apiBase: options.apiBase ?? API_BASE,
    downloadBase: options.downloadBase ?? DOWNLOAD_BASE,
  };
}

/**
 * Fetch the release feed and pick the latest stable (non-draft, non-prerelease)
 * release. GitHub returns releases newest-first; the first stable one wins.
 */
export async function fetchLatestRelease(options = {}) {
  const { apiBase } = bases(options);
  const response = await fetch(`${apiBase}/releases?per_page=30`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "goat-router" },
  });
  if (!response.ok) {
    throw new Error(`GitHub Releases lookup failed (HTTP ${response.status})`);
  }
  const releases = await response.json();
  const stable = releases.find((release: { draft?: boolean; prerelease?: boolean; tag_name?: unknown; assets?: Array<{ name?: string }> }) => !release.draft && !release.prerelease);
  if (stable === undefined) {
    throw new Error("no stable release found on the GOATRouter release feed");
  }
  const tag = stable.tag_name;
  if (typeof tag !== "string" || !tag.startsWith("v")) {
    throw new Error(`unexpected release tag: ${String(tag)}`);
  }
  const version = tag.replace(/^v/, "");
  const { downloadBase } = bases(options);
  const artifact = stable.assets?.find((asset: { name?: string }) => asset.name === `${ARTIFACT_PREFIX}${version}${ARTIFACT_SUFFIX}`);
  const checksum = stable.assets?.find((asset: { name?: string }) => asset.name === CHECKSUM_FILE);
  if (artifact === undefined || checksum === undefined) {
    throw new Error(`release v${version} is missing its artifact or checksum asset`);
  }
  return {
    version,
    artifactName: artifact.name,
    downloadUrl: `${downloadBase}/${tag}/${artifact.name}`,
    checksumUrl: `${downloadBase}/${tag}/${CHECKSUM_FILE}`,
  };
}

/** Fetch the release for a specific version (used for rollback). */
export async function fetchReleaseForVersion(version: string, options: { apiBase?: string; downloadBase?: string } = {}) {
  const { apiBase, downloadBase } = bases(options);
  const response = await fetch(`${apiBase}/releases/tags/${versionTag(version)}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "goat-router" },
  });
  if (!response.ok) {
    throw new Error(`no release tagged ${versionTag(version)} (HTTP ${response.status})`);
  }
  const release = await response.json();
  const tag = release.tag_name;
  const artifact = release.assets?.find((asset: { name?: string }) => asset.name === `${ARTIFACT_PREFIX}${version.replace(/^v/, "")}${ARTIFACT_SUFFIX}`);
  const checksum = release.assets?.find((asset: { name?: string }) => asset.name === CHECKSUM_FILE);
  if (artifact === undefined || checksum === undefined) {
    throw new Error(`release ${tag} is missing its artifact or checksum asset`);
  }
  return {
    version: String(version).replace(/^v/, ""),
    artifactName: artifact.name,
    downloadUrl: `${downloadBase}/${tag}/${artifact.name}`,
    checksumUrl: `${downloadBase}/${tag}/${CHECKSUM_FILE}`,
  };
}

/* ---------------------------------------------------------------- downloads */

async function downloadBytes(url: string) {
  const response = await fetch(url, { headers: { "user-agent": "goat-router" } });
  if (!response.ok) {
    throw new Error(`download failed (HTTP ${response.status}): ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function sha256Hex(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Parse a SHA256SUMS.txt file. Expected per line:
 *   `<hex>  <artifact-name>`
 * Returns the expected sha for `artifactName`, or undefined if absent.
 */
export function checksumFor(checksumText: string, artifactName: string) {
  for (const line of checksumText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const [hex, name] = /^([0-9a-fA-F]{64})\s+(.+)$/.exec(trimmed)?.slice(1) ?? [];
    if (hex !== undefined && name === artifactName) return hex.toLowerCase();
  }
  return undefined;
}

/* ------------------------------------------------------------------- install */

/** The npm prefix the currently-installed package lives under. */
function resolveInstallPrefix(packageDir: string) {
  if (INSTALL_PREFIX !== undefined) return INSTALL_PREFIX;
  // bin path: <prefix>/node_modules/bayz-router/dist/bayz.mjs
  // package dir: <prefix>/node_modules/bayz-router
  const fromBin = resolve(packageDir, "..", "..");
  return fromBin;
}

function currentVersionFrom(packageRoot: string) {
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  return manifest.version;
}

/** Reinstall the given local tarball into the same prefix. Data dir untouched. */
function installTarball(prefix: string, tarballPath: string) {
  const result = spawnSync(
    "npm",
    ["install", tarballPath, "--prefix", prefix, "--omit=dev", "--no-audit", "--no-fund"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    throw new Error(`npm install of the release artifact failed (exit ${result.status}): ${(result.stderr ?? "").slice(-400)}`);
  }
}

function writeTemp(dir: string, name: string, bytes: Buffer) {
  writeFileSync(resolve(dir, name), bytes);
  return resolve(dir, name);
}

async function downloadAndVerifyTemp(dir: string, release: Release) {
  const artifactBytes = await downloadBytes(release.downloadUrl);
  const checksumBytes = await downloadBytes(release.checksumUrl);
  const artifactText = checksumBytes.toString("utf8");
  const expected = checksumFor(artifactText, release.artifactName);
  if (expected === undefined) {
    throw new Error(`SHA256SUMS.txt does not list ${release.artifactName}`);
  }
  const actual = sha256Hex(artifactBytes);
  if (actual !== expected) {
    throw new Error(
      `checksum mismatch: expected ${expected} got ${actual}; the artifact will NOT be installed`,
    );
  }
  const artifactPath = writeTemp(dir, release.artifactName, artifactBytes);
  writeTemp(dir, CHECKSUM_FILE, checksumBytes);
  return { artifactPath, artifactSha: actual };
}

/* ------------------------------------------------------------------- update */

/**
 * The release-based update flow. Always reads the current version from the
 * installed package, queries the official feed, and refuses to downgrade.
 *
 * Returns a report object describing what happened.
 */
export async function runUpdate({ packageRoot, tempDir, apiBase, downloadBase }: { packageRoot: string; tempDir: string; apiBase?: string; downloadBase?: string }) {
  const current = currentVersionFrom(packageRoot);
  const latest = await fetchLatestRelease({ apiBase, downloadBase });
  const resolved = bases({ apiBase, downloadBase });

  if (!isNewer(latest.version, current)) {
    return { action: "current", current, latest: latest.version };
  }

  const dir = tempDir;
  const { artifactPath, artifactSha } = await downloadAndVerifyTemp(dir, latest);
  const prefix = resolveInstallPrefix(packageRoot);

  // Back up the installed version's coordinates so rollback can restore it.
  const previous: PreviousRelease = {
    version: current,
    downloadUrl: `${resolved.downloadBase}/${versionTag(current)}/${ARTIFACT_PREFIX}${current}${ARTIFACT_SUFFIX}`,
    checksumUrl: `${resolved.downloadBase}/${versionTag(current)}/${CHECKSUM_FILE}`,
    artifactName: `${ARTIFACT_PREFIX}${current}${ARTIFACT_SUFFIX}`,
  };

  // The server reads BAYZ_DATA_DIR at startup and the package replacement does
  // not affect it, so the update never stops or restarts the user's server. We
  // verify the newly installed binary answers --version, and the caller can
  // restart as needed.
  installTarball(prefix, artifactPath);

  // Verify the installed version matches the release. Resolve the bin from the
  // installed package root rather than relying on PATH, which may not include
  // the prefix (e.g. an isolated install).
  const binPath = resolve(packageRoot, "dist", "bayz.mjs");
  const installed = execFileSync(process.execPath, [binPath, "--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (installed !== latest.version) {
    await rollback(previous, tempDir, prefix);
    throw new Error(`after install the CLI reports ${installed}, expected ${latest.version}; rolled back`);
  }

  return { action: "updated", from: current, to: latest.version, sha: artifactSha };
}

/** Roll back to a previous release version after a failed update. */
export async function rollback(release: PreviousRelease, tempDir: string, prefix: string) {
  const { artifactPath } = await downloadAndVerifyTemp(tempDir, release);
  installTarball(prefix, artifactPath);
}

/** A pure summary for `--check-update`. Never installs; only reports. */
export async function checkUpdate(packageRoot: string, options: { apiBase?: string; downloadBase?: string } = {}) {
  const current = currentVersionFrom(packageRoot);
  let latest;
  try {
    latest = await fetchLatestRelease(options);
  } catch (error) {
    return { current, latest: undefined, updateAvailable: false, error: error instanceof Error ? error.message : String(error) };
  }
  return {
    current,
    latest: latest.version,
    updateAvailable: isNewer(latest.version, current),
  };
}
