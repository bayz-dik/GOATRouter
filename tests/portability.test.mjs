import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const scan = await import(join(root, "scripts/portability-scan.mjs"));

/**
 * Cross-platform path, permission, and shell hygiene — 9J Task 3.
 *
 * Three separate claims are defended here, and they fail in three different ways:
 *
 * 1. **One data directory resolver.** `apps/server/src/data-dir.ts` is the only file permitted to
 *    ask the operating system where home is. A second resolver appearing anywhere else is how an
 *    install ends up with two databases — the daemon writing one and a tool reading the other.
 * 2. **No POSIX shell on a user path.** A `&&` chain, a `$(...)` substitution, or a bare `sh -c`
 *    inside an `exec` string works perfectly here and fails on Windows, where nobody running this
 *    repository would notice.
 * 3. **Permissions are verified, not re-implemented.** `packages/storage/src/paths.ts` already
 *    creates the data directory `0o700` and tightens the database to `0o600`, and already tolerates
 *    a filesystem that cannot represent either. This file asserts the *observed* mode on this
 *    device, so the platform matrix cell records what happened rather than what was intended.
 */

/** The one file allowed to resolve the data directory from the environment. */
const RESOLVER = "apps/server/src/data-dir.ts";

test("the scanner reaches every src and scripts file, and nothing else", () => {
  const files = scan.collectSourceFiles(root);

  /*
   * A scan is only as good as its file list, and the failure mode of a source scan is silent: a
   * glob that matches nothing passes every assertion. So the list is checked for shape before it is
   * trusted — known files present, test files absent, `node_modules` absent.
   */
  assert.ok(files.length > 50, `the scan collected only ${files.length} files, which cannot be the whole tree`);

  for (const expected of [
    "apps/server/src/config.ts",
    "apps/dashboard/src/FluxCoreSlot.tsx",
    "packages/storage/src/paths.ts",
    "scripts/dependency-closure.mjs",
  ]) {
    assert.ok(files.includes(expected), `the scan misses ${expected}`);
  }

  for (const file of files) {
    assert.ok(!file.includes("node_modules"), `the scan reaches into node_modules: ${file}`);
    assert.ok(
      !/(^|\/)test\//.test(file) && !file.endsWith(".test.ts") && !file.endsWith(".test.mjs"),
      `the scan reaches a test file, which is allowed hardcoded paths: ${file}`,
    );
  }
});

test("no src or scripts file hardcodes /tmp, /home, or a drive letter", () => {
  const violations = scan
    .scanRepo(root)
    .violations.filter((entry) => entry.rule === "hardcoded-path");

  assert.deepEqual(
    violations.map((entry) => `${entry.file}:${entry.line} ${entry.rule} ${entry.text}`),
    [],
    "a hardcoded absolute path escapes the temp-directory and home-directory helpers",
  );
});

test("homedir() is called in exactly one file, the data directory resolver", () => {
  /*
   * **The assertion that keeps the resolver single-sourced.**
   *
   * `${homedir()}/.bayz` was inlined in `config.ts` before this task. Moving it out is only half the
   * fix; without this scan the next feature that needs a path would inline it again, and the two
   * would drift the first time one of them learned about `%LOCALAPPDATA%`.
   */
  const { violations } = scan.scanRepo(root);
  const offenders = violations.filter((entry) => entry.rule === "homedir-outside-resolver");

  assert.deepEqual(
    offenders.map((entry) => `${entry.file}:${entry.line}`),
    [],
    `homedir() is called outside ${RESOLVER}; the data directory must come from one resolver`,
  );

  // Non-vacuous: the resolver must actually exist and actually call it, or the scan above is
  // trivially satisfied by a repository that resolves nothing at all.
  assert.ok(existsSync(join(root, RESOLVER)), `${RESOLVER} does not exist`);
  const resolverSource = readFileSync(join(root, RESOLVER), "utf8");
  assert.match(resolverSource, /homedir/, `${RESOLVER} does not resolve the home directory`);
});

test("the hardcoded-path scan is not vacuous", () => {
  /*
   * Fed synthetic sources rather than the repository, because the repository is clean by the time
   * this passes and a clean tree cannot demonstrate that a scanner detects anything.
   */
  const cases = [
    ['const db = "/tmp/bayz.db";', "hardcoded-path"],
    ['const home = "/home/operator/.bayz";', "hardcoded-path"],
    ['const mac = "/Users/operator/.bayz";', "hardcoded-path"],
    ['const win = "C:\\\\Users\\\\op\\\\bayz";', "hardcoded-path"],
    ['import { homedir } from "node:os";', "homedir-outside-resolver"],
  ];

  for (const [source, rule] of cases) {
    const found = scan.scanText("packages/example/src/thing.ts", source, { userRun: false });
    assert.ok(
      found.some((entry) => entry.rule === rule),
      `the scanner missed ${rule} in ${JSON.stringify(source)}`,
    );
  }
});

