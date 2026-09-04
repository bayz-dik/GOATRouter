#!/usr/bin/env node
/**
 * GOAT ROUTER lifecycle CLI — install, start, stop, restart, status, update,
 * doctor, backup, restore, verify.
 *
 * This is the repository-checkout shell around the shared lifecycle engine
 * (scripts/lifecycle-lib.mjs). The same engine is bundled into the installed
 * `bayz` control plane by scripts/pack.mjs, so the repository CLI and the
 * installed binary share one daemon implementation and can never drift about a
 * lifecycle rule.
 *
 * Proot-friendly by construction: no systemd, no shell, no daemon tools. The
 * data directory is resolved by the same resolver the server uses
 * (apps/server/src/data-dir.ts), so this tool and the daemon can never disagree
 * about where the database lives.
 *
 * Run from the repository root:  node scripts/goat.mjs <command>
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
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
const backup = await import("./backup-lib.mjs");
const doctor = await import("./doctor-lib.mjs");
const lifecycle = await import("./lifecycle-lib.mjs");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIN_NODE_MAJOR = 24;

function version() {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
}

function dataDir() {
  return resolveRuntimeDataDir(process.env).path;
}

/** The repository server: run index.ts under tsx from this checkout. */
function serverCommand() {
  return [process.execPath, ["--import", "tsx", "apps/server/src/index.ts"]];
}

