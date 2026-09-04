import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const backup = await import(join(root, "scripts/backup-lib.mjs"));

function makeDataDir() {
  const dir = mkdtempSync(join(tmpdir(), "bayz-backup-test-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bayz.db"), "fake-db-bytes");
  writeFileSync(join(dir, "master.key"), "fake-key-bytes");
  writeFileSync(join(dir, "integrity.json"), '{"maxOpenCounter":1}');
  return dir;
}

test("createBackup produces a verifiable archive with a manifest", () => {
  const dataDir = makeDataDir();
  const out = join(dataDir, "backup.tgz");
  try {
    backup.createBackup({ dataDir, outPath: out, version: "0.1.0" });
    const { manifest, entries } = backup.verifyBackup(out);
    assert.equal(manifest.formatVersion, backup.BACKUP_FORMAT_VERSION);
    assert.equal(manifest.goatVersion, "0.1.0");
    assert.equal(manifest.files.length, 3);
    const names = entries.map((e) => e.name).sort();
    assert.deepEqual(names, ["bayz.db", "integrity.json", "manifest.json", "master.key"]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("verifyBackup rejects a corrupted archive", () => {
  const dataDir = makeDataDir();
  const out = join(dataDir, "backup.tgz");
  try {
    backup.createBackup({ dataDir, outPath: out, version: "0.1.0" });
    // Corrupt the archive bytes in place.
    const raw = readFileSync(out);
    raw[raw.length - 1] = raw[raw.length - 1] ^ 0xff;
    writeFileSync(out, raw);
    assert.throws(() => backup.verifyBackup(out));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("verifyBackup rejects a missing manifest", () => {
  const dataDir = makeDataDir();
  const out = join(dataDir, "backup.tgz");
  try {
    // Write a tarball with no manifest.
    backup.writeTarGz([{ name: "bayz.db", content: Buffer.from("x") }], out);
    assert.throws(() => backup.verifyBackup(out), /missing manifest/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("assertSafeEntryName rejects traversal and absolute paths", () => {
  assert.throws(() => backup.assertSafeEntryName("../evil"), /path traversal/);
  assert.throws(() => backup.assertSafeEntryName("/etc/passwd"), /absolute path/);
  assert.throws(() => backup.assertSafeEntryName("a/b"), /not a plain filename/);
  assert.throws(() => backup.assertSafeEntryName(""), /empty name/);
  assert.doesNotThrow(() => backup.assertSafeEntryName("bayz.db"));
});

test("restoreBackup refuses to overwrite existing data without --replace", () => {
  const dataDir = makeDataDir();
  const out = join(dataDir, "backup.tgz");
  const target = mkdtempSync(join(tmpdir(), "bayz-restore-target-"));
  try {
    backup.createBackup({ dataDir, outPath: out, version: "0.1.0" });
    // Target already has a database.
    writeFileSync(join(target, "bayz.db"), "existing");
    assert.throws(() => backup.restoreBackup({ archivePath: out, dataDir: target }), /already contains data/);
    // Original untouched.
    assert.equal(readFileSync(join(target, "bayz.db"), "utf8"), "existing");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("restoreBackup restores into a fresh runtime", () => {
  const dataDir = makeDataDir();
  const out = join(dataDir, "backup.tgz");
  const target = mkdtempSync(join(tmpdir(), "bayz-restore-fresh-"));
  try {
    backup.createBackup({ dataDir, outPath: out, version: "0.1.0" });
    backup.restoreBackup({ archivePath: out, dataDir: target });
    assert.equal(readFileSync(join(target, "bayz.db"), "utf8"), "fake-db-bytes");
    assert.equal(readFileSync(join(target, "master.key"), "utf8"), "fake-key-bytes");
    assert.equal(readFileSync(join(target, "integrity.json"), "utf8"), '{"maxOpenCounter":1}');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("restoreBackup with --replace overwrites and preserves a safety copy", () => {
  const dataDir = makeDataDir();
  const out = join(dataDir, "backup.tgz");
  const target = mkdtempSync(join(tmpdir(), "bayz-restore-replace-"));
  try {
    backup.createBackup({ dataDir, outPath: out, version: "0.1.0" });
    writeFileSync(join(target, "bayz.db"), "old-db");
    backup.restoreBackup({ archivePath: out, dataDir: target, replace: true });
    assert.equal(readFileSync(join(target, "bayz.db"), "utf8"), "fake-db-bytes");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("restoreBackup rejects a malformed archive and leaves the target intact", () => {
  const dataDir = makeDataDir();
  const out = join(dataDir, "backup.tgz");
  const target = mkdtempSync(join(tmpdir(), "bayz-restore-bad-"));
  try {
    backup.createBackup({ dataDir, outPath: out, version: "0.1.0" });
    writeFileSync(join(target, "bayz.db"), "original");
    // Corrupt the archive.
    const raw = readFileSync(out);
    raw[raw.length - 1] = raw[raw.length - 1] ^ 0xff;
    writeFileSync(out, raw);
    assert.throws(() => backup.restoreBackup({ archivePath: out, dataDir: target, replace: true }));
    assert.equal(readFileSync(join(target, "bayz.db"), "utf8"), "original");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("createBackup rejects a data dir missing an authoritative file", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "bayz-backup-missing-"));
  try {
    // only master.key present; bayz.db missing
    writeFileSync(join(dataDir, "master.key"), "k");
    assert.throws(
      () => backup.createBackup({ dataDir, outPath: join(dataDir, "x.tgz"), version: "0.1.0" }),
      /missing authoritative files/,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a path-traversal archive entry is refused at restore", () => {
  const dataDir = makeDataDir();
  const out = join(dataDir, "backup.tgz");
  const target = mkdtempSync(join(tmpdir(), "bayz-restore-traversal-"));
  try {
    backup.createBackup({ dataDir, outPath: out, version: "0.1.0" });
    // Rewrite the archive injecting a traversal entry.
    const entries = backup.readTarEntries(out);
    entries.push({ name: "../evil", content: Buffer.from("pwn") });
    backup.writeTarGz(entries, out);

    assert.throws(() => backup.restoreBackup({ archivePath: out, dataDir: target }));
    assert.equal(existsSync(join(target, "bayz.db")), false, "no file was restored for a traversal archive");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});
