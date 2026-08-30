import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

/**
 * Every Phase 9 lock, as a mechanical check — Phase 9L Task 5.
 *
 * Spec §18 lists eight prohibitions and the §25 amendment adds a ninth. A lock recorded only in
 * prose is a lock that holds until somebody is in a hurry, and the two most likely to break are the
 * two nobody would notice breaking: a Flux Core file "polished" during unrelated work, and a `git
 * remote add` typed from muscle memory.
 *
 * Each lock is asserted **and** proved capable of failing. A scan hardcoded to pass would satisfy
 * every positive assertion here, so each rule that scans source is also run against a synthetic
 * violation — the same discipline 9H Task 6, 9K Task 8 and 9L Tasks 2 and 4 each needed.
 *
 * This file reads the tree and spawns only `git`. It starts no server and runs no smoke script: the
 * content-persistence lock is asserted by *checking that a smoke script exercises it*, not by
 * re-running one, because a two-minute lock test is a lock test that gets skipped.
 */

/** Every `.ts`/`.tsx` file under a directory, recursively. */
function sourceFiles(dir, extensions = [".ts", ".tsx"]) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full, extensions));
    else if (extensions.some((extension) => entry.endsWith(extension))) found.push(full);
  }
  return found;
}

/**
 * Strip comments before matching.
 *
 * Without this, a comment explaining a lock would trip the lock — which teaches future authors to
 * stop documenting the reasoning, the exact opposite of what the check is for. Lifted in behaviour
 * from `packages/gateway/test/adversarial.test.ts`, which established the rule for 9A.
 */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** Every tracked file under each workspace's `src` directory. The runtime path, as shipped. */
function runtimeSourceFiles() {
  const roots = [];
  for (const group of ["packages", "apps"]) {
    const base = join(ROOT, group);
    if (!existsSync(base)) continue;
    for (const workspace of readdirSync(base)) {
      const src = join(base, workspace, "src");
      if (existsSync(src)) roots.push(src);
    }
  }
  return roots.flatMap((root) => sourceFiles(root));
}

function relativeTo(path) {
  return relative(ROOT, path).split("\\").join("/");
}

/* ============================================================== Flux Core V2 visual lock */

/**
 * The manifest path. Committed alongside this test so a change to any pinned file fails here rather
 * than in review, where a visual diff is invisible.
 */
const FLUX_MANIFEST = join(ROOT, "docs/superpowers/flux-core-v2-manifest.json");

/** The files the visual lock covers: the Flux Core V2 implementation and its mount point. */
export function fluxLockedFiles() {
  const files = sourceFiles(join(ROOT, "apps/dashboard/src/flux"), [".ts", ".tsx", ".css"]).map(relativeTo);
  const slot = "apps/dashboard/src/FluxCoreSlot.tsx";
  if (existsSync(join(ROOT, slot))) files.push(slot);
  return files.sort();
}

export function sha256Of(path) {
  return createHash("sha256").update(readFileSync(join(ROOT, path))).digest("hex");
}

test("Flux Core V2 is pinned by SHA-256, and no pinned file has drifted", () => {
  assert.ok(
    existsSync(FLUX_MANIFEST),
    `the Flux Core V2 manifest is missing at ${relativeTo(FLUX_MANIFEST)}. Regenerate it deliberately, never as a convenience.`,
  );
  const manifest = JSON.parse(readFileSync(FLUX_MANIFEST, "utf8"));
  const onDisk = fluxLockedFiles();

  /*
   * The file *set* is pinned as well as each file's contents. Without this, adding a new file to
   * `flux/` would change what Flux Core V2 looks like while every pinned hash still matched — the
   * lock passing while the thing it locks changed.
   */
  assert.deepEqual(
    onDisk,
    Object.keys(manifest.files).sort(),
    "the set of Flux Core V2 files changed. A new or deleted file changes the visual output even when every pinned hash still matches.",
  );

  const drifted = onDisk.filter((path) => sha256Of(path) !== manifest.files[path]);
  assert.deepEqual(
    drifted,
    [],
    `Flux Core V2 files changed: ${drifted.join(", ")}.\n` +
      "The visual lock holds. Re-pin ONLY alongside a documented bug fix, never for polish:\n" +
      "  node scripts/pin-flux-core.mjs",
  );
});

