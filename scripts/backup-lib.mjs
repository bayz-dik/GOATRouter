#!/usr/bin/env node
/**
 * GOAT ROUTER backup / restore / verify — deterministic, portable archive.
 *
 * The authoritative runtime state is exactly three files:
 *   bayz.db        all domain state (providers, routes, proxies, identities,
 *                  usage) plus the encrypted secret envelopes
 *   master.key     the KEK required to decrypt those envelopes
 *   integrity.json the open-counter witness (rollback detection)
 *
 * WAL/SHM are transient (removed on a clean close) and pid/log are lifecycle
 * only, so none of them are backed up. A consistent snapshot is produced by a
 * controlled stop (clean WAL close) before the copy, and the server is restarted
 * afterwards.
 *
 * The archive is a deterministic gzipped ustar tarball (same writer as the
 * release packer) containing a manifest plus the three files. The manifest
 * records the format version, GOAT ROUTER version, creation time, source data
 * dir, the included logical files, and a SHA256 of each. No plaintext secret
 * ever enters the manifest — the database bytes are ciphertext and the key is
 * a random 32-byte blob.
 *
 * Restore is conservative: verify the archive, extract into a staging
 * directory, refuse to overwrite an existing runtime unless --replace, and swap
 * atomically. Path traversal and absolute paths are rejected.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

export const BACKUP_FORMAT_VERSION = 1;
export const MANIFEST_NAME = "manifest.json";
export const AUTHORITATIVE_FILES = ["bayz.db", "master.key", "integrity.json"];

/* ------------------------------------------------------------- tar (ustar) */

function tarHeader({ name, size, mode }) {
  const header = Buffer.alloc(512);
  const write = (value, offset, length) =>
    header.write(value.padEnd(length, "\0"), offset, length, "ascii");
  const octal = (value, offset, length) =>
    header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");

  if (Buffer.byteLength(name) > 100) throw new Error(`entry name too long for ustar: ${name}`);
  write(name, 0, 100);
  octal(mode, 100, 8);
  octal(0, 108, 8); // uid
  octal(0, 116, 8); // gid
  octal(size, 124, 12);
  octal(0, 136, 12); // mtime — zeroed for determinism
  write("        ", 148, 8); // checksum placeholder
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

export function writeTarGz(entries, outPath) {
  const parts = [];
  for (const entry of entries) {
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content);
    parts.push(tarHeader({ name: entry.name, size: content.length, mode: entry.mode ?? 0o600 }));
    parts.push(content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) parts.push(Buffer.alloc(padding));
  }
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

/* ------------------------------------------------------------- manifest */

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function buildManifest({ version, dataDir, files }) {
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    goatVersion: version,
    createdAt: new Date().toISOString(),
    sourceDataDir: dataDir,
    files: files.map((name) => ({
      name,
      sha256: sha256Hex(readFileSync(join(dataDir, name))),
    })),
  };
}

/* ------------------------------------------------------------- create */

/**
 * Create a backup archive of the authoritative runtime files.
 *
 * `dataDir` must already be in a consistent state (server stopped, WAL closed).
 * Returns the archive path.
 */
export function createBackup({ dataDir, outPath, version }) {
  const missing = AUTHORITATIVE_FILES.filter((name) => !existsSync(join(dataDir, name)));
  if (missing.length > 0) {
    throw new Error(`cannot back up: missing authoritative files: ${missing.join(", ")}`);
  }

  const manifest = buildManifest({ version, dataDir, files: AUTHORITATIVE_FILES });
  const entries = [
    { name: MANIFEST_NAME, content: `${JSON.stringify(manifest, null, 2)}\n`, mode: 0o600 },
    ...AUTHORITATIVE_FILES.map((name) => ({
      name,
      content: readFileSync(join(dataDir, name)),
      mode: 0o600,
    })),
  ];
  return writeTarGz(entries, outPath);
}

/* ------------------------------------------------------------- verify */

/**
 * Verify an archive without restoring it: structure, manifest, required files,
 * and SHA256 of each. Throws on any problem.
 */
export function verifyBackup(archivePath) {
  const entries = readTarEntries(archivePath);
  const manifestEntry = entries.find((entry) => entry.name === MANIFEST_NAME);
  if (manifestEntry === undefined) {
    throw new Error("backup is not a GOAT ROUTER archive: missing manifest");
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.content.toString("utf8"));
  } catch (error) {
    throw new Error(`backup manifest is not valid JSON: ${error.message}`);
  }
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(
      `unsupported backup format version ${manifest.formatVersion}; expected ${BACKUP_FORMAT_VERSION}`,
    );
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("backup manifest lists no files");
  }

  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  for (const file of manifest.files) {
    if (typeof file.name !== "string" || typeof file.sha256 !== "string") {
      throw new Error("backup manifest has a malformed file entry");
    }
    const entry = byName.get(file.name);
    if (entry === undefined) {
      throw new Error(`backup is missing file ${file.name}`);
    }
    const actual = sha256Hex(entry.content);
    if (actual !== file.sha256) {
      throw new Error(`checksum mismatch for ${file.name}: expected ${file.sha256} got ${actual}`);
    }
  }

  // The archive must not contain anything beyond the manifest and the listed
  // files — an unexpected entry is a sign of tampering or a malformed backup.
  const expected = new Set([MANIFEST_NAME, ...manifest.files.map((file) => file.name)]);
  for (const entry of entries) {
    if (!expected.has(entry.name)) {
      throw new Error(`backup contains unexpected entry: ${entry.name}`);
    }
  }

  return { manifest, entries };
}

