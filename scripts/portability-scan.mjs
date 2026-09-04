#!/usr/bin/env node
/**
 * Portability scan — Phase 9J Task 3.
 *
 * Three claims, each of which fails silently on this device and loudly on somebody else's:
 *
 * 1. **One data directory resolver.** Only `apps/server/src/data-dir.ts` may ask the operating
 *    system where home is. Two resolvers means two databases — the daemon writing one while a tool
 *    reads the other — and the drift starts the moment one of them learns about `%LOCALAPPDATA%`.
 * 2. **No hardcoded absolute path.** `/tmp`, `/home/...`, and `C:\...` are all wrong somewhere.
 *    `tmpdir()` and the resolver exist so nothing has to guess.
 * 3. **No POSIX shell on a user path.** A `&&` chain inside an `exec` string, a `$(...)`
 *    substitution, or a bare `sh -c` runs fine here and dies on `cmd.exe`. Nobody working in this
 *    repository would ever see it.
 *
 * Run as a script it prints a summary and exits non-zero on any violation.
 * Imported, it exposes the scanner so `tests/portability.test.mjs` can assert each rule bites.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..");

/** The one file permitted to resolve the home directory. */
export const RESOLVER = "apps/server/src/data-dir.ts";

/**
 * The user-run surface: everything that executes on a machine this repository does not own.
 *
 * Two groups, for two different reasons:
 *
 * - **Runtime source** (`apps/server/src`, `packages/*​/src`) ships in the Task 4 tarball and runs
 *   wherever an operator installs it. That is the population the Windows claim is about.
 * - **Operator-facing scripts** are the ones a user or a CI runner invokes by name. The smoke, fuzz,
 *   chaos, load, and soak scripts are *developer* verification tooling, excluded from the tarball,
 *   and may use anything this device provides — they are deliberately not on this list, because
 *   pretending they are portable would mean weakening them for no user's benefit.
 */
export const USER_RUN_SCRIPTS = [
  "scripts/dependency-closure.mjs",
  "scripts/portability-scan.mjs",
  "scripts/pack.mjs",
  "scripts/install-smoke.mjs",
  "scripts/upgrade-smoke.mjs",
  "scripts/platform-gate.mjs",
  "scripts/goat.mjs",
  "scripts/remote-load.mjs",
];

const SOURCE_ROOTS = [
  { dir: "apps", nested: "src", extensions: [".ts", ".tsx"] },
  { dir: "packages", nested: "src", extensions: [".ts", ".tsx"] },
];

function walk(absolute, root, out, extensions) {
  if (!existsSync(absolute)) return;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) {
      walk(child, root, out, extensions);
      continue;
    }
    if (!extensions.some((extension) => entry.name.endsWith(extension))) continue;
    if (entry.name.includes(".test.")) continue;
    out.push(relative(root, child).split(sep).join("/"));
  }
}

/**
 * Every `src` and `scripts` file the scan covers, as repo-relative POSIX paths.
 *
 * Test files are excluded deliberately: a test *should* be able to write `"C:\\Users\\x"` as a
 * fixture, and `apps/server/test/data-dir.test.ts` does exactly that to exercise the Windows branch.
 * Forbidding it there would make the Windows path untestable, which is the opposite of the goal.
 */
