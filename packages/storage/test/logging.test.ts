import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { redactSecrets } from "@bayz/security";
import { EnvKeyProvider, openSecretStorage } from "../src/index.js";

const SENTINEL = "sk-live-LOG-SENTINEL-must-never-be-logged";
const KEY = Buffer.alloc(32, 0x4d);
const NEW_KEY = Buffer.alloc(32, 0x5e);
const PASSPHRASE = "zzz-unique-unlock-factor-zzz";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bayz-log-"));
}

test("a full write/read/rotate cycle logs nothing sensitive", () => {
  const captured: string[] = [];
  const dataDir = tempDir();
  const storage = openSecretStorage({
    dataDir,
    env: { BAYZ_MASTER_KEY: KEY.toString("hex"), BAYZ_PASSPHRASE: PASSPHRASE },
    logger: (payload) => captured.push(JSON.stringify(payload)),
  });

  try {
    storage.put("provider:openai:api_key", SENTINEL);
    storage.get("provider:openai:api_key");
    storage.list();
    storage.rotateRootKey(
      new EnvKeyProvider({ BAYZ_MASTER_KEY: NEW_KEY.toString("hex") }),
    );
  } finally {
    storage.close();
  }

  assert.ok(captured.length > 0, "expected the storage layer to log something");
  const log = captured.join("\n");
  assert.doesNotMatch(log, new RegExp(SENTINEL), "plaintext secret leaked");
  assert.doesNotMatch(log, new RegExp(KEY.toString("hex")), "KEK leaked");
  assert.doesNotMatch(log, new RegExp(NEW_KEY.toString("hex")), "new KEK leaked");
  assert.doesNotMatch(log, new RegExp(PASSPHRASE), "passphrase leaked");
  assert.doesNotMatch(log, /[0-9a-f]{64}/, "key-shaped material leaked");
});

test("storage diagnostics report only non-secret operational fields", () => {
  const captured: Record<string, unknown>[] = [];
  const dataDir = tempDir();
  const storage = openSecretStorage({
    dataDir,
    env: { BAYZ_MASTER_KEY: KEY.toString("hex") },
    logger: (payload) => captured.push(payload),
  });
  storage.close();

  const opened = captured.find((entry) => entry.event === "storage_ready");
  assert.ok(opened, "expected a storage_ready diagnostic");
  assert.deepEqual(Object.keys(opened).sort(), [
    // 9F Task 5: the config-HMAC verdict is operational shape, not content — one of
    // "ok" | "unsealed" | "mismatch", with no row values and no key material.
    "configIntegrity",
    "driver",
    "event",
    "journalMode",
    "keyId",
    "keyProvider",
    "schemaVersion",
  ]);
  assert.equal(opened.keyProvider, "environment");
  assert.match(String(opened.keyId), /^kek_[0-9a-f]{32}$/);
});

test("the key id in diagnostics is a fingerprint, not the key", () => {
  const captured: Record<string, unknown>[] = [];
  const storage = openSecretStorage({
    dataDir: tempDir(),
    env: { BAYZ_MASTER_KEY: KEY.toString("hex") },
    logger: (payload) => captured.push(payload),
  });
  storage.close();

  const keyId = String(
    captured.find((entry) => entry.event === "storage_ready")?.keyId,
  );
  const keyHex = KEY.toString("hex");
  for (let offset = 0; offset + 16 <= keyHex.length; offset += 2) {
    assert.equal(keyId.includes(keyHex.slice(offset, offset + 16)), false);
  }
});

test("redaction removes storage secrets from a logged payload", () => {
  const payload = redactSecrets({
    event: "debug",
    apiKey: SENTINEL,
    kek: KEY.toString("hex"),
    nested: { wrappedDek: "raw", passphrase: PASSPHRASE, ciphertext: "bytes" },
    keyId: "kek_abc",
    schemaVersion: 1,
  });

  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, new RegExp(SENTINEL));
  assert.doesNotMatch(serialized, new RegExp(KEY.toString("hex")));
  assert.doesNotMatch(serialized, new RegExp(PASSPHRASE));
  // Non-secret operational fields must survive redaction.
  assert.match(serialized, /kek_abc/);
  assert.match(serialized, /"schemaVersion":1/);
});

test("a thrown storage error carries no secret material", () => {
  const dataDir = tempDir();
  const storage = openSecretStorage({
    dataDir,
    env: { BAYZ_MASTER_KEY: KEY.toString("hex") },
  });
  storage.put("corrupt-me", SENTINEL);
  storage.corruptForTest("corrupt-me", "ciphertext");

  try {
    storage.get("corrupt-me");
    assert.fail("expected a throw");
  } catch (error) {
    const serialized = `${String((error as Error).message)} ${String((error as Error).stack)}`;
    assert.doesNotMatch(serialized, new RegExp(SENTINEL));
    assert.doesNotMatch(serialized, new RegExp(KEY.toString("hex")));
  } finally {
    storage.close();
  }
});
