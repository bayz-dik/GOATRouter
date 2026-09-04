#!/usr/bin/env node
/**
 * Remote-load reference detection for the install smoke.
 *
 * The bundle under test is served from the packaged artifact. The property we
 * prove is that the served dashboard never *loads* a resource from a remote
 * origin at runtime — a `<script src>`, a `<link href>`, a CSS `@import`, a
 * dynamic `import(...)`, or a `fetch(...)` pointing at an `http(s)` URL.
 *
 * A bare hostname string is NOT a load. The dashboard bundle deliberately
 * contains provider-kind classifier regular expressions (for example
 * `/generativelanguage\.googleapis\.com$/` to recognise a Gemini endpoint) and
 * placeholder/help URLs (`https://react.dev/errors/…`, `https://api.example.com`,
 * `https://json-schema.org`). All of those are inert data. The old smoke regex
 * matched `googleapis` anywhere, so the Gemini classifier tripped "loads a
 * remote origin" even though nothing is fetched. This module matches only the
 * load forms, so provider-family strings such as Gemini stay green while a real
 * `<script src="https://cdn…">` or `fetch("https://…")` still fails.
 */

/** The load forms that constitute an actual remote resource load. */
export const REMOTE_LOAD_PATTERNS = [
  // <script src="https://…">, <img src="https://…">
  /\bsrc=["']https?:\/\//i,
  // <link href="https://…">, <a href="https://…">
  /\bhref=["']https?:\/\//i,
  // CSS @import url(https://…)
  /@import\s+url\(\s*["']?https?:\/\//i,
  // CSS url(https://…) used as a fetched image/font
  /url\(\s*["']?https?:\/\//i,
  // dynamic import("https://…")
  /\bimport\(\s*["']https?:\/\//,
  // fetch("https://…")
  /\bfetch\(\s*["']https?:\/\//,
];

/**
 * True when `text` references a remote resource load (anything that would make
 * the browser or the runtime fetch bytes from an external origin at execute
 * time). Bare hostnames that merely appear in data strings do not count.
 */
export function hasRemoteLoadReference(text) {
  return REMOTE_LOAD_PATTERNS.some((pattern) => pattern.test(text));
}

function main() {
  // Each tuple: [text, expectedDetected]. Bare hostnames and classifier/help
  // strings must stay green; real load forms must be caught.
  const cases = [
    // Provider classifier and placeholder strings — inert data.
    ["[/(^\\\\.)generativelanguage\\\\.googleapis\\\\.com$/, `gemini`]", false],
    ["googleapis", false],
    ["https://react.dev/errors/1", false],
    ["https://api.example.com/v1", false],
    ["https://json-schema.org/draft/2020-12/schema", false],
    // Real remote loads — must be detected.
    ['<script src="https://cdn.example.com/app.js"></script>', true],
    ['<link href="https://fonts.example.com/x.css" rel="stylesheet">', true],
    ["@import url(https://cdn.example.com/x.css);", true],
    ['fetch("https://evil.example.com/api")', true],
    ['import("https://evil.example.com/mod.js")', true],
  ];
  const failures = [];
  for (const [text, expected] of cases) {
    const detected = hasRemoteLoadReference(text);
    if (detected !== expected) {
      failures.push(
        `${JSON.stringify(text)} ${detected ? "falsely flagged" : "missed"}`,
      );
    }
  }
  if (failures.length > 0) {
    process.stderr.write(`remote-load self-check FAIL\n  ${failures.join("\n  ")}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `${cases.length} remote-load reference cases: PASS\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  main();
}