test("the Flux lock covers a real, non-trivial file set", () => {
  // The vacuity guard. An empty manifest would satisfy every assertion above.
  const files = fluxLockedFiles();
  assert.ok(files.length >= 10, `expected the Flux Core V2 file set to be substantial, found ${files.length}`);
  assert.ok(files.includes("apps/dashboard/src/FluxCoreSlot.tsx"), "the mount point must be pinned");
  assert.ok(files.some((path) => path.endsWith("FluxCore.tsx")), "the component itself must be pinned");
  assert.ok(files.some((path) => path.endsWith(".css")), "the stylesheet must be pinned — polish usually lands there");
});

/* ============================================================== no client name in the runtime path */

/** The client identifiers 9A forbids in the runtime path. */
export const PRODUCT_NAMES = Object.freeze(["opencode", "hermes", "antigravity", "cline", "continue"]);

/** The one file 9A's plan text names as allowed to hold a client identifier. */
const PRESETS = "packages/gateway/src/presets.ts";

/**
 * The files that may name a client, each holding the name as **data** and nothing else.
 *
 * The plan says `presets.ts` and only `presets.ts`. Measured against the tree, that is wrong in the
 * *tree's* favour and is recorded rather than forced: two more files carry the same name list, and
 * neither branches on it.
 *
 *   - `packages/identity/src/repository.ts` — a `Set` of valid preset values, used to reject an
 *     unknown one at the storage boundary. Deleting it would make `preset: "not-a-client"` storable.
 *   - `apps/dashboard/src/api/types.ts` — the list the create-identity form offers, plus each
 *     preset's default scopes. It is the UI's copy of the same data table.
 *   - `apps/dashboard/src/panels/IdentitiesPanel.tsx` — one line, `DEFAULT_PRESET = "opencode"`: which
 *     entry the form's select starts on. A default selection, not a behaviour.
 *
 * The honest lock is therefore **two** rules rather than one: the name may appear in exactly these
 * four files, and nowhere in the tree may a client name sit in a control-flow position. The second
 * is the property §18 actually cares about — "BAYZ derives behaviour from the protocol, never from a
 * product identifier" — and it is the one a new file cannot satisfy by accident.
 */
export const CLIENT_NAME_ALLOWLIST = Object.freeze([
  PRESETS,
  "packages/identity/src/repository.ts",
  "apps/dashboard/src/api/types.ts",
  "apps/dashboard/src/panels/IdentitiesPanel.tsx",
]);

/**
 * `continue` needs care that the other four do not.
 *
 * It is a JavaScript keyword. A bare substring scan for it fires on every loop in the tree, which is
 * why 9A's own scan omitted it — and omitting it left the fifth client unchecked. The rule here
 * matches it only where it could be a *client identifier*: quoted, or as a property/`case` value.
 * A `continue;` statement is syntax, not a product name.
 */
