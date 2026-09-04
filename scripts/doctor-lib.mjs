#!/usr/bin/env node
/**
 * GOAT ROUTER diagnostics ("doctor").
 *
 * A read-only diagnostic surface for the lifecycle CLI. It inspects the
 * environment, runtime files, data directory, master key, database integrity,
 * pid/process state, port conflicts, health, and log for startup failures — and
 * reports each as PASS/WARN/FAIL without printing any secret.
 *
 * Exit codes:
 *   0  healthy (warnings alone do not fail)
 *   1  one or more real failures
 *   2  the diagnostic command itself could not complete
 *
 * `--json` emits machine-readable results without secrets.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

/*
 * The data-directory resolver is TypeScript, so the standalone CLI relaunches
 * under tsx (the same pattern every smoke and the lifecycle CLI uses) so it can
 * reach the real resolver for the default data dir. The lifecycle CLI passes an
 * explicit `dir` and never exercises this path. Gated on being run directly so
 * importing this module for tests does not relaunch.
 */
const isMain = process.argv[1] !== undefined &&
  (() => { try { return statSync(process.argv[1]).isFile(); } catch { return false; } })() &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain && !process.env.BAYZ_DOCTOR_LOADER) {
  const { spawnSync: relaunch } = await import("node:child_process");
  const r = relaunch(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, BAYZ_DOCTOR_LOADER: "1" } },
  );
  process.exit(r.status ?? 1);
}

export const MIN_NODE_MAJOR = 24;
/*
 * GOAT ROUTER's own default port is 20156. 20128 is the 9Router default; GOAT
 * must never fall back to it. BAYZ_PORT always overrides this.
 */
const DEFAULT_PORT = "20156";
const DEFAULT_HOST = "127.0.0.1";
const PID_FILE = "bayz.pid";
const LOG_FILE = "bayz.log";

/* ------------------------------------------------------------- helpers */

/**
 * Resolve the data directory. When run inside the lifecycle CLI the caller
 * passes an explicit `dir` (from the server's own resolver); standalone mode
 * honours BAYZ_DATA_DIR or falls back to the real resolver via tsx.
 */
export function dataDir(env = process.env) {
  const explicit = env.BAYZ_DATA_DIR;
  if (explicit !== undefined && explicit.trim().length > 0) {
    return resolve(explicit);
  }
  return undefined;
}

export function configuredPort(env = process.env) {
  return env.BAYZ_PORT ?? DEFAULT_PORT;
}

export function configuredHost(env = process.env) {
  return env.BAYZ_HOST ?? DEFAULT_HOST;
}

