#!/usr/bin/env node
/**
 * Built-bundle proof for Phase 7.
 *
 * The source scan in the test suite proves the *source* never persists a token.
 * This script proves the *shipped artifact* does not either: it builds the
 * dashboard and inspects the emitted JavaScript, which is what a browser actually
 * executes and what a reviewer can verify independently of the test suite.
 *
 * Exits non-zero on any failed check.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DASHBOARD = join(ROOT, "apps", "dashboard");
const DIST = join(DASHBOARD, "dist");

const failures = [];
let checks = 0;

function check(label, condition) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    failures.push(label);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function collect(dir, extensions) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
        found.push(full);
      }
    }
  };
  walk(dir);
  return found;
}

section("1. Build the dashboard from source");
{
  const build = spawnSync("npm", ["run", "build", "--workspace", "@bayz/dashboard"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  check("the dashboard build exits 0", build.status === 0);
  if (build.status !== 0) {
    console.error(build.stdout);
    console.error(build.stderr);
    process.exit(1);
  }
  check("dist exists", existsSync(DIST) && statSync(DIST).isDirectory());
}

section("2. Inspect the emitted JavaScript");
const scripts = collect(DIST, [".js", ".mjs"]);
check("at least one script was emitted", scripts.length > 0);

const bundle = scripts.map((file) => readFileSync(file, "utf8")).join("\n");
check("the bundle is non-trivial", bundle.length > 1000);

section("3. No persistence of any kind");
{
  const forbidden = [
    ["localStorage", /localStorage/],
    ["sessionStorage", /sessionStorage/],
    ["document.cookie assignment", /document\s*\.\s*cookie\s*=/],
    ["indexedDB", /indexedDB/],
    ["window.name assignment", /window\s*\.\s*name\s*=/],
  ];
  for (const [label, pattern] of forbidden) {
    check(`the bundle contains no ${label}`, !pattern.test(bundle));
  }
}

section("4. No unsafe DOM or eval escape hatch in our own code");
{
  // React's own runtime ships inside this bundle and both mentions
  // `dangerouslySetInnerHTML` in its prop dispatcher and assigns `.innerHTML`
  // internally, so bare substring searches for those would always fail here. Only
  // patterns our code could introduce are asserted at the bundle level; the
  // stricter per-file rules (no `.innerHTML =`, no `insertAdjacentHTML`) are
  // enforced against our own source in apps/dashboard/test/adversarial.test.tsx,
  // where React's code is not in scope.
  const forbidden = [
    ["dangerouslySetInnerHTML being set", /dangerouslySetInnerHTML\s*:/],
    ["document.write", /document\s*\.\s*write\s*\(/],
    ["eval(", /\beval\s*\(/],
    ["new Function(", /new\s+Function\s*\(/],
  ];
  for (const [label, pattern] of forbidden) {
    check(`the bundle contains no ${label}`, !pattern.test(bundle));
  }
}

section("5. No credential accessor and no secret literal");
{
  check(
    "no credential or password getter was shipped",
    !/getCredential|getPassword|revealCredential|revealPassword/.test(bundle),
  );
  // A 64-hex run is the shape of a Bayz API token or a root key; none may be
  // baked into the artifact.
  const hexMatches = bundle.match(/\b[0-9a-f]{64}\b/g) ?? [];
  check(
    `no 64-hex literal is embedded (found ${hexMatches.length})`,
    hexMatches.length === 0,
  );
  check("no sk- style credential literal is embedded", !/["'`]sk-[A-Za-z0-9_-]{8,}/.test(bundle));
  check(
    "no bearer literal is embedded",
    !/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/.test(bundle),
  );
}

section("6. The token field is write-only and unremembered");
{
  // Minified JSX emits the props as an object literal, so the assertion looks for
  // the token input's own shape rather than a bare "password" substring, which
  // React's input-type table also contains.
  check(
    "the token input is declared as a password field",
    /name:\s*`bayz-api-token`[\s\S]{0,80}type:\s*`password`/.test(bundle) ||
      /name:\s*"bayz-api-token"[\s\S]{0,80}type:\s*"password"/.test(bundle),
  );
  check(
    "autocomplete is disabled on it",
    /autoComplete:\s*[`"']off[`"']/.test(bundle),
  );
}

section("7. The Flux Core slot is present and empty");
{
  check(
    "the Flux Core mount point is emitted",
    /data-bayz-flux-core-slot/.test(bundle),
  );
  // The approved V2 source is supplied separately; nothing may stand in for it.
  check(
    "no animation primitive was invented for the slot",
    !/requestAnimationFrame/.test(bundle) && !/getContext\(["']2d["']\)/.test(bundle),
  );
}

section("8. Emitted HTML and CSS carry no secret");
{
  const assets = collect(DIST, [".html", ".css"]);
  const text = assets.map((file) => readFileSync(file, "utf8")).join("\n");
  check("html and css were emitted", assets.length > 0);
  check("no 64-hex literal in html or css", !/\b[0-9a-f]{64}\b/.test(text));
  check("no token-shaped attribute in html", !/value\s*=\s*["'][0-9a-f]{32,}/.test(text));
}

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length > 0) {
  console.error("dashboard smoke: FAIL");
  process.exit(1);
}
console.log("dashboard smoke: PASS");
