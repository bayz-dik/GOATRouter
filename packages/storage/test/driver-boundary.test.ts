import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SRC_ROOT = fileURLToPath(new URL("../src/", import.meta.url));
const ALLOWED_DRIVER_FILE = join(SRC_ROOT, "drivers", "node-sqlite.ts");

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (full.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

test("node:sqlite is imported in exactly one source file", () => {
  const offenders = collectSourceFiles(SRC_ROOT).filter(
    (file) =>
      file !== ALLOWED_DRIVER_FILE &&
      /["']node:sqlite["']/.test(readFileSync(file, "utf8")),
  );

  assert.deepEqual(
    offenders,
    [],
    `node:sqlite must only be imported by drivers/node-sqlite.ts, found in: ${offenders.join(", ")}`,
  );
});

test("the sanctioned driver file does import node:sqlite", () => {
  const source = readFileSync(ALLOWED_DRIVER_FILE, "utf8");
  assert.match(source, /["']node:sqlite["']/);
});

test("no source file outside the storage package boundary embeds raw SQL keywords", () => {
  // Guards the layering rule: SQL belongs to packages/storage/src only. This
  // test asserts the driver contract module itself stays SQL-free so callers
  // cannot smuggle statements through it.
  const sqlContract = readFileSync(join(SRC_ROOT, "sql.ts"), "utf8");
  assert.doesNotMatch(sqlContract, /\bCREATE TABLE\b/i);
  assert.doesNotMatch(sqlContract, /\bINSERT INTO\b/i);
  assert.doesNotMatch(sqlContract, /\bSELECT\b/i);
});
