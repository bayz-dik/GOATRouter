import { StorageError } from "../errors.js";

/**
 * Key material encoding shared by the platform adapters.
 *
 * The length constant is duplicated rather than imported from `key-provider.ts`
 * to keep the module graph acyclic: `key-provider.ts` imports the adapters, so an
 * import back would form a cycle. A test in `os-keystore.test.ts` pins the two to
 * the same value.
 */
export const KEYSTORE_KEK_LENGTH = 32;

/** Hex, because every platform store we drive is a text-valued store. */
export function encodeKeystoreKey(key: Buffer): string {
  return key.toString("hex");
}

/**
 * Decode a stored value, rejecting anything that is not exactly 32 bytes of hex.
 *
 * Hashing, padding, or truncating a malformed value would hand back a key that
 * decrypts nothing while looking like a success, so a bad value is fatal.
 */
export function decodeKeystoreKey(raw: string, stage: string): Buffer {
  const trimmed = raw.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new StorageError("master_key_invalid", stage);
  }
  const decoded = Buffer.from(trimmed, "hex");
  if (decoded.byteLength !== KEYSTORE_KEK_LENGTH) {
    throw new StorageError("master_key_invalid", stage);
  }
  return decoded;
}
