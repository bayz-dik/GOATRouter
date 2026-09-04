/**
 * Smoke the rendered dashboard through a real browser.
 *
 * Usage: node scripts/ui-render-check.mjs [url] [token]
 *
 * jsdom performs no layout, so every existing dashboard test measures the DOM and the
 * emitted CSS rather than the picture. This drives headless Chromium over CDP: real
 * cascade, real box model, real canvas. It reports rather than asserts — the caller
 * reads the numbers.
 */
import { connect } from "./cdp-lib.mjs";

const URL_BASE = process.argv[2] ?? "http://127.0.0.1:21077";
const TOKEN = process.argv[3] ?? process.env.BAYZ_API_TOKEN ?? "";

const VIEWPORTS = [
  ["narrow mobile", 320, 568],
  ["normal mobile", 390, 844],
  ["tablet", 768, 1024],
  ["desktop", 1280, 800],
];

function line(label, value) {
  console.log(`${label.padEnd(34)} ${value}`);
}

const page = await connect();
try {
  await page.goto(`${URL_BASE}/`);
  line("title", await page.evaluate("return document.title;"));

  // ---- token gate ----
  const gate = await page.evaluate(`
    const heading = document.querySelector("h1, h2");
    const inputs = [...document.querySelectorAll("input")].map((i) => ({
      type: i.type,
      label: (document.querySelector('label[for="' + i.id + '"]')?.textContent ?? "").trim(),
    }));
    const navLabels = [...document.querySelectorAll("nav a, nav button")].map((n) => n.textContent.trim());
    return { heading: heading?.textContent?.trim() ?? null, inputs, navLabels };
  `);
  line("gate heading", JSON.stringify(gate.heading));
  line("gate inputs", JSON.stringify(gate.inputs));
  line("gate nav (must be empty)", JSON.stringify(gate.navLabels));

  if (TOKEN.length === 0) {
    console.log("\nno token supplied; stopping before unlock");
    process.exit(0);
  }

  // ---- unlock ----
  const unlocked = await page.evaluate(`
    const input = document.querySelector('input[type="password"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, ${JSON.stringify(TOKEN)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const button = [...document.querySelectorAll("button")].find((b) => /unlock|connect|sign/i.test(b.textContent));
    button?.click();
    return button?.textContent?.trim() ?? null;
  `);
  line("unlock button", JSON.stringify(unlocked));

  await new Promise((resolve) => setTimeout(resolve, 2500));
  const after = await page.evaluate(`
    return {
      nav: [...document.querySelectorAll(".side-nav a, .side-nav button")].map((n) => n.textContent.trim()),
      main: (document.querySelector("main")?.textContent ?? "").slice(0, 120),
    };
  `);
  line("nav after unlock", JSON.stringify(after.nav));
  line("main after unlock", JSON.stringify(after.main));

  // ---- per-viewport geometry ----
  for (const [name, width, height] of VIEWPORTS) {
    await page.setViewport(width, height, width < 640);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const layout = await page.evaluate(`
      const doc = document.documentElement;
      const nav = document.querySelector(".side-nav");
      const toggle = document.querySelector(".nav-toggle");
      const cs = (el) => (el === null ? null : getComputedStyle(el));
      const navStyle = cs(nav);
      const toggleStyle = cs(toggle);
      const rect = (el) => {
        if (el === null) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      };
      return {
        scrollW: doc.scrollWidth,
        clientW: doc.clientWidth,
        overflowX: doc.scrollWidth > doc.clientWidth,
        navPosition: navStyle?.position ?? null,
        navVisibility: navStyle?.visibility ?? null,
        navTransform: navStyle?.transform ?? null,
        toggleDisplay: toggleStyle?.display ?? null,
        toggleBox: rect(toggle),
      };
    `);
    console.log(`\n[${name} ${width}x${height}]`);
    line("  scrollW/clientW", `${layout.scrollW}/${layout.clientW}  overflowX=${layout.overflowX}`);
    line("  .side-nav", `position=${layout.navPosition} visibility=${layout.navVisibility} transform=${layout.navTransform}`);
    line("  .nav-toggle", `display=${layout.toggleDisplay} box=${JSON.stringify(layout.toggleBox)}`);
  }
} finally {
  page.close();
}
