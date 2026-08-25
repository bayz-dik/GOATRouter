import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  ENVELOPE_VERSION,
  SECRET_ALGORITHM,
  StorageError,
  computeKeyId,
  openSecret,
  rewrapEnvelope,
  sealSecret,
  type SecretEnvelope,
} from "../src/index.js";

const NAME = "provider:openai:api_key";
const PLAINTEXT = "sk-live-do-not-leak-0123456789";

function kek(fill: number): Buffer {
  return Buffer.alloc(32, fill);
}

function clone(envelope: SecretEnvelope): SecretEnvelope {
  return {
    ...envelope,
    wrappedDek: Uint8Array.from(envelope.wrappedDek),
    wrapIv: Uint8Array.from(envelope.wrapIv),
    wrapTag: Uint8Array.from(envelope.wrapTag),
    ciphertext: Uint8Array.from(envelope.ciphertext),
    iv: Uint8Array.from(envelope.iv),
    tag: Uint8Array.from(envelope.tag),
  };
}

function flipFirstByte(bytes: Uint8Array): Uint8Array {
  const copy = Uint8Array.from(bytes);
  copy[0] = copy[0]! ^ 0xff;
  return copy;
}

function expectCorrupt(run: () => unknown, label: string): void {
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof StorageError && error.code === "secret_corrupt",
    label,
  );
}

test("round-trips a secret, including multi-byte UTF-8", () => {
  const key = kek(0x11);
  for (const plaintext of [PLAINTEXT, "kunci-rahasia-日本語-🔐-ünïcode", "x", ""]) {
    const envelope = sealSecret(key, NAME, plaintext);
    assert.equal(openSecret(key, NAME, envelope), plaintext);
  }
});

test("an empty secret still produces a non-empty authenticated ciphertext", () => {
  // AES-GCM of an empty string yields zero ciphertext bytes, which would be
  // indistinguishable from an emptied column. Framing keeps empty secrets
  // storable while an emptied ciphertext stays detectable as corruption.
  const key = kek(0x12);
  const envelope = sealSecret(key, NAME, "");
  assert.ok(envelope.ciphertext.byteLength >= 1);
  assert.equal(openSecret(key, NAME, envelope), "");
});

test("envelope carries the metadata needed for later migration", () => {
  const envelope = sealSecret(kek(0x22), NAME, PLAINTEXT);
  assert.equal(envelope.version, ENVELOPE_VERSION);
  assert.equal(envelope.version, 1);
  assert.equal(envelope.algorithm, SECRET_ALGORITHM);
  assert.equal(envelope.algorithm, "aes-256-gcm");
  assert.equal(envelope.kdf, "none");
  assert.match(envelope.keyId, /^kek_[0-9a-f]{32}$/);
  assert.equal(envelope.iv.byteLength, 12);
  assert.equal(envelope.tag.byteLength, 16);
  assert.equal(envelope.wrapIv.byteLength, 12);
  assert.equal(envelope.wrapTag.byteLength, 16);
  assert.equal(envelope.wrappedDek.byteLength, 32);
});

test("identical plaintext under one KEK yields different IVs, ciphertext, and DEKs", () => {
  const key = kek(0x33);
  const a = sealSecret(key, NAME, PLAINTEXT);
  const b = sealSecret(key, NAME, PLAINTEXT);

  assert.notDeepEqual(a.iv, b.iv, "IV must never repeat");
  assert.notDeepEqual(a.ciphertext, b.ciphertext, "no deterministic encryption");
  assert.notDeepEqual(a.wrapIv, b.wrapIv);
  assert.notDeepEqual(
    a.wrappedDek,
    b.wrappedDek,
    "each write must mint a fresh per-secret DEK",
  );
  assert.equal(openSecret(key, NAME, a), PLAINTEXT);
  assert.equal(openSecret(key, NAME, b), PLAINTEXT);
});

test("plaintext bytes never appear in the ciphertext or wrapped DEK", () => {
  const envelope = sealSecret(kek(0x44), NAME, PLAINTEXT);
  const needle = Buffer.from(PLAINTEXT, "utf8");
  assert.equal(Buffer.from(envelope.ciphertext).includes(needle), false);
  assert.equal(Buffer.from(envelope.wrappedDek).includes(needle), false);
});

test("fails closed on the wrong KEK", () => {
  const envelope = sealSecret(kek(0x55), NAME, PLAINTEXT);
  expectCorrupt(() => openSecret(kek(0x56), NAME, envelope), "wrong KEK");
});

