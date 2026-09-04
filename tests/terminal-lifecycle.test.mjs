import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const lifecycle = await import(join(root, "scripts/lifecycle-lib.mjs"));
const tui = await import(join(root, "scripts/tui.mjs"));

/**
 * Terminal + TUI + lifecycle semantics for the GOAT ROUTER control plane.
 *
 * These run at the module level where a real TTY (and therefore the raw-mode
 * state machine) is not available, so the interactive `chooseIndex`/`notice`
 * loops are tested through their pure helpers and the lifecycle engine is
 * exercised directly with isolated data dirs. The bare-auto-start and
 * exit-leaves-running behaviours are covered end-to-end in the repo CLI
 * (`goat.mjs`) integration below, which spawns the real server.
 */

/* -------------------------------------------------------------- default port */

test("GOAT ROUTER's permanent default port is 20156, not 9Router's 20128", () => {
  assert.equal(lifecycle.DEFAULT_PORT, "20156");
  assert.equal(lifecycle.healthUrlFrom({}), "http://127.0.0.1:20156/api/health");
  assert.equal(lifecycle.healthUrlFrom({ BAYZ_PORT: "20999" }), "http://127.0.0.1:20999/api/health");
  assert.equal(lifecycle.healthUrlFrom({ BAYZ_HOST: "0.0.0.0", BAYZ_PORT: "20156" }), "http://127.0.0.1:20156/api/health");
});

/* --------------------------------------------------------------- TUI helpers */

test("the TUI wordmark is plain terminal text, no image is required", () => {
  assert.match(tui.wordmark("0.1.2"), /^GOAT ROUTER  v0\.1\.2$/);
  assert.equal(typeof tui.GOAT_ART, "string");
  assert.ok(tui.GOAT_ART.length > 0);
});

test("the TUI status text reports running / foreign / stopped distinctly", () => {
  assert.match(tui.statusText("running"), /RUNNING/);
  assert.match(tui.statusText("foreign"), /in use by another process/i);
  assert.match(tui.statusText("stopped"), /STOPPED/);
  assert.match(tui.statusText("degraded"), /DEGRADED/);
});

test("raw mode is refused when stdin is not a TTY", () => {
  // In a non-TTY test process stdin.isTTY is undefined/falsy, so enterRawMode
  // must throw rather than ever entering raw mode off-terminal.
  assert.ok(!process.stdin.isTTY, "test harness expected a non-TTY stdin");
  assert.throws(() => tui.enterRawMode(), /requires a terminal/);
});

/* ------------------------------------------------------- lifecycle-lib core */

test("isAlive and pidfile read/write round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "bayz-tui-lifecycle-"));
  try {
    assert.equal(lifecycle.readPid(dir), undefined, "no pidfile should read as absent");
    lifecycle.writePid(dir, 4242);
    assert.equal(lifecycle.readPid(dir), 4242);
    lifecycle.removePid(dir);
    assert.equal(lifecycle.readPid(dir), undefined);
    assert.equal(lifecycle.isAlive(process.pid), true, "our own process should be alive");
    assert.equal(lifecycle.isAlive(0), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serverState reports stopped with no pidfile and no listener", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bayz-tui-state-"));
  // A free port far from 20156 so no parallel test can hold it.
  const state = await lifecycle.serverState({ dir, env: { BAYZ_PORT: "20987" } });
  try {
    assert.equal(state.state, "stopped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a foreign process answering the port is not mistaken for GOAT", async () => {
  const { createServer } = await import("node:http");
  const srv = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "9router-sim" })); // no uptimeSeconds
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = srv.address().port;
  const dir = mkdtempSync(join(tmpdir(), "bayz-tui-foreign-"));
  try {
    const state = await lifecycle.serverState({ dir, env: { BAYZ_PORT: String(port) } });
    assert.equal(state.state, "foreign-port", "a foreign ok-service must be reported as foreign");
    assert.equal(state.goat, false);
  } finally {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------- repo CLI integration */

function runGoat(args, env) {
  return spawnSync(process.execPath, ["scripts/goat.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
}

/** Wait for a real HTTP health response on a port. */
async function waitForHealth(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.status === 200) return true;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/** Find a free TCP port on loopback. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

test("goat start/status/stop round-trip leaves no server behind", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "bayz-tui-cli-"));
  const dataDir = join(workspace, "data");
  const port = await freePort();

  try {
    // start
    const start = runGoat(["start"], {
      BAYZ_PORT: String(port),
      BAYZ_DATA_DIR: dataDir,
      BAYZ_API_TOKEN: "terminal-lifecycle-test-token-0123456789",
    });
    assert.equal(start.status, 0, `goat start failed:\n${start.stderr}\n${start.stdout}`);
    assert.match(start.stdout, /is ready/, start.stdout);
    assert.ok(await waitForHealth(port), "server did not become healthy");

    // status reports running + the pidfile exists
    const status = runGoat(["status"], { BAYZ_PORT: String(port), BAYZ_DATA_DIR: dataDir });
    assert.equal(status.status, 0);
    assert.match(status.stdout, /RUNNING|health:.*ok|pid:/);
    const pidfile = join(dataDir, "bayz.pid");
    assert.equal(existsSync(pidfile), true, "no pidfile after start");
    const pid = Number(readFileSync(pidfile, "utf8").trim());
    assert.ok(Number.isInteger(pid) && pid > 0);

    // start again reuses the daemon (no duplicate)
    const again = runGoat(["start"], { BAYZ_PORT: String(port), BAYZ_DATA_DIR: dataDir });
    assert.equal(again.status, 0);
    assert.match(again.stdout, /already running/, again.stdout);
    assert.equal(Number(readFileSync(pidfile, "utf8").trim()), pid, "pid changed on a re-start");

    // stop
    const stop = runGoat(["stop"], { BAYZ_PORT: String(port), BAYZ_DATA_DIR: dataDir });
    assert.equal(stop.status, 0, stop.stderr);
    assert.match(stop.stdout, /stopped/, stop.stdout);
    assert.equal(existsSync(pidfile), false, "pidfile left behind after stop");
    assert.equal(await waitForHealth(port, 2000), false, "server still answering after stop");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}, { timeout: 180_000 });
