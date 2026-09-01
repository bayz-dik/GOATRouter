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

/**
 * Record one check, numbered.
 *
 * The number is what makes a citation resolvable: 9L Task 1's `resolveEvidence` refuses
 * `smoke:<script>#<n>` against a script that prints no numbers, because `#n` cannot be looked up in
 * output that has none — and 9L Task 2's feature inventory needs exactly that citation for the
 * Phase 1-8 features this script proves. **Numbers are contractual: append checks, never insert
 * one**, or every citation after the insertion point silently starts pointing at the wrong check.
 */
function check(label, condition) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${String(checks).padStart(2)}  ${label}`);
  } else {
    console.error(`  FAIL ${String(checks).padStart(2)}  ${label}`);
    failures.push(`#${checks} ${label}`);
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

section("7. The approved Flux Core V2 is mounted, with no invented motion");
{
  check(
    "the Flux Core mount point is emitted",
    /data-bayz-flux-core-slot/.test(bundle),
  );
  // The approved engine drives frames; that is expected and required.
  check("the relay canvas engine is present", /requestAnimationFrame/.test(bundle));
  check("the approved relay stage markup is present", /relay-wrap/.test(bundle));
  check(
    "the approved Calm / Live / Surge semantics are present",
    /Calm/.test(bundle) && /Surge/.test(bundle),
  );
  check(
    "the approved provider positions are present",
    /p1/.test(bundle) && /p5/.test(bundle),
  );
  check(
    "no WebGL context was substituted for the approved Canvas 2D",
    !/getContext\(\s*[`"']webgl/i.test(bundle),
  );
}

section("8. No remote font, script, or stylesheet dependency");
{
  const assets = collect(DIST, [".html", ".css", ".js", ".mjs"]);
  const all = assets.map((file) => readFileSync(file, "utf8")).join("\n");
  check("assets were emitted for the scan", assets.length > 0);
  check(
    "no Google Fonts reference survives the build",
    !/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(all),
  );
  check("no @import remains in the emitted css", !/@import/.test(
    collect(DIST, [".css"]).map((file) => readFileSync(file, "utf8")).join("\n"),
  ));
  /*
   * XML namespace URIs, JSON Schema `$schema` identifiers, and React's error-doc
   * links are string constants inside React and zod. None is ever fetched, so a
   * blanket URL match would fail on library internals rather than on a real
   * dependency. The check below looks for origins that a browser would actually
   * load from, which is the property that matters for CSP and local-first.
   */
  const FETCHED_URL_RE =
    /(?:src|href|url\(|import\s*\(|from\s*['"`])\s*['"`(]?\s*(https?:\/\/[a-z0-9.-]+)/gi;
  const LOCAL_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost)/i;
  const fetched = [...all.matchAll(FETCHED_URL_RE)]
    .map((match) => match[1])
    .filter((origin) => !LOCAL_ORIGIN_RE.test(origin));
  check(
    `no remote origin is loaded (found ${fetched.length})`,
    fetched.length === 0,
  );
  check(
    "no bare font or CDN host appears anywhere",
    !/fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr|unpkg\.com|cdnjs\.cloudflare/i.test(all),
  );
  const html = collect(DIST, [".html"]).map((file) => readFileSync(file, "utf8")).join("\n");
  check(
    "no remote script tag is emitted",
    !/<script[^>]+src\s*=\s*["']https?:/i.test(html),
  );
  check(
    "no remote stylesheet link is emitted",
    !/<link[^>]+href\s*=\s*["']https?:/i.test(html),
  );
}

section("9. Scalable provider constellation is present");
{
  check("the zoomable provider field is emitted", /flux-field/.test(bundle));
  check("the local provider mark table is emitted", /provider-mark/.test(bundle));
  check(
    "the safe short-id scheme is emitted",
    /PVD-/.test(bundle),
  );
  check("the incident list is emitted", /incident-row/.test(bundle));
  /*
   * React's runtime mentions `dangerouslySetInnerHTML` in its prop dispatcher, so
   * the narrower "is it ever passed as a prop" form is checked here — the same
   * distinction section 4 already makes. What matters is that no icon path can
   * become markup: marks come from a local svg table keyed by a validated string.
   */
  check(
    "no provider-supplied icon source can be rendered",
    !/dangerouslySetInnerHTML\s*:/.test(bundle) && !/createElement\(\s*[`"']img/.test(bundle),
  );
  // Aggregation would hide failed providers, which the requirement forbids.
  check(
    "no aggregate \"+N providers\" abstraction was shipped",
    !/\+\$\{[^}]*\}\s*providers?/i.test(bundle),
  );
}

section("10. The built dashboard is compatible with a strict CSP");
{
  const html = collect(DIST, [".html"]).map((file) => readFileSync(file, "utf8")).join("\n");

  /*
   * `style-src 'self'` forbids a literal style attribute and an inline <style>
   * element. React's `style` prop is a DOM property assignment and is unaffected,
   * which is exactly why this asserts on the emitted HTML rather than the source.
   */
  check("no inline style attribute in emitted html", !/\sstyle\s*=\s*["']/.test(html));
  check("no inline <style> element in emitted html", !/<style[\s>]/i.test(html));
  check(
    "no inline script element in emitted html",
    !/<script(?![^>]*\ssrc\s*=)[^>]*>[^<]/i.test(html),
  );
  check("no inline event handler in emitted html", !/\son[a-z]+\s*=\s*["']/i.test(html));
  check("no javascript: url in emitted html", !/javascript:/i.test(html));
  // `script-src 'self'` means every script must be an external same-origin file.
  const scriptTags = html.match(/<script[^>]*>/gi) ?? [];
  check(
    `every script tag has a src (${scriptTags.length} found)`,
    scriptTags.every((tag) => /\ssrc\s*=\s*["']\//.test(tag)),
  );
  check("no eval or Function constructor in the bundle", !/\beval\s*\(|new\s+Function\s*\(/.test(bundle));
}

section("11. Emitted HTML and CSS carry no secret");
{
  const assets = collect(DIST, [".html", ".css"]);
  const text = assets.map((file) => readFileSync(file, "utf8")).join("\n");
  check("html and css were emitted", assets.length > 0);
  check("no 64-hex literal in html or css", !/\b[0-9a-f]{64}\b/.test(text));
  check("no token-shaped attribute in html", !/value\s*=\s*["'][0-9a-f]{32,}/.test(text));
}

/*
 * Appended, never inserted: check numbers are contractual citations (see `check`), so this
 * section starts after the existing 48 rather than beside the navigation checks it relates
 * to.
 *
 * Why it exists: the mobile drawer's correctness lives in CSS, and the test suite runs
 * under jsdom, which applies no stylesheet. `test/shell-responsive.test.ts` asserts the
 * *source* CSS; this asserts the **emitted** CSS, which is a different claim — vite
 * minifies media queries into range syntax (`(width>=640px)`), and a build that dropped or
 * rewrote a breakpoint would still leave the source test green.
 */
section("12. The authenticated mobile drawer survived the build");
{
  const css = collect(DIST, [".css"]).map((file) => readFileSync(file, "utf8")).join("\n");
  const html = collect(DIST, [".html"]).map((file) => readFileSync(file, "utf8")).join("\n");

  // The reported bug: below the breakpoint the rail was `display:none` with no drawer and
  // no trigger, so a phone had no way to change screen.
  check("the drawer panel is emitted", /\.side-nav\{[^}]*position:fixed/.test(css));
  check(
    "the drawer opens on the attribute the shell sets",
    /\.side-nav\[data-open\]\{[^}]*translatex?\(0\)/i.test(css),
  );
  check("the drawer backdrop is emitted", /\.nav-backdrop\{/.test(css));
  check("the menu trigger is emitted", /\.nav-toggle\{/.test(css));
  check(
    "the scroll lock behind the open drawer is emitted",
    /\.app\[data-menu-open\]\{[^}]*overflow:hidden/.test(css),
  );

  /*
   * Both breakpoints survive minification. Written as two alternatives because vite
   * rewrites `(min-width: 640px)` to the range form `(width>=640px)`; asserting only the
   * authored spelling would pass on a stylesheet that shipped neither.
   */
  const at640 = /@media\s*\((?:min-width:\s*640px|width>=640px)\)/.test(css);
  const at1024 = /@media\s*\((?:min-width:\s*1024px|width>=1024px)\)/.test(css);
  check("the 640px breakpoint is emitted", at640);
  check("the 1024px breakpoint is emitted", at1024);

  // Desktop navigation is unchanged: the approved rail columns are still there.
  check("the approved 84px rail column is emitted", /grid-template-columns:84px 1fr/.test(css));
  check("the approved 224px rail column is emitted", /grid-template-columns:224px 1fr/.test(css));

  /*
   * One nav, not two. A `.mobile-nav` rule would mean a second button list built from a
   * second source, free to drift from `SCREENS`.
   */
  check("no second mobile navigation was shipped", !/\.mobile-nav[\s{,.:]/.test(css));

  // The trigger is labelled rather than an unlabelled glyph, and it reports its state.
  check("the menu trigger ships an accessible name", /Open navigation/.test(bundle));
  check("the menu trigger ships its closed-state name", /Close navigation/.test(bundle));
  check("the menu trigger ships aria-expanded", /aria-expanded/.test(bundle));

  /*
   * The preview caption that caused the report — `<screen> / FLUX CORE V2` in the mobile
   * header — is gone from the shipped markup. `FLUX CORE V2` itself still appears in the
   * rail foot, which is a real label for the relay visualization, so this asserts on the
   * caption's own class rather than banning the string.
   */
  check("the preview header caption class is gone", !/shell-tag/.test(`${css}\n${bundle}`));

  /*
   * Every canonical screen is reachable from the one list.
   *
   * Matched as `label:<quote>Name<quote>` with the quote left open, because this bundler
   * emits string literals in **backticks**, not double quotes. The first version of these
   * checks asserted `"Home"` and failed on a correct build — which is the right kind of
   * failure to have found here rather than in a citation six months from now. Pinning
   * `label:` as well as the name keeps it from matching a screen heading or a table cell
   * that happens to contain the same word.
   */
  const navLabel = (label) => new RegExp(`label:["'\`]${label}["'\`]`);
  for (const label of ["Home", "Usage", "Providers", "Routes", "Proxies", "Identities", "Chat"]) {
    check(`the ${label} entry is emitted`, navLabel(label).test(bundle));
  }
  // `Settings` is not a screen the product has, so it must not ship as a nav label.
  check("no inert Settings entry was shipped", !navLabel("Settings").test(bundle));

  // The login surface stays navigation-free: the shell is not in the pre-auth markup.
  check("the emitted shell is client-rendered, not baked into the html", !/side-nav/.test(html));
}

/*
 * ================= 13. the direct provider setup flow survived the build =================
 *
 * Asserted on the emitted artifact rather than only in jsdom, because the *ordering* of the
 * form is a build-time property of the bundle and a `<details>` that vite tree-shook or a
 * label that got renamed would leave every component test green.
 */
{
  const css = collect(DIST, [".css"]).map((file) => readFileSync(file, "utf8")).join("\n");
  const html = collect(DIST, [".html"]).map((file) => readFileSync(file, "utf8")).join("\n");

  // The three primary fields, by the ids their labels point at.
  check("the display name field is emitted", /provider-display-name/.test(bundle));
  check("the base URL field is emitted", /provider-base-url/.test(bundle));
  check("the API key field is emitted", /provider-api-key/.test(bundle));

  /*
   * The key field is a password input with autocomplete off, exactly as the per-row
   * credential field is. A `type="text"` key box would put a live credential on screen and
   * into the browser's autofill store.
   *
   * The quote class is left open because this bundler emits **backticks** — the same thing
   * that broke checks 63-69 on a correct build the first time round, so the lesson is
   * applied here rather than relearned.
   */
  check(
    "the API key field is a password input with autocomplete off",
    /provider-api-key[\s\S]{0,200}type:["'`]password["'`][\s\S]{0,80}autoComplete:["'`]off["'`]/.test(
      bundle,
    ),
  );

  // Advanced exists as a real disclosure element, and holds the overrides.
  check("the advanced disclosure is emitted", /bayz-advanced/.test(bundle));
  check("the advanced disclosure is styled", /\.bayz-advanced/.test(css));
  check("the provider id override is emitted", /provider-id-note/.test(bundle));
  check("the compatibility fields are emitted", /provider-discovery-path/.test(bundle));
  check("the loopback opt-in is still emitted", /provider-allow-loopback/.test(bundle));

  /*
   * `Add provider` and `Add and test connection` both ship. The second is what makes setup
   * verifiable in one pass instead of create-then-hunt-for-the-row.
   */
  check("the add button is emitted", /Add provider/.test(bundle));
  check("the create-and-test button is emitted", /Add and test connection/.test(bundle));

  /*
   * A proxy is optional and the shipped copy says so. This is the one claim in the flow that
   * is a product promise rather than a mechanism, so it is asserted on the bytes that reach
   * the operator.
   */
  check("the shipped copy states that a proxy is optional", /A proxy is optional/.test(bundle));

  /*
   * No credential-shaped literal rode along with the new field. The existing scan (checks
   * 44-48) covers the whole bundle; this is the same property re-asserted after adding a
   * form that handles a key, because that is exactly when a fixture leaks into source.
   */
  check(
    "no key-shaped literal accompanies the new field",
    !/sk-[A-Za-z0-9]{16,}/.test(`${bundle}\n${css}\n${html}`),
  );
}

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length > 0) {
  console.error("dashboard smoke: FAIL");
  process.exit(1);
}
console.log("dashboard smoke: PASS");