test("a home-directory call is detected without an import on the same line", () => {
  /*
   * **A mutation passed twice before this test existed**, which is why it is separate.
   *
   * The vacuity case above used to feed `import { homedir } from "node:os";` and `homedir()`
   * together as one two-line source. Disabling the *call* rule entirely — leaving only the import
   * rule — kept the suite green, because the import line alone satisfied the assertion. So the rule
   * that catches an aliased or dynamically imported call was unprotected, and these are the exact
   * shapes that would slip past:
   *
   *   import * as os from "node:os";      os.homedir()
   *   const { homedir } = await import("node:os");
   *   import { homedir as h } from "node:os";
   *
   * Each source below therefore contains a call and **no** static named import, so only the call
   * rule can satisfy it.
   */
  const callOnly = [
    "const dir = homedir();",
    "const dir = os.homedir();",
    'const { homedir } = await import("node:os");',
    "const dir = join(homedir(), \".bayz\");",
  ];

  for (const source of callOnly) {
    const found = scan.scanText("packages/example/src/thing.ts", source, { userRun: false });
    assert.ok(
      found.some((entry) => entry.rule === "homedir-outside-resolver"),
      `a home-directory call went undetected in ${JSON.stringify(source)}`,
    );
  }

  // And the resolver itself is exempt, or the rule would forbid the one correct call site.
  assert.deepEqual(
    scan.scanText("apps/server/src/data-dir.ts", "const dir = homedir();", { userRun: false }),
    [],
  );
});

test("a path inside a comment is not a violation", () => {
  /*
   * `scripts/chaos-part3.mjs` explains in prose why it will not fill `/tmp`. A scan that counted
   * that would push authors towards deleting the explanation, which is the opposite of the goal.
   */
  const block = "/*\n * Filling /tmp would endanger the device.\n */\nconst dir = mkdtempSync(tmpdir());";
  assert.deepEqual(scan.scanText("scripts/example.mjs", block, { userRun: true }), []);

  const line = 'const dir = tmpdir(); // never /tmp directly\n';
  assert.deepEqual(scan.scanText("scripts/example.mjs", line, { userRun: true }), []);

  // And a URL is not a comment, so the stripper must not eat the rest of the line.
  const url = 'const u = "http://127.0.0.1"; const bad = "/tmp/x";';
  assert.ok(
    scan.scanText("scripts/example.mjs", url, { userRun: true }).some((entry) => entry.rule === "hardcoded-path"),
    "the comment stripper swallowed code after a URL",
  );
});

test("no user-run script invokes a shell, a shell builtin, chmod, or rm", () => {
  /*
   * The surface is named explicitly in the scanner rather than inferred from the directory, because
   * "which scripts does a *user* run" is a packaging decision. The smoke, fuzz, chaos, load, and
   * soak scripts are developer verification tooling and are excluded from the release tarball by
   * Task 4 — they may use whatever this device provides. Everything a user or a CI runner invokes
   * must work on `cmd.exe`.
   */
  const { violations, userRunFiles } = scan.scanRepo(root);
  const offenders = violations.filter((entry) => entry.rule.startsWith("shell-"));

  assert.deepEqual(
    offenders.map((entry) => `${entry.file}:${entry.line} ${entry.rule} ${entry.text}`),
    [],
    "a user-run script depends on a POSIX shell",
  );

  assert.ok(userRunFiles.length > 0, "the user-run surface is empty, so the shell rules check nothing");
  for (const file of userRunFiles) {
    assert.ok(existsSync(join(root, file)), `the user-run surface names a file that does not exist: ${file}`);
  }
});

