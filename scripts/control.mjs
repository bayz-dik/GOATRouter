#!/usr/bin/env node
/**
 * GOAT ROUTER control plane — the operator surface behind the installed `bayz`
 * command. Works from any directory after `npm install -g bayz-router`.
 *
 * Operator commands:
 *   bayz                      auto-start if needed, then open the TUI (TTY);
 *                             concise status otherwise (non-TTY)
 *   bayz start / stop / restart / status / doctor
 *   bayz backup / backup-verify <file> / restore <file> [--replace]
 *   bayz update / --check-update / --version / --help
 *
 * Shares ONE lifecycle engine with the repository CLI (scripts/goat.mjs):
 * everything here delegates to scripts/lifecycle-lib.mjs, so the repository and
 * the installed control plane can never drift about a lifecycle rule.
 *
 * Two runtime contexts:
 *   - repository checkout: executed under tsx (so the data-dir resolver in
 *     apps/server/src/data-dir.ts is reachable), spawning apps/server via tsx.
 *   - installed artifact: scripts/pack.mjs bundles this module — with
 *     lifecycle-lib, doctor-lib, backup-lib, tui, and the data-dir resolver
 *     compiled in — into dist/control.mjs. The `bayz` bin imports it, and the
 *     server command is the sibling dist/server.mjs bundle.
 *
 * This file must stay free of any 64-hex literal, sk- prefix, or Bearer header,
 * because the packaging secret-scan reads its bytes.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..");
const IS_REPO = existsSync(join(PKG_ROOT, "apps", "server", "src", "index.ts"));

const lifecycle = await import("./lifecycle-lib.mjs");
const doctor = await import("./doctor-lib.mjs");
const tui = await import("./tui.mjs");

/** Package version: ../package.json is the root manifest in a checkout and the
 * artifact manifest when bundled (dist/..). Read at import like version.ts does. */
export function version() {
  const manifestUrl = new URL("../package.json", import.meta.url);
  const manifest = JSON.parse(readFileSync(fileURLToPath(manifestUrl), "utf8"));
  return manifest.version;
}

/** The data directory, via the server's own resolver (never drifted). */
export async function dataDir() {
  // In a checkout we run under tsx; in the artifact data-dir.ts is bundled in,
  // so the `.ts`/`.js` extension specifier resolves in both.
  const mod = await import("../apps/server/src/data-dir.ts");
  return mod.resolveRuntimeDataDir(process.env).path;
}

/** The Web UI base URL, from the same config defaults the server uses. */
export function webUrl() {
  const host = lifecycle.healthHost(process.env.BAYZ_HOST ?? lifecycle.DEFAULT_HOST);
  const port = process.env.BAYZ_PORT ?? lifecycle.DEFAULT_PORT;
  const scheme = lifecycle.schemeFrom(process.env);
  return `${scheme}://${host}:${port}`;
}

/** The server command for the running context. */
function serverCommand() {
  if (IS_REPO) {
    return [process.execPath, ["--import", "tsx", "apps/server/src/index.ts"]];
  }
  return [process.execPath, [join(PKG_ROOT, "dist", "server.mjs")]];
}

/* ------------------------------------------------------- platform opener */

/** Best-effort open of the Web UI; never errors if no opener exists. */
export function openWebUi(url) {
  const candidates = [];
  if (process.platform === "darwin") candidates.push("open");
  else candidates.push("xdg-open", "termux-open-url");
  for (const name of candidates) {
    try {
      const r = spawnSync(name, [url], { stdio: "ignore", timeout: 5000 });
      if (r.status === 0) return true;
    } catch {
      // try the next opener
    }
  }
  return false;
}

/* ------------------------------------------------------------- server state */

