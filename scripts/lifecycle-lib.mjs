#!/usr/bin/env node
/**
 * GOAT ROUTER lifecycle engine — the one daemon implementation, shared by the
 * repository CLI (scripts/goat.mjs) and the installed `bayz` control plane
 * (bundled into dist/control.mjs by scripts/pack.mjs).
 *
 * Proot-friendly by construction: no systemd, no shell, no daemon tools. A
 * single Node process manages the server through a pidfile and a real HTTP
 * health probe, so it works on Termux/Android ARM64 under proot where a user
 * or system bus may be absent. Everything that would normally be a shell
 * builtin (kill, rm, chmod) is done with the Node API, so the engine is
 * portable and passes the repository's portability scan.
 *
 * There is deliberately ONE engine. The repository CLI and the installed
 * binary must agree about every lifecycle rule: pidfile location, readiness
 * proof, stale-pidfile handling, foreign-port detection, and stop semantics.
 * Duplicating that logic would let the two drift.
 *
 * The data directory is resolved by the same resolver the server uses
 * (apps/server/src/data-dir.ts), so any caller and the daemon can never
 * disagree about where the database lives.
 */
import {
  spawn,
} from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const PID_FILE = "bayz.pid";
export const LOG_FILE = "bayz.log";
export const DB_FILE = "bayz.db";

/** GOAT ROUTER's own default port. 20128 is the 9Router default, never ours. */
export const DEFAULT_PORT = "20156";
export const DEFAULT_HOST = "127.0.0.1";

const MIN_NODE_MAJOR = 24;

/**
 * Resolve a loopback-safe health host: a wildcard bind answers on loopback,
 * so the probe targets 127.0.0.1 rather than the wildcard.
 */
export function healthHost(host) {
  if (host === "0.0.0.0" || host === "::" || host === "::0") return "127.0.0.1";
  return host;
}

export function healthUrlFrom(env, overrides = {}) {
  const host = healthHost(env.BAYZ_HOST ?? overrides.host ?? DEFAULT_HOST);
  const port = env.BAYZ_PORT ?? overrides.port ?? DEFAULT_PORT;
  return `http://${host}:${port}/api/health`;
}