async function cmdStart() {
  const dir = dataDir();
  const existing = lifecycle.readPid(dir);
  if (existing !== undefined && lifecycle.isAlive(existing)) {
    console.log(`GOAT ROUTER is already running (pid ${existing}).`);
    return;
  }
  if (existing !== undefined) {
    console.log("Removing a stale pidfile.");
    lifecycle.removePid(dir);
  }
  const started = await lifecycle.startHealthy({
    dir,
    command: serverCommand(),
    cwd: ROOT,
    env: process.env,
  });
  if (!started.ready) {
    console.error(
      `GOAT ROUTER did not become healthy (${started.reason}). Check the log:`,
    );
    console.error(`  ${lifecycle.logPath(dir)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`GOAT ROUTER is ready at ${lifecycle.healthUrlFrom(process.env)}.`);
  lifecycle.surfaceFreshToken(dir, started.fresh);
}

async function cmdStop() {
  const dir = dataDir();
  await lifecycle.stopServer({ dir });
}

async function cmdRestart() {
  const dir = dataDir();
  await lifecycle.stopServer({ dir });
  const started = await lifecycle.startHealthy({
    dir,
    command: serverCommand(),
    cwd: ROOT,
    env: process.env,
  });
  if (!started.ready) {
    console.error(
      `GOAT ROUTER did not become healthy after restart (${started.reason}). Check the log:`,
    );
    console.error(`  ${lifecycle.logPath(dir)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`GOAT ROUTER is ready at ${lifecycle.healthUrlFrom(process.env)}.`);
  lifecycle.surfaceFreshToken(dir, started.fresh);
}

async function cmdStatus() {
  const dir = dataDir();
  const state = await lifecycle.serverState({ dir });
  console.log(`GOAT ROUTER ${version()}`);
  console.log(`  data dir:  ${dir}`);
  if (state.state === "running") {
    console.log(`  pid:       ${state.pid ?? "(unknown)"}`);
    console.log(`  health:    ok (v${state.version ?? "?"})`);
  } else if (state.state === "foreign-port") {
    console.log("  pid:       (not running)");
    console.log("  health:    port in use by a non-GOAT process");
  } else {
    console.log(`  pid:       ${state.state === "stale-pid" || state.state === "degraded" ? state.pid : "(not running)"}`);
    console.log(`  health:    ${state.state === "stopped" ? "(not running)" : "unreachable"}`);
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
  const wasRunning = lifecycle.readPid(dir) !== undefined && lifecycle.isAlive(lifecycle.readPid(dir));
  if (wasRunning) {
    console.log("Restarting the running server...");
    await cmdRestart();
  } else {
    console.log("The server was not running; start it with:  node scripts/goat.mjs start");
  }
  console.log("Update complete. Operator data was not touched.");
}

async function cmdBackup() {
  const dir = dataDir();
  const wasRunning = lifecycle.readPid(dir) !== undefined && lifecycle.isAlive(lifecycle.readPid(dir));
  if (wasRunning) {
    console.log("Stopping GOAT ROUTER for a consistent snapshot...");
    await lifecycle.stopServer({ dir });
  }
  try {
    const outPath = process.env.BAYZ_BACKUP_OUTPUT ?? join(dir, `bayz-backup-${Date.now()}.tgz`);
    const path = backup.createBackup({ dataDir: dir, outPath, version: version() });
    console.log(`Backup created: ${path}`);
    console.log("Contains: bayz.db, master.key, integrity.json (encrypted state).");
    console.log("Store it somewhere safe; it is as sensitive as the database.");
  } finally {
    if (wasRunning) {
      console.log("Restarting GOAT ROUTER...");
      await cmdRestart();
    }
  }
}

async function cmdBackupVerify() {
  const archivePath = process.argv[3];
  if (archivePath === undefined) {
    throw new Error("backup-verify requires a backup file path");
  }
  const { manifest } = backup.verifyBackup(archivePath);
  console.log(`Backup OK: format v${manifest.formatVersion}, ${manifest.files.length} files.`);
  console.log(`  created: ${manifest.createdAt}`);
  console.log(`  source:  ${manifest.sourceDataDir}`);
  for (const file of manifest.files) {
    console.log(`  ${file.name}  ${file.sha256}`);
  }
}

async function cmdRestore() {
  const archivePath = process.argv[3];
  if (archivePath === undefined) {
    throw new Error("restore requires a backup file path");
  }
  const replace = process.argv.includes("--replace");
  const dir = dataDir();
  const wasRunning = lifecycle.readPid(dir) !== undefined && lifecycle.isAlive(lifecycle.readPid(dir));
  if (wasRunning) {
    console.log("Stopping GOAT ROUTER before restore...");
    await lifecycle.stopServer({ dir });
  }
  try {
    backup.restoreBackup({ archivePath, dataDir: dir, replace });
    console.log(`Restored runtime from ${archivePath} into ${dir}.`);
    console.log("The restored database will be opened on next start.");
  } finally {
    if (wasRunning) {
      console.log("Restarting GOAT ROUTER...");
      await cmdRestart();
    }
  }
}

async function cmdDoctor() {
  const dir = dataDir();
  const wantJson = process.argv.includes("--json");
  const wantRepair = process.argv.includes("--repair");

  if (wantRepair) {
    const actions = doctor.safeRepair({ dir });
    if (wantJson) {
      console.log(JSON.stringify({ repaired: actions }));
    } else {
      console.log(
        actions.length === 0
          ? "No low-risk repairs needed."
          : `Repaired: ${actions.join(", ")}`,
      );
    }
    return;
  }

  const results = await doctor.runDoctor({ dir });
  const failures = results.filter((r) => r.status === "fail");
  const warnings = results.filter((r) => r.status === "warn");

  if (wantJson) {
    console.log(JSON.stringify({ healthy: failures.length === 0, results }, null, 2));
  } else {
    for (const r of results) {
      const mark = r.status === "pass" ? "PASS" : r.status === "warn" ? "WARN" : "FAIL";
      console.log(`${mark.padEnd(5)} ${r.name.padEnd(24)} ${r.detail}`);
    }
    console.log("");
    console.log(
      `${results.length - failures.length - warnings.length} pass, ${warnings.length} warn, ${failures.length} fail`,
    );
  }
  process.exitCode = failures.length > 0 ? 1 : 0;
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

/* --------------------------------------------------------- repo-only: git/npm */

function gitStatusClean() {
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
    `packaging/out/bayz-router-${version()}.tgz`,
  ];
  for (const file of required) {
    if (!existsSync(join(ROOT, file))) {
      throw new Error(`required file missing after build: ${file}`);
    }
  }
}

function cmdInstall() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE_MAJOR) {
    throw new Error(`Node.js ${MIN_NODE_MAJOR}+ is required; found ${process.versions.node}`);
  }
  try {
    spawnSync("npm", ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error("npm is required but was not found on PATH");
  }
  console.log("Installing dependencies...");
  runNpm(["ci"]);
  console.log("Building the runtime...");
  runNpm(["run", "runtime:build"]);
  console.log("Packing the release artifact...");
  runNpm(["run", "release:pack"]);
  verifyRequiredFiles();
  console.log("Installing the artifact globally...");
  runNpm(["install", "-g", `packaging/out/bayz-router-${version()}.tgz`]);
  const check = spawnSync("bayz", ["--version"], { encoding: "utf8" });
  if (check.status !== 0) {
    throw new Error("bayz --version failed after global install");
  }
  console.log(`Installed GOAT ROUTER ${check.stdout.trim()}.`);
  console.log("Start it with:  bayz");
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
  console.log("  backup    create a consistent backup archive");
  console.log("  backup-verify <file>   verify a backup archive");
  console.log("  restore <file> [--replace]   restore a backup archive");
  console.log("  doctor    run diagnostics (--json, --repair)");
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
  backup: cmdBackup,
  "backup-verify": cmdBackupVerify,
  restore: cmdRestore,
  doctor: cmdDoctor,
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