test("the shell scan is not vacuous", () => {
  const cases = [
    ['import { execSync } from "node:child_process";', "shell-exec-import"],
    ['import { exec } from "node:child_process";', "shell-exec-import"],
    ['spawnSync("npm", ["ci"], { shell: true });', "shell-true"],
    ['execFileSync("sh", ["-c", "npm ci"]);', "shell-binary"],
    ['execFileSync("bash", ["-lc", "npm ci"]);', "shell-binary"],
    ['execFileSync("/bin/sh", ["-c", "npm ci"]);', "shell-binary"],
    ['execFileSync("chmod", ["700", dir]);', "shell-binary"],
    ['spawnSync("rm", ["-rf", dir]);', "shell-binary"],
    ['execSync("npm ci && npm test");', "shell-chain"],
    ['execSync("npm pack");', "shell-exec-call"],
    ['spawnSync("npm run build 2>&1");', "shell-redirect"],
    ['spawnSync("cp $(pwd)/a b");', "shell-substitution"],
  ];

  for (const [source, rule] of cases) {
    const found = scan.scanText("scripts/pack.mjs", source, { userRun: true });
    assert.ok(
      found.some((entry) => entry.rule === rule),
      `the scanner missed ${rule} in ${JSON.stringify(source)}: got ${JSON.stringify(found.map((e) => e.rule))}`,
    );
  }

  // `execFile`/`spawn` with a plain binary and an argument array is the required form.
  for (const clean of [
    'execFileSync("npm", ["pack", "--workspace", name]);',
    'spawnSync(process.execPath, ["--test", file]);',
    'spawn("opencode", args, { env, cwd });',
  ]) {
    assert.deepEqual(scan.scanText("scripts/pack.mjs", clean, { userRun: true }), [], `flagged the required form: ${clean}`);
  }

  /*
   * The false positives that made the first version of this rule useless.
   *
   * The original `shell-chain` rule looked for `&&` inside any string literal, which matched
   * `if (a === "x" && b === "y")` — the substring `" && b === "` is a string containing a chain by
   * that reading. It reported 33 lines of ordinary comparison code across `apps/server/src` and
   * `packages/*​/src` as shell violations. A rule that fires on a third of the runtime source is not
   * a gate; it is noise that gets suppressed. The rule now only reads strings actually handed to a
   * child process.
   */
  for (const clean of [
    'if (mode === "chat" && kind === "stream") return true;',
    'const ok = a.status === 200 && b.status === 200 || c.retried;',
    'const m = /^HTTP\\/1\\.\\d (\\d{3})/.exec(raw);',
    'const found = pattern.exec(line);',
    'import { spawnSync } from "node:child_process";',
    'import { execFile, execFileSync } from "node:child_process";',
    'const template = `${host}:${port}`;',
  ]) {
    assert.deepEqual(
      scan.scanText("apps/server/src/thing.ts", clean, { userRun: true }),
      [],
      `false positive on ordinary code: ${clean}`,
    );
  }
});

test("npm lifecycle scripts use only constructs cmd.exe supports", () => {
  /*
   * `npm run` spawns the platform shell — `cmd.exe` on Windows. `&&` is supported there and is
   * pinned as acceptable, because `runtime:build` is a twelve-step chain and rewriting it into a
   * Node driver would trade a working build for a portability gesture. `$(...)`, backticks, `||`,
   * single-quoted arguments, and `2>&1` are not supported and are refused.
   */
  const { npmViolations, npmScriptCount } = scan.scanRepo(root);

  assert.deepEqual(
    npmViolations.map((entry) => `${entry.file} ${entry.script}: ${entry.rule}`),
    [],
    "an npm lifecycle script uses a POSIX-only shell construct",
  );

  assert.ok(npmScriptCount >= 20, `only ${npmScriptCount} npm scripts were scanned across the workspaces`);

  // `&&` is present in the real tree and deliberately allowed; asserting that pins the decision
  // rather than leaving it as an absence.
  const rootScripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
  assert.match(rootScripts["runtime:build"], /&&/, "runtime:build no longer chains, so the cmd.exe allowance is stale");
  assert.deepEqual(scan.scanNpmScriptText("build", "tsc -p tsconfig.json && vite build"), []);
});

test("the npm script scan is not vacuous", () => {
  const cases = [
    ["cp -r $(pwd)/dist out", "npm-substitution"],
    ["echo `date`", "npm-backtick"],
    ["npm test || true", "npm-or-chain"],
    ["node script.mjs 2>&1", "npm-redirect"],
    ["node -e 'console.log(1)'", "npm-single-quote"],
  ];

  for (const [command, rule] of cases) {
    const found = scan.scanNpmScriptText("example", command);
    assert.ok(
      found.some((entry) => entry.rule === rule),
      `the scanner missed ${rule} in ${JSON.stringify(command)}`,
    );
  }
});

