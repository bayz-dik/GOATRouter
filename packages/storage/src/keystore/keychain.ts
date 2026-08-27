import { StorageError } from "../errors.js";
import {
  OsKeystoreAdapter,
  type KeystoreAdapterOptions,
  type KeystoreBackend,
  type KeystoreProbe,
} from "./adapter.js";

const SERVICE = "bayz-router";
const ACCOUNT = "root-key";

/** `security(1)` reports a missing generic password with this documented status. */
const ITEM_NOT_FOUND = 44;

/**
 * macOS Keychain custody through `security(1)`.
 *
 * Reads pass the service and account names in argv — neither is secret — but the
 * write goes through `security -i`, whose interactive mode takes the whole
 * command on stdin. That keeps the key out of `ps` output, which `-w <password>`
 * on the command line would not.
 */
export class KeychainKeyProvider extends OsKeystoreAdapter {
  readonly backend: KeystoreBackend = "keychain";

  constructor(options: KeystoreAdapterOptions = {}) {
    super(options);
  }

  protected detect(): KeystoreProbe {
    if (this.platform !== "darwin") {
      return { available: false, reason: "keychain is a macOS facility" };
    }
    const probed = this.run("security", ["list-keychains"]);
    if (probed.failedToSpawn) {
      return { available: false, reason: "the security binary is not present" };
    }
    if (probed.status !== 0) {
      return { available: false, reason: "no keychain is available to this user" };
    }
    return { available: true, reason: "security listed at least one keychain" };
  }

  protected read(): string | null {
    const result = this.run("security", [
      "find-generic-password",
      "-s",
      SERVICE,
      "-a",
      ACCOUNT,
      "-w",
    ]);
    if (result.status === 0) {
      return result.stdout;
    }
    if (result.status === ITEM_NOT_FOUND) {
      return null;
    }
    throw new StorageError("master_key_invalid", "keychain-lookup");
  }

  protected write(value: string): void {
    // `-U` replaces an existing item instead of failing; the caller only reaches
    // here when the lookup found nothing, so this covers a racing writer.
    const command = `add-generic-password -s ${SERVICE} -a ${ACCOUNT} -U -w ${value}\n`;
    const result = this.run("security", ["-i"], { input: command });
    if (result.failedToSpawn || result.status !== 0) {
      throw new StorageError("master_key_invalid", "keychain-store");
    }
  }
}