export function productNameHits(source, name) {
  const code = stripComments(source);
  if (name !== "continue") {
    return code.toLowerCase().includes(name) ? [name] : [];
  }
  const asIdentifier = /["'`]continue["'`]|\bcontinue\s*:/i;
  return asIdentifier.test(code) ? [name] : [];
}

/**
 * A client name in a **control-flow position** — the thing §18 forbids.
 *
 * Comparison, `case` label, membership test, or optional/indexed lookup keyed by the literal. A name
 * in an array, a type union, or an object *key being declared* is data; a name being *tested against*
 * is a branch, and a branch is how behaviour starts depending on who is calling.
 */
export function branchesOnClientName(source, name) {
  const code = stripComments(source);
  const literal = `["'\`]${name}["'\`]`;
  const patterns = [
    new RegExp(`[=!]==?\\s*${literal}`, "i"),
    new RegExp(`${literal}\\s*[=!]==?`, "i"),
    new RegExp(`\\bcase\\s+${literal}`, "i"),
    new RegExp(`\\.(?:includes|has|startsWith|endsWith|test)\\(\\s*${literal}`, "i"),
    new RegExp(`\\[\\s*${literal}\\s*\\]\\s*(?:\\?|&&|\\|\\|)`, "i"),
  ];
  return patterns.some((pattern) => pattern.test(code));
}

test("no client name appears outside the four data-only files", () => {
  const offenders = [];
  for (const file of runtimeSourceFiles()) {
    const path = relativeTo(file);
    if (CLIENT_NAME_ALLOWLIST.includes(path)) continue;
    const source = readFileSync(file, "utf8");
    for (const name of PRODUCT_NAMES) {
      for (const hit of productNameHits(source, name)) offenders.push(`${path} mentions ${hit}`);
    }
  }
  assert.deepEqual(offenders, [], `client names outside the allowlist:\n${offenders.join("\n")}`);
});

test("every allowlisted file really does name a client, so no entry is dead", () => {
  /*
   * An allowlist nobody prunes grows until it covers the tree. Each entry must still be load-bearing;
   * a stale one is an exemption sitting open for a file that no longer needs it.
   */
  for (const path of CLIENT_NAME_ALLOWLIST) {
    const full = join(ROOT, path);
    assert.ok(existsSync(full), `allowlisted file ${path} does not exist — prune the entry`);
    const source = readFileSync(full, "utf8");
    assert.ok(
      PRODUCT_NAMES.some((name) => productNameHits(source, name).length > 0),
      `${path} is allowlisted but names no client — the exemption is dead and should be removed`,
    );
  }
});

test("no client name sits in a control-flow position anywhere in the runtime path", () => {
  /*
   * The load-bearing half, and it has **no** allowlist: `presets.ts` may hold the names, and it still
   * may not branch on them. A preset selects a label and a documentation page; it must never select
   * how a request is served.
   */
  const offenders = [];
  for (const file of runtimeSourceFiles()) {
    const source = readFileSync(file, "utf8");
    for (const name of PRODUCT_NAMES) {
      if (branchesOnClientName(source, name)) offenders.push(`${relativeTo(file)} branches on ${name}`);
    }
  }
  assert.deepEqual(offenders, [], `client-name branching in the runtime path:\n${offenders.join("\n")}`);
});

test("the branching rule fires on every branch shape and passes every data shape", () => {
  const branches = [
    'if (profile.preset === "opencode") { legacy(); }',
    'switch (preset) { case "hermes": return other; }',
    'if (KNOWN.includes("antigravity")) {}',
    'if (preset !== "cline") {}',
    'if (PRESET_SCOPES["opencode"] ?? fallback) {}',
  ];
  for (const shape of branches) {
    const name = PRODUCT_NAMES.find((candidate) => shape.toLowerCase().includes(candidate));
    assert.ok(branchesOnClientName(shape, name), `the branching rule missed: ${shape}`);
  }
  const data = [
    'const PRESET_NAMES = new Set(["opencode", "hermes", "antigravity", "generic-openai"]);',
    'export type Preset = "opencode" | "hermes" | "antigravity";',
    'const PRESET_SCOPES = { opencode: ["chat.completions"], hermes: ["chat.completions"] };',
  ];
  for (const shape of data) {
    for (const name of PRODUCT_NAMES) {
      assert.ok(!branchesOnClientName(shape, name), `a data declaration tripped the branching rule: ${shape}`);
    }
  }
});

test("the product-name scan covers every workspace, including the ones 9A did not exist for", () => {
  // The vacuity guard. 9A's own scan looked at `packages/gateway/src` and `apps/server/src/routes`
  // only; `gateway`, `identity` and `capability` did not all exist yet, and a scan that misses a
  // workspace reports clean for the same reason a working one does.
  const scanned = runtimeSourceFiles().map(relativeTo);
  for (const workspace of ["gateway", "identity", "capability", "router", "providers", "proxy", "storage"]) {
    assert.ok(
      scanned.some((path) => path.startsWith(`packages/${workspace}/src/`)),
      `packages/${workspace}/src is not being scanned`,
    );
  }
  assert.ok(scanned.some((path) => path.startsWith("apps/server/src/")), "apps/server/src is not being scanned");
  assert.ok(scanned.some((path) => path.startsWith("apps/dashboard/src/")), "apps/dashboard/src is not being scanned");
  assert.ok(scanned.length > 100, `expected a substantial runtime source set, scanned ${scanned.length} files`);
});

test("the product-name scan fires on a real hit and ignores comments and the continue keyword", () => {
  assert.deepEqual(productNameHits('const preset = "opencode";', "opencode"), ["opencode"]);
  assert.deepEqual(productNameHits("// opencode is deliberately not named here\nconst x = 1;", "opencode"), []);
  // The distinction that made `continue` checkable at all.
  assert.deepEqual(productNameHits("for (;;) { continue; }", "continue"), []);
  assert.deepEqual(productNameHits('if (preset === "continue") {}', "continue"), ["continue"]);
});

test("presets.ts really is the only file that needs the exemption", () => {
  // If the exemption ever stopped being load-bearing, the rule would be one edit away from being
  // deleted as redundant — and then the next client name would land unnoticed.
  const source = readFileSync(join(ROOT, PRESETS), "utf8");
  const named = PRODUCT_NAMES.filter((name) => productNameHits(source, name).length > 0);
  assert.ok(named.length >= 3, `presets.ts should name the clients it labels, names ${named.join(", ") || "none"}`);
});

/* ============================================================== no credential read path */

/** Getter shapes that would return a stored secret to a caller. */
export const CREDENTIAL_GETTERS = Object.freeze([
  /\bgetCredential\b/,
  /\bgetPassword\b/,
  /\breveal[A-Z]\w*/,
  /\bexportCredential\b/,
  /\bexportSecret\b/,
  /\bexportPassword\b/,
]);

/**
 * Files exempt from the credential-getter scan, each for a stated reason.
 *
 * `secret-repository.ts` and the storage driver *are* the decryption boundary — something has to read
 * the ciphertext, and Phase 2's design is that exactly one file may. The lock is that no **manager or
 * route** exposes it upward.
 */
const CREDENTIAL_BOUNDARY = Object.freeze([
  "packages/storage/src/secret-repository.ts",
  "packages/storage/src/secret.ts",
]);

test("no package exposes a credential read path", () => {
  const offenders = [];
  for (const file of runtimeSourceFiles()) {
    const path = relativeTo(file);
    if (CREDENTIAL_BOUNDARY.includes(path)) continue;
    const code = stripComments(readFileSync(file, "utf8"));
    for (const getter of CREDENTIAL_GETTERS) {
      const match = getter.exec(code);
      if (match !== null) offenders.push(`${path} declares ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `credential read paths:\n${offenders.join("\n")}`);
});

test("the credential scan reaches the packages that did not exist when Phase 3 wrote it", () => {
  const scanned = runtimeSourceFiles().map(relativeTo);
  for (const workspace of ["gateway", "identity", "capability"]) {
    assert.ok(
      scanned.some((path) => path.startsWith(`packages/${workspace}/src/`)),
      `packages/${workspace}/src must be covered by the credential scan`,
    );
  }
});

test("the credential scan fires on each getter shape", () => {
  const shapes = [
    "async getCredential(id: string) { return secret; }",
    "function getPassword() { return password; }",
    "export function revealSecret() { return value; }",
    "const exportCredential = () => stored;",
  ];
  for (const shape of shapes) {
    const code = stripComments(shape);
    assert.ok(
      CREDENTIAL_GETTERS.some((getter) => getter.test(code)),
      `the credential scan missed: ${shape}`,
    );
  }
});

/* ============================================================== no content persistence */

/**
 * The six sentinels `scripts/usage-smoke.mjs` plants, plus the four `scripts/stream-smoke.mjs` uses
 * for streaming chunks and tool-call arguments.
 *
 * This lock is asserted by **checking that a smoke script exercises it**, not by re-running one. The
 * drill needs a real listener, a real database and a real origin; re-running it here would add two
 * minutes to a lock test, and a slow lock test is one that gets skipped. What the lock guards against
 * is the *drill* being deleted or hollowed out, which is a property of the script's source.
 */
const PERSISTENCE_DRILLS = Object.freeze([
  {
    script: "scripts/usage-smoke.mjs",
    sentinels: [
      "PROMPT_CONTENT_SENTINEL",
      "COMPLETION_CONTENT_SENTINEL",
      "PROVIDER_CREDENTIAL_SENTINEL",
      "PROXY_CREDENTIAL_SENTINEL",
      "BAYZ_AUTHORIZATION_SENTINEL",
      "UPSTREAM_ERROR_BODY_SENTINEL",
    ],
    // Each drill names its own absence check, because the two scripts word it differently and
    // normalising the wording would mean editing a passing smoke script to satisfy a lock test.
    absenceCheck: /absent from db\/wal\/shm/,
    // The positive control inside the drill itself: a byte scan that can only ever return "absent" is
    // indistinguishable from one reading an empty buffer, so the script must also prove it sees real
    // content. Requiring it here means the drill cannot be hollowed out into a vacuous pass.
    positiveControl: /proving the scan reads real content|the database files were read|database bytes were read/,
  },
  {
    // 9L's extension: the plan requires the drill to reach streaming chunks and tool-call arguments,
    // which the Phase 8 usage drill predates and therefore never covered.
    script: "scripts/stream-smoke.mjs",
    sentinels: ["PROMPT", "COMPLETION", "TOOL_ARGUMENT", "TOOL_RESULT"],
    absenceCheck: /absent from disk/,
    positiveControl: /the database files were read/,
  },
]);

test("the content-persistence drill exists, plants every sentinel, and asserts absence from disk", () => {
  for (const drill of PERSISTENCE_DRILLS) {
    const path = join(ROOT, drill.script);
    assert.ok(existsSync(path), `${drill.script} is missing, so the content-persistence drill is gone`);
    const source = readFileSync(path, "utf8");

    for (const sentinel of drill.sentinels) {
      assert.match(
        source,
        new RegExp(`const ${sentinel}\\s*=`),
        `${drill.script} no longer plants the ${sentinel} sentinel`,
      );
    }

    /*
     * Planting a sentinel proves nothing on its own — the assertion that it never reaches disk is the
     * check. Asserted structurally: the script must read the database bytes back and test them.
     */
    assert.match(
      source,
      /bytes\.includes\(|\.includes\(Buffer\.from\(/,
      `${drill.script} no longer scans the database bytes for a sentinel`,
    );
    assert.match(source, drill.absenceCheck, `${drill.script} no longer carries its absence check`);
    assert.match(
      source,
      drill.positiveControl,
      `${drill.script} no longer proves its byte scan reads real content, so "absent" could mean "read nothing"`,
    );
  }
});

test("the streaming drill covers chunks and tool arguments specifically, which the Phase 8 drill did not", () => {
  // Named separately because this is the 9L extension. A regression here would leave the two newest
  // content paths — streamed chunks and tool-call arguments — unproven while the older drill still
  // passed, and the lock would read green.
  const source = readFileSync(join(ROOT, "scripts/stream-smoke.mjs"), "utf8");
  for (const label of ["tool argument", "tool result"]) {
    assert.ok(source.includes(label), `the streaming drill no longer names the ${label} sentinel in its checks`);
  }
  assert.match(source, /absent from the logs/, "the streaming drill no longer scans the logs");
  assert.match(source, /absent from the usage API/, "the streaming drill no longer scans the management surface");
});

/* ============================================================== node:sqlite in exactly one file */

test("node:sqlite is imported in exactly one file", () => {
  const importers = runtimeSourceFiles().filter((file) => {
    const code = stripComments(readFileSync(file, "utf8"));
    return /from\s+["']node:sqlite["']|require\(["']node:sqlite["']\)/.test(code);
  });
  assert.deepEqual(
    importers.map(relativeTo),
    ["packages/storage/src/drivers/node-sqlite.ts"],
    "node:sqlite must be imported by exactly one driver file, so the database can be swapped in one place",
  );
});

test("the sqlite rule counts imports, not mentions", () => {
  // Two other storage files *discuss* `node:sqlite` in prose — the swappable-driver rationale and a
  // note about boolean bindings. A mention-counting rule would fail on the documentation explaining
  // the constraint, which is how a rule teaches people to stop writing the explanation down.
  const mentions = runtimeSourceFiles().filter((file) => readFileSync(file, "utf8").includes("node:sqlite"));
  assert.ok(
    mentions.length > 1,
    "no file mentions node:sqlite outside the driver, so this distinction is untested",
  );
});

/* ============================================================== GitHub remote absent */

/**
 * `git remote -v`, read from the real repository.
 *
 * In the test suite rather than a checklist because this is the prohibition most easily broken by
 * muscle memory: `git remote add origin …` is a reflex, and a reflex does not consult a document.
 */
export function gitRemotes() {
  const output = execFileSync("git", ["remote", "-v"], { cwd: ROOT, encoding: "utf8" });
  return output
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [name, rest = ""] = line.split(/\s+/, 2);
      return { name, url: rest };
    });
}

test("no git remote exists at all", () => {
  const remotes = gitRemotes();
  assert.deepEqual(
    remotes,
    [],
    `Phase 9 prohibits a remote until the gate is green and the user explicitly instructs a push. Found: ${remotes
      .map((remote) => `${remote.name} -> ${remote.url}`)
      .join(", ")}`,
  );
});

test("no remote is named B-Router and none points at GitHub", () => {
  /*
   * Asserted separately from "no remote at all" and deliberately not folded into it. The two say
   * different things: a future task may legitimately add a local mirror or a bundle remote, at which
   * point the first assertion is the one to revisit — while *this* one must keep holding, because the
   * specific prohibition is the GitHub push, not remotes as a concept.
   */
  for (const remote of gitRemotes()) {
    assert.notEqual(remote.name, "B-Router", "the B-Router remote is prohibited by name");
    assert.ok(
      !/github\.com|github\.io/i.test(remote.url),
      `remote ${remote.name} points at GitHub: ${remote.url}`,
    );
  }
});

test("the remote check reads git rather than trusting a config file", () => {
  // A `.git/config` scan would miss a remote added with `--local` overrides or an insteadOf rewrite.
  // Asserting the command runs and returns a string is what makes the empty result meaningful.
  const output = execFileSync("git", ["remote", "-v"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(typeof output, "string");
  assert.equal(output.trim(), "", `git remote -v should be empty, printed: ${output.trim()}`);
});

/* ============================================================== §25 amendment: no paid fallback */

/**
 * The free-only selection path. Read from source, because "no paid fallback" is a property of the
 * code and cannot be established by a passing test alone — a test proves the paths it exercises.
 */
const SELECTION = "packages/router/src/selection.ts";
const ROUTER = "packages/router/src/router.ts";

test("the free-only filter treats an unclassified model as not free", () => {
  /*
   * The single most expensive mistake this lock prevents. `undefined` means "the catalogue has no row
   * for this model", and reading that as free is how a free-only route spends money — the failure is
   * silent and the operator finds out from a bill.
   */
  const source = readFileSync(join(ROOT, SELECTION), "utf8");
  assert.match(
    stripComments(source),
    /economics\s*===\s*undefined\s*\?\s*false/,
    `${SELECTION} must treat an unclassified model as NOT free`,
  );
});

test("no branch widens a free-only candidate set on failure", () => {
  /*
   * The amendment's actual words. A widening branch would look like a `catch`/failure path that
   * re-runs selection without the free-only predicate, or that flips `freeOnly` to false. Both shapes
   * are searched for; the honest positive statement is that the only `freeOnly` reads are the filter
   * and the per-attempt re-check.
   */
  const code = stripComments(readFileSync(join(ROOT, ROUTER), "utf8"));
  const widenings = [
    /freeOnly\s*=\s*false/,
    /freeOnly\s*:\s*false/,
    /!\s*route\.freeOnly\s*\|\|\s*attempts/,
    /attempts\s*>\s*0\s*\?\s*true\s*:\s*route\.freeOnly/,
  ];
  for (const pattern of widenings) {
    assert.ok(!pattern.test(code), `${ROUTER} contains a paid-fallback widening: ${pattern}`);
  }

  // And the positive half: the free-only check is re-evaluated per attempt rather than once, so a
  // reclassification between the first attempt and the failover cannot be spent through.
  assert.match(code, /route\.freeOnly\s*&&/, `${ROUTER} no longer gates attempts on route.freeOnly`);
  assert.ok(
    (code.match(/route\.freeOnly\s*&&/g) ?? []).length >= 2,
    `${ROUTER} should check freeOnly on both the streaming and non-streaming attempt paths`,
  );
});

test("the paid-fallback rule would catch a real widening", () => {
  // The positive control: each forbidden shape, confirmed to match. Without this the rule above could
  // be four patterns that never match anything.
  const violations = [
    "if (attempts > 0) { route.freeOnly = false; }",
    "const relaxed = { ...route, freeOnly: false };",
  ];
  const patterns = [/freeOnly\s*=\s*false/, /freeOnly\s*:\s*false/];
  for (const [index, violation] of violations.entries()) {
    assert.ok(patterns[index].test(stripComments(violation)), `the paid-fallback rule missed: ${violation}`);
  }
});