/** Machine + human status for the current environment. */
export async function serverState() {
  const dir = await dataDir();
  const pid = lifecycle.readPid(dir);
  const pidAlive = pid !== undefined && lifecycle.isAlive(pid);
  const health = await lifecycle.probeHealthAt(process.env);

  if (health.ok) {
    return { state: "running", pid: pidAlive ? pid : undefined, health: true, version: health.version, dir };
  }
  if (pid !== undefined && pidAlive) {
    return { state: "degraded", pid, health: false, dir };
  }
  if (pid !== undefined) {
    return { state: "stale", pid: undefined, health: false, dir };
  }
  if (health.goat === false && health.status !== 0) {
    return { state: "foreign", pid: undefined, health: false, dir };
  }
  return { state: "stopped", pid: undefined, health: false, dir };
}

function humanState(state) {
  switch (state) {
    case "running": return "RUNNING";
    case "degraded": return "DEGRADED";
    case "stale": return "STOPPED (stale pidfile)";
    case "foreign": return "PORT IN USE by another process";
    default: return "STOPPED";
  }
}

/* ---------------------------------------------------------- lifecycle CLI */

export async function cmdStart({ silent = false } = {}) {
  const dir = await dataDir();
  const existing = lifecycle.readPid(dir);
  if (existing !== undefined && lifecycle.isAlive(existing)) {
    if (!silent) console.log(`GOAT ROUTER is already running (pid ${existing}).`);
    return { started: false, reason: "already-running", pid: existing, dir };
  }
  if (existing !== undefined) lifecycle.removePid(dir);
  const started = await lifecycle.startHealthy({
    dir,
    command: serverCommand(),
    cwd: IS_REPO ? PKG_ROOT : undefined,
    env: process.env,
  });
  if (!started.ready) {
    if (!silent) console.error(`GOAT ROUTER could not start (${started.reason}).`);
    return { started: false, reason: started.reason, dir };
  }
  if (!silent) {
    console.log(`GOAT ROUTER is ready at ${lifecycle.healthUrlFrom(process.env)}.`);
    lifecycle.surfaceFreshToken(dir, started.fresh);
  }
  return { started: true, reason: "healthy", fresh: started.fresh, pid: started.pid, dir };
}

export async function cmdStop() {
  const dir = await dataDir();
  return lifecycle.stopServer({ dir });
}

export async function cmdRestart() {
  const dir = await dataDir();
  await lifecycle.stopServer({ dir });
  const started = await cmdStart({ silent: true });
  if (!started.started) {
    console.error(`GOAT ROUTER could not restart (${started.reason}).`);
    return { restarted: false, reason: started.reason };
  }
  console.log(`GOAT ROUTER restarted and is ready at ${lifecycle.healthUrlFrom(process.env)}.`);
  lifecycle.surfaceFreshToken(dir, started.fresh);
  return { restarted: true, dir };
}

export async function cmdStatus() {
  const state = await serverState();
  console.log(`GOAT ROUTER ${version()}  ${humanState(state.state)}`);
  if (state.state === "running") {
    console.log(`  url:   ${webUrl()}`);
    if (state.pid !== undefined) console.log(`  pid:   ${state.pid}`);
    console.log(`  data:  ${state.dir}`);
  } else {
    console.log(`  url:   ${webUrl()} (not answering)`);
    console.log(`  data:  ${state.dir}`);
    if (state.state === "foreign") {
      console.log("  The port is already used by a non-GOAT process. Fix that, then start again.");
    }
    if (state.state === "stale") {
      console.log("  A stale pidfile was found. Run: bayz doctor");
    }
  }
}

/* ---------------------------------------------------------- doctor */

