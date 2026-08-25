import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EnvKeyProvider,
  OsKeystoreKeyProvider,
  PassphraseKeyProvider,
  SCRYPT_PARAMS,
  SecureFileKeyProvider,
  StorageError,
  masterKeyPath,
  resolveKeyProvider,
} from "../src/index.js";

const KEK_BYTES = 32;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bayz-key-"));
}

function hexKey(fill: number): string {
  return Buffer.alloc(KEK_BYTES, fill).toString("hex");
}

test("EnvKeyProvider accepts a 64-character hex key", () => {
  const provider = new EnvKeyProvider({ BAYZ_MASTER_KEY: hexKey(0xab) });
  assert.equal(provider.kind, "environment");
  assert.equal(provider.available, true);
  const kek = provider.loadKek();
  assert.equal(kek.byteLength, KEK_BYTES);
  assert.equal(kek.toString("hex"), hexKey(0xab));
});

test("EnvKeyProvider accepts base64 that decodes to 32 bytes", () => {
  const raw = Buffer.alloc(KEK_BYTES, 0x5c);
  const provider = new EnvKeyProvider({ BAYZ_MASTER_KEY: raw.toString("base64") });
  assert.deepEqual(provider.loadKek(), raw);
});

test("EnvKeyProvider rejects malformed keys without hashing or truncating", () => {
  const rejected = [
    "",
    "   ",
    "not-hex-at-all",
    hexKey(0x11).slice(0, 62),
    hexKey(0x11) + "ab",
    Buffer.alloc(16, 1).toString("base64"),
    Buffer.alloc(64, 1).toString("base64"),
  ];

  for (const value of rejected) {
    assert.throws(
      () => new EnvKeyProvider({ BAYZ_MASTER_KEY: value }).loadKek(),
      (error: unknown) =>
        error instanceof StorageError && error.code === "master_key_invalid",
      `expected ${JSON.stringify(value)} to be rejected`,
    );
  }
});

test("EnvKeyProvider is unavailable without BAYZ_MASTER_KEY", () => {
  const provider = new EnvKeyProvider({});
  assert.equal(provider.available, false);
  assert.throws(
    () => provider.loadKek(),
    (error: unknown) =>
      error instanceof StorageError && error.code === "master_key_invalid",
  );
});

test("EnvKeyProvider error message never contains the supplied key", () => {
  const leaky = "deadbeef".repeat(9);
  try {
    new EnvKeyProvider({ BAYZ_MASTER_KEY: leaky }).loadKek();
    assert.fail("expected a throw");
  } catch (error) {
    assert.ok(error instanceof StorageError);
    assert.doesNotMatch(error.message, /deadbeef/);
  }
});

