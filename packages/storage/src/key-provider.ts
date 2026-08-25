import { randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StorageError, asStorageError } from "./errors.js";
import { ensureDataDir, masterKeyPath } from "./paths.js";

export const KEK_LENGTH = 32;

/**
 * scrypt profile for FORTRESS mode.
 *
 * Measured on the ARM64 target (Node 24, linux arm64):
 *   N=2^14  49 ms / 16 MiB
 *   N=2^15  95 ms / 32 MiB
 *   N=2^16 194 ms / 64 MiB   <- selected
 *   N=2^17 393 ms / 128 MiB
 *
 * 194 ms and 64 MiB is a real cost to an attacker while staying tolerable on a
 * phone. Node's default `maxmem` is below what N=2^16 requires, so an explicit
 * budget is mandatory or `scryptSync` throws.
 *
 * PBKDF2 is rejected as a final design because it is not memory-hard. Argon2id
 * would be preferable but every Node binding is native, which would break the
 * Termux baseline; the envelope's `kdf` field exists so it can be added later.
 */
export const SCRYPT_PARAMS = {
  N: 1 << 16,
  r: 8,
  p: 1,
  keyLength: KEK_LENGTH,
  maxmem: 256 * (1 << 16) * 8 + (1 << 24),
} as const;

const KDF_FILENAME = "kdf.json";

export type KeyProviderKind =
  | "environment"
  | "passphrase"
  | "os-keystore"
  | "secure-file";

export type BayzSecurityMode = "STANDARD" | "SECURE" | "FORTRESS";

export interface KeyProvider {
  readonly kind: KeyProviderKind;
  readonly available: boolean;
  loadKek(): Buffer;
}

function decodeConfiguredKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new StorageError("master_key_invalid", "decode-key");
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  // Base64 is accepted only when it decodes to exactly 32 bytes. A malformed or
  // wrong-length value is rejected outright: silently hashing, padding, or
  // truncating would hand the operator a different key than they configured.
  let decoded: Buffer;
  try {
    decoded = Buffer.from(trimmed, "base64");
  } catch {
    throw new StorageError("master_key_invalid", "decode-key");
  }
  if (decoded.byteLength !== KEK_LENGTH) {
    throw new StorageError("master_key_invalid", "decode-key");
  }
  return decoded;
}

export class EnvKeyProvider implements KeyProvider {
  readonly kind = "environment" as const;
  readonly #raw: string | undefined;

  constructor(env: Record<string, string | undefined>) {
    this.#raw = env.BAYZ_MASTER_KEY;
  }

  get available(): boolean {
    return typeof this.#raw === "string" && this.#raw.trim().length > 0;
  }

  loadKek(): Buffer {
    if (!this.available) {
      throw new StorageError("master_key_invalid", "env-key-missing");
    }
    return decodeConfiguredKey(this.#raw as string);
  }
}

export type SecureFileOptions = {
  warn?: (message: string) => void;
};

export class SecureFileKeyProvider implements KeyProvider {
  readonly kind = "secure-file" as const;
  readonly available = true;
  readonly #dataDir: string;
  readonly #warn: (message: string) => void;

  constructor(dataDir: string, options: SecureFileOptions = {}) {
    this.#dataDir = dataDir;
    this.#warn = options.warn ?? (() => {});
  }

  loadKek(): Buffer {
    ensureDataDir(this.#dataDir);
    const file = masterKeyPath(this.#dataDir);

    if (existsSync(file)) {
      let contents: Buffer;
      try {
        contents = readFileSync(file);
      } catch (error) {
        throw asStorageError("master_key_invalid", "read-key-file", error);
      }
      if (contents.byteLength !== KEK_LENGTH) {
        throw new StorageError("master_key_invalid", "key-file-length");
      }
      this.#warnOnLoosePermissions(file);
      return contents;
    }

    const generated = randomBytes(KEK_LENGTH);
    try {
      // Exclusive create so a concurrent start cannot clobber an existing key.
      writeFileSync(file, generated, { flag: "wx", mode: 0o600 });
    } catch (error) {
      throw asStorageError("master_key_invalid", "write-key-file", error);
    }
    return generated;
  }

  /**
   * A loose mode warns rather than fails: some Android and FAT-derived mounts
   * cannot represent POSIX modes, and aborting there would make Bayz unusable on
   * a first-class target. The warning names the path, never the key.
   */
  #warnOnLoosePermissions(file: string): void {
    try {
      const mode = statSync(file).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        this.#warn(
          `master key file permission is 0${mode.toString(8)}; expected 0600. ` +
            "Other users on this device may be able to read it.",
        );
      }
    } catch {
      // Mode is unavailable on this filesystem; nothing to assert.
    }
  }
}