test("fails closed on a tampered ciphertext", () => {
  const key = kek(0x66);
  const envelope = clone(sealSecret(key, NAME, PLAINTEXT));
  envelope.ciphertext = flipFirstByte(envelope.ciphertext);
  expectCorrupt(() => openSecret(key, NAME, envelope), "tampered ciphertext");
});

test("fails closed on a tampered secret auth tag", () => {
  const key = kek(0x77);
  const envelope = clone(sealSecret(key, NAME, PLAINTEXT));
  envelope.tag = flipFirstByte(envelope.tag);
  expectCorrupt(() => openSecret(key, NAME, envelope), "tampered tag");
});

test("fails closed on a tampered wrapped DEK", () => {
  const key = kek(0x88);
  const envelope = clone(sealSecret(key, NAME, PLAINTEXT));
  envelope.wrappedDek = flipFirstByte(envelope.wrappedDek);
  expectCorrupt(() => openSecret(key, NAME, envelope), "tampered wrapped DEK");
});

test("fails closed on a tampered wrap auth tag", () => {
  const key = kek(0x99);
  const envelope = clone(sealSecret(key, NAME, PLAINTEXT));
  envelope.wrapTag = flipFirstByte(envelope.wrapTag);
  expectCorrupt(() => openSecret(key, NAME, envelope), "tampered wrap tag");
});

test("fails closed on a tampered IV", () => {
  const key = kek(0xaa);
  const envelope = clone(sealSecret(key, NAME, PLAINTEXT));
  envelope.iv = flipFirstByte(envelope.iv);
  expectCorrupt(() => openSecret(key, NAME, envelope), "tampered IV");
});

test("fails closed on an unsupported envelope version", () => {
  const key = kek(0xbb);
  const envelope = clone(sealSecret(key, NAME, PLAINTEXT));
  (envelope as { version: number }).version = 2;
  expectCorrupt(() => openSecret(key, NAME, envelope), "unsupported version");
});

test("fails closed on an unknown algorithm", () => {
  const key = kek(0xcc);
  const envelope = clone(sealSecret(key, NAME, PLAINTEXT));
  (envelope as { algorithm: string }).algorithm = "aes-128-cbc";
  expectCorrupt(() => openSecret(key, NAME, envelope), "unknown algorithm");
});

test("fails closed on truncated or malformed fields", () => {
  const key = kek(0xdd);
  const base = sealSecret(key, NAME, PLAINTEXT);

  const mutations: Array<[string, (e: SecretEnvelope) => void]> = [
    ["short iv", (e) => (e.iv = e.iv.slice(0, 8))],
    ["long iv", (e) => (e.iv = new Uint8Array(16))],
    ["short tag", (e) => (e.tag = e.tag.slice(0, 8))],
    ["short wrapIv", (e) => (e.wrapIv = e.wrapIv.slice(0, 8))],
    ["short wrapTag", (e) => (e.wrapTag = e.wrapTag.slice(0, 8))],
    ["short wrappedDek", (e) => (e.wrappedDek = e.wrappedDek.slice(0, 16))],
    ["empty ciphertext", (e) => (e.ciphertext = new Uint8Array(0))],
  ];

  for (const [label, mutate] of mutations) {
    const envelope = clone(base);
    mutate(envelope);
    expectCorrupt(() => openSecret(key, NAME, envelope), label);
  }
});

test("AAD binding rejects an envelope moved to a different secret name", () => {
  // Without AAD binding an attacker with write access to the database could
  // relocate a known-value envelope onto another secret's row and plain GCM
  // would happily decrypt it.
  const key = kek(0xee);
  const envelope = sealSecret(key, "provider:openai:api_key", PLAINTEXT);
  expectCorrupt(
    () => openSecret(key, "provider:anthropic:api_key", envelope),
    "relocated envelope",
  );
  assert.equal(openSecret(key, "provider:openai:api_key", envelope), PLAINTEXT);
});

test("rejects a KEK of the wrong length", () => {
  for (const bad of [Buffer.alloc(16, 1), Buffer.alloc(31, 1), Buffer.alloc(33, 1)]) {
    assert.throws(
      () => sealSecret(bad, NAME, PLAINTEXT),
      (error: unknown) =>
        error instanceof StorageError && error.code === "master_key_invalid",
    );
  }

  const envelope = sealSecret(kek(0x01), NAME, PLAINTEXT);
  assert.throws(
    () => openSecret(Buffer.alloc(16, 1), NAME, envelope),
    (error: unknown) =>
      error instanceof StorageError && error.code === "master_key_invalid",
  );
});