test("the data directory is created 0o700 and the database 0o600 on this filesystem", () => {
  /*
   * **Observed, not intended.**
   *
   * The mode is probed in a child process against the real `ensureDataDir` and `restrictFileMode`,
   * on the real filesystem, rather than asserted from reading `paths.ts`. This device is Termux on
   * Android under proot, where some mounts cannot represent POSIX modes at all — so the probe
   * reports what it saw and this test records it. If a future target does not honour modes, the
   * assertion below records `UNVERIFIED` with the observed mode instead of failing, because a
   * best-effort mode reported as a guarantee is exactly the overclaim this phase forbids.
   */
  const probe = scan.probeDataDirModes({ root });

  assert.equal(typeof probe.dirMode, "number", "the probe did not report a directory mode");
  assert.equal(typeof probe.dbMode, "number", "the probe did not report a database mode");

  if (probe.honoursModes) {
    assert.equal(
      probe.dirMode,
      0o700,
      `the data directory was created ${probe.dirMode.toString(8)}, not 700, on a filesystem that honours modes`,
    );
    for (const [suffix, mode] of Object.entries(probe.sidecarModes)) {
      assert.equal(mode, 0o600, `bayz.db${suffix} is ${mode.toString(8)}, not 600`);
    }
    assert.equal(probe.dbMode, 0o600, `bayz.db is ${probe.dbMode.toString(8)}, not 600`);
    console.log(`data dir permissions: PASS — dir 0${probe.dirMode.toString(8)}, db 0${probe.dbMode.toString(8)}`);
  } else {
    console.log(
      `data dir permissions: UNVERIFIED: filesystem does not honour POSIX modes — dir 0${probe.dirMode.toString(8)}, db 0${probe.dbMode.toString(8)}`,
    );
  }
});

test("a chmod failure is tolerated, but a create failure stays fatal", () => {
  /*
   * The Windows story and the FAT-mount story are the same story: `chmod` does not do what POSIX
   * says and BAYZ must still start. Proven by behaviour — `restrictFileMode` on a path that does not
   * exist is the cheapest available `chmod` failure — rather than by asserting the presence of a
   * `try` block, which would pass for a `try` that rethrows.
   *
   * The other half matters just as much: tolerance must not have swallowed the fatal branch. A data
   * directory that genuinely cannot be created has to stop startup, or the daemon runs with nowhere
   * to put the database and reports success.
   */
  const probe = scan.probeDataDirModes({ root });
  assert.equal(probe.missingFileTolerated, true, "restrictFileMode threw on a chmod failure");
  assert.equal(probe.createFailureIsFatal, true, "an impossible mkdir was tolerated instead of refused");
  assert.equal(probe.createFailureCode, "storage_unavailable", `the failure surfaced as ${probe.createFailureCode}`);
  assert.equal(probe.dirModeAfterReopen, probe.dirMode, "a second ensureDataDir changed the mode of an existing directory");
});

test("Windows permissions are recorded UNVERIFIED, not claimed equivalent", () => {
  /*
   * There is no Windows machine here, and `0o700` has no NTFS equivalent that `chmod` sets. The
   * matrix cell must therefore stay `UNVERIFIED` for every Windows row — asserted against the matrix
   * document so the claim cannot be quietly upgraded in a later task.
   */
  const matrix = readFileSync(join(root, "docs/superpowers/2026-08-27-bayz-platform-matrix.md"), "utf8");
  const rows = matrix
    .split("\n")
    .filter((line) => line.startsWith("| Windows"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));

  assert.equal(rows.length, 2, "expected two Windows rows in the platform matrix");
  const header = matrix
    .split("\n")
    .find((line) => line.trim().startsWith("| platform"))
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  const column = header.indexOf("data dir permissions");
  assert.ok(column > 0, "the matrix has no data dir permissions column");

  for (const row of rows) {
    assert.equal(row[column], "UNVERIFIED", `${row[0]} claims a data dir permission status this repository cannot observe`);
  }
});

test("the scanner runs as a script and exits 0 on the clean tree", () => {
  /*
   * The scanner is an operator-facing gate as well as a test fixture, so its exit code is checked
   * directly. `execFileSync` with an argument array — the form this task requires of everything
   * else.
   */
  const output = execFileSync(process.execPath, [join(root, "scripts/portability-scan.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(output, /portability/i, "the scanner prints no summary");
  assert.match(output, /files scanned/i, "the scanner does not report how much it looked at");
});
