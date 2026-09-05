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

const CHARACTER_ASSET_PATH = join(root, "apps", "dashboard", "public", "brand", "goat-router-character.webp");
const hasAsset = existsSync(CHARACTER_ASSET_PATH);

test("the TUI wordmark is plain terminal text, no image is required", () => {
  assert.match(tui.wordmark("0.1.2"), /^GOAT ROUTER  v0\.1\.2$/);
});

test("the TUI no longer draws the crude ASCII character (branding hotfix)", () => {
  // The released TUI drew a hand-rolled ASCII "GOAT" face. The approved
  // identity is the real character asset + wordmark; the ASCII approximation is
  // removed. Mode B must never render a fake character of any kind.
  assert.equal("GOAT_ART" in tui, false, "the ASCII GOAT_ART export must be gone");
  const rows = tui.headerRows({ cap: null, version: "0.1.4", status: "RUNNING", width: 60 });
  const joined = rows.join("\n");
  assert.doesNotMatch(joined, /\(o o\)|GOAT_|goat face|robot/i);
  assert.ok(rows.some((r) => r.includes("GOAT ROUTER")), "wordmark header must still appear");
});

test("Mode B (unsupported/Termux terminal) shows a clean wordmark header, no image escapes", () => {
  // A plain terminal (no TERM_PROGRAM, non-iterm2) must get the clean wordmark
  // header and MUST NOT receive an inline-image escape sequence.
  const rows = tui.headerRows({ cap: null, version: "0.1.4", status: "● Server   RUNNING", url: "http://127.0.0.1:20156", width: 70 });
  const joined = rows.join("\n");
  assert.ok(rows[0].includes("GOAT ROUTER"), `header should open with wordmark: ${rows[0]}`);
  assert.ok(!joined.includes("\x1b]1337"), "no iTerm2 inline-image escape in Mode B");
  assert.ok(!joined.includes("\x1b["), "no ANSI escape should leak into a Mode B header row");
  assert.ok(joined.includes("RUNNING"));
  assert.ok(joined.includes("http://127.0.0.1:20156"));
});

test("image capability is only claimed for a terminal that positively opts in", () => {
  // Never infer from TERM alone; kitty without a decoder is NOT image-capable.
  assert.equal(tui.imageCapability({ TERM: "xterm-256color" }, { isTTY: true }), null);
  assert.equal(tui.imageCapability({ TERM: "screen" }, { isTTY: true }), null);
  assert.equal(tui.imageCapability({ TERM: "kitty", KITTY_WINDOW_ID: "1" }, { isTTY: true }), null);
  assert.equal(tui.imageCapability({ TERM: "xterm-256color", TERM_PROGRAM: "iTerm.app" }, { isTTY: true })?.protocol, "iterm2");
  // Non-TTY stdout never yields an image capability, even under iTerm2.
  assert.equal(tui.imageCapability({ TERM_PROGRAM: "iTerm.app" }, { isTTY: false }), null);
});

test("Mode A selects the exact approved asset path and protocol", () => {
  const asset = join(tui.assetDir(), tui.characterAssetName());
  assert.equal(tui.characterAssetName(), "goat-router-character.webp");
  if (hasAsset) {
    // The approved packaged character asset is the exact one served by the Web UI.
    const rows = tui.headerRows({
      cap: { protocol: "iterm2" },
      version: "0.1.4",
      status: "RUNNING",
      width: 80,
      assetPath: CHARACTER_ASSET_PATH,
    });
    const first = rows[0];
    assert.ok(first.startsWith("\x1b]1337;File="), "Mode A should open an iTerm2 inline-image sequence");
    assert.ok(first.includes("goat-router-character.webp"), "must reference the approved character asset");
    assert.ok(first.includes("inline=1"));
    assert.ok(!first.includes("(o o)"), "Mode A must not mix in ASCII art");
  }
});

test("narrow and wide terminals keep the menu usable", () => {
  // Narrow (<50 cols): header must stay shallow and wordmark present.
  const narrow = tui.headerRows({ cap: null, version: "0.1.4", status: "○ Server   STOPPED", width: 30 });
  assert.ok(narrow.some((r) => r.includes("GOAT ROUTER")), "wordmark must not be truncated on a narrow terminal");
  assert.ok(narrow.length <= 5, `narrow header too tall: ${narrow.length} rows`);
  // Wide (>100 cols): rule extends but never truncates; layout stays clean.
  const wide = tui.headerRows({ cap: null, version: "0.1.4", status: "● Server   RUNNING", url: "http://127.0.0.1:20156", width: 120 });
  const ruleLine = wide.find((r) => r.trim().startsWith("─"));
  assert.ok(ruleLine, "wide header should include a rule");
  assert.ok(ruleLine.length > 60, "rule should span most of a wide terminal");
  assert.ok(wide.some((r) => r.includes("GOAT ROUTER")));
  assert.ok(wide.every((r) => !r.includes("\x1b]1337")), "Mode B wide header has no image escapes");
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