export async function cmdDoctor({ json = false, repair = false } = {}) {
  const dir = await dataDir();
  if (repair) {
    const actions = doctor.safeRepair({ dir });
    if (json) console.log(JSON.stringify({ repaired: actions }));
    else console.log(actions.length === 0 ? "No low-risk repairs needed." : `Repaired: ${actions.join(", ")}`);
    return { healthy: true };
  }
  const results = await doctor.runDoctor({ dir, installed: !IS_REPO });
  const failures = results.filter((r) => r.status === "fail");
  if (json) {
    console.log(JSON.stringify({ healthy: failures.length === 0, results }, null, 2));
  } else {
    for (const r of results) {
      const mark = r.status === "pass" ? "PASS" : r.status === "warn" ? "WARN" : "FAIL";
      console.log(`${mark.padEnd(5)} ${r.name.padEnd(24)} ${r.detail}`);
    }
    console.log("");
    const warnings = results.filter((x) => x.status === "warn").length;
    console.log(`doctor: ${results.length - failures.length - warnings} pass, ${warnings} warn, ${failures.length} fail`);
  }
  return { healthy: failures.length === 0 };
}

/* ---------------------------------------------------------- backup */

export async function cmdBackup() {
  const dir = await dataDir();
  const backup = await import("./backup-lib.mjs");
  const pid = lifecycle.readPid(dir);
  const wasRunning = pid !== undefined && lifecycle.isAlive(pid);
  if (wasRunning) {
    console.log("Stopping GOAT ROUTER for a consistent snapshot...");
    await lifecycle.stopServer({ dir });
  }
  try {
    const outPath = process.env.BAYZ_BACKUP_OUTPUT ?? join(dir, `bayz-backup-${Date.now()}.tgz`);
    const path = backup.createBackup({ dataDir: dir, outPath, version: version() });
    console.log(`Backup created: ${path}`);
    console.log("Store it somewhere safe; it is as sensitive as the database.");
  } finally {
    if (wasRunning) {
      console.log("Restarting GOAT ROUTER...");
      await cmdStart({ silent: true });
    }
  }
}

export async function cmdBackupVerify(archivePath) {
  const backup = await import("./backup-lib.mjs");
  const { manifest } = backup.verifyBackup(archivePath);
  console.log(`Backup OK: format v${manifest.formatVersion}, ${manifest.files.length} files.`);
  console.log(`  created: ${manifest.createdAt}`);
  console.log(`  source:  ${manifest.sourceDataDir}`);
  return { ok: true };
}

export async function cmdRestore(archivePath, replace) {
  const dir = await dataDir();
  const backup = await import("./backup-lib.mjs");
  const pid = lifecycle.readPid(dir);
  const wasRunning = pid !== undefined && lifecycle.isAlive(pid);
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
      await cmdStart({ silent: true });
    }
  }
}

/* ---------------------------------------------------------- TUI screens */

/**
 * The Server screen. Shows real state and offers Restart / Stop / View Recent
 * Logs / Back. Every action calls the shared lifecycle engine.
 */
export async function serverScreen() {
  const state = await serverState();
  const dir = state.dir;
  const rows = [];
  rows.push("SERVER");
  rows.push("");
  rows.push(`  Status    ${humanState(state.state)}`);
  rows.push(`  Address   ${process.env.BAYZ_HOST ?? lifecycle.DEFAULT_HOST}`);
  rows.push(`  Port      ${process.env.BAYZ_PORT ?? lifecycle.DEFAULT_PORT}`);
  if (state.state === "running") {
    if (state.pid !== undefined) rows.push(`  PID       ${state.pid}`);
  }
  rows.push("");
  const choice = await tui.chooseIndex({
    rows,
    options: ["Restart Server", "Stop Server", "View Recent Logs", "Back"],
    backable: true,
  });
  if (choice === "back" || choice === "exit") return "back";
  const action = ["restart", "stop", "logs"][choice];

  if (action === "restart") {
    await cmdRestart();
    await tui.notice(["Server restarted.", "", `Web UI: ${webUrl()}`]);
  } else if (action === "stop") {
    const confirm = await tui.chooseIndex({
      rows: [
        "STOP SERVER",
        "",
        "Stopping the server closes the Web UI and any connected",
        "clients until you start it again. Continue?",
      ],
      options: ["Stop server", "Cancel"],
      backable: true,
    });
    if (confirm !== 0 || confirm === "back" || confirm === "exit") return "back";
    await cmdStop();
    await tui.notice(["Server stopped.", ""]);
  } else if (action === "logs") {
    const log = join(dir, lifecycle.LOG_FILE);
    let text;
    try {
      text = readFileSync(log, "utf8");
    } catch {
      text = "(no log file yet)";
    }
    const redacted = doctor.redactLog(text).split("\n").slice(-30).join("\n");
    await tui.notice(["RECENT LOGS", "", redacted]);
  }
  return "back";
}

