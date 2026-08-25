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