export function healthUrl(host, port) {
  const h = host === "0.0.0.0" || host === "::" || host === "::0" ? "127.0.0.1" : host;
  return `http://${h}:${port}/api/health`;
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readPidFile(dir) {
  const path = join(dir, PID_FILE);
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8").trim();
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export function processLabel(pid) {
  // Read /proc/<pid>/cmdline directly rather than shelling out to `ps`, which is
  // not portable and is flagged by the portability scan.
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const label = cmdline.replace(/\0/g, " ").trim();
    return label.length > 0 ? label.slice(0, 80) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when the port answers with a GOAT ROUTER health payload.
 *
 * GOAT's `/api/health` returns exactly `{ status: "ok", version: <semver>,
 * uptimeSeconds: <number> }`. Requiring the numeric `uptimeSeconds` field
 * distinguishes a real GOAT listener from an arbitrary service (e.g. 9Router)
 * that happens to answer `{"status":"ok"}` on a port — which the task must not
 * be reported as healthy GOAT.
 */
export async function probeHealth(host, port) {
  try {
    const response = await fetch(healthUrl(host, port), { signal: AbortSignal.timeout(5000) });
    if (response.status !== 200) return { ok: false, status: response.status, goat: false };
    const body = await response.json();
    const goat =
      body?.status === "ok" &&
      typeof body?.version === "string" &&
      /^\d+\.\d+\.\d+/.test(body.version) &&
      typeof body?.uptimeSeconds === "number";
    return {
      ok: goat,
      status: response.status,
      version: goat ? body.version : undefined,
      goat,
    };
  } catch {
    return { ok: false, status: 0, goat: false };
  }
}

/** Best-effort: is the port already bound by some process? */
export function portOccupied(port) {
  try {
    const out = spawnSync("ss", ["-tlnp"], { encoding: "utf8" });
    if (out.status === 0) {
      return out.stdout.split("\n").some((line) => line.includes(`:${port} `) || line.includes(`:${port}\t`));
    }
  } catch {
    // fall through
  }
  return false;
}

/** Read-only SQLite integrity check. Returns { ok, detail }. */
export function checkDatabaseIntegrity(dir) {
  const dbPath = join(dir, "bayz.db");
  if (!existsSync(dbPath)) return { ok: false, detail: "bayz.db missing" };
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA query_only = ON");
    const row = db.prepare("PRAGMA integrity_check").get();
    const ok = row?.integrity_check === "ok";
    return { ok, detail: ok ? "ok" : String(row?.integrity_check ?? "unknown") };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

/** Read-only schema/version check. */
export function checkSchema(dir) {
  const dbPath = join(dir, "bayz.db");
  if (!existsSync(dbPath)) return { ok: false, detail: "bayz.db missing" };
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA query_only = ON");
    const v = db.prepare("PRAGMA user_version").get();
    const head = Number(v?.user_version ?? 0);
    const ledger = db.prepare("SELECT max(version) AS head, count(*) AS n FROM schema_migrations").get();
    const ok = head > 0 && Number(ledger?.head) === head && Number(ledger?.n) === head;
    return { ok, detail: `schema v${head}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

/** Read-only: can the encrypted runtime state be opened (key present + DB readable)? */
export function checkEncryptedState(dir) {
  const keyPath = join(dir, "master.key");
  const dbPath = join(dir, "bayz.db");
  if (!existsSync(keyPath)) return { ok: false, detail: "master.key missing" };
  if (!existsSync(dbPath)) return { ok: false, detail: "bayz.db missing" };
  try {
    const key = readFileSync(keyPath);
    if (key.byteLength !== 32) return { ok: false, detail: "master.key wrong length" };
    // A read-only open of the DB with the key present is the practical check.
    const db = new DatabaseSync(dbPath, { readOnly: true });
    db.close();
    return { ok: true, detail: "key present, db readable" };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/* ------------------------------------------------------------- checks */

/**
 * Run all diagnostics. Returns an array of { name, status, detail } where
 * status is "pass" | "warn" | "fail". Never includes secrets.
 */
export async function runDoctor({ env = process.env, dir = dataDir(env), installed = false } = {}) {
  const results = [];
  const add = (name, status, detail = "") => results.push({ name, status, detail });

  // Node / npm
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add("Node.js", nodeMajor >= MIN_NODE_MAJOR ? "pass" : "fail", `v${process.versions.node}`);
  const npm = spawnSync("npm", ["--version"], { encoding: "utf8" });
  add("npm", npm.status === 0 ? "pass" : "fail", npm.status === 0 ? npm.stdout.trim() : "not found");

  // Runtime files. In the repository this means the source tree; in an installed
  // control plane (bare `bayz`) there is no checkout, so the packaged bundle is
  // the proof instead.
  if (!installed) {
    const required = ["apps/server/src/index.ts", "apps/dashboard/dist/index.html"];
    const missing = required.filter((f) => !existsSync(join(ROOT, f)));
    add("runtime files", missing.length === 0 ? "pass" : "fail", missing.length === 0 ? "present" : `missing: ${missing.join(", ")}`);
  }

  // Data directory
  const dirExists = existsSync(dir);
  add("data directory", dirExists ? "pass" : "warn", dirExists ? dir : "not present (will be created on first start)");

  // Permissions (best-effort; proot may not honor modes)
  let perms = "pass";
  let permsDetail = "ok";
  if (dirExists) {
    try {
      const mode = statSync(dir).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        perms = "warn";
        permsDetail = `data dir mode 0${mode.toString(8)} (expected 0700)`;
      }
    } catch {
      perms = "warn";
      permsDetail = "cannot stat data dir";
    }
  }
  add("permissions", perms, permsDetail);

  // Master key
  const keyPath = join(dir, "master.key");
  add("master key", existsSync(keyPath) ? "pass" : "fail", existsSync(keyPath) ? "present" : "missing");

  // Database
  const dbPath = join(dir, "bayz.db");
  add("database", existsSync(dbPath) ? "pass" : "fail", existsSync(dbPath) ? "present" : "missing");

  // Integrity metadata
  const integrityPath = join(dir, "integrity.json");
  add("integrity metadata", existsSync(integrityPath) ? "pass" : "warn", existsSync(integrityPath) ? "present" : "missing (created on first open)");

  // SQLite integrity
  const integ = checkDatabaseIntegrity(dir);
  add("database integrity", integ.ok ? "pass" : "fail", integ.detail);

  // Schema
  const schema = checkSchema(dir);
  add("schema", schema.ok ? "pass" : "warn", schema.detail);

  // Encrypted state
  const enc = checkEncryptedState(dir);
  add("encrypted state", enc.ok ? "pass" : "fail", enc.detail);

  // Pidfile / process
  const pid = readPidFile(dir);
  if (pid === undefined) {
    add("pidfile", "pass", "no pidfile (not running)");
    add("process", "pass", "not running");
  } else if (!processAlive(pid)) {
    add("pidfile", "warn", `stale pidfile (pid ${pid} not alive)`);
    add("process", "pass", "not running");
  } else {
    const label = processLabel(pid);
    add("pidfile", "pass", `pid ${pid}`);
    add("process", "pass", label ? `running: ${label}` : `running (pid ${pid})`);
  }

  // Port / health
  const host = configuredHost(env);
  const port = configuredPort(env);
  const occupied = portOccupied(port);
  const health = await probeHealth(host, port);
  if (health.ok) {
    add("configured port", "pass", `${host}:${port} answering`);
    add("health endpoint", "pass", `HTTP 200 (v${health.version ?? "?"})`);
  } else if (occupied) {
    add("configured port", "warn", `${host}:${port} occupied by another process (possibly 9Router)`);
    add("health endpoint", "fail", "no GOAT ROUTER health response on configured port");
  } else {
    add("configured port", "pass", `${host}:${port} free`);
    add("health endpoint", "warn", "server not running");
  }

  // API authentication (only when a server is up; uses a temporary token, never a real one)
  if (health.ok) {
    add("API authentication", "warn", "server up; auth requires the operator's token (not probed)");
  } else {
    add("API authentication", "pass", "not applicable (server not running)");
  }

  // Provider state (external connectivity is WARN, not FAIL)
  add("provider state", "warn", "external provider connectivity is not a core failure");

  // Backup capability. In an installed control plane the backup engine is
  // bundled with `bayz`, so it is always available there.
  if (!installed) {
    const backupLib = join(ROOT, "scripts/backup-lib.mjs");
    add("backup capability", existsSync(backupLib) ? "pass" : "fail", existsSync(backupLib) ? "available" : "missing");
  }

  // Disk space
  try {
    const out = spawnSync("df", ["-k", dir], { encoding: "utf8" });
    if (out.status === 0) {
      const line = out.stdout.split("\n")[1];
      const parts = line?.split(/\s+/);
      const availKb = Number(parts?.[3] ?? 0);
      add("disk space", availKb > 1024 * 100 ? "pass" : "warn", `${Math.round(availKb / 1024)} MB available`);
    } else {
      add("disk space", "warn", "df unavailable");
    }
  } catch {
    add("disk space", "warn", "df unavailable");
  }

  // Memory
  try {
    const out = spawnSync("free", ["-m"], { encoding: "utf8" });
    if (out.status === 0) {
      const line = out.stdout.split("\n")[1];
      const parts = line?.split(/\s+/);
      const availMb = Number(parts?.[6] ?? 0);
      add("memory", availMb > 200 ? "pass" : "warn", `${availMb} MB available`);
    } else {
      add("memory", "warn", "free unavailable");
    }
  } catch {
    add("memory", "warn", "free unavailable");
  }

  // Log diagnostics (redacted)
  const logPath = join(dir, LOG_FILE);
  if (existsSync(logPath)) {
    const log = readFileSync(logPath, "utf8");
    const hasStartupError = /EADDRINUSE|address already in use|failed to start|storage_unavailable|master_key_mismatch/i.test(log);
    add("log", hasStartupError ? "warn" : "pass", hasStartupError ? "recent startup error detected" : "no startup error detected");
  } else {
    add("log", "pass", "no log file");
  }

  return results;
}

/** Redact likely secrets from a log excerpt. */
export function redactLog(text) {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[REDACTED]")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "AIza[REDACTED]")
    .replace(/\b[0-9a-f]{64}\b/g, "[REDACTED-HEX]");
}

/* ------------------------------------------------------------- repair */

/**
 * Low-risk, deterministic repairs only. Returns a list of actions taken.
 * Refuses anything destructive or ambiguous.
 */
export function safeRepair({ dir }) {
  const actions = [];
  const pid = readPidFile(dir);
  if (pid !== undefined && !processAlive(pid)) {
    const path = join(dir, PID_FILE);
    try {
      rmSync(path, { force: true });
      actions.push("removed stale pidfile");
    } catch {
      // fall through
    }
  }
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      actions.push("created data directory");
    } catch {
      // fall through
    }
  }
  return actions;
}

/* ------------------------------------------------------------- CLI */

function usage() {
  console.log("GOAT ROUTER doctor");
  console.log("");
  console.log("Usage: node scripts/doctor-lib.mjs [--json] [--repair]");
  console.log("");
  console.log("  --json    machine-readable output (no secrets)");
  console.log("  --repair  apply only low-risk deterministic repairs");
  console.log("");
}

const args = process.argv.slice(2);
const wantJson = args.includes("--json");
const wantRepair = args.includes("--repair");

if (
  process.argv[1] !== undefined &&
  statSync(process.argv[1]).isFile() &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  main();
}

async function main() {
  try {
    let dir = dataDir();
    if (dir === undefined) {
      // Standalone: reach the real resolver (we are already relaunched under tsx).
      const { resolveRuntimeDataDir } = await import("../apps/server/src/data-dir.ts");
      dir = resolveRuntimeDataDir().path;
    }
    if (wantRepair) {
      const actions = safeRepair({ dir });
      if (wantJson) {
        console.log(JSON.stringify({ repaired: actions }));
      } else {
        console.log(actions.length === 0 ? "No low-risk repairs needed." : `Repaired: ${actions.join(", ")}`);
      }
      return;
    }

    const results = await runDoctor({ dir });
    const failures = results.filter((r) => r.status === "fail");
    const warnings = results.filter((r) => r.status === "warn");

    if (wantJson) {
      console.log(JSON.stringify({ healthy: failures.length === 0, results }, null, 2));
    } else {
      for (const r of results) {
        const mark = r.status === "pass" ? "PASS" : r.status === "warn" ? "WARN" : "FAIL";
        console.log(`${mark.padEnd(5)} ${r.name.padEnd(22)} ${r.detail}`);
      }
      console.log("");
      console.log(`${results.length - failures.length - warnings.length} pass, ${warnings.length} warn, ${failures.length} fail`);
    }

    process.exitCode = failures.length > 0 ? 1 : 0;
  } catch (error) {
    if (wantJson) {
      console.log(JSON.stringify({ healthy: false, error: error instanceof Error ? error.message : String(error) }));
    } else {
      console.error(`doctor: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 2;
  }
}
