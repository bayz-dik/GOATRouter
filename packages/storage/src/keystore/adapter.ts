import { randomBytes } from "node:crypto";
import { StorageError } from "../errors.js";
import { runCommand, type CommandRunner } from "./exec.js";
import {
  KEYSTORE_KEK_LENGTH,
  decodeKeystoreKey,
  encodeKeystoreKey,
} from "./material.js";

export type KeystoreBackend =
  | "secret-service"
  | "keychain"
  | "dpapi"
  | "android-keystore"
  | "none";

export type KeystoreProbe = {
  readonly available: boolean;
  /** Metadata-only explanation, safe to log. Never contains key material. */
  readonly reason: string;
};

export type KeystoreAdapterOptions = {
  readonly platform?: NodeJS.Platform | string;
  readonly env?: Record<string, string | undefined>;
  readonly runner?: CommandRunner;
};

/**
 * A key provider backed by an operating-system secret store.
 *
 * `available` is the result of a real probe — running the platform binary and
 * checking that it answers — not a `process.platform` comparison. A machine that
 * is nominally supported but has no working store reports unavailable, because
 * claiming custody we do not have is worse than admitting we lack it.
 */
export abstract class OsKeystoreAdapter {
  readonly kind = "os-keystore" as const;
  abstract readonly backend: KeystoreBackend;

  protected readonly platform: string;
  protected readonly env: Record<string, string | undefined>;
  protected readonly run: CommandRunner;

  #probed: KeystoreProbe | undefined;

  protected constructor(options: KeystoreAdapterOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.run = options.runner ?? runCommand;
  }

  get available(): boolean {
    return this.probe().available;
  }

  /** Cached so `available` can be read repeatedly without re-spawning a binary. */
  probe(): KeystoreProbe {
    this.#probed ??= this.detect();
    return this.#probed;
  }

  loadKek(): Buffer {
    const probed = this.probe();
    if (!probed.available) {
      throw new StorageError("master_key_invalid", `${this.backend}-unavailable`);
    }

    const existing = this.read();
    if (existing !== null) {
      return decodeKeystoreKey(existing, `${this.backend}-decode`);
    }

    // First run: mint a key and hand custody to the platform store. The value is
    // read back before it is returned, because a store that accepts a write and
    // then holds nothing would orphan every ciphertext written under this key.
    const generated = randomBytes(KEYSTORE_KEK_LENGTH);
    this.write(encodeKeystoreKey(generated));

    const confirmed = this.read();
    if (confirmed === null) {
      throw new StorageError(
        "master_key_invalid",
        `${this.backend}-store-unconfirmed`,
      );
    }
    const decoded = decodeKeystoreKey(confirmed, `${this.backend}-decode`);
    if (!decoded.equals(generated)) {
      throw new StorageError(
        "master_key_invalid",
        `${this.backend}-store-mismatch`,
      );
    }
    return decoded;
  }

  protected abstract detect(): KeystoreProbe;

  /**
   * Return the stored value, or null when the store definitively holds no item.
   *
   * An error that is *not* "no such item" must throw: falling through to a fresh
   * key on a transient store failure is the one outcome that silently destroys
   * data.
   */
  protected abstract read(): string | null;

  protected abstract write(value: string): void;
}