test("a failed open never returns a value", () => {
  // Guards against an accidental `return ""` or `return null` fallback: every
  // failure path must throw, so no assertion here can observe a return value.
  const envelope = clone(sealSecret(kek(0x02), NAME, PLAINTEXT));
  envelope.ciphertext = flipFirstByte(envelope.ciphertext);

  let returned: unknown = Symbol("untouched");
  try {
    returned = openSecret(kek(0x02), NAME, envelope);
    assert.fail("expected openSecret to throw");
  } catch (error) {
    assert.ok(error instanceof StorageError);
  }
  assert.equal(typeof returned, "symbol", "openSecret must not have returned");
});

test("error messages never leak plaintext, key bytes, or OpenSSL detail", () => {
  const key = kek(0x03);
  const envelope = clone(sealSecret(key, NAME, PLAINTEXT));
  envelope.ciphertext = flipFirstByte(envelope.ciphertext);

  try {
    openSecret(key, NAME, envelope);
    assert.fail("expected a throw");
  } catch (error) {
    assert.ok(error instanceof StorageError);
    const serialized = `${error.message} ${String(error.stack)}`;
    assert.doesNotMatch(serialized, new RegExp(PLAINTEXT));
    assert.doesNotMatch(serialized, new RegExp(key.toString("hex")));
    assert.doesNotMatch(serialized, /unable to authenticate/i);
    assert.doesNotMatch(serialized, /Unsupported state/i);
  }
});

test("rewrapEnvelope moves an envelope to a new KEK without re-encrypting", () => {
  const oldKek = kek(0x10);
  const newKek = kek(0x20);
  const original = sealSecret(oldKek, NAME, PLAINTEXT);

  const rewrapped = rewrapEnvelope(oldKek, newKek, NAME, original);

  assert.equal(openSecret(newKek, NAME, rewrapped), PLAINTEXT);
  expectCorrupt(
    () => openSecret(oldKek, NAME, rewrapped),
    "old KEK must no longer open a rewrapped envelope",
  );

  // Rewrap-only: the secret ciphertext is untouched, so rotation costs O(rows)
  // tiny wraps rather than O(bytes) re-encryption and never materializes plaintext.
  assert.deepEqual(rewrapped.ciphertext, original.ciphertext);
  assert.deepEqual(rewrapped.iv, original.iv);
  assert.deepEqual(rewrapped.tag, original.tag);
  assert.notDeepEqual(rewrapped.wrappedDek, original.wrappedDek);
  assert.notDeepEqual(rewrapped.wrapIv, original.wrapIv);
  assert.equal(rewrapped.keyId, computeKeyId(newKek));
  assert.notEqual(rewrapped.keyId, original.keyId);
});

test("rewrapEnvelope fails closed when the old KEK is wrong", () => {
  const envelope = sealSecret(kek(0x30), NAME, PLAINTEXT);
  expectCorrupt(
    () => rewrapEnvelope(kek(0x31), kek(0x40), NAME, envelope),
    "rewrap with wrong old KEK",
  );
});

test("rewrapEnvelope preserves the DEK so the plaintext stays readable", () => {
  const oldKek = kek(0x50);
  const newKek = kek(0x60);
  const first = sealSecret(oldKek, NAME, PLAINTEXT);
  const second = rewrapEnvelope(oldKek, newKek, NAME, first);
  const third = rewrapEnvelope(newKek, oldKek, NAME, second);

  assert.equal(openSecret(oldKek, NAME, third), PLAINTEXT);
  assert.deepEqual(third.ciphertext, first.ciphertext);
});

test("computeKeyId is stable, distinct per key, and reveals no key material", () => {
  const key = randomBytes(32);
  const other = randomBytes(32);

  assert.equal(computeKeyId(key), computeKeyId(key));
  assert.notEqual(computeKeyId(key), computeKeyId(other));
  assert.match(computeKeyId(key), /^kek_[0-9a-f]{32}$/);

  // The identifier must not expose any run of the key itself.
  const id = computeKeyId(key);
  const keyHex = key.toString("hex");
  for (let offset = 0; offset + 16 <= keyHex.length; offset += 2) {
    assert.equal(
      id.includes(keyHex.slice(offset, offset + 16)),
      false,
      "keyId leaked a run of key bytes",
    );
  }
});

test("computeKeyId rejects a wrong-length key", () => {
  assert.throws(
    () => computeKeyId(Buffer.alloc(16, 1)),
    (error: unknown) =>
      error instanceof StorageError && error.code === "master_key_invalid",
  );
});
