#!/usr/bin/env node
/**
 * Resolve the SERVED stylesheet against the shell's own selectors, per viewport.
 *
 * Why this exists: there is no browser on this host (`chromium-browser` is a snap stub and
 * the harness reports `chrome-not-running`), and jsdom computes no layout. So the drawer
 * cannot be *seen* here. What can be established without a renderer is which declarations
 * actually win at each viewport width — which is the mechanism the reported bug lived in:
 * `.side-nav` resolved to `display: none` below 640px with no drawer and no trigger.
 *
 * This is a report, not a substitute for looking at it. It prints the cascade result and
 * exits non-zero only if a viewport resolves to a state where navigation is unreachable.
 *
 *   node scripts/drawer-breakpoint-report.mjs                 # reads the built dist
 *   node scripts/drawer-breakpoint-report.mjs http://host:p   # reads a running Core
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ORIGIN = process.argv[2];

/** The stylesheet as a browser would receive it: from the server, or from `dist`. */
async function loadCss() {
  if (ORIGIN !== undefined) {
    const html = await (await fetch(new URL("/", ORIGIN))).text();
    // The emitted index links exactly one stylesheet; find it rather than guess the hash.
    const href = /<link[^>]+href="([^"]+\.css)"/.exec(html)?.[1];
    if (href === undefined) {
      throw new Error("the served index.html links no stylesheet");
    }
    const response = await fetch(new URL(href, ORIGIN));
    if (!response.ok) {
      throw new Error(`${href} returned ${response.status}`);
    }
    return { source: new URL(href, ORIGIN).href, css: await response.text() };
  }
  const dir = join(ROOT, "apps", "dashboard", "dist", "assets");
  const name = readdirSync(dir).find((file) => file.endsWith(".css"));
  if (name === undefined) {
    throw new Error(`no stylesheet in ${dir} — run the dashboard build first`);
  }
  return { source: join(dir, name), css: readFileSync(join(dir, name), "utf8") };
}

/**
 * Flatten a stylesheet into `{ query, selectors, body }` rules by brace balance.
 *
 * Regex cannot do this: a media block holds nested rules with their own braces, and a
 * selector list means a rule is not findable by one selector's text.
 */