/** The API Token screen. */
export async function tokenScreen() {
  const rows = [];
  rows.push("API TOKEN");
  rows.push("");
  rows.push("Status: configured (stored encrypted).");
  rows.push("");
  rows.push("The running token cannot be revealed: GOAT ROUTER stores it");
  rows.push("encrypted and never prints it again after first boot. If you");
  rows.push("lost it, rotate it to mint a replacement you can copy now.");
  const choice = await tui.chooseIndex({
    rows,
    options: ["Rotate token (mints a new one)", "Back"],
    backable: true,
  });
  if (choice !== 0 || choice === "back" || choice === "exit") return "back";

  const confirm = await tui.chooseIndex({
    rows: [
      "ROTATE API TOKEN",
      "",
      "Rotating replaces the current token. Any client using the old",
      "token stops working. Continue?",
    ],
    options: ["Rotate now", "Cancel"],
    backable: true,
  });
  if (confirm !== 0 || confirm === "back" || confirm === "exit") return "back";

  const rotated = await rotateTokenLocal();
  if (!rotated.ok) {
    await tui.notice([
      `Could not rotate the token: ${rotated.error}`,
      "",
      "Rotation requires the server to be RUNNING. If it is, a remote or",
      "browser caller needs the operator token; a local shell can rotate.",
    ]);
    return "back";
  }
  await tui.notice([
    "API TOKEN ROTATED",
    "",
    "Your new token (shown once):",
    `  ${rotated.token}`,
    "",
    "Store it now. It is stored encrypted and will not be shown again.",
    "The previous token no longer works.",
  ]);
  return "back";
}

/**
 * Rotate the API token through the running server over its loopback API,
 * mirroring the existing identity-key rotation.
 *
 * Two callers are supported:
 *   - A same-uid loopback operator with no token present: the server's
 *     loopback-local admin route allows a local, Origin-less rotate so a LOST
 *     token can be recovered. This is the deadlock case rotation exists for.
 *   - A caller with BAYZ_API_TOKEN set: the rotate is authenticated normally.
 * The new token is minted by the server, stored encrypted, returned once, and
 * never logged.
 */
async function rotateTokenLocal() {
  const state = await serverState();
  if (state.state !== "running") {
    return { ok: false, error: "server is not running" };
  }
  const token = process.env.BAYZ_API_TOKEN;
  const url = `${webUrl()}/api/security/rotate-api-token`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers:
        token === undefined
          ? { "content-type": "application/json" }
          : { authorization: `Bearer ${token}`, "content-type": "application/json" },
      // The route is a bodyless POST whose handler reads nothing, but declaring
      // application/json without a parseable body makes Fastify reject the empty
      // stream; an explicit JSON object keeps the request well-formed.
      body: "{}",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      // The API error envelope carries {code,message,requestId}; surface the
      // human message, never the whole object (which would stringify as
      // "[object Object]" in the TUI).
      const message =
        typeof body?.error?.message === "string"
          ? body.error.message
          : `HTTP ${response.status}`;
      return { ok: false, error: message };
    }
    return { ok: true, token: body.token };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/* ---------------------------------------------------------- bare entrypoint */

/**
 * `bayz` with no command:
 *  - TTY: ensure the server is running (auto-start if needed, wait on GOAT's own
 *    health proof), then open the TUI. Exiting the TUI leaves the server running.
 *  - non-TTY: print a concise status, exit 0. Never enters raw mode and never
 *    spawns a server it cannot surface to an operator.
 */
