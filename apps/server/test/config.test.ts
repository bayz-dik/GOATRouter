import assert from "node:assert/strict";
import test from "node:test";
import { loadRuntimeConfig } from "../src/config.js";

test("uses private local defaults", () => {
  const config = loadRuntimeConfig({});
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 20128);
  assert.match(config.dataDir, /\.bayz$/);
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