function flatten(css, query = null) {
  const rules = [];
  let index = 0;
  while (index < css.length) {
    const open = css.indexOf("{", index);
    if (open < 0) break;
    const prelude = css.slice(index, open).trim();
    let depth = 0;
    let close = open;
    for (; close < css.length; close += 1) {
      if (css[close] === "{") depth += 1;
      else if (css[close] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const body = css.slice(open + 1, close);
    if (prelude.startsWith("@")) {
      if (/\{/.test(body)) {
        rules.push(...flatten(body, prelude.replace(/^@media\s*/, "").trim() || query));
      }
    } else if (prelude.length > 0) {
      rules.push({
        query,
        selectors: prelude.split(",").map((one) => one.replace(/\s+/g, " ").trim()),
        body,
      });
    }
    index = close + 1;
  }
  return rules;
}

/**
 * Whether a media query applies at a given width.
 *
 * Only the width dimension is evaluated, in both the authored (`min-width: 640px`) and the
 * minified range (`width>=640px`) spellings, since vite rewrites them. Anything mentioning
 * a pointer, an aspect ratio, or an orientation is reported as conditional rather than
 * guessed at — a report that quietly assumed a pointer type would be worse than one that
 * says it does not know.
 */
function appliesAt(query, width) {
  if (query === null) return true;
  if (/pointer|aspect-ratio|orientation|height/.test(query)) return null;
  const bounds = [
    ...query.matchAll(/min-width:\s*(\d+)px|width\s*>=\s*(\d+)px/g),
  ].map((match) => Number(match[1] ?? match[2]));
  const maxima = [
    ...query.matchAll(/max-width:\s*(\d+)px|width\s*<=\s*(\d+)px/g),
  ].map((match) => Number(match[1] ?? match[2]));
  if (bounds.some((min) => width < min)) return false;
  if (maxima.some((max) => width > max)) return false;
  return bounds.length > 0 || maxima.length > 0 ? true : null;
}

/** The winning value of a property for a selector at a width, following source order. */
function resolve(rules, selector, property, width) {
  let winner = null;
  for (const rule of rules) {
    if (!rule.selectors.includes(selector)) continue;
    if (appliesAt(rule.query, width) !== true && rule.query !== null) continue;
    const match = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`, "i").exec(rule.body);
    if (match) {
      winner = { value: match[1].replace(/\s+/g, " ").trim(), from: rule.query ?? "base" };
    }
  }
  return winner;
}

const { source, css } = await loadCss();
const rules = flatten(css);

console.log(`stylesheet: ${source}`);
console.log(`rules parsed: ${rules.length}\n`);

/** The three widths that decide the shell: phone, the 84px rail, the 224px rail. */
const VIEWPORTS = [360, 640, 1024];

const PROBES = [
  [".side-nav", "display"],
  [".side-nav", "position"],
  [".side-nav", "transform"],
  [".side-nav", "visibility"],
  [".side-nav[data-open]", "transform"],
  [".side-nav[data-open]", "visibility"],
  [".nav-toggle", "display"],
  [".nav-backdrop", "display"],
  [".mobile-head", "display"],
  [".nav-label", "display"],
  [".app", "grid-template-columns"],
];

const problems = [];

for (const width of VIEWPORTS) {
  console.log(`${width}px`);
  for (const [selector, property] of PROBES) {
    const winner = resolve(rules, selector, property, width);
    const shown = winner === null ? "(unset)" : `${winner.value}`;
    const origin = winner === null ? "" : `   <- ${winner.from}`;
    console.log(`  ${`${selector} { ${property} }`.padEnd(44)} ${shown}${origin}`);
  }

  /*
   * The load-bearing conclusion, stated per viewport rather than left to the reader.
   *
   * Below 640px navigation must be reachable through the drawer: the panel present (not
   * `display: none`) and a trigger visible. From 640px it must be the static rail with the
   * mobile chrome hidden.
   */
  const panelDisplay = resolve(rules, ".side-nav", "display", width)?.value ?? "block";
  const toggleDisplay = resolve(rules, ".nav-toggle", "display", width)?.value ?? "grid";
  const headDisplay = resolve(rules, ".mobile-head", "display", width)?.value ?? "flex";
  const openTransform = resolve(rules, ".side-nav[data-open]", "transform", width)?.value;

  if (width < 640) {
    const reachable =
      panelDisplay !== "none" && toggleDisplay !== "none" && headDisplay !== "none";
    /*
     * `translate(0)` and `translateX(0)` both mean on-canvas, and which one appears is a
     * minifier decision: vite rewrites the authored `translateX(0)` to `translate(0)`.
     * The first version of this check accepted only the authored spelling and reported a
     * correct build as broken — a defect in the report, found by running it.
     */
    const opens =
      openTransform !== undefined && /translate(?:x)?\(\s*0(?:px|%)?\s*\)/i.test(openTransform);
    console.log(
      `  => drawer reachable: ${reachable ? "YES" : "NO"}; opens on [data-open]: ${opens ? "YES" : "NO"}`,
    );
    if (!reachable) problems.push(`${width}px: navigation is unreachable`);
    if (!opens) problems.push(`${width}px: the drawer never comes on-canvas`);
  } else {
    const railVisible = panelDisplay !== "none";
    const chromeHidden = toggleDisplay === "none" && headDisplay === "none";
    console.log(
      `  => static rail: ${railVisible ? "YES" : "NO"}; mobile chrome hidden: ${chromeHidden ? "YES" : "NO"}`,
    );
    if (!railVisible) problems.push(`${width}px: the rail is hidden`);
    if (!chromeHidden) problems.push(`${width}px: mobile chrome is still visible`);
  }
  console.log("");
}

console.log("NOT verified by this script: rendered pixels, type metrics, tap-target size,");
console.log("motion, and how the artwork actually looks. No browser exists on this host.");

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("\nbreakpoint resolution: OK");
