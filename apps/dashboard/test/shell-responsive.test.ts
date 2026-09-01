import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The drawer's breakpoint, asserted against the stylesheet itself.
 *
 * `App.test.tsx` covers the drawer's structure and behaviour — one canonical list, a
 * labelled trigger, `aria-expanded`, close-on-select — but it runs in jsdom, which
 * applies no stylesheet and computes no layout. Every assertion there would pass just as
 * happily if `.side-nav` were still `display: none` below 640px, which is the exact bug
 * being fixed: the markup was never the broken part.
 *
 * So the responsive half is asserted here, on the source CSS, as the two properties that
 * actually decide it:
 *
 *  1. Below 640px the navigation is a drawer — off-canvas, openable, and *reachable*.
 *  2. From 640px it is the rail the approved reference specifies, with the mobile-only
 *     chrome hidden, so desktop navigation is unchanged by any of this.
 *
 * This reads the source rather than the built bundle deliberately: the build minifies and
 * hashes, and a test that has to run `vite build` first would be slow enough to be
 * skipped. `dashboard-smoke.mjs` is what inspects the emitted artifact.
 */

/**
 * Locate `apps/dashboard/src` on disk.
 *
 * Same resolution `adversarial.test.tsx` uses, and for the same reason: jsdom rewrites
 * `import.meta.url` to an http scheme, and the cwd differs depending on whether Vitest was
 * started from the workspace or the repo root. `__dirname` is available because Vitest
 * transforms these files to CJS interop, but the cwd pair is what the suite already relies
 * on, so a miss is a hard failure rather than a silently empty read.
 */