export function versionFromManifest(manifestPath) {
  const raw = readFileSync(manifestPath, "utf8");
  return JSON.parse(raw).version;
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readPid(dir) {
  const path = join(dir, PID_FILE);
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8").trim();
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export function writePid(dir, pid) {
  writeFileSync(join(dir, PID_FILE), `${pid}\n`, { mode: 0o600 });
}

export function removePid(dir) {
  const path = join(dir, PID_FILE);
  if (existsSync(path)) rmSync(path);
}

export function logPath(dir) {
  return join(dir, LOG_FILE);
}

/** True when the port answers a GOAT ROUTER health payload (never a foreign one). */
export async function probeHealthAt(env, overrides = {}) {
  const host = healthHost(env.BAYZ_HOST ?? overrides.host ?? DEFAULT_HOST);
  const port = env.BAYZ_PORT ?? overrides.port ?? DEFAULT_PORT;
  try {
    const response = await fetch(`http://${host}:${port}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
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
export async function waitForHealthWatching(child, dir, timeoutMs = 60_000) {
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
      try {
        const response = await fetch(healthUrlFrom(process.env));
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

/**
 * Spawn the server detached, with its stdio redirected to the data-dir log.
 *
 * `command` is a [file, args] pair the caller resolves (a repo run spawns
 * tsx+index.ts from the checkout; an installed run spawns the server bundle).
 * Both share this exact daemonisation, so the pidfile and readiness rules are
 * identical no matter where the engine runs.
 */
export function startServer({ dir, command, cwd, env }) {
  const [cmd, args] = command;
  mkdirSync(dir, { recursive: true });
  const logFd = openSync(logPath(dir), "a", 0o600);
  const child = spawn(cmd, args, {
    cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...env, BAYZ_DATA_DIR: dir },
  });
  writePid(dir, child.pid);
  child.unref();
  return { pid: child.pid, child };
}

export async function stopServer({ dir, graceMs = 15_000, onMessage = (m) => console.log(m) }) {
  const pid = readPid(dir);
  if (pid === undefined) {
    onMessage("GOAT ROUTER is not running (no pidfile).");
    return false;
  }
  if (!isAlive(pid)) {
    onMessage("GOAT ROUTER pidfile is stale; removing it.");
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
    onMessage("GOAT ROUTER stopped (SIGKILL after grace period).");
  } else {
    onMessage("GOAT ROUTER stopped.");
  }
  removePid(dir);
  return true;
}

/**
 * Read the first-boot token out of the server log. Returns undefined when the
 * log does not show a fresh token generation (not a first boot, or an env
 * token was used). Never printed from a normal start — surfaced explicitly.
 */
export function extractFirstBootToken(dir) {
  const path = logPath(dir);
  if (!existsSync(path)) return undefined;
  const log = readFileSync(path, "utf8");
  const match = /Bayz local API token \(shown only once, store it now\): ([0-9a-f]{64})/.exec(log);
  return match === null ? undefined : match[1];
}

/**
 * Runtime identity of a live server for the current environment, or an
 * explanation of why nothing is running. Used by status/TUI so every surface
 * agrees on RUNNING / STOPPED / DEGRADED / foreign-port.
 */
export async function serverState({ dir, env = process.env, overrides = {} } = {}) {
  const pid = readPid(dir);
  const pidAlive = pid !== undefined && isAlive(pid);
  const health = await probeHealthAt(env, overrides);

  if (health.ok) {
    // A real GOAT health payload answers. The pidfile may be stale (e.g. the
    // server outlived a pidfile write or was started by another tool), but a
    // GOAT listener is GOAT.
    const alivePid =
      pidAlive ? pid
      : health.goat ? undefined
      : undefined;
    return {
      state: "running",
      pid: alivePid,
      pidAlive,
      health: health.ok,
      portOccupied: true,
      goat: true,
      version: health.version,
    };
  }

  if (health.goat === false && health.status !== 0) {
    // A foreign process answers this port but not with a GOAT payload.
    return {
      state: "foreign-port",
      pid: undefined,
      pidAlive: false,
      health: false,
      portOccupied: true,
      goat: false,
      version: undefined,
    };
  }

  if (pid !== undefined && !pidAlive) {
    return {
      state: "stale-pid",
      pid,
      pidAlive: false,
      health: false,
      portOccupied: false,
      goat: false,
      version: undefined,
    };
  }

  if (pid !== undefined && pidAlive) {
    // A live pid but the port does not answer (yet, or it crashed without
    // exiting). Reported as degraded: the operator needs Doctor/Logs.
    return {
      state: "degraded",
      pid,
      pidAlive: true,
      health: false,
      portOccupied: false,
      goat: false,
      version: undefined,
    };
  }

  return {
    state: "stopped",
    pid: undefined,
    pidAlive: false,
    health: false,
    portOccupied: false,
    goat: false,
    version: undefined,
  };
}

export function checkPrerequisites() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE_MAJOR) {
    throw new Error(`Node.js ${MIN_NODE_MAJOR}+ is required; found ${process.versions.node}`);
  }
}

/**
 * One helper for "start the server and prove it became healthy".
 *
 * Resolves freshness (was the database created on this boot?) before the
 * server may create it, spawns through the shared daemonisation, and waits on
 * the child's OWN log line plus a real health probe. Both the repository CLI
 * and the installed control plane call exactly this, so a readiness proof can
 * never differ between them.
 */
export async function startHealthy({ dir, command, cwd, env = process.env, timeoutMs }) {
  const fresh = !existsSync(join(dir, DB_FILE));
  const { pid, child } = startServer({ dir, command, cwd, env });
  const { ready, reason } = await waitForHealthWatching(child, dir, timeoutMs);
  if (!ready) {
    removePid(dir);
  }
  return { ready, reason, fresh, pid };
}

/**
 * Surface a freshly generated first-boot token exactly once.
 *
 * The token is read out of the server's own log (the one place a generated
 * token is ever printed) and shown to the operator. It is never logged by this
 * function, never stored in a new plaintext file, and only ever surfaced when
 * `fresh` says this boot created the database.
 */
export function surfaceFreshToken(dir, fresh, onLine = (line) => console.log(line)) {
  if (!fresh) return;
  const token = extractFirstBootToken(dir);
  if (token === undefined) return;
  onLine("");
  onLine("GOAT ROUTER generated a local API token (shown only once):");
  onLine(`  ${token}`);
  onLine("Open the dashboard and enter this token to unlock it.");
  onLine("The token is stored encrypted; it will not be printed again.");
}
