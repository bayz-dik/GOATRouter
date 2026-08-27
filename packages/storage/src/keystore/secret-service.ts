import { StorageError } from "../errors.js";
import {
  OsKeystoreAdapter,
  type KeystoreAdapterOptions,
  type KeystoreBackend,
  type KeystoreProbe,
} from "./adapter.js";

const SERVICE_ATTRIBUTE = "service";
const SERVICE_VALUE = "bayz-router";
const KEY_ATTRIBUTE = "key";
const KEY_VALUE = "root-key";
const LABEL = "Bayz Router root key";

/**
 * Linux Secret Service custody through `secret-tool`.
 *
 * The binary is used rather than a D-Bus client library because a native
 * dependency would break the zero-native-dependency Termux baseline. `secret-tool`
 * reads the secret from stdin on `store`, so the key never appears in argv.
 */
export class SecretServiceKeyProvider extends OsKeystoreAdapter {
  readonly backend: KeystoreBackend = "secret-service";

  constructor(options: KeystoreAdapterOptions = {}) {
    super(options);
  }

  protected detect(): KeystoreProbe {
    if (this.platform !== "linux") {
      return {
        available: false,
        reason: "secret service is a linux facility",
      };
    }
    // A Secret Service provider is reached over the session bus. Without one,
    // `secret-tool` exists but has nothing to talk to.
    const bus = this.env.DBUS_SESSION_BUS_ADDRESS;
    if (typeof bus !== "string" || bus.trim().length === 0) {
      return {
        available: false,
        reason: "no DBUS_SESSION_BUS_ADDRESS in this environment",
      };
    }
    const probed = this.run("secret-tool", ["--version"]);
    if (probed.failedToSpawn) {
      return { available: false, reason: "secret-tool is not installed" };
    }
    if (probed.status !== 0) {
      return {
        available: false,
        reason: "secret-tool did not answer its version probe",
      };
    }
    return { available: true, reason: "secret-tool answered a version probe" };
  }

  protected read(): string | null {
    const result = this.run("secret-tool", [
      "lookup",
      SERVICE_ATTRIBUTE,
      SERVICE_VALUE,
      KEY_ATTRIBUTE,
      KEY_VALUE,
    ]);
    if (result.status === 0) {
      return result.stdout;
    }
    // `secret-tool lookup` signals "no such item" with a non-zero status and no
    // diagnostic output. Anything that did produce a diagnostic is a real
    // failure, and must not be mistaken for an empty store: minting a fresh key
    // there would orphan every existing ciphertext.
    if (
      !result.failedToSpawn &&
      result.stderr.trim().length === 0 &&
      result.stdout.trim().length === 0
    ) {
      return null;
    }
    throw new StorageError("master_key_invalid", "secret-service-lookup");
  }

  protected write(value: string): void {
    const result = this.run(
      "secret-tool",
      [
        "store",
        "--label",
        LABEL,
        SERVICE_ATTRIBUTE,
        SERVICE_VALUE,
        KEY_ATTRIBUTE,
        KEY_VALUE,
      ],
      { input: `${value}\n` },
    );
    if (result.failedToSpawn || result.status !== 0) {
      throw new StorageError("master_key_invalid", "secret-service-store");
    }
  }
}