export async function bare({ tty = tui.isTty() } = {}) {
  if (!tty) {
    await cmdStatus();
    console.log("");
    console.log("Run `bayz` in a terminal to open the interactive menu.");
    console.log("Commands: start, stop, restart, status, doctor, backup, restore, update");
    return "status";
  }

  const before = await serverState();
  if (before.state === "running") {
    // reuse the running server; no duplicate.
  } else if (before.state === "foreign") {
    console.error("");
    console.error(`Port ${process.env.BAYZ_PORT ?? lifecycle.DEFAULT_PORT} is already used by another process.`);
    console.error("GOAT ROUTER will not start. Run `bayz doctor` for details.");
    return "foreign";
  } else {
    console.log("Starting GOAT ROUTER...");
    const dir = await dataDir();
    const startResult = await cmdStart({ silent: true });
    if (!startResult.started) {
      console.error("");
      console.error(`GOAT ROUTER could not start (${startResult.reason}).`);
      console.error(`Run \`bayz doctor\` or view the log at ${lifecycle.logPath(dir)}.`);
      return "error";
    }
    console.log("✓ Server ready");
    lifecycle.surfaceFreshToken(dir, startResult.fresh);
    console.log("");
  }
  return runTui();
}

/* ---------------------------------------------------------- root menu */

const ROOT_OPTIONS = ["Open Web UI", "API Token", "Server", "Status", "Doctor", "Update", "Exit TUI"];

/** Render the GOAT ROUTER header (Mode A image or Mode B wordmark) and run the root menu. */
export async function runTui() {
  const state = await serverState();
  const isRunning = state.state === "running";

  const headerRows = () => {
    // Mode A: only when a supported image terminal is positively detected AND
    // the approved character asset is present. Mode B everywhere else.
    const cap = tui.imageCapability();
    const asset = cap === null ? null : join(tui.assetDir(), tui.characterAssetName());
    const assetOk = asset !== null && existsSync(asset);
    return tui.headerRows({
      cap: assetOk ? cap : null,
      version: version(),
      status: tui.statusText(state.state),
      url: isRunning ? webUrl() : null,
      width: process.stdout.columns,
      assetPath: assetOk ? asset : null,
    });
  };

  let exit = false;
  while (!exit) {
    const choice = await tui.chooseIndex({ rows: headerRows(), options: ROOT_OPTIONS, backable: false });
    if (choice === "exit" || choice === "back") break;
    const selected = ROOT_OPTIONS[choice];
    switch (selected) {
      case "Open Web UI": {
        const ok = openWebUi(webUrl());
        await tui.notice([
          "OPEN WEB UI",
          "",
          `Web UI: ${webUrl()}`,
          ...(ok ? [] : ["", "No browser opener was found. Open the URL above manually."]),
        ]);
        break;
      }
      case "API Token":
        await tokenScreen();
        break;
      case "Server":
        await serverScreen();
        break;
      case "Status": {
        const s = await serverState();
        await tui.notice([
          "STATUS",
          "",
          `  ${tui.statusText(s.state)}`,
          `  Web UI:  ${webUrl()}`,
          ...(s.state === "running" && s.pid !== undefined ? [`  PID:     ${s.pid}`] : []),
          `  data:    ${s.dir}`,
        ]);
        break;
      }
      case "Doctor": {
        const lines = await doctorLines();
        await tui.notice(["DOCTOR", "", ...lines]);
        break;
      }
      case "Update": {
        await tui.notice([
          "UPDATE",
          "",
          "Self-update runs from the shell, not the menu:",
          "  bayz update",
        ]);
        break;
      }
      case "Exit TUI":
        exit = true;
        break;
      default:
        break;
    }
  }
  return "exit";
}

