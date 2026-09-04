#!/usr/bin/env node
/**
 * GOAT ROUTER lifecycle CLI — install, start, stop, restart, status, update, verify.
 *
 * Proot-friendly by construction: no systemd, no shell, no daemon tools. A single
 * Node process manages the server through a pidfile and a real HTTP health probe,
 * so it works on Termux/Android ARM64 under proot where a user/system bus may be
 * absent. Everything that would normally be a shell builtin (kill, rm, chmod) is
 * done with the Node API, so the script is portable and passes the repository's
 * portability scan.
 *
 * The data directory is resolved by the same resolver the server uses
 * (apps/server/src/data-dir.ts), so this tool and the daemon can never disagree
 * about where the database lives. Operator data lives outside the repository and
 * is never touched by install or update.
 *
 * Commands:
 *   install   check prerequisites, install deps, build, pack, install -g
 *   start     start the server in the background (pidfile + health probe)
 *   stop      stop the server (SIGTERM, then SIGKILL after a grace period)
 *   restart   stop then start
 *   status    report pid, health, data dir, version
 *   update    fetch latest code, rebuild, verify, restart (never discards changes)
 *   verify    run the portability scan and a version check
 *   help      usage
 *
 * Run from the repository root:  node scripts/goat.mjs <command>
 */

import { spawn, spawnSync, execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * The resolver is TypeScript, so this script relaunches itself under tsx — the
 * same pattern every smoke in this repository uses. Everything under test is
 * still the real resolver, not a re-implementation.
 */
if (!process.env.BAYZ_GOAT_LOADER) {
  const relaunch = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, BAYZ_GOAT_LOADER: "1" } },
  );
  process.exit(relaunch.status ?? 1);
}

const { resolveRuntimeDataDir } = await import("../apps/server/src/data-dir.ts");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PID_FILE = "bayz.pid";
const LOG_FILE = "bayz.log";
const DEFAULT_PORT = "20128";
const DEFAULT_HOST = "127.0.0.1";
const MIN_NODE_MAJOR = 24;

function version() {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
}

function dataDir() {
  return resolveRuntimeDataDir(process.env).path;
}

function pidPath(dir) {
  return join(dir, PID_FILE);
}

function logPath(dir) {
  return join(dir, LOG_FILE);
}

function healthHost(host) {
  if (host === "0.0.0.0" || host === "::" || host === "::0") return "127.0.0.1";
  return host;
}

