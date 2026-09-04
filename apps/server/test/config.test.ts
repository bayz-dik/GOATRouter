import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRuntimeConfig } from "../src/config.js";

test("uses private local defaults", () => {
  const config = loadRuntimeConfig({});
  assert.equal(config.host, "127.0.0.1");
  // GOAT ROUTER's permanent default port is 20156 (its own, distinct from
  // 9Router's 20128). BAYZ_PORT overrides it; the override test covers that.
  assert.equal(config.port, 20156);
  /*
   * 9J Task 3 moved data directory resolution into `src/data-dir.ts`, and this assertion changed
   * with it. It used to be `/\.bayz$/`, which pinned the *old inlined* `${homedir()}/.bayz` — the
   * only answer the previous code could give.
   *
   * The resolver is a fallback chain: an existing `~/.bayz` always wins (the backward-compatibility
   * guard, so no existing install is orphaned), and only when none exists does it use the platform
   * path — `~/.local/share/bayz` here. So on a machine that has run BAYZ before, the old assertion
   * is still what happens; on a machine that has not, it is not. This asserts the *chain*, which is
   * the behaviour, rather than one of its two outcomes.
   *
   * Every branch of the chain is covered exhaustively in `data-dir.test.ts` against injected
   * platforms; this test only checks that `loadRuntimeConfig` is wired to it.
   */
  const legacy = join(homedir(), ".bayz");
  assert.equal(
    config.dataDir,
    existsSync(legacy) ? legacy : join(homedir(), ".local", "share", "bayz"),
    "loadRuntimeConfig no longer resolves the data directory through data-dir.ts",
  );
  // The chosen link in the chain is reported, so the daemon can log it. Metadata only: an enum.
  assert.equal(config.dataDirReason, existsSync(legacy) ? "existing" : "platform-default");
});

test("rejects invalid ports and public binding without explicit opt-in", () => {
  assert.throws(() => loadRuntimeConfig({ BAYZ_PORT: "0" }), /BAYZ_PORT/);
  assert.throws(
    () => loadRuntimeConfig({ BAYZ_HOST: "0.0.0.0" }),
    /BAYZ_ALLOW_REMOTE=true/,
  );
});

test("the whole loopback range is accepted without an opt-in", () => {
  // 9F Task 6 shares one classifier with the posture ladder. The old inline set knew
  // only 127.0.0.1, so binding 127.0.0.53 — a real loopback address, and the one
  // systemd-resolved uses — was refused as if it were remote.
  for (const host of ["127.0.0.1", "127.0.0.53", "::1", "localhost"]) {
    assert.doesNotThrow(
      () => loadRuntimeConfig({ BAYZ_HOST: host }),
      `${host} must be treated as loopback`,
    );
  }
});

test("a private-range bind still requires the opt-in", () => {
  for (const host of ["192.168.1.10", "10.0.0.5", "172.16.0.1"]) {
    assert.throws(
      () => loadRuntimeConfig({ BAYZ_HOST: host }),
      /BAYZ_ALLOW_REMOTE=true/,
      `${host} must require an explicit opt-in`,
    );
  }
});

test("allows an explicit remote binding", () => {
  const config = loadRuntimeConfig({
    BAYZ_HOST: "0.0.0.0",
    BAYZ_ALLOW_REMOTE: "true",
    BAYZ_PORT: "32128",
    BAYZ_DATA_DIR: "/tmp/bayz-data",
  });
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 32128);
  assert.equal(config.dataDir, "/tmp/bayz-data");
});
