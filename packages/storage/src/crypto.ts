import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { StorageError, asStorageError } from "./errors.js";
import { KEK_LENGTH } from "./key-provider.js";

export const ENVELOPE_VERSION = 1 as const;
export const SECRET_ALGORITHM = "aes-256-gcm" as const;

const DEK_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_ID_INFO = "bayz-kek-id-v1";
const KEY_ID_LENGTH = 16;

export type SecretEnvelope = {
  version: typeof ENVELOPE_VERSION;
  algorithm: typeof SECRET_ALGORITHM;
  /** How the KEK was derived. Recorded so rotation can reason about custody. */
  kdf: "none" | "scrypt";
  /** Non-secret KEK fingerprint; see computeKeyId. */
  keyId: string;
  wrappedDek: Uint8Array;
  wrapIv: Uint8Array;
  wrapTag: Uint8Array;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
};

function assertKekLength(kek: Buffer, stage: string): void {
  if (kek.byteLength !== KEK_LENGTH) {
    throw new StorageError("master_key_invalid", stage);
  }
}

/**
 * Additional Authenticated Data binds an envelope to the secret's identity.
 *
 * Both the DEK wrap and the secret encryption authenticate this value, so an
 * attacker with write access to the database cannot relocate a known-value
 * envelope onto a different secret's row — plain GCM would accept that.
 */
function aadFor(name: string): Buffer {
  return Buffer.from(`bayz:v${ENVELOPE_VERSION}:${name}`, "utf8");
}

/**
 * Non-secret KEK fingerprint.
 *
 * HKDF is one-way and the output is truncated to 16 bytes with a
 * domain-separated info string, so the identifier permits no practical key
 * recovery while still detecting "you started with the wrong key" before any
 * ciphertext is touched.
 */
export function computeKeyId(kek: Buffer): string {
  assertKekLength(kek, "compute-key-id");
  const derived = hkdfSync(
    "sha256",
    kek,
    Buffer.alloc(0),
    KEY_ID_INFO,
    KEY_ID_LENGTH,
  );
  return `kek_${Buffer.from(derived).toString("hex")}`;
}

function wrapDek(kek: Buffer, aad: Buffer, dek: Buffer): {
  wrappedDek: Uint8Array;
  wrapIv: Uint8Array;
  wrapTag: Uint8Array;
} {
  const wrapIv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(SECRET_ALGORITHM, kek, wrapIv);
  cipher.setAAD(aad);
  const wrappedDek = Buffer.concat([cipher.update(dek), cipher.final()]);
  return { wrappedDek, wrapIv, wrapTag: cipher.getAuthTag() };
}

function unwrapDek(kek: Buffer, aad: Buffer, envelope: SecretEnvelope): Buffer {
  try {
    const decipher = createDecipheriv(
      SECRET_ALGORITHM,
      kek,
      Buffer.from(envelope.wrapIv),
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(envelope.wrapTag));
    const dek = Buffer.concat([
      decipher.update(Buffer.from(envelope.wrappedDek)),
      decipher.final(),
    ]);
    if (dek.byteLength !== DEK_LENGTH) {
      throw new StorageError("secret_corrupt", "unwrap-dek-length");
    }
    return dek;
  } catch (error) {
    // The OpenSSL message is discarded: it describes cipher internals and must
    // not cross the storage boundary.
    throw asStorageError("secret_corrupt", "unwrap-dek", error);
  }
}

/**
 * Validate every structural field before any cipher runs, so a malformed record
 * is rejected without touching key material.
 */
function assertEnvelopeShape(envelope: SecretEnvelope): void {
  if (envelope.version !== ENVELOPE_VERSION) {
    throw new StorageError("secret_corrupt", "envelope-version");
  }
  if (envelope.algorithm !== SECRET_ALGORITHM) {
    throw new StorageError("secret_corrupt", "envelope-algorithm");
  }
  const lengths: Array<[Uint8Array, number, string]> = [
    [envelope.iv, IV_LENGTH, "iv"],
    [envelope.tag, TAG_LENGTH, "tag"],
    [envelope.wrapIv, IV_LENGTH, "wrap-iv"],
    [envelope.wrapTag, TAG_LENGTH, "wrap-tag"],
    [envelope.wrappedDek, DEK_LENGTH, "wrapped-dek"],
  ];
  for (const [bytes, expected, label] of lengths) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== expected) {
      throw new StorageError("secret_corrupt", `envelope-${label}`);
    }
  }
  if (!(envelope.ciphertext instanceof Uint8Array) || envelope.ciphertext.byteLength === 0) {
    throw new StorageError("secret_corrupt", "envelope-ciphertext");
  }
}

export function sealSecret(
  kek: Buffer,
  name: string,
  plaintext: string,
): SecretEnvelope {
  assertKekLength(kek, "seal-secret");
  const aad = aadFor(name);
  // A fresh 256-bit DEK per write: no DEK is shared between records or reused
  // across writes, so one recovered DEK decrypts exactly one secret.
  const dek = randomBytes(DEK_LENGTH);
  try {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(SECRET_ALGORITHM, dek, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(plaintext, "utf8")),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const wrapped = wrapDek(kek, aad, dek);

    return {
      version: ENVELOPE_VERSION,
      algorithm: SECRET_ALGORITHM,
      kdf: "none",
      keyId: computeKeyId(kek),
      wrappedDek: wrapped.wrappedDek,
      wrapIv: wrapped.wrapIv,
      wrapTag: wrapped.wrapTag,
      ciphertext,
      iv,
      tag,
    };
  } catch (error) {
    throw asStorageError("secret_corrupt", "seal-secret", error);
  } finally {
    // Reduces the window in which the DEK sits in a reachable buffer. Note that
    // JavaScript cannot guarantee erasure: the GC may have copied this buffer
    // and immutable strings cannot be wiped at all.
    dek.fill(0);
  }
}

export function openSecret(
  kek: Buffer,
  name: string,
  envelope: SecretEnvelope,
): string {
  assertKekLength(kek, "open-secret");
  assertEnvelopeShape(envelope);
  const aad = aadFor(name);
  const dek = unwrapDek(kek, aad, envelope);
  try {
    const decipher = createDecipheriv(
      SECRET_ALGORITHM,
      dek,
      Buffer.from(envelope.iv),
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(envelope.tag));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext)),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch (error) {
    // Fail closed. Never an empty string, never null, never partial plaintext.
    throw asStorageError("secret_corrupt", "open-secret", error);
  } finally {
    dek.fill(0);
  }
}

/**
 * Rotate the KEK protecting an envelope.
 *
 * The DEK is unwrapped with the old KEK and rewrapped with the new one. The
 * secret ciphertext, IV, and tag are untouched, so rotation never materializes
 * plaintext and costs one small wrap per record.
 */
export function rewrapEnvelope(
  oldKek: Buffer,
  newKek: Buffer,
  name: string,
  envelope: SecretEnvelope,
): SecretEnvelope {
  assertKekLength(oldKek, "rewrap-old-key");
  assertKekLength(newKek, "rewrap-new-key");
  assertEnvelopeShape(envelope);

  const aad = aadFor(name);
  const dek = unwrapDek(oldKek, aad, envelope);
  try {
    const wrapped = wrapDek(newKek, aad, dek);
    return {
      ...envelope,
      keyId: computeKeyId(newKek),
      wrappedDek: wrapped.wrappedDek,
      wrapIv: wrapped.wrapIv,
      wrapTag: wrapped.wrapTag,
    };
  } catch (error) {
    throw asStorageError("secret_corrupt", "rewrap-envelope", error);
  } finally {
    dek.fill(0);
  }
}
