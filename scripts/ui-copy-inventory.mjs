#!/usr/bin/env node
/**
 * Inventory user-facing text in the authenticated dashboard.
 *
 * Audit instrument, not a gate. It extracts JSX text nodes and the string literals that
 * reach the screen (`aria-label`, `title`, `placeholder`, label maps), then flags the ones
 * matching the locked copy rule so a cleanup can be argued from a list rather than from
 * memory.
 *
 * Deliberately crude on purpose: it over-reports rather than under-reports, because a
 * string it misses is a string that ships. Every hit is verified by hand before removal.
 *
 *   node scripts/ui-copy-inventory.mjs           # summary + flagged strings
 *   node scripts/ui-copy-inventory.mjs --all     # every extracted string
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "apps", "dashboard", "src");
const ALL = process.argv.includes("--all");

/** Copy the locked rule names as gimmick, decorative, or stale branding. */
const FLAGS = [
  [/\bFLUX\s*CORE(\s*V2)?\b/i, "flux-core"],
  [/\bDIRECT\s+ROUTE\b/i, "direct-route"],
  [/\bCOMBO\s+ROUTING\b/i, "combo-routing"],
  [/\bFAILOVER\s+SEQUENCE\b/i, "failover-sequence"],
  [/\bRELAY\s+TRACK\b/i, "relay-track"],
  [/^\s*(01|02|03)\s*\/\s*(SOURCE|HANDOFF|IMPACT)\s*$/i, "legend-caption"],
  [/\bBAYZ\b/, "stale-branding"],
  [/\bBayz\b/, "stale-branding"],
  [/\bSIM\b/, "sim-badge"],
  [/\bNODES\b/i, "jargon"],
  [/\bNETWORK\s+LOAD\b/i, "jargon"],
  [/\bDRILL\s+ACTIVE\b/i, "shouty-state"],
  [/\bAWAITING\s+CORE\b/i, "filler"],
  /*
   * Case-SENSITIVE, unlike the rest. The banned thing here is the shouting, not the fact:
   * `NOT REPORTED` in caps read as an error when it is a normal, expected state, and the
   * sentence-case `Not reported` that replaced it is the correct copy. An `/i` flag here
   * flagged the fix as the defect — which it did, on the first run of this script after the
   * cleanup.
   */
  [/\bNOT\s+REPORTED\b/, "shouty-state"],
  [/\bNOW\b/, "fake-liveness"],
  [/\bLIVE\b/, "liveness-word"],
];

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/** Strip comments so prose *about* a string is never inventoried as one. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const found = [];

for (const file of walk(SRC)) {
  const name = relative(SRC, file);
  const source = stripComments(readFileSync(file, "utf8"));

  /*
   * Four extraction passes, because user-facing text arrives four ways.
   *
   * 1. JSX text between tags — `>Reset view<`. Matched ACROSS newlines: JSX is normally
   *    formatted with the text on its own line, so a newline-excluding pattern misses
   *    almost every real string. The first version of this script did exactly that and
   *    reported 6 flagged strings when the true count was far higher — the reason this
   *    file exists as a script rather than as a claim.
   * 2. Template literals, INCLUDING those carrying `\uXXXX` escapes — the shouty meta
   *    lines are built that way, so excluding backslashes hid them.
   * 3. Attributes a screen reader or tooltip speaks: aria-label, title, placeholder.
   * 4. Label maps: `calm: "Calm"`, which reach buttons and badges.
   */
  for (const match of source.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) {
    const text = match[1].replace(/\s+/g, " ").trim();
    // A lone `/` or punctuation run is markup noise, not copy.
    if (text.length > 1 && /[A-Za-z]/.test(text)) {
      found.push({ file: name, kind: "jsx-text", text });
    }
  }
  for (const match of source.matchAll(/`([^`]{2,400})`/g)) {
    const text = match[1].replace(/\s+/g, " ").trim();
    // Skip pure code-ish templates (class name joins, selectors, urls).
    if (
      /[A-Za-z]/.test(text) &&
      !/^[a-z-]+$/.test(text) &&
      !/^\/|^https?:/.test(text) &&
      !/^[\w-]*\$\{[^}]*\}[\w-]*$/.test(text)
    ) {
      found.push({ file: name, kind: "template", text });
    }
  }
  for (const match of source.matchAll(
    /(aria-label|title|placeholder)\s*=\s*["']([^"']{2,200})["']/g,
  )) {
    found.push({ file: name, kind: match[1], text: match[2].trim() });
  }
  for (const match of source.matchAll(/^\s*[a-zA-Z_][\w]*:\s*"([^"]{2,80})",?\s*$/gm)) {
    found.push({ file: name, kind: "label-map", text: match[1] });
  }
  /*
   * Pass 5: display strings returned or selected in expressions —
   * `return "DIRECT ROUTE";`, `drilling ? "DRILL ACTIVE" : "Failover drill"`,
   * `summary === undefined ? "AWAITING CORE" : ...`.
   *
   * Without this pass the shouty mode words are invisible to the inventory, because they
   * never appear as JSX text. Restricted to literals that look like prose — containing a
   * space, or entirely upper case — so identifiers, css classes, and api paths are not
   * swept in.
   */
  for (const match of source.matchAll(/["']([^"'\n]{2,80})["']/g)) {
    const text = match[1].trim();
    const looksLikeCopy = /\s/.test(text) || /^[A-Z][A-Z0-9 /–—-]{1,}$/.test(text);
    const looksLikeCode =
      /^[a-z][\w.-]*$/.test(text) ||
      /^\//.test(text) ||
      /^https?:/.test(text) ||
      /^[\w-]+\/[\w-]+$/.test(text) ||
      /[<>{}]/.test(text);
    if (looksLikeCopy && !looksLikeCode) {
      found.push({ file: name, kind: "expression", text });
    }
  }
}

const flagged = [];
for (const entry of found) {
  for (const [pattern, reason] of FLAGS) {
    if (pattern.test(entry.text)) {
      flagged.push({ ...entry, reason });
      break;
    }
  }
}

if (ALL) {
  console.log(`=== every extracted string (${found.length}) ===`);
  const byFile = new Map();
  for (const entry of found) {
    byFile.set(entry.file, [...(byFile.get(entry.file) ?? []), entry]);
  }
  for (const [file, entries] of [...byFile].sort()) {
    console.log(`\n${file}`);
    for (const entry of entries) {
      console.log(`  [${entry.kind}] ${JSON.stringify(entry.text)}`);
    }
  }
  console.log("");
}

console.log(`=== flagged (${flagged.length}) ===`);
const byReason = new Map();
for (const entry of flagged) {
  byReason.set(entry.reason, [...(byReason.get(entry.reason) ?? []), entry]);
}
for (const [reason, entries] of [...byReason].sort()) {
  console.log(`\n${reason} (${entries.length})`);
  const seen = new Set();
  for (const entry of entries) {
    const key = `${entry.file}::${entry.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  ${entry.file.padEnd(28)} ${JSON.stringify(entry.text)}`);
  }
}
console.log(`\nstrings extracted: ${found.length}   flagged: ${flagged.length}`);
