import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/** Wait for a real HTTP health response on a port. */
async function waitForHealth(port, timeoutMs = 20_000) {
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

/** Start a real server (the actual index.ts) on a port and wait for health. */
async function startRealServer({ port, dataDir, token }) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/server/src/index.ts"],
    {
      cwd: root,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        BAYZ_PORT: String(port),
        BAYZ_DATA_DIR: dataDir,
        BAYZ_API_TOKEN: token,
      },
    },
  );
  child.unref();
  const ready = await waitForHealth(port);
  return { child, ready };
}

function runGoat(args, env) {
  return spawnSync(process.execPath, ["scripts/goat.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
}

test("start does not report ready when the port is already in use", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "bayz-lifecycle-port-"));
  const dataDir = join(workspace, "data");
  const port = 20199;
  const token = "lifecycle-port-test-token-0123456789";

  // A real server already bound to the port.
  const foreign = await startRealServer({ port, dataDir, token });
  assert.equal(foreign.ready, true, "the foreign server did not become healthy");

  try {
    // Now the lifecycle tries to start on the SAME port. Its child will die
    // with EADDRINUSE while the health probe answers 200 against the foreign
    // server. The lifecycle must detect the child's death and NOT report ready;
    // it must also not leave a pidfile pointing at that dead child.
    const result = runGoat(["start"], {
      BAYZ_PORT: String(port),
      BAYZ_DATA_DIR: dataDir,
      BAYZ_API_TOKEN: token,
    });

    // start must not claim readiness for a server that died.
    assert.ok(
      !result.stdout.includes("is ready"),
      `start falsely reported readiness when its child died:\n${result.stdout}`,
    );

    // It must exit non-zero so a caller notices the failure.
    assert.notEqual(result.status, 0, `start exited 0 despite the port being in use`);

    // It must not leave a pidfile pointing at the dead child.
    const pidfile = join(dataDir, "bayz.pid");
    assert.equal(
      existsSync(pidfile),
      false,
      "start left a pidfile after its child died on a conflicting port",
    );
  } finally {
    foreign.child.kill("SIGKILL");
    foreign.child.unref();
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});