function resolveSrc(): string {
  for (const candidate of [
    join(process.cwd(), "src"),
    join(process.cwd(), "apps", "dashboard", "src"),
  ]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("Unable to locate apps/dashboard/src for the stylesheet assertions");
}

const SRC = resolveSrc();

/** The stylesheet with comments stripped, so prose about a rule is never read as one. */
function stylesheet(): string {
  return readFileSync(join(SRC, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
}

type Rule = { selectors: string[]; body: string };

/**
 * Flat rules parsed out of a stylesheet fragment, by brace balance.
 *
 * Regex is not enough for either half of this. A selector *list*
 * (`.nav-toggle, .nav-backdrop`) means a rule cannot be found by its own selector text
 * alone, and an `@media` block contains nested rules with their own braces, so
 * `\{[^}]*\}` stops at the first inner one. Nested at-rule bodies are recursed into and
 * their rules returned flattened, which is what the callers want: they ask a fragment
 * "what does this say about `.side-nav`", never "how is it nested".
 */
function parseRules(css: string): Rule[] {
  const rules: Rule[] = [];
  let index = 0;
  while (index < css.length) {
    const open = css.indexOf("{", index);
    if (open < 0) {
      break;
    }
    const prelude = css.slice(index, open).trim();
    let depth = 0;
    let close = open;
    for (; close < css.length; close += 1) {
      if (css[close] === "{") {
        depth += 1;
      } else if (css[close] === "}") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }
    const body = css.slice(open + 1, close);
    if (prelude.startsWith("@")) {
      // A conditional group (`@media`, `@supports`): its body is more rules.
      if (/\{/.test(body)) {
        rules.push(...parseRules(body));
      }
    } else if (prelude.length > 0) {
      rules.push({
        selectors: prelude.split(",").map((one) => one.replace(/\s+/g, " ").trim()),
        body,
      });
    }
    index = close + 1;
  }
  return rules;
}

/**
 * Every `@media` body matching a query, concatenated.
 *
 * Plural on purpose: `styles.css` declares the same breakpoint more than once — the login
 * surface has its own 1024px block separate from the shell's — so taking only the first
 * match would report a rule as absent because it lives in the second.
 */
function media(css: string, query: string): string {
  const wanted = `@media ${query}`;
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const start = css.indexOf(wanted, from);
    if (start < 0) {
      break;
    }
    const open = css.indexOf("{", start);
    let depth = 0;
    let close = open;
    for (; close < css.length; close += 1) {
      if (css[close] === "{") {
        depth += 1;
      } else if (css[close] === "}") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }
    bodies.push(css.slice(open + 1, close));
    from = close + 1;
  }
  return bodies.join("\n");
}

/**
 * A property's effective value for one selector within a fragment.
 *
 * Selectors are matched exactly against each rule's selector list, because `.side-nav` and
 * `.side-nav[data-open]` are different rules saying opposite things and a substring match
 * would conflate them. Later declarations win, as the cascade does within one origin.
 */
function value(fragment: string, selector: string, property: string): string | null {
  let found: string | null = null;
  for (const rule of parseRules(fragment)) {
    if (!rule.selectors.includes(selector)) {
      continue;
    }
    const match = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`, "i").exec(rule.body);
    if (match) {
      found = match[1].replace(/\s+/g, " ").trim().toLowerCase();
    }
  }
  return found;
}

/** Whether a fragment declares any rule for a selector at all. */
function has(fragment: string, selector: string): boolean {
  return parseRules(fragment).some((rule) => rule.selectors.includes(selector));
}

/**
 * The shell's own rules: the stylesheet minus every `@media` body.
 *
 * This is what a viewport narrower than 640px gets, which is the state the reported bug
 * lived in. Asserting on the whole file instead would let a desktop override answer a
 * question about mobile.
 */
function baseLayer(css: string): string {
  let stripped = css;
  for (;;) {
    const start = stripped.indexOf("@media");
    if (start < 0) {
      return stripped;
    }
    const open = stripped.indexOf("{", start);
    let depth = 0;
    let close = open;
    for (; close < stripped.length; close += 1) {
      if (stripped[close] === "{") {
        depth += 1;
      } else if (stripped[close] === "}") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }
    stripped = stripped.slice(0, start) + stripped.slice(close + 1);
  }
}

describe("GOAT ROUTER shell — the stylesheet under test", () => {
  it("parses into the rules it is meant to assert on", () => {
    const css = stylesheet();
    /*
     * Not vacuous. Every assertion below is a lookup, and a lookup in an empty or
     * unparsed stylesheet reports "absent" for exactly the same reason a broken one does —
     * so the parser is proved to work before its answers are trusted.
     */
    expect(css.length).toBeGreaterThan(1000);
    const rules = parseRules(css);
    expect(rules.length).toBeGreaterThan(50);
    expect(has(baseLayer(css), ".side-nav")).toBe(true);
    expect(media(css, "(min-width: 640px)").length).toBeGreaterThan(0);
    expect(media(css, "(min-width: 1024px)").length).toBeGreaterThan(0);

    // A selector list is reachable by each of its members, which the drawer's
    // `.nav-toggle, .nav-backdrop` rule depends on.
    const lists = parseRules(css).filter((rule) => rule.selectors.length > 1);
    expect(lists.length).toBeGreaterThan(0);
  });
});

describe("GOAT ROUTER shell — mobile drawer stylesheet", () => {
  it("makes the navigation a real drawer below the breakpoint, not a hidden rail", () => {
    const base = baseLayer(stylesheet());
    expect(has(base, ".side-nav"), ".side-nav has no base rule").toBe(true);

    /*
     * The bug, stated as a test. The rail used to be `display: none` at mobile width with
     * no drawer and no trigger, so the only navigation on a phone was a caption that
     * looked like a two-item menu. A `display: none` element cannot be revealed by a
     * `[data-open]` attribute, cannot transition, and is invisible to a screen reader.
     */
    expect(value(base, ".side-nav", "display")).not.toBe("none");

    // Off-canvas and out of the tab order while closed — hidden, but present.
    expect(value(base, ".side-nav", "position")).toBe("fixed");
    expect(value(base, ".side-nav", "transform")).toBe("translatex(-100%)");
    expect(value(base, ".side-nav", "visibility")).toBe("hidden");

    // Scrollable, because seven entries plus the brand and foot exceed a short viewport.
    expect(value(base, ".side-nav", "overflow-y")).toBe("auto");
  });

  it("opens on the attribute the shell actually sets", () => {
    /*
     * `Shell.tsx` renders `data-open` on `.side-nav` while the drawer is open. A rule keyed
     * to any other attribute or class would leave the drawer permanently off-canvas with
     * every jsdom test still green, so the selector is pinned to the DOM contract at both
     * ends.
     */
    const base = baseLayer(stylesheet());
    expect(has(base, ".side-nav[data-open]"), "no open state is declared").toBe(true);
    expect(value(base, ".side-nav[data-open]", "transform")).toBe("translatex(0)");
    expect(value(base, ".side-nav[data-open]", "visibility")).toBe("visible");

    const shell = readFileSync(join(SRC, "Shell.tsx"), "utf8");
    expect(shell).toContain("data-open=");
    expect(shell).toContain("data-menu-open=");
  });

  it("dims the page behind the open drawer and stops it scrolling", () => {
    const base = baseLayer(stylesheet());

    // The backdrop is what makes a tap outside dismiss the drawer, and it must sit above
    // the page but below the panel — otherwise it covers the menu it exists to dismiss.
    expect(has(base, ".nav-backdrop"), ".nav-backdrop has no rule").toBe(true);
    expect(value(base, ".nav-backdrop", "position")).toBe("fixed");

    const backdropZ = Number(value(base, ".nav-backdrop", "z-index"));
    const panelZ = Number(value(base, ".side-nav", "z-index"));
    expect(Number.isFinite(backdropZ)).toBe(true);
    expect(Number.isFinite(panelZ)).toBe(true);
    expect(panelZ).toBeGreaterThan(backdropZ);

    // Scroll lock, applied to the shell rather than `body` so nothing outside this
    // component is touched.
    expect(has(base, ".app[data-menu-open]"), "no scroll lock is declared").toBe(true);
    expect(value(base, ".app[data-menu-open]", "overflow")).toBe("hidden");
  });

  it("carries no second navigation list for mobile", () => {
    /*
     * `.side-nav` *is* the drawer. A `.mobile-nav` rule would mean a second set of buttons
     * built from a second list, which could drift from `SCREENS` and would make every
     * `getByRole("button", { name })` in the suite ambiguous.
     */
    expect(stylesheet()).not.toContain(".mobile-nav");
  });
});

describe("GOAT ROUTER shell — desktop navigation is unchanged", () => {
  it("restores the approved static rail at 640px", () => {
    const block = media(stylesheet(), "(min-width: 640px)");

    // The approved 84px rail column.
    expect(value(block, ".app", "grid-template-columns")).toBe("84px 1fr");

    /*
     * Every drawer-only property is unwound, so the rail is the plain sticky column the
     * reference specifies. Missing any one of these would leave a desktop rail that is
     * off-canvas, invisible, or floating over the content.
     */
    expect(has(block, ".side-nav"), ".side-nav is not restored at 640px").toBe(true);
    expect(value(block, ".side-nav", "position")).toBe("sticky");
    expect(value(block, ".side-nav", "transform")).toBe("none");
    expect(value(block, ".side-nav", "visibility")).toBe("visible");
    expect(value(block, ".side-nav", "display")).not.toBe("none");
  });

  it("hides every mobile-only control from 640px up", () => {
    const block = media(stylesheet(), "(min-width: 640px)");

    /*
     * The trigger and backdrop are meaningless once the rail is permanent, and a visible
     * hamburger beside a full rail is the clearest possible sign of a broken breakpoint.
     * Each selector is checked on its own so a rule that hides only one of them fails.
     */
    expect(value(block, ".nav-toggle", "display")).toBe("none");
    expect(value(block, ".nav-backdrop", "display")).toBe("none");
    expect(value(block, ".mobile-head", "display")).toBe("none");
  });

  it("keeps the approved 224px rail and its labels at 1024px", () => {
    const block = media(stylesheet(), "(min-width: 1024px)");

    expect(value(block, ".app", "grid-template-columns")).toBe("224px 1fr");

    // Labels return at the wide rail; the 640px rail is icon-only by design.
    expect(value(block, ".nav-label", "display")).toBe("block");
    expect(value(block, ".side-foot", "display")).toBe("block");
  });
});