/* ------------------------------------------------------------- traversal */

/**
 * Reject path traversal and absolute paths in an archive entry name.
 * A backup entry must be a plain basename (bayz.db, master.key, integrity.json).
 */
export function assertSafeEntryName(name) {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("archive entry has an empty name");
  }
  if (isAbsolute(name)) {
    throw new Error(`archive entry has an absolute path: ${name}`);
  }
  const parts = name.split(/[\\/]/);
  if (parts.some((part) => part === "..")) {
    throw new Error(`archive entry contains path traversal: ${name}`);
  }
  if (parts.length !== 1) {
    throw new Error(`archive entry is not a plain filename: ${name}`);
  }
}

/* ------------------------------------------------------------- restore */

/**
 * Restore a verified backup into a data directory.
 *
 * Conservative by design:
 *  - verifies the archive first (structure, manifest, checksums)
 *  - extracts into a staging directory, never directly into the runtime dir
 *  - refuses to overwrite an existing runtime unless `replace` is true
 *  - swaps atomically (rename) so a failed restore leaves the original intact
 */
export function restoreBackup({ archivePath, dataDir, replace = false }) {
  const { manifest, entries } = verifyBackup(archivePath);

  // Refuse to overwrite existing data unless explicitly asked.
  const existing = existsSync(join(dataDir, "bayz.db"));
  if (existing && !replace) {
    throw new Error(
      "target runtime already contains data; pass --replace to overwrite it (a safety backup is made first)",
    );
  }

  // Stage into a sibling directory so the swap is atomic.
  const parent = dirname(dataDir);
  const staging = join(parent, `.bayz-restore-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });

  try {
    for (const file of manifest.files) {
      assertSafeEntryName(file.name);
      const entry = entries.find((candidate) => candidate.name === file.name);
      if (entry === undefined) {
        throw new Error(`backup is missing file ${file.name}`);
      }
      writeFileSync(join(staging, file.name), entry.content, { mode: 0o600 });
    }
    chmodSync(staging, 0o700);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  // Safety backup of the existing runtime before replacement.
  if (existing && replace) {
    const safety = join(parent, `.bayz-pre-restore-${Date.now()}`);
    mkdirSync(safety, { recursive: true, mode: 0o700 });
    for (const name of AUTHORITATIVE_FILES) {
      const src = join(dataDir, name);
      if (existsSync(src)) {
        writeFileSync(join(safety, name), readFileSync(src), { mode: 0o600 });
      }
    }
  }

  // Atomic swap: move the old data dir aside, move staging into place.
  const backupDir = join(parent, `.bayz-old-${process.pid}`);
  rmSync(backupDir, { recursive: true, force: true });
  if (existsSync(dataDir)) {
    renameSync(dataDir, backupDir);
  }
  try {
    renameSync(staging, dataDir);
  } catch (error) {
    // Roll back: restore the original directory.
    if (existsSync(backupDir)) {
      rmSync(dataDir, { recursive: true, force: true });
      renameSync(backupDir, dataDir);
    }
    throw error;
  }
  rmSync(backupDir, { recursive: true, force: true });

  return { manifest };
}

/* ------------------------------------------------------------- CLI */

function usage() {
  console.log("GOAT ROUTER backup tool");
  console.log("");
  console.log("Usage: node scripts/backup-lib.mjs <command>");
  console.log("");
  console.log("  create <dataDir> <outPath> [version]   create a backup archive");
  console.log("  verify <archivePath>                   verify an archive without restoring");
  console.log("  restore <archivePath> <dataDir> [--replace]");
  console.log("");
}

const [command, ...rest] = process.argv.slice(2);

if (
  process.argv[1] !== undefined &&
  statSync(process.argv[1]).isFile() &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  mainCli();
}

function mainCli() {
  try {
    if (command === "create") {
      const [dataDir, outPath, version] = rest;
      if (!dataDir || !outPath) throw new Error("create requires <dataDir> <outPath>");
      const path = createBackup({ dataDir, outPath, version: version ?? "0.0.0" });
      console.log(`backup created: ${path}`);
    } else if (command === "verify") {
      const [archivePath] = rest;
      if (!archivePath) throw new Error("verify requires <archivePath>");
      const { manifest } = verifyBackup(archivePath);
      console.log(`backup OK: format v${manifest.formatVersion}, ${manifest.files.length} files`);
    } else if (command === "restore") {
      const [archivePath, dataDir, flag] = rest;
      if (!archivePath || !dataDir) throw new Error("restore requires <archivePath> <dataDir>");
      const { manifest } = restoreBackup({
        archivePath,
        dataDir,
        replace: flag === "--replace",
      });
      console.log(`restored ${manifest.files.length} files to ${dataDir}`);
    } else {
      usage();
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`backup: ${error.message}`);
    process.exitCode = 1;
  }
}