export function collectSourceFiles(root = REPO_ROOT) {
  const files = [];
  for (const { dir, nested, extensions } of SOURCE_ROOTS) {
    const base = join(root, dir);
    if (!existsSync(base)) continue;
    for (const workspace of readdirSync(base, { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue;
      walk(join(base, workspace.name, nested), root, files, extensions);
    }
  }
  walk(join(root, "scripts"), root, files, [".mjs"]);
  return files.sort();
}

/**
 * Blank out comments, line by line, leaving code and string literals byte-for-byte intact.
 *
 * Comments are stripped because `scripts/chaos-part3.mjs` explains at length why it will not fill
 * the POSIX temp directory, and a scan that punished the explanation would push authors to delete
 * it. String literals are **not** stripped — a hardcoded path is almost always inside one.
 *
 * The first version of this walked the file character by character tracking quote state, and it was
 * wrong in a way worth recording: this repository is full of regular expression literals containing
 * quote characters, such as the ones a few lines below. The walker read the `"` inside a regex as the
 * start of a string, never saw a close, and from that point on treated the rest of the file as one
 * enormous string — so block comments stopped being recognised and leaked back into the scan as
 * violations. It also rewrote `\\` as two spaces, which silently destroyed exactly the escaped
 * backslash the Windows drive-letter rule looks for.
 *
 * Line-based with a block-comment flag is less clever and does not have either failure mode.
 */
function stripComments(source) {
  const out = [];
  let inBlock = false;

  for (const raw of source.split("\n")) {
    let line = raw;

    if (inBlock) {
      const close = line.indexOf("*/");
      if (close === -1) {
        out.push("");
        continue;
      }
      line = " ".repeat(close + 2) + line.slice(close + 2);
      inBlock = false;
    }

    // Block comment opening on this line. `/*` inside a string literal is vanishingly rare and
    // costs only a false negative, never a false positive.
    for (;;) {
      const open = line.indexOf("/*");
      if (open === -1) break;
      const close = line.indexOf("*/", open + 2);
      if (close === -1) {
        line = line.slice(0, open);
        inBlock = true;
        break;
      }
      line = line.slice(0, open) + " ".repeat(close + 2 - open) + line.slice(close + 2);
    }

    // A trailing `//` comment, but only where it is genuinely outside a string. Quote parity before
    // the candidate is what distinguishes `// note` from the `//` inside `"http://host"`.
    let search = 0;
    for (;;) {
      const slashes = line.indexOf("//", search);
      if (slashes === -1) break;
      const before = line.slice(0, slashes);
      const balanced = ['"', "'", "`"].every((quote) => {
        const matches = before.match(new RegExp(`(?<!\\\\)\\${quote}`, "g"));
        return (matches?.length ?? 0) % 2 === 0;
      });
      if (balanced) {
        line = line.slice(0, slashes);
        break;
      }
      search = slashes + 2;
    }

    out.push(line);
  }
  return out.join("\n");
}

/*
 * Absolute paths that are correct on exactly one family of machines.
 *
 * The labels are deliberately descriptive rather than examples: this file is itself inside the scan,
 * and a label containing a literal forbidden path would make the scanner report itself. Excluding
 * the scanner from its own scan would be the alternative, and it is worse — an exclusion is a hole,
 * whereas a label is just prose.
 */
const HARDCODED_PATH_RULES = [
  { pattern: /["'`]\/tmp(?:\/|["'`])/, label: "posix temp path" },
  { pattern: /["'`]\/var\/tmp(?:\/|["'`])/, label: "posix var temp path" },
  { pattern: /["'`]\/home\//, label: "linux home path" },
  { pattern: /["'`]\/Users\//, label: "macos home path" },
  // A Windows drive letter, as it appears in source: an escaped backslash.
  { pattern: /["'`][A-Za-z]:\\\\/, label: "windows drive letter" },
];

/** Shells, shell interpreters, and POSIX utilities that either do not exist on Windows or differ. */
const NON_PORTABLE_BINARIES = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "csh", "cmd", "cmd.exe", "powershell", "pwsh",
  "chmod", "chown", "chgrp", "rm", "cp", "mv", "ln", "touch", "sed", "awk", "grep",
  "which", "env", "kill", "ps", "cat", "head", "tail", "cut", "tr", "xargs", "find",
]);

/** Metacharacters that only a shell interprets. A command string holding one needs a shell. */
const SHELL_METACHARACTERS = [
  { fragment: "&&", rule: "shell-chain", label: "chains commands inside a single string" },
  { fragment: "||", rule: "shell-chain", label: "chains commands inside a single string" },
  { fragment: "$(", rule: "shell-substitution", label: "uses POSIX command substitution" },
  { fragment: ">&", rule: "shell-redirect", label: "redirects a file descriptor" },
];

/**
 * Extract the first argument of every `exec`/`spawn`-family call on a line, when it is a literal.
 *
 * This replaced a regex that looked for `&&` inside any string literal, which flagged 33 lines of
 * ordinary code: in `if (a === "x" && b === "y")` the substring `" && b === "` is a perfectly good
 * match for "a quoted string containing a command chain". The rule now only reads strings that are
 * actually handed to a child process, which is the only place a chain means anything.
 *
 * The leading `(?<![.\w$])` is the second correction and matters just as much. Without it, every
 * `db.exec("PRAGMA …")` in `@bayz/storage` and every `pattern.exec(line)` in this very file was read
 * as a child process spawning a shell — 22 more false positives across `migrations.ts`,
 * `secret-repository.ts`, `database.ts`, `catalogue.ts`, and `repository.ts`. A method call on an
 * object is not `child_process.exec`, and the import rule below is what covers the case where the
 * module is imported under a namespace.
 */
function execCallArguments(line) {
  const calls = [];
  const pattern = /(?<![.\w$])(exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(\s*(["'`])((?:[^\\]|\\.)*?)\2/g;
  let match;
  while ((match = pattern.exec(line)) !== null) {
    calls.push({ fn: match[1], command: match[3] });
  }
  return calls;
}

const SHELL_RULES = [
  {
    rule: "shell-exec-import",
    // `exec` and `execSync` interpret their argument with a shell; `execFile*` and `spawn*` do not.
    pattern: /from\s+["']node:child_process["']|require\(["']child_process["']\)/,
    refine: (line) => /\{[^}]*\b(?:exec|execSync)\b[^}]*\}\s*from/.test(line),
    label: "imports a shell-interpreting child_process API",
  },
  {
    rule: "shell-true",
    pattern: /shell\s*:\s*true/,
    label: "enables a shell",
  },
];

/**
 * Rules that read an extracted command string rather than the raw line.
 *
 * `execFile("npm", ["pack"])` is the required form and passes. `execFile("sh", ["-c", ...])`,
 * `exec("npm ci && npm test")`, and `spawn("chmod", ["700", dir])` all fail, each for its own
 * reason.
 */
function scanExecCalls(file, line, number) {
  const violations = [];
  for (const { fn, command } of execCallArguments(line)) {
    const binary = command.split(/[\\/]/).pop();
    if (NON_PORTABLE_BINARIES.has(binary)) {
      violations.push({ file, line: number, rule: "shell-binary", text: `spawns ${binary}` });
    }
    for (const { fragment, rule, label } of SHELL_METACHARACTERS) {
      if (command.includes(fragment)) {
        violations.push({ file, line: number, rule, text: label });
      }
    }
    // `exec`/`execSync` are shell-interpreting by definition, whatever they are given.
    if (fn === "exec" || fn === "execSync") {
      violations.push({ file, line: number, rule: "shell-exec-call", text: `${fn}() interprets its argument with a shell` });
    }
  }
  return violations;
}

/**
 * Scan one file's text. `userRun` selects whether the shell rules apply.
 *
 * Exported so the test can feed it synthetic sources: once the repository is clean, the repository
 * cannot demonstrate that the scanner detects anything at all.
 */
export function scanText(file, source, { userRun = false } = {}) {
  const stripped = stripComments(source);
  const lines = stripped.split("\n");
  const violations = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) continue;
    const number = index + 1;

    for (const { pattern, label } of HARDCODED_PATH_RULES) {
      if (pattern.test(line)) {
        violations.push({ file, line: number, rule: "hardcoded-path", text: label });
      }
    }

    /*
     * The rule labels below deliberately avoid writing the function call they detect. This file is
     * inside its own scan, and a label spelled as a live call made the scanner report itself — a
     * self-report is indistinguishable from a real finding in the output, and the alternative
     * (excluding the scanner from the scan) is a hole rather than a fix.
     *
     * Three shapes, because one pattern does not cover them. A direct or namespaced call
     * (`homedir()`, `os.homedir()`) is the common case; a static named import is caught even when the
     * call is on another line; and a **dynamic** `await import("node:os")` destructure has neither a
     * `from` clause nor a call on its line, so it needs its own pattern. That last one was found by
     * mutation: disabling the call rule left the suite green, because the vacuity fixture fed an
     * import and a call together and the import alone satisfied it.
     */
    if (/\bhomedir\s*\(/.test(line) || /from\s+["']node:os["'][^\n]*homedir/.test(line)) {
      if (file !== RESOLVER) {
        violations.push({ file, line: number, rule: "homedir-outside-resolver", text: "home-directory call" });
      }
    }
    if (/import\s*\{[^}]*\bhomedir\b[^}]*\}\s*from\s*["']node:os["']/.test(line) && file !== RESOLVER) {
      violations.push({ file, line: number, rule: "homedir-outside-resolver", text: "home-directory import" });
    }
    if (
      /\{[^}]*\bhomedir\b[^}]*\}\s*=\s*(?:await\s+)?(?:import|require)\s*\(\s*["'](?:node:)?os["']/.test(line) &&
      file !== RESOLVER
    ) {
      violations.push({ file, line: number, rule: "homedir-outside-resolver", text: "home-directory dynamic import" });
    }

    if (!userRun) continue;
    for (const { rule, pattern, refine, label } of SHELL_RULES) {
      if (!pattern.test(line)) continue;
      if (refine !== undefined && !refine(line)) continue;
      violations.push({ file, line: number, rule, text: label });
    }
    violations.push(...scanExecCalls(file, line, number));
  }

  // Dedupe: two rules can name the same line, and a doubled report reads like two defects.
  const seen = new Set();
  return violations.filter((entry) => {
    const key = `${entry.file}:${entry.line}:${entry.rule}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * npm lifecycle scripts.
 *
 * `npm run` spawns the platform shell, which on Windows is `cmd.exe`. `&&` works there and is
 * **allowed**: `runtime:build` is a twelve-step chain, and rewriting it as a Node driver would trade
 * a working build for a portability gesture. Everything below genuinely does not work on `cmd.exe`.
 */
const NPM_RULES = [
  { rule: "npm-substitution", pattern: /\$\((?!\{)/, label: "command substitution" },
  { rule: "npm-backtick", pattern: /`/, label: "backtick substitution" },
  { rule: "npm-or-chain", pattern: /\|\|/, label: "|| chain (cmd.exe has no ||)" },
  { rule: "npm-redirect", pattern: /\d?>&\d/, label: "fd redirection" },
  { rule: "npm-single-quote", pattern: /'/, label: "single-quoted argument (cmd.exe does not quote with ')" },
  { rule: "npm-posix-binary", pattern: /(^|\s)(sh|bash|chmod|rm|cp|mv|ln|sed|awk|touch)\s/, label: "POSIX-only binary" },
];

export function scanNpmScriptText(name, command) {
  const violations = [];
  for (const { rule, pattern, label } of NPM_RULES) {
    if (pattern.test(command)) {
      violations.push({ script: name, rule, text: label, command });
    }
  }
  return violations;
}

function manifestPaths(root) {
  const manifests = ["package.json"];
  for (const dir of ["apps", "packages"]) {
    const base = join(root, dir);
    if (!existsSync(base)) continue;
    for (const workspace of readdirSync(base, { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue;
      const manifest = join(dir, workspace.name, "package.json");
      if (existsSync(join(root, manifest))) manifests.push(manifest);
    }
  }
  return manifests;
}

export function scanRepo(root = REPO_ROOT) {
  const files = collectSourceFiles(root);
  const userRunFiles = USER_RUN_SCRIPTS.filter((file) => existsSync(join(root, file)));
  const runtimeSource = files.filter(
    (file) => file.startsWith("apps/server/src/") || /^packages\/[^/]+\/src\//.test(file),
  );
  const userRunSet = new Set([...userRunFiles, ...runtimeSource]);

  const violations = [];
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    violations.push(...scanText(file, source, { userRun: userRunSet.has(file) }));
  }

  const npmViolations = [];
  let npmScriptCount = 0;
  for (const manifest of manifestPaths(root)) {
    const scripts = JSON.parse(readFileSync(join(root, manifest), "utf8")).scripts ?? {};
    for (const [name, command] of Object.entries(scripts)) {
      npmScriptCount += 1;
      for (const entry of scanNpmScriptText(name, command)) {
        npmViolations.push({ file: manifest, ...entry });
      }
    }
  }

  return { files, userRunFiles: [...userRunSet].sort(), violations, npmViolations, npmScriptCount };
}

/**
 * Probe the real filesystem for the modes `packages/storage/src/paths.ts` actually achieves.
 *
 * Run in a child process so the probe uses the shipped `ensureDataDir` and `restrictFileMode`
 * rather than a re-implementation. The point is to record what *happened*: this device is Termux on
 * Android under proot, and some Android and FAT-derived mounts cannot represent POSIX modes at all.
 * A mode that is best-effort in the code and reported as a guarantee in the matrix is exactly the
 * overclaim this phase forbids, so the observed octal travels with the result.
 */
export function probeDataDirModes({ root = REPO_ROOT } = {}) {
  const script = `
    import { mkdtempSync, statSync, writeFileSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { ensureDataDir, restrictFileMode, restrictDatabaseFileModes, databasePath } from ${JSON.stringify(
      join(root, "packages/storage/src/paths.ts"),
    )};

    const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-mode-probe-")), "bayz");
    ensureDataDir(dataDir);
    const dirMode = statSync(dataDir).mode & 0o777;

    const db = databasePath(dataDir);
    for (const suffix of ["", "-wal", "-shm"]) writeFileSync(\`\${db}\${suffix}\`, "", { mode: 0o666 });
    restrictDatabaseFileModes(dataDir);
    const dbMode = statSync(db).mode & 0o777;
    const sidecarModes = {};
    for (const suffix of ["-wal", "-shm"]) sidecarModes[suffix] = statSync(\`\${db}\${suffix}\`).mode & 0o777;

    // The cheapest genuine chmod failure: a file that is not there.
    let missingFileTolerated = true;
    try { restrictFileMode(join(dataDir, "absent-on-purpose")); } catch { missingFileTolerated = false; }

    // The fatal branch must stay fatal: a create that genuinely cannot succeed is not tolerated.
    const asFile = join(dataDir, "occupied");
    writeFileSync(asFile, "");
    let createFailureIsFatal = false;
    let createFailureCode;
    try { ensureDataDir(join(asFile, "child")); } catch (error) {
      createFailureIsFatal = true;
      createFailureCode = error?.code;
    }

    // Calling twice must be idempotent — the daemon restarts into an existing directory.
    ensureDataDir(dataDir);
    const dirModeAfterReopen = statSync(dataDir).mode & 0o777;

    process.stdout.write(JSON.stringify({
      dirMode, dbMode, sidecarModes, dirModeAfterReopen,
      honoursModes: dirMode === 0o700 && dbMode === 0o600,
      missingFileTolerated, createFailureIsFatal, createFailureCode,
    }));
  `;

  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output);
}

function main() {
  const report = scanRepo(REPO_ROOT);
  const lines = [];
  lines.push("BAYZ portability scan — Phase 9J Task 3");
  lines.push(`  files scanned: ${report.files.length}`);
  lines.push(`  user-run surface: ${report.userRunFiles.length} files`);
  lines.push(`  npm lifecycle scripts scanned: ${report.npmScriptCount}`);
  lines.push(`  source violations: ${report.violations.length}`);
  lines.push(`  npm script violations: ${report.npmViolations.length}`);

  for (const entry of report.violations) {
    lines.push(`  VIOLATION ${entry.file}:${entry.line} ${entry.rule} — ${entry.text}`);
  }
  for (const entry of report.npmViolations) {
    lines.push(`  VIOLATION ${entry.file} ${entry.script} ${entry.rule} — ${entry.text}`);
  }

  let modes;
  try {
    modes = probeDataDirModes({ root: REPO_ROOT });
    lines.push(
      modes.honoursModes
        ? `  data dir permissions: PASS — dir 0${modes.dirMode.toString(8)}, db 0${modes.dbMode.toString(8)}`
        : `  data dir permissions: UNVERIFIED: filesystem does not honour POSIX modes — dir 0${modes.dirMode.toString(8)}, db 0${modes.dbMode.toString(8)}`,
    );
  } catch (error) {
    lines.push(`  data dir permissions: UNVERIFIED: probe failed — ${error.message.split("\n")[0]}`);
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  const failed = report.violations.length + report.npmViolations.length;
  process.exitCode = failed === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && statSync(process.argv[1]).isFile() && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
