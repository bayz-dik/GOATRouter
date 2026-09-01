/**
 * Mutation drill for the mobile drawer work.
 *
 * Each mutation reintroduces the reported bug (or a plausible near-miss of it) and the run
 * is expected to go RED. A mutation that stays green means the corresponding assertion is
 * decorative. Every file is restored byte-identically afterwards, verified by hash.
 *
 * Run from `apps/dashboard`:  node ../../scripts/drawer-mutations.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const CSS = "src/styles.css";
const SHELL = "src/Shell.tsx";

/** Every test that could plausibly catch a drawer regression. */
const SUITE = [
  "test/shell-responsive.test.ts",
  "test/App.test.tsx",
  "test/adversarial.test.tsx",
];

const MUTATIONS = [
  {
    name: "M1 the original bug: the mobile rail is display:none again",
    file: CSS,
    from: ".side-nav {\n  position: fixed;",
    to: ".side-nav {\n  display: none;\n  position: fixed;",
  },
  {
    name: "M2 the drawer never comes on-canvas (open state dropped)",
    file: CSS,
    from: ".side-nav[data-open] {\n  transform: translateX(0);",
    to: ".side-nav[data-open] {\n  transform: translateX(-100%);",
  },
  {
    name: "M3 the closed drawer stays in the tab order",
    file: CSS,
    from: "  transform: translateX(-100%);\n  visibility: hidden;",
    to: "  transform: translateX(-100%);\n  visibility: visible;",
  },
  {
    name: "M4 the backdrop covers the panel it should sit behind",
    file: CSS,
    from: ".nav-backdrop {\n  position: fixed;\n  inset: 0;\n  z-index: 35;",
    to: ".nav-backdrop {\n  position: fixed;\n  inset: 0;\n  z-index: 45;",
  },
  {
    name: "M5 the page behind the open drawer scrolls",
    file: CSS,
    from: ".app[data-menu-open] {\n  overflow: hidden;",
    to: ".app[data-menu-open] {\n  overflow: auto;",
  },
  {
    name: "M6 desktop keeps the hamburger beside the full rail",
    file: CSS,
    from: "  .nav-toggle,\n  .nav-backdrop {\n    display: none;\n  }",
    to: "  .nav-backdrop {\n    display: none;\n  }",
  },
  {
    name: "M7 desktop rail stays off-canvas (transform not unwound)",
    file: CSS,
    from: "    position: sticky;\n    width: auto;\n    z-index: auto;\n    transform: none;",
    to: "    position: sticky;\n    width: auto;\n    z-index: auto;",
  },
  {
    name: "M8 the 84px rail column is lost",
    file: CSS,
    from: "  .app {\n    grid-template-columns: 84px 1fr;\n  }",
    to: "  .app {\n    grid-template-columns: 1fr;\n  }",
  },
  {
    name: "M9 the drawer stays open over the screen it just opened",
    file: SHELL,
    /*
     * This must delete the close, not merely add a line near it. The first attempt
     * inserted a dead `if (false) setMenuOpen(false);` *above* the real call and
     * survived — correctly, because the drawer still closed. A mutation that does not
     * change behaviour proves nothing about the assertion aimed at it.
     */
    from:
      "      // Selecting always closes: on desktop the drawer is not open in the first place,\n" +
      "      // so this is a no-op there rather than a branch.\n" +
      "      setMenuOpen(false);",
    to: "      // MUTATION: the close is gone.",
  },
  {
    name: "M10 the trigger stops reporting its state",
    file: SHELL,
    from: "            aria-expanded={menuOpen}",
    to: "            aria-expanded={false}",
  },
  {
    name: "M11 the trigger loses its accessible name",
    file: SHELL,
    from: '              {menuOpen ? "Close navigation" : "Open navigation"}',
    to: '              {menuOpen ? "" : ""}',
  },
  {
    name: "M12 an invented nav entry is added to the canonical list",
    file: SHELL,
    from: '  { id: "chat", label: "Chat", icon: "\\u2338" },\n] as const;',
    to: '  { id: "chat", label: "Chat", icon: "\\u2338" },\n  { id: "settings", label: "Settings", icon: "\\u2318" },\n] as const;',
  },
  {
    name: "M13 Escape no longer dismisses the drawer",
    file: SHELL,
    from: '      if (event.key === "Escape") {',
    to: '      if (event.key === "EscapeNever") {',
  },
  {
    name: "M14 aria-controls points at nothing",
    file: SHELL,
    from: "            aria-controls={navId}",
    to: '            aria-controls="no-such-element"',
  },
];

function hash(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function run() {
  const result = spawnSync("npx", ["vitest", "run", ...SUITE], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const text = `${result.stdout}${result.stderr}`;
  const failed = /Tests\s+(\d+) failed/.exec(text);
  const passedOnly = /Tests\s+(\d+) passed/.exec(text);
  return {
    red: result.status !== 0,
    failed: failed ? Number(failed[1]) : 0,
    passed: passedOnly ? Number(passedOnly[1]) : 0,
    tail: text.trim().split("\n").slice(-4).join(" | "),
  };
}

const baselineHashes = new Map([CSS, SHELL].map((file) => [file, hash(file)]));

console.log("baseline (unmutated) — must be GREEN");
const baseline = run();
console.log(
  `  ${baseline.red ? "RED" : "GREEN"}  passed=${baseline.passed} failed=${baseline.failed}`,
);
if (baseline.red) {
  console.error("baseline is red; fix that before drilling mutations");
  process.exit(1);
}

let caught = 0;
const survivors = [];

for (const mutation of MUTATIONS) {
  const original = readFileSync(mutation.file, "utf8");
  if (!original.includes(mutation.from)) {
    console.error(`  SKIP  ${mutation.name} — anchor not found`);
    survivors.push(`${mutation.name} (anchor not found)`);
    continue;
  }
  writeFileSync(mutation.file, original.replace(mutation.from, mutation.to));
  const outcome = run();
  writeFileSync(mutation.file, original);
  if (hash(mutation.file) !== baselineHashes.get(mutation.file)) {
    console.error(`  RESTORE FAILED for ${mutation.file}`);
    process.exit(1);
  }
  if (outcome.red) {
    caught += 1;
    console.log(`  CAUGHT   ${mutation.name}  (${outcome.failed} failing)`);
  } else {
    survivors.push(mutation.name);
    console.log(`  SURVIVED ${mutation.name}  <-- assertion gap`);
  }
}

console.log(`\n${caught}/${MUTATIONS.length} mutations caught`);
if (survivors.length > 0) {
  console.log("survivors:");
  for (const name of survivors) {
    console.log(`  - ${name}`);
  }
}

const final = run();
console.log(
  `\nfinal (restored) — ${final.red ? "RED" : "GREEN"} passed=${final.passed} failed=${final.failed}`,
);
process.exit(survivors.length === 0 && !final.red ? 0 : 1);