function healthUrl() {
  const host = healthHost(process.env.BAYZ_HOST ?? DEFAULT_HOST);
  const port = process.env.BAYZ_PORT ?? DEFAULT_PORT;
  return `http://${host}:${port}/api/health`;
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(dir) {
  const path = pidPath(dir);
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8").trim();
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function writePid(dir, pid) {
  writeFileSync(pidPath(dir), `${pid}\n`, { mode: 0o600 });
}

function removePid(dir) {
  const path = pidPath(dir);
  if (existsSync(path)) rmSync(path);
}

/**
 * Wait for the spawned server to become ready, keying on the server's OWN log
 * line rather than a bare health probe.
 *
 * The health probe alone is not enough: when the target port is already bound by
 * another server, the freshly spawned child dies with EADDRINUSE while
 * GET /api/health still answers 200 against the other process, so a probe-only
 * wait would report a false "ready" and leave a dead pidfile.
 *
 * The deterministic signal is the child's own log: on success it writes a JSON
 * line with its pid and `"msg":"Bayz Core ready"`; on a port conflict it crashes
 * with EADDRINUSE. Only that pid's own readiness counts.
 */
async function waitForHealthWatching(child, dir, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  let exitCode = undefined;
  child.once("exit", (code) => {
    exited = true;
    exitCode = code;
  });

  const readLogTail = () => {
    const path = logPath(dir);
    if (!existsSync(path)) return "";
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  };

  // Does the log show OUR pid declaring readiness, or our pid hitting a port
  // conflict?
  const ourReady = () => {
    const log = readLogTail();
    return new RegExp(`Bayz Core ready`).test(log) && log.includes(`"pid":${child.pid}`);
  };
  const ourEaddrinuse = () => {
    const log = readLogTail();
    return /EADDRINUSE|address already in use/.test(log) && log.includes(`(${child.pid})`);
  };

  while (Date.now() < deadline) {
    if (exited) {
      return { ready: false, reason: `exited(code ${exitCode})` };
    }
    if (ourReady()) {
      // Our child logged readiness; confirm the port actually answers.
      try {
        const response = await fetch(healthUrl());
        if (response.status === 200) return { ready: true, reason: "healthy" };
      } catch {
        // Not answering yet — keep waiting.
      }
    } else if (ourEaddrinuse()) {
      return { ready: false, reason: "EADDRINUSE" };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { ready: false, reason: "timeout" };
}

function serverCommand() {
  return [process.execPath, ["--import", "tsx", "apps/server/src/index.ts"]];
}

function startServer({ dir }) {
  const [cmd, args] = serverCommand();
  // The data directory is created by the server's storage layer, but the CLI
  // opens the log here, so create the directory up front on a fresh install.
  // An explicit BAYZ_DATA_DIR must exist; the storage layer is strict about
  // an empty value, so only create when absent.
  mkdirSync(dir, { recursive: true });
  const logFd = openSync(logPath(dir), "a", 0o600);
  const child = spawn(cmd, args, {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, BAYZ_DATA_DIR: dir },
  });
  writePid(dir, child.pid);
  child.unref();
  // Return the child so the caller can detect an early exit (e.g. EADDRINUSE) —
  // the health probe alone cannot distinguish "our server is ready" from
  // "some other server is already answering on this port".
  return { pid: child.pid, child };
}

function surfaceFirstBootToken(dir, fresh) {
  if (!fresh) return;
  const path = logPath(dir);
  if (!existsSync(path)) return;
  const log = readFileSync(path, "utf8");
  const match = /Bayz local API token \(shown only once, store it now\): ([0-9a-f]{64})/.exec(log);
  if (match === null) return;
  console.log("");
  console.log("GOAT ROUTER generated a local API token (shown only once):");
  console.log(`  ${match[1]}`);
  console.log("Open the dashboard and enter this token to unlock it.");
  console.log("The token is stored encrypted; it will not be printed again.");
}

async function stopServer({ dir, graceMs = 15_000 }) {
  const pid = readPid(dir);
  if (pid === undefined) {
    console.log("GOAT ROUTER is not running (no pidfile).");
    return false;
  }
  if (!isAlive(pid)) {
    console.log("GOAT ROUTER pidfile is stale; removing it.");
    removePid(dir);
    return false;
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (isAlive(pid)) {
    process.kill(pid, "SIGKILL");
    while (isAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 50));
    console.log("GOAT ROUTER stopped (SIGKILL after grace period).");
  } else {
    console.log("GOAT ROUTER stopped.");
  }
  removePid(dir);
  return true;
}

function checkPrerequisites() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE_MAJOR) {
    throw new Error(`Node.js ${MIN_NODE_MAJOR}+ is required; found ${process.versions.node}`);
  }
  try {
    execFileSync("npm", ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error("npm is required but was not found on PATH");
  }
}

function runNpm(args) {
  const result = spawnSync("npm", args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed (exit ${result.status})`);
  }
}

function verifyRequiredFiles() {
  const required = [
    "apps/dashboard/dist/index.html",
    "apps/server/src/index.ts",
    "packaging/out/bayz-router-0.1.0.tgz",
  ];
  for (const file of required) {
    if (!existsSync(join(ROOT, file))) {
      throw new Error(`required file missing after build: ${file}`);
    }
  }
}

function gitStatusClean() {
  // Refuse to update over uncommitted tracked changes. Untracked files are left alone.
  const diff = spawnSync("git", ["diff", "--quiet"], { cwd: ROOT });
  const cached = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: ROOT });
  return diff.status === 0 && cached.status === 0;
}

function runGit(args) {
  const result = spawnSync("git", args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${result.status})`);
  }
}

/* ------------------------------------------------------------------ commands */

async function cmdInstall() {
  checkPrerequisites();
  console.log("Installing dependencies...");
  runNpm(["ci"]);
  console.log("Building the runtime...");
  runNpm(["run", "runtime:build"]);
  console.log("Packing the release artifact...");
  runNpm(["run", "release:pack"]);
  verifyRequiredFiles();
  console.log("Installing the artifact globally...");
  runNpm(["install", "-g", "packaging/out/bayz-router-0.1.0.tgz"]);
  const check = spawnSync("bayz", ["--version"], { encoding: "utf8" });
  if (check.status !== 0) {
    throw new Error("bayz --version failed after global install");
  }
  console.log(`Installed GOAT ROUTER ${check.stdout.trim()}.`);
  console.log("Start it with:  node scripts/goat.mjs start");
  console.log("Operator data was not touched.");
}

async function cmdStart() {
  const dir = dataDir();
  const existing = readPid(dir);
  if (existing !== undefined && isAlive(existing)) {
    console.log(`GOAT ROUTER is already running (pid ${existing}).`);
    return;
  }
  if (existing !== undefined) {
    console.log("Removing a stale pidfile.");
    removePid(dir);
  }
  // Capture freshness before the server creates the database, so the one-time
  // token is surfaced exactly on first boot and never again.
  const fresh = !existsSync(join(dir, "bayz.db"));
  const { pid, child } = startServer({ dir });
  console.log(`Starting GOAT ROUTER (pid ${pid})...`);
  const { ready, reason } = await waitForHealthWatching(child, dir);
  if (!ready) {
    console.error(`GOAT ROUTER did not become healthy (${reason}). Check the log:`);
    console.error(`  ${logPath(dir)}`);
    removePid(dir);
    process.exitCode = 1;
    return;
  }
  console.log(`GOAT ROUTER is ready at ${healthUrl()}.`);
  surfaceFirstBootToken(dir, fresh);
}

async function cmdStop() {
  const dir = dataDir();
  await stopServer({ dir });
}

async function cmdRestart() {
  const dir = dataDir();
  await stopServer({ dir });
  // Capture freshness before the server may create a database on a first boot.
  const fresh = !existsSync(join(dir, "bayz.db"));
  const { pid, child } = startServer({ dir });
  console.log(`Restarting GOAT ROUTER (pid ${pid})...`);
  const { ready, reason } = await waitForHealthWatching(child, dir);
  if (!ready) {
    console.error(`GOAT ROUTER did not become healthy after restart (${reason}). Check the log:`);
    console.error(`  ${logPath(dir)}`);
    removePid(dir);
    process.exitCode = 1;
    return;
  }
  console.log(`GOAT ROUTER is ready at ${healthUrl()}.`);
  surfaceFirstBootToken(dir, fresh);
}

async function cmdStatus() {
  const dir = dataDir();
  const pid = readPid(dir);
  const running = pid !== undefined && isAlive(pid);
  console.log(`GOAT ROUTER ${version()}`);
  console.log(`  data dir:  ${dir}`);
  console.log(`  pid:       ${running ? pid : "(not running)"}`);
  if (running) {
    try {
      const response = await fetch(healthUrl());
      console.log(`  health:    ${response.status === 200 ? "ok" : `HTTP ${response.status}`}`);
    } catch {
      console.log("  health:    unreachable");
    }
  } else {
    console.log("  health:    (not running)");
  }
}

async function cmdUpdate() {
  if (!gitStatusClean()) {
    throw new Error(
      "The working tree has uncommitted tracked changes. Commit or stash them first; update never discards your changes.",
    );
  }
  console.log("Fetching the latest code...");
  runGit(["fetch", "origin"]);
  console.log("Fast-forwarding to the latest commit...");
  runGit(["pull", "--ff-only"]);
  console.log("Installing dependencies...");
  runNpm(["ci"]);
  console.log("Building the runtime...");
  runNpm(["run", "runtime:build"]);
  console.log("Verifying the build...");
  runNpm(["run", "release:pack"]);
  verifyRequiredFiles();
  const scan = spawnSync(process.execPath, ["scripts/portability-scan.mjs"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (scan.status !== 0) {
    throw new Error("portability scan failed after update");
  }
  const dir = dataDir();
  const wasRunning = readPid(dir) !== undefined && isAlive(readPid(dir));
  if (wasRunning) {
    console.log("Restarting the running server...");
    await cmdRestart();
  } else {
    console.log("The server was not running; start it with:  node scripts/goat.mjs start");
  }
  console.log("Update complete. Operator data was not touched.");
}

async function cmdVerify() {
  const scan = spawnSync(process.execPath, ["scripts/portability-scan.mjs"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (scan.status !== 0) {
    process.exitCode = 1;
    return;
  }
  console.log(`GOAT ROUTER ${version()} verified.`);
}

function usage() {
  console.log(`GOAT ROUTER ${version()} — lifecycle CLI`);
  console.log("");
  console.log("Usage: node scripts/goat.mjs <command>");
  console.log("");
  console.log("  install   check prerequisites, install deps, build, pack, install -g");
  console.log("  start     start the server in the background");
  console.log("  stop      stop the server");
  console.log("  restart   stop then start");
  console.log("  status    report pid, health, data dir, version");
  console.log("  update    fetch latest code, rebuild, verify, restart");
  console.log("  verify    run the portability scan and a version check");
  console.log("  help      this message");
  console.log("");
  console.log("Configuration is by the same BAYZ_* environment variables the server uses.");
}

const command = process.argv[2] ?? "help";
const handlers = {
  install: cmdInstall,
  start: cmdStart,
  stop: cmdStop,
  restart: cmdRestart,
  status: cmdStatus,
  update: cmdUpdate,
  verify: cmdVerify,
  help: usage,
};

if (handlers[command] === undefined) {
  console.error(`Unknown command: ${command}`);
  usage();
  process.exitCode = 1;
} else {
  try {
    await handlers[command]();
  } catch (error) {
    console.error(`goat: ${error.message}`);
    process.exitCode = 1;
  }
}