test("SecureFileKeyProvider generates a key file with restrictive permissions", () => {
  const dataDir = tempDir();
  const provider = new SecureFileKeyProvider(dataDir);
  assert.equal(provider.kind, "secure-file");

  const kek = provider.loadKek();
  assert.equal(kek.byteLength, KEK_BYTES);

  const keyFile = masterKeyPath(dataDir);
  const mode = statSync(keyFile).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got 0${mode.toString(8)}`);
  assert.equal(readFileSync(keyFile).byteLength, KEK_BYTES);
});

test("SecureFileKeyProvider returns the same key on a second load", () => {
  const dataDir = tempDir();
  const first = new SecureFileKeyProvider(dataDir).loadKek();
  const second = new SecureFileKeyProvider(dataDir).loadKek();
  assert.deepEqual(first, second);
});

test("SecureFileKeyProvider generates distinct keys for distinct directories", () => {
  const a = new SecureFileKeyProvider(tempDir()).loadKek();
  const b = new SecureFileKeyProvider(tempDir()).loadKek();
  assert.notDeepEqual(a, b);
});

test("SecureFileKeyProvider rejects a key file of the wrong size", () => {
  const dataDir = tempDir();
  writeFileSync(masterKeyPath(dataDir), Buffer.alloc(16, 7), { mode: 0o600 });

  assert.throws(
    () => new SecureFileKeyProvider(dataDir).loadKek(),
    (error: unknown) =>
      error instanceof StorageError && error.code === "master_key_invalid",
  );
});

test("SecureFileKeyProvider warns but still loads a world-readable key file", () => {
  // Some Android and FAT-derived mounts cannot represent POSIX modes. Failing
  // hard there would make Bayz unusable on a first-class target, so a loose mode
  // warns instead of aborting.
  const dataDir = tempDir();
  const seeded = new SecureFileKeyProvider(dataDir).loadKek();
  chmodSync(masterKeyPath(dataDir), 0o644);

  const warnings: string[] = [];
  const provider = new SecureFileKeyProvider(dataDir, {
    warn: (message) => warnings.push(message),
  });

  assert.deepEqual(provider.loadKek(), seeded);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /permission/i);
  assert.doesNotMatch(warnings[0]!, new RegExp(seeded.toString("hex")));
  assert.doesNotMatch(warnings[0]!, /[0-9a-f]{64}/);
});

test("PassphraseKeyProvider derives a stable key from the same passphrase", () => {
  const dataDir = tempDir();
  const first = new PassphraseKeyProvider(dataDir, "correct horse battery staple");
  const kek = first.loadKek();
  assert.equal(first.kind, "passphrase");
  assert.equal(kek.byteLength, KEK_BYTES);

  const second = new PassphraseKeyProvider(dataDir, "correct horse battery staple");
  assert.deepEqual(second.loadKek(), kek);
});

test("PassphraseKeyProvider derives a different key from a different passphrase", () => {
  const dataDir = tempDir();
  const a = new PassphraseKeyProvider(dataDir, "passphrase-a").loadKek();
  const b = new PassphraseKeyProvider(dataDir, "passphrase-b").loadKek();
  assert.notDeepEqual(a, b);
});

test("PassphraseKeyProvider persists a random 16-byte salt and its parameters", () => {
  const dataDir = tempDir();
  new PassphraseKeyProvider(dataDir, "unlock me").loadKek();

  const stored = JSON.parse(
    readFileSync(join(dataDir, "kdf.json"), "utf8"),
  ) as Record<string, unknown>;

  assert.equal(stored.kdf, "scrypt");
  assert.equal(stored.N, SCRYPT_PARAMS.N);
  assert.equal(stored.r, SCRYPT_PARAMS.r);
  assert.equal(stored.p, SCRYPT_PARAMS.p);
  assert.equal(Buffer.from(String(stored.salt), "base64").byteLength, 16);

  // The derived key must never be written next to its parameters.
  const raw = readFileSync(join(dataDir, "kdf.json"), "utf8");
  assert.doesNotMatch(raw, /[0-9a-f]{64}/);
});

test("PassphraseKeyProvider uses distinct salts across directories", () => {
  const a = tempDir();
  const b = tempDir();
  new PassphraseKeyProvider(a, "same passphrase").loadKek();
  new PassphraseKeyProvider(b, "same passphrase").loadKek();

  const saltOf = (dir: string) =>
    String(
      (JSON.parse(readFileSync(join(dir, "kdf.json"), "utf8")) as { salt: string })
        .salt,
    );
  assert.notEqual(saltOf(a), saltOf(b));
});

test("PassphraseKeyProvider rejects an empty passphrase", () => {
  for (const value of ["", "   "]) {
    assert.throws(
      () => new PassphraseKeyProvider(tempDir(), value).loadKek(),
      (error: unknown) =>
        error instanceof StorageError && error.code === "master_key_invalid",
    );
  }
});

test("scrypt parameters match the ARM64-measured Fortress profile", () => {
  assert.equal(SCRYPT_PARAMS.N, 1 << 16);
  assert.equal(SCRYPT_PARAMS.r, 8);
  assert.equal(SCRYPT_PARAMS.p, 1);
  assert.equal(SCRYPT_PARAMS.keyLength, KEK_BYTES);
  // Node's default maxmem is below what N=2^16 needs; an explicit budget is
  // required or scryptSync throws.
  assert.ok(SCRYPT_PARAMS.maxmem >= 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r);
});

test("OsKeystoreKeyProvider is an unimplemented interface that refuses to load", () => {
  const provider = new OsKeystoreKeyProvider();
  assert.equal(provider.kind, "os-keystore");
  assert.equal(
    provider.available,
    false,
    "os-keystore must not claim availability until a real platform adapter exists",
  );
  assert.throws(
    () => provider.loadKek(),
    (error: unknown) =>
      error instanceof StorageError && error.code === "master_key_invalid",
  );
});

test("resolveKeyProvider prefers the environment key in STANDARD mode", () => {
  const provider = resolveKeyProvider({
    dataDir: tempDir(),
    env: { BAYZ_MASTER_KEY: hexKey(0x33) },
    mode: "STANDARD",
  });
  assert.equal(provider.kind, "environment");
});

test("resolveKeyProvider falls back to the secure file in STANDARD mode", () => {
  const provider = resolveKeyProvider({
    dataDir: tempDir(),
    env: {},
    mode: "STANDARD",
  });
  assert.equal(provider.kind, "secure-file");
  assert.equal(provider.loadKek().byteLength, KEK_BYTES);
});

test("resolveKeyProvider defaults to STANDARD when no mode is given", () => {
  const provider = resolveKeyProvider({ dataDir: tempDir(), env: {} });
  assert.equal(provider.kind, "secure-file");
});

test("SECURE mode requires an explicit key instead of silently downgrading", () => {
  const dataDir = tempDir();
  assert.throws(
    () => resolveKeyProvider({ dataDir, env: {}, mode: "SECURE" }),
    (error: unknown) =>
      error instanceof StorageError && error.code === "master_key_invalid",
  );

  const provider = resolveKeyProvider({
    dataDir,
    env: { BAYZ_MASTER_KEY: hexKey(0x44) },
    mode: "SECURE",
  });
  assert.equal(provider.kind, "environment");
});

test("FORTRESS mode requires a passphrase", () => {
  const dataDir = tempDir();
  assert.throws(
    () => resolveKeyProvider({ dataDir, env: {}, mode: "FORTRESS" }),
    (error: unknown) =>
      error instanceof StorageError && error.code === "master_key_invalid",
  );

  const provider = resolveKeyProvider({
    dataDir,
    env: { BAYZ_PASSPHRASE: "unlock the fortress" },
    mode: "FORTRESS",
  });
  assert.equal(provider.kind, "passphrase");
  assert.equal(provider.loadKek().byteLength, KEK_BYTES);
});

test("resolveKeyProvider rejects an unknown mode", () => {
  assert.throws(
    () =>
      resolveKeyProvider({
        dataDir: tempDir(),
        env: {},
        mode: "PARANOID" as never,
      }),
    (error: unknown) =>
      error instanceof StorageError && error.code === "master_key_invalid",
  );
});

test("no key provider exposes key material through stringification", () => {
  const secretPassphrase = "zzz-unique-unlock-factor-zzz";
  const providers = [
    new EnvKeyProvider({ BAYZ_MASTER_KEY: hexKey(0x7e) }),
    new SecureFileKeyProvider(tempDir()),
    new PassphraseKeyProvider(tempDir(), secretPassphrase),
  ];

  for (const provider of providers) {
    provider.loadKek();
    const serialized = `${String(provider)} ${JSON.stringify(provider)}`;
    assert.doesNotMatch(
      serialized,
      /[0-9a-f]{64}/,
      `${provider.kind} leaked key-shaped material`,
    );
    // `kind` legitimately reads "passphrase"; the passphrase *value* must not appear.
    assert.doesNotMatch(
      serialized,
      new RegExp(secretPassphrase),
      `${provider.kind} leaked the passphrase value`,
    );
  }
});
