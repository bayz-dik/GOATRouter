import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  StorageError,
  openSecretStorage,
  scopedSecretStorage,
  type SecretStorage,
} from "../src/index.js";

const KEY = Buffer.alloc(32, 0x21).toString("hex");

function open(): SecretStorage {
  const dir = join(mkdtempSync(join(tmpdir(), "bayz-scoped-")), ".bayz");
  return openSecretStorage({
    dataDir: dir,
    env: { BAYZ_MASTER_KEY: KEY },
  });
}

function invalidSegment(scope: string | readonly string[]): void {
  assert.throws(
    () => scopedSecretStorage(open(), scope),
    (error: unknown) =>
      error instanceof StorageError && error.code === "invalid_argument",
  );
}

function invalidField(field: unknown): void {
  const storage = open();
  try {
    const scoped = scopedSecretStorage(storage, ["provider", "p1"]);
    assert.throws(
      () => scoped.put(field as string, "value"),
      (error: unknown) =>
        error instanceof StorageError && error.code === "invalid_argument",
    );
  } finally {
    storage.close();
  }
}

test("scoped views store and read under joined physical names", () => {
  const storage = open();
  try {
    const scoped = scopedSecretStorage(storage, ["provider", "p1"]);
    const sentinel =
      "sk-scoped-multi-\u043A\u043B\u044E\u0447-\u30AD\u30FC-must-round-trip";
    scoped.put("api_key", sentinel);
    assert.equal(scoped.get("api_key"), sentinel);

    // Physical-name proof: the envelope lives at exactly provider:<id>:api_key.
    const view = storage.inspect("provider:p1:api_key");
    assert.ok(view.keyId.startsWith("kek_"));
    assert.ok(view.ciphertext.byteLength > 0);
  } finally {
    storage.close();
  }
});

test("a single-string scope composes the same way", () => {
  const storage = open();
  try {
    const scoped = scopedSecretStorage(storage, "provider");
    scoped.put("token", "top-level-token-value");
    assert.equal(scoped.get("token"), "top-level-token-value");
    storage.inspect("provider:token");
  } finally {
    storage.close();
  }
});

test("two scopes sharing a field are isolated in both directions", () => {
  const storage = open();
  try {
    const p1 = scopedSecretStorage(storage, ["provider", "p1"]);
    const p2 = scopedSecretStorage(storage, ["provider", "p2"]);
    p1.put("api_key", "key-for-p1");
    p2.put("api_key", "key-for-p2");

    assert.equal(p1.get("api_key"), "key-for-p1");
    assert.equal(p2.get("api_key"), "key-for-p2");

    assert.equal(p1.delete("api_key"), true);
    assert.equal(p1.find("api_key"), undefined);
    assert.equal(p2.get("api_key"), "key-for-p2", "p2 survives p1's delete");
  } finally {
    storage.close();
  }
});

test("similar ids cannot collide through prefix matching", () => {
  const storage = open();
  try {
    const p1 = scopedSecretStorage(storage, ["provider", "p1"]);
    const p10 = scopedSecretStorage(storage, ["provider", "p10"]);
    p1.put("api_key", "one");
    p10.put("api_key", "ten");

    assert.deepEqual(
      p1.list().map((meta) => meta.name),
      ["api_key"],
    );
    assert.equal(p1.get("api_key"), "one");
    assert.equal(p10.get("api_key"), "ten");
  } finally {
    storage.close();
  }
});

test("list filters to the scope and strips the prefix", () => {
  const storage = open();
  try {
    storage.put("unrelated", "outside-any-scope");
    const p1 = scopedSecretStorage(storage, ["provider", "p1"]);
    const p2 = scopedSecretStorage(storage, ["provider", "p2"]);
    p1.put("api_key", "a");
    p1.put("refresh_token", "b");
    p2.put("api_key", "c");

    const names = p1.list().map((meta) => meta.name);
    assert.deepEqual(names, ["api_key", "refresh_token"]);
    for (const meta of p1.list()) {
      assert.match(meta.createdAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(typeof meta.version, "number");
    }
  } finally {
    storage.close();
  }
});

test("delete reports whether the scoped field existed", () => {
  const storage = open();
  try {
    const scoped = scopedSecretStorage(storage, ["provider", "p1"]);
    assert.equal(scoped.delete("api_key"), false);
    scoped.put("api_key", "x");
    assert.equal(scoped.delete("api_key"), true);
    assert.equal(scoped.delete("api_key"), false);
  } finally {
    storage.close();
  }
});

test("corruption under a scoped name fails closed from find and get", () => {
  const storage = open();
  try {
    const scoped = scopedSecretStorage(storage, ["provider", "p1"]);
    scoped.put("api_key", "victim-value");
    storage.corruptForTest("provider:p1:api_key", "ciphertext");

    assert.throws(
      () => scoped.find("api_key"),
      (error: unknown) =>
        error instanceof StorageError && error.code === "secret_corrupt",
      "tampered records must never masquerade as unset credentials",
    );
    assert.throws(
      () => scoped.get("api_key"),
      (error: unknown) =>
        error instanceof StorageError && error.code === "secret_corrupt",
    );
  } finally {
    storage.close();
  }
});

test("scope segments outside the allowed alphabet are rejected", () => {
  invalidSegment("");
  invalidSegment(["provider", ""]);
  invalidSegment(["Provider"]);
  invalidSegment([String("-leading-dash")]);
  invalidSegment(["a".repeat(64)]);
  invalidSegment(["a:b"]);
  invalidSegment(["a..b"]);
  invalidSegment(["a b"]);
  invalidSegment([]);
  invalidSegment([42 as unknown as string]);
});

test("fields outside the allowed alphabet are rejected", () => {
  invalidField("");
  invalidField(".hidden");
  invalidField("-lead");
  invalidField("UPPER");
  invalidField("a:b");
  invalidField("a..b");
  invalidField("f".repeat(65));
  invalidField(7 as unknown as string);
  invalidField(undefined as unknown as string);
});

test("boundary-valid segments and fields are accepted", () => {
  const storage = open();
  try {
    const scoped = scopedSecretStorage(storage, [
      "provider",
      "a".repeat(63),
    ]);
    scoped.put("refresh_token.v2", "edge-ok");
    assert.equal(scoped.get("refresh_token.v2"), "edge-ok");
  } finally {
    storage.close();
  }
});

test("scoped operations leave unrelated top-level secrets untouched", () => {
  const storage = open();
  try {
    storage.put("standalone", "keep-me");
    const scoped = scopedSecretStorage(storage, ["provider", "p1"]);
    scoped.put("api_key", "scoped");
    assert.equal(storage.get("standalone"), "keep-me");
    assert.equal(scoped.get("api_key"), "scoped");
    assert.equal(storage.list().length, 2);
  } finally {
    storage.close();
  }
});
