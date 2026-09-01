import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The typography and spacing system, asserted on the stylesheets.
 *
 * jsdom computes no layout and applies no stylesheet, so a rendered-DOM test cannot see a
 * font family, a size, or a gutter. These properties therefore have to be asserted where
 * they are declared. That makes this a source test by necessity rather than by preference —
 * and it is why it asserts on *tokens* rather than on individual rules: a token scale can
 * be checked for existence and use, whereas "is this 13px correct" cannot be.
 *
 * The contract:
 *
 *  1. One UI sans for everything a user reads as prose. Mono only where a value is
 *     technical — ids, endpoints, raw API strings.
 *  2. A closed set of size tokens. An arbitrary `font-size: 21px` in a rule is what made
 *     the hierarchy feel random, so sizes come from the scale or not at all.
 *  3. No display/techno family and no letter-spacing theatrics on body copy.
 *  4. No remote font. This is a regression guard on a property earlier phases established.
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
  throw new Error("Unable to locate apps/dashboard/src");
}

const SRC = resolveSrc();

/** A stylesheet with comments stripped, so prose about a rule is not read as one. */
function css(...parts: string[]): string {
  return readFileSync(join(SRC, ...parts), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
}

const SHELL = () => css("styles.css");
const FLUX = () => css("flux", "flux.css");

/** Declarations of a property across a stylesheet, normalised. */
function declarations(sheet: string, property: string): string[] {
  return [...sheet.matchAll(new RegExp(`${property}\\s*:([^;}]*)`, "gi"))].map((match) =>
    match[1].replace(/\s+/g, " ").trim().toLowerCase(),
  );
}

/**
 * The declaration block of the rule whose selector *list* includes a selector.
 *
 * `/\.button\s*\{([^}]*)\}/` is not enough and this is the second time that has bitten:
 * `.button` is declared once as the head of a seven-selector list shared with
 * `.bayz-actions button` and friends, so a pattern anchored to `.button {` finds nothing
 * and the assertion silently passes against an empty string. Splitting the prelude on `,`
 * and comparing exact selectors is what makes the answer trustworthy — and it refuses
 * `.button.small`, which is a different rule saying a different thing.
 */
function ruleFor(sheet: string, selector: string): string {
  let index = 0;
  const blocks: string[] = [];
  while (index < sheet.length) {
    const open = sheet.indexOf("{", index);
    if (open < 0) {
      break;
    }
    const close = sheet.indexOf("}", open);
    if (close < 0) {
      break;
    }
    const prelude = sheet.slice(index, open);
    const selectors = prelude
      .slice(prelude.lastIndexOf("}") + 1)
      .split(",")
      .map((one) => one.replace(/\s+/g, " ").trim());
    if (selectors.includes(selector)) {
      blocks.push(sheet.slice(open + 1, close));
    }
    index = close + 1;
  }
  return blocks.join("\n");
}

describe("typography — one restrained system", () => {
  it("declares a single closed type scale as tokens", () => {
    const sheet = SHELL();
    /*
     * The five roles the brief names. Declared as tokens on `:root` so every rule spends
     * them rather than inventing a size, which is the actual fix for "hierarchy feels
     * random" — a rule can be wrong, but it can no longer be arbitrary.
     */
    for (const token of [
      "--type-page-title",
      "--type-section-title",
      "--type-body",
      "--type-label",
      "--type-meta",
    ]) {
      expect(sheet, `${token} is not declared`).toContain(token);
    }
  });

  it("spends the scale instead of arbitrary pixel sizes", () => {
    const sheet = SHELL();
    const sizes = declarations(sheet, "font-size");
    expect(sizes.length).toBeGreaterThan(5);

    /*
     * Every `font-size` must be a token, a `clamp()`/`calc()` built from tokens, or `inherit`.
     * A bare `px` literal is the thing being removed: the audit found thirteen distinct
     * literal sizes from 9px to 40px across this file, which is a scale nobody designed.
     */
    const offenders = sizes.filter(
      (value) => !/var\(--type-/.test(value) && !/^inherit$/.test(value),
    );
    expect(
      offenders,
      `these font-size declarations bypass the scale: ${offenders.join(" | ")}`,
    ).toEqual([]);
  });

  it("renders prose in the UI sans and never in mono", () => {
    const sheet = SHELL();
    /*
     * Mono is legitimate for a technical value. It is not legitimate for navigation, so the
     * nav label rule must not select it — that was the clearest "techno" tell in the audit.
     */
    const navRule = ruleFor(sheet, ".nav-button");
    expect(navRule).not.toMatch(/font-family/);
    const navLabel = ruleFor(sheet, ".nav-label");
    expect(navLabel).not.toMatch(/mono/);
  });

  it("retires the display family from the dashboard chrome", () => {
    /*
     * `Archivo Black` / `Impact` / `Haettenschweiler` is a poster face. It is what made the
     * headings read as techno rather than strong, and the brief asks for weight instead. The
     * approved GOAT ROUTER artwork keeps its own lettering — that is an image, not a font.
     */
    const sheet = SHELL();
    expect(sheet).not.toMatch(/--bayz-font-display/);
    expect(sheet).not.toMatch(/archivo black/i);
    expect(sheet).not.toMatch(/haettenschweiler/i);
    expect(sheet).not.toMatch(/impact/i);
    // The flux panel had its own copy of the same stack, and a lock on one file would have
    // let the face survive in the other.
    const flux = FLUX();
    expect(flux).not.toMatch(/--flux-font-display/);
    expect(flux).not.toMatch(/archivo black/i);
  });

  it("carries the weight the display face used to supply", () => {
    /*
     * **This exists because retiring the family silently un-bolded every heading.**
     * `Archivo Black` is heavy at `font-weight: 400` — the weight *is* the face — so six
     * rules declared 400 and, once the family was gone, rendered as regular Archivo. The
     * scale assertions above all still passed: they check the size and the family and say
     * nothing about weight, which is exactly the gap this closes.
     *
     * A heading may be 700 or 800; what it may not be is the 400 that only made sense while
     * a black face was supplying the weight.
     */
    const sheet = SHELL();
    for (const selector of [
      ".screen-title",
      ".panel-head h2",
      ".panel-head h3",
      ".bayz-panel > h2",
      ".bayz-list-item strong",
      ".status-panel strong",
    ]) {
      const rule = ruleFor(sheet, selector);
      expect(rule, `${selector} has no rule`).not.toBe("");
      const weight = /font-weight\s*:\s*(\d+)/.exec(rule)?.[1];
      expect(weight, `${selector} declares no weight`).toBeDefined();
      expect(
        Number(weight),
        `${selector} is weight ${weight}, which was only heavy while Archivo Black supplied it`,
      ).toBeGreaterThanOrEqual(700);
    }
  });

  it("keeps letter-spacing off body copy and out of theatrical ranges", () => {
    for (const [name, sheet] of [
      ["styles.css", SHELL()],
      ["flux.css", FLUX()],
    ] as const) {
      for (const value of declarations(sheet, "letter-spacing")) {
        const em = /^(-?[\d.]+)em$/.exec(value);
        if (em === null) {
          continue;
        }
        /*
         * A small positive tracking on an uppercase micro-label is typography. `0.22em` is
         * decoration, and negative tracking below -0.02em is the display face's tight
         * setting, which leaves with it.
         */
        const amount = Number(em[1]);
        expect(
          amount,
          `${name} has theatrical letter-spacing ${value}`,
        ).toBeLessThanOrEqual(0.1);
        expect(amount, `${name} has display-tight tracking ${value}`).toBeGreaterThanOrEqual(
          -0.02,
        );
      }
    }
  });

  it("depends on no remote font", () => {
    // A regression guard: earlier phases removed the Google Fonts import and a strict CSP
    // has no `font-src` exception, so a reintroduced `@import` would break the deployment.
    for (const sheet of [SHELL(), FLUX()]) {
      expect(sheet).not.toMatch(/@import/);
      expect(sheet).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
      expect(sheet).not.toMatch(/url\(\s*['"]?https?:/i);
    }
  });
});

describe("spacing and alignment — a shared grid", () => {
  it("declares gutter and control-height tokens", () => {
    const sheet = SHELL();
    for (const token of ["--gutter", "--control-height"]) {
      expect(sheet, `${token} is not declared`).toContain(token);
    }
  });

  it("uses the gutter token for screen padding rather than per-breakpoint literals", () => {
    const sheet = SHELL();
    const screenRule = ruleFor(sheet, ".screen");
    expect(screenRule).toMatch(/var\(--gutter/);
    /*
     * And nowhere re-states it as a literal. The padding was declared four times — base,
     * 640px, 1024px, 1800px — which is how the screen edge and the panel edges came to
     * disagree. A `padding` literal in any `.screen` rule means the token is decorative.
     */
    expect(screenRule).not.toMatch(/padding[^;]*\d+px/);
  });

  it("normalizes button heights through one token", () => {
    const sheet = SHELL();
    /*
     * The audit found `min-height` set independently on `.button`, `.nav-button`,
     * `.period-button` and the flux controls, which is why controls did not line up. One
     * token, spent by each.
     *
     * `.nav-button` is deliberately excluded: the 54px rail row is approved-reference
     * geometry rather than a control size, and it is documented as such in the sheet.
     */
    for (const selector of [".button", ".period-button", ".tag", "input"]) {
      expect(
        ruleFor(sheet, selector),
        `${selector} does not spend --control-height`,
      ).toMatch(/var\(--control-height/);
    }
  });

  it("guards against horizontal overflow at the narrowest supported width", () => {
    const sheet = SHELL();
    // 320px is the floor the body already declares. `overflow-x: hidden` on the body is a
    // symptom-hider, so the real guard is that no rule pins a width wider than the floor.
    expect(sheet).toMatch(/min-width:\s*320px/);
    const fixedWide = [...sheet.matchAll(/(?:^|[;{\s])width:\s*(\d{3,})px/g)]
      .map((match) => Number(match[1]))
      .filter((width) => width > 320);
    expect(
      fixedWide,
      `fixed widths wider than the 320px floor: ${fixedWide.join(", ")}`,
    ).toEqual([]);
  });
});