async function doctorLines() {
  const dir = await dataDir();
  const results = await doctor.runDoctor({ dir, installed: !IS_REPO });
  const failures = results.filter((r) => r.status === "fail");
  const lines = results.map((r) => `${r.status === "pass" ? "PASS" : r.status === "warn" ? "WARN" : "FAIL"}  ${r.name}: ${r.detail}`);
  lines.push("");
  lines.push(`${failures.length === 0 ? "Healthy" : `${failures.length} failure(s) — see doctor`}`);
  return lines;
}

/* ------------------------------------------------------------ CLI dispatch */

function usage() {
  const out = [];
  out.push(`GOAT ROUTER ${version()} — operator control plane`);
  out.push("");
  out.push("Usage: bayz [command]");
  out.push("");
  out.push("  (no args)   start the server if needed, then open the terminal menu (TTY)");
  out.push("              or print concise status (non-TTY)");
  out.push("  start       start the server in the background (daemonised)");
  out.push("  stop        stop the server");
  out.push("  restart     stop then start");
  out.push("  status      report state, url, pid, data dir");
  out.push("  doctor      run diagnostics (--json, --repair)");
  out.push("  backup      create a consistent backup archive");
  out.push("  backup-verify <file>   verify a backup archive");
  out.push("  restore <file> [--replace]   restore a backup archive");
  out.push("  update      check for and install the latest GitHub release");
  out.push("  --version   print the version");
  out.push("  --help      this message");
  out.push("");
  out.push("Configuration is by the same BAYZ_* environment variables the server uses.");
  return out.join("\n");
}

/**
 * The `bayz` operator-CLI entrypoint.
 *
 * Bare (`bayz`) = inspect → auto-start if needed → open the TUI (TTY), or a
 * concise status otherwise. Subcommands dispatch to the lifecycle engine.
 * `update` and `--check-update` are the one exception: they load the
 * separately-bundled update-cli, so the `bayz` process never opens a database
 * or binds a listener just to ask about an update.
 *
 * The update-cli module lives as a sibling (`./update-cli.mjs`) only in the
 * installed artifact. The repository checkout runs `goat.mjs update` instead,
 * so this dispatch resolves the sibling at runtime and reports a clear error
 * when it is absent rather than importing a path that esbuild must resolve.
 */
async function dispatchUpdate(argv) {
  const sibling = join(HERE, "update-cli.mjs");
  if (!existsSync(sibling)) {
    console.error("update is available from the installed package (npm i -g), not a repository checkout.");
    console.error("In a checkout run: node scripts/goat.mjs update");
    return 1;
  }
  const mod = await import(`${join(HERE, "update-cli")}.mjs`);
  if (argv.includes("--check-update")) {
    return mod.mainCheckUpdate();
  }
  return mod.mainUpdate();
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  if (argv.includes("--check-update") || argv[0] === "update") {
    return dispatchUpdate(argv);
  }
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const command = argv[0];
  try {
    switch (command) {
      case undefined:
      case "":
        await bare();
        return 0;
      case "start":
        await cmdStart();
        return 0;
      case "stop":
        await cmdStop();
        return 0;
      case "restart":
        await cmdRestart();
        return 0;
      case "status":
        await cmdStatus();
        return 0;
      case "doctor": {
        const json = argv.includes("--json");
        const repair = argv.includes("--repair");
        const { healthy } = await cmdDoctor({ json, repair });
        return healthy ? 0 : 1;
      }
      case "backup":
        await cmdBackup();
        return 0;
      case "backup-verify": {
        const file = argv[1];
        if (file === undefined) {
          console.error("backup-verify requires a backup file path");
          return 1;
        }
        await cmdBackupVerify(file);
        return 0;
      }
      case "restore": {
        const file = argv[1];
        if (file === undefined) {
          console.error("restore requires a backup file path");
          return 1;
        }
        await cmdRestore(file, argv.includes("--replace"));
        return 0;
      }
      default:
        console.error(`Unknown command: ${command}`);
        process.stdout.write(`${usage()}\n`);
        return 1;
    }
  } catch (error) {
    console.error(`bayz: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export async function cli() {
  process.exitCode = await main();
}