type StoredKdfParams = {
  kdf: "scrypt";
  N: number;
  r: number;
  p: number;
  keyLength: number;
  salt: string;
};

export class PassphraseKeyProvider implements KeyProvider {
  readonly kind = "passphrase" as const;
  readonly available = true;
  readonly #dataDir: string;
  readonly #passphrase: string;

  constructor(dataDir: string, passphrase: string) {
    this.#dataDir = dataDir;
    this.#passphrase = passphrase;
  }

  loadKek(): Buffer {
    if (this.#passphrase.trim().length === 0) {
      throw new StorageError("master_key_invalid", "empty-passphrase");
    }
    ensureDataDir(this.#dataDir);
    const params = this.#loadOrCreateParams();
    try {
      return scryptSync(
        this.#passphrase,
        Buffer.from(params.salt, "base64"),
        params.keyLength,
        { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_PARAMS.maxmem },
      );
    } catch (error) {
      throw asStorageError("master_key_invalid", "derive-key", error);
    }
  }

  #loadOrCreateParams(): StoredKdfParams {
    const file = join(this.#dataDir, KDF_FILENAME);
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as StoredKdfParams;
        if (
          parsed.kdf !== "scrypt" ||
          !Number.isInteger(parsed.N) ||
          !Number.isInteger(parsed.r) ||
          !Number.isInteger(parsed.p) ||
          parsed.keyLength !== KEK_LENGTH ||
          typeof parsed.salt !== "string"
        ) {
          throw new StorageError("master_key_invalid", "kdf-params");
        }
        return parsed;
      } catch (error) {
        throw asStorageError("master_key_invalid", "kdf-params", error);
      }
    }

    // Parameters are persisted so they can be raised later without guessing how
    // an existing key was derived. The derived key itself is never written.
    const created: StoredKdfParams = {
      kdf: "scrypt",
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
      keyLength: SCRYPT_PARAMS.keyLength,
      salt: randomBytes(16).toString("base64"),
    };
    try {
      writeFileSync(file, `${JSON.stringify(created, null, 2)}\n`, {
        mode: 0o600,
      });
    } catch (error) {
      throw asStorageError("master_key_invalid", "write-kdf-params", error);
    }
    return created;
  }
}

/**
 * Interface placeholder for OS-backed key custody (DPAPI, macOS Keychain, Linux
 * Secret Service, Android Keystore).
 *
 * Every option requires a native module or a platform binary, which would break
 * the zero-native-dependency Termux baseline. It is therefore declared
 * unavailable and throws if forced. It is deliberately NOT faked, and must not
 * be described as working until the packaging phase ships per-platform
 * artifacts.
 */
export class OsKeystoreKeyProvider implements KeyProvider {
  readonly kind = "os-keystore" as const;
  readonly available = false;

  loadKek(): Buffer {
    throw new StorageError("master_key_invalid", "os-keystore-unavailable");
  }
}

export type ResolveKeyProviderOptions = {
  dataDir: string;
  env: Record<string, string | undefined>;
  mode?: BayzSecurityMode;
};

export function resolveKeyProvider(
  options: ResolveKeyProviderOptions,
): KeyProvider {
  const mode = options.mode ?? "STANDARD";
  const env = options.env;

  switch (mode) {
    case "FORTRESS": {
      const passphrase = env.BAYZ_PASSPHRASE;
      if (typeof passphrase !== "string" || passphrase.trim().length === 0) {
        throw new StorageError("master_key_invalid", "fortress-passphrase-required");
      }
      return new PassphraseKeyProvider(options.dataDir, passphrase);
    }
    case "SECURE": {
      // No silent downgrade to on-disk custody: an operator who asked for SECURE
      // must be told their key is missing rather than handed a weaker mode.
      const provider = new EnvKeyProvider(env);
      if (!provider.available) {
        throw new StorageError("master_key_invalid", "secure-key-required");
      }
      return provider;
    }
    case "STANDARD": {
      const provider = new EnvKeyProvider(env);
      return provider.available
        ? provider
        : new SecureFileKeyProvider(options.dataDir);
    }
    default:
      throw new StorageError("master_key_invalid", "unknown-security-mode");
  }
}
