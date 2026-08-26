import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { databasePath, openSecretStorage, type SecretStorage } from "@bayz/storage";
import {
  API_TOKEN_SECRET_NAME,
  resolveApiToken,
  verifyApiToken,
} from "../src/api-token.js";

const KEY = Buffer.alloc(32, 0x44).toString("hex");

function storageIn(dir: string): SecretStorage {
  return openSecretStorage({ dataDir: dir, env: { BAYZ_MASTER_KEY: KEY } });
}

function freshDir(): string {
  return join(mkdtempSync(join(tmpdir(), "bayz-api-token-")), ".bayz");
}

test("a token is generated on first start and stored under the reserved name", () => {
  const dir = freshDir();
  const storage = storageIn(dir);
  try {
    const notices: string[] = [];
    const resolved = resolveApiToken({
      storage,
      env: {},
      notify: (line) => notices.push(line),
    });

    assert.equal(resolved.source, "generated");
    assert.match(resolved.token, /^[0-9a-f]{64}$/, "32 random bytes as hex");
    assert.equal(API_TOKEN_SECRET_NAME, "api:token");
    assert.deepEqual(
      storage.list().map((meta) => meta.name),
      [API_TOKEN_SECRET_NAME],
    );
    assert.equal(storage.get(API_TOKEN_SECRET_NAME), resolved.token);

    // Printed exactly once, and unmistakably.
    assert.equal(notices.length, 1);
    assert.ok(notices[0]?.includes(resolved.token));
    assert.match(notices[0] ?? "", /once/i);
  } finally {
    storage.close();
  }
});

test("a stored token is reused on restart and never printed again", () => {
  const dir = freshDir();
  let first: string;
  {
    const storage = storageIn(dir);
    try {
      first = resolveApiToken({ storage, env: {}, notify: () => {} }).token;
    } finally {
      storage.close();
    }
  }

  const storage = storageIn(dir);
  try {
    const notices: string[] = [];
    const again = resolveApiToken({
      storage,
      env: {},
      notify: (line) => notices.push(line),
    });
    assert.equal(again.token, first, "the same token must survive a restart");
    assert.equal(again.source, "stored");
    assert.equal(notices.length, 0, "an existing token must never be reprinted");
  } finally {
    storage.close();
  }
});

test("BAYZ_API_TOKEN takes precedence and is not written to storage", () => {
  const dir = freshDir();
  const storage = storageIn(dir);
  try {
    const notices: string[] = [];
    const resolved = resolveApiToken({
      storage,
      env: { BAYZ_API_TOKEN: "env-token-value-managed-externally" },
      notify: (line) => notices.push(line),
    });

    assert.equal(resolved.token, "env-token-value-managed-externally");
    assert.equal(resolved.source, "environment");
    assert.equal(
      storage.list().length,
      0,
      "an externally managed token must not be copied into the database",
    );
    assert.equal(notices.length, 0);
  } finally {
    storage.close();
  }
});

test("an environment token overrides an already stored one", () => {
  const dir = freshDir();
  {
    const storage = storageIn(dir);
    try {
      resolveApiToken({ storage, env: {}, notify: () => {} });
    } finally {
      storage.close();
    }
  }
  const storage = storageIn(dir);
  try {
    const resolved = resolveApiToken({
      storage,
      env: { BAYZ_API_TOKEN: "env-wins-over-stored-token" },
      notify: () => {},
    });
    assert.equal(resolved.token, "env-wins-over-stored-token");
    assert.equal(resolved.source, "environment");
  } finally {
    storage.close();
  }
});

test("a too-short or blank environment token is refused rather than accepted weakly", () => {
  const dir = freshDir();
  const storage = storageIn(dir);
  try {
    for (const value of ["", "   ", "short", "a".repeat(15)]) {
      assert.throws(
        () => resolveApiToken({ storage, env: { BAYZ_API_TOKEN: value }, notify: () => {} }),
        /BAYZ_API_TOKEN/,
        `token must be refused: ${JSON.stringify(value)}`,
      );
    }
  } finally {
    storage.close();
  }
});

test("the token is never stored in plaintext on disk", () => {
  const dir = freshDir();
  let token: string;
  const storage = storageIn(dir);
  try {
    token = resolveApiToken({ storage, env: {}, notify: () => {} }).token;
  } finally {
    storage.close();
  }

  let bytes = Buffer.alloc(0);
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      bytes = Buffer.concat([bytes, readFileSync(`${databasePath(dir)}${suffix}`)]);
    } catch {
      // Sidecar absent.
    }
  }
  assert.ok(bytes.byteLength > 0, "the scan must read real bytes");
  assert.equal(
    bytes.includes(Buffer.from(token, "utf8")),
    false,
    "the API token must be envelope-encrypted like any other secret",
  );
});

test("a corrupted stored token fails closed instead of degrading", () => {
  const dir = freshDir();
  {
    const storage = storageIn(dir);
    try {
      resolveApiToken({ storage, env: {}, notify: () => {} });
    } finally {
      storage.close();
    }
  }
  const storage = storageIn(dir);
  try {
    storage.corruptForTest(API_TOKEN_SECRET_NAME, "ciphertext");
    assert.throws(
      () => resolveApiToken({ storage, env: {}, notify: () => {} }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as { code: unknown }).code === "secret_corrupt",
      "a tampered token must not be silently replaced with a fresh one",
    );
  } finally {
    storage.close();
  }
});

test("verification accepts the exact token and rejects everything else", () => {
  const token = "a".repeat(64);
  assert.equal(verifyApiToken(token, token), true);
  assert.equal(verifyApiToken(token, `${token}x`), false);
  assert.equal(verifyApiToken(token, token.slice(0, -1)), false);
  assert.equal(verifyApiToken(token, "b".repeat(64)), false);
  assert.equal(verifyApiToken(token, ""), false);
  assert.equal(verifyApiToken(token, undefined), false);
  assert.equal(verifyApiToken(token, null as unknown as string), false);
  assert.equal(verifyApiToken(token, 42 as unknown as string), false);
});

test("verification compares digests, so length is not an oracle", () => {
  // A wrong token of a very different length must still be rejected without
  // throwing, which is what a raw timingSafeEqual on the raw bytes would do.
  const token = "c".repeat(64);
  assert.equal(verifyApiToken(token, "x"), false);
  assert.equal(verifyApiToken(token, "y".repeat(4096)), false);
});

test("verification is case sensitive and whitespace sensitive", () => {
  const token = "abcdef0123456789".repeat(4);
  assert.equal(verifyApiToken(token, token.toUpperCase()), false);
  assert.equal(verifyApiToken(token, ` ${token}`), false);
  assert.equal(verifyApiToken(token, `${token} `), false);
});

test("two generated tokens differ", () => {
  const seen = new Set<string>();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const storage = storageIn(freshDir());
    try {
      seen.add(resolveApiToken({ storage, env: {}, notify: () => {} }).token);
    } finally {
      storage.close();
    }
  }
  assert.equal(seen.size, 5, "each generated token must be unique");
});
