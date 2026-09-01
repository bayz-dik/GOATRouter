#!/usr/bin/env node
/*
 * Re-pin the two vite content-hashed asset names in tests/pack.test.mjs.
 *
 * Exists because the manual edit gets the ORDER wrong roughly half the time: the pinned
 * list is compared against `files.sort()`, so `index-CkPxq9A9.js` sorts BEFORE
 * `index-DX5J5t6e.css` (C < D) even though .css looks like it should come first. Sorting
 * the whole block here removes the guesswork.
 *
 *   node scripts/repin-dashboard-assets.mjs
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST = join(ROOT, "tests/pack.test.mjs");
const ASSETS = join(ROOT, "apps/dashboard/dist/assets");

const emitted = readdirSync(ASSETS);
const css = emitted.find((f) => f.endsWith(".css"));
const js = emitted.find((f) => f.endsWith(".js"));
if (css === undefined || js === undefined) {
  throw new Error(`expected a .css and a .js in ${ASSETS}, found: ${emitted.join(", ")}`);
}

let source = readFileSync(TEST, "utf8");

// The pinned array, located by its two anchors rather than by line number.
const start = source.indexOf('  assert.deepEqual(files, [');
const end = source.indexOf("]);", start);
if (start < 0 || end < 0) throw new Error("could not locate the pinned file list");

const block = source.slice(start, end);
const entries = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

const updated = entries
  .map((entry) =>
    entry.endsWith(".css")
      ? `package/dist/dashboard/assets/${css}`
      : entry.includes("/assets/") && entry.endsWith(".js")
        ? `package/dist/dashboard/assets/${js}`
        : entry,
  )
  // Same order the assertion compares against: `files` is `.sort()`ed.
  .sort();

const rebuilt =
  "  assert.deepEqual(files, [\n" + updated.map((e) => `    "${e}",`).join("\n") + "\n  ";

source = source.slice(0, start) + rebuilt + source.slice(end);
writeFileSync(TEST, source);

console.log(`re-pinned: ${css}, ${js}`);
for (const entry of updated) console.log(`  ${entry}`);
