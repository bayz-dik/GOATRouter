import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StorageError, asStorageError } from "../errors.js";
import { ensureDataDir, restrictFileMode } from "../paths.js";
import {
  OsKeystoreAdapter,
  type KeystoreAdapterOptions,
  type KeystoreBackend,
  type KeystoreProbe,
} from "./adapter.js";

export const DPAPI_BLOB_FILENAME = "master.key.dpapi";

/**
 * PowerShell scripts are fixed string constants with no interpolation of any
 * kind. The key travels on stdin and comes back on stdout, so nothing secret
 * enters a script body or an argument vector.
 */
const PROBE_SCRIPT = "$PSVersionTable.PSVersion.Major";

const PROTECT_SCRIPT = [
  "Add-Type -AssemblyName System.Security;",
  "$plain = [Console]::In.ReadToEnd().Trim();",
  "$bytes = [Text.Encoding]::UTF8.GetBytes($plain);",
  "$sealed = [Security.Cryptography.ProtectedData]::Protect(",
  "$bytes, $null, 'CurrentUser');",
  "[Convert]::ToBase64String($sealed)",
].join(" ");

const UNPROTECT_SCRIPT = [
  "Add-Type -AssemblyName System.Security;",
  "$blob = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());",
  "$open = [Security.Cryptography.ProtectedData]::Unprotect(",
  "$blob, $null, 'CurrentUser');",
  "[Text.Encoding]::UTF8.GetString($open)",
].join(" ");

function powershellArgs(script: string): readonly string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ];
}

export type DpapiOptions = KeystoreAdapterOptions & {
  /** Where the protected blob is stored; DPAPI itself keeps no named item. */
  readonly dataDir: string;
};

/**
 * Windows DPAPI custody.
 *
 * DPAPI is a wrapping API rather than a named store, so the sealed blob is kept
 * next to the database. The blob is useless on another account or machine, which
 * is the property that makes this stronger than the plain key file: an attacker
 * who copies the data directory cannot unwrap it.
 */
export class DpapiKeyProvider extends OsKeystoreAdapter {
  readonly backend: KeystoreBackend = "dpapi";
  readonly #dataDir: string;

  constructor(options: DpapiOptions) {
    super(options);
    this.#dataDir = options.dataDir;
  }

  protected detect(): KeystoreProbe {
    if (this.platform !== "win32") {
      return { available: false, reason: "DPAPI is a Windows facility" };
    }
    const probed = this.run("powershell", powershellArgs(PROBE_SCRIPT));
    if (probed.failedToSpawn) {
      return { available: false, reason: "powershell is not present" };
    }
    if (probed.status !== 0) {
      return { available: false, reason: "powershell did not answer a version probe" };
    }
    return { available: true, reason: "powershell answered a version probe" };
  }

  #blobPath(): string {
    return join(this.#dataDir, DPAPI_BLOB_FILENAME);
  }

  protected read(): string | null {
    const file = this.#blobPath();
    if (!existsSync(file)) {
      return null;
    }
    let blob: string;
    try {
      blob = readFileSync(file, "utf8");
    } catch (error) {
      throw asStorageError("master_key_invalid", "dpapi-read-blob", error);
    }
    const result = this.run("powershell", powershellArgs(UNPROTECT_SCRIPT), {
      input: `${blob.trim()}\n`,
    });
    if (result.failedToSpawn || result.status !== 0) {
      // The blob exists but cannot be unwrapped — a different user, a different
      // machine, or a corrupt file. Refusing is mandatory: generating a new key
      // would leave every existing secret undecryptable.
      throw new StorageError("master_key_invalid", "dpapi-unprotect");
    }
    return result.stdout;
  }

  protected write(value: string): void {
    const result = this.run("powershell", powershellArgs(PROTECT_SCRIPT), {
      input: `${value}\n`,
    });
    if (result.failedToSpawn || result.status !== 0) {
      throw new StorageError("master_key_invalid", "dpapi-protect");
    }
    const sealed = result.stdout.trim();
    if (sealed.length === 0) {
      throw new StorageError("master_key_invalid", "dpapi-protect-empty");
    }
    ensureDataDir(this.#dataDir);
    const file = this.#blobPath();
    try {
      writeFileSync(file, `${sealed}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      throw asStorageError("master_key_invalid", "dpapi-write-blob", error);
    }
    restrictFileMode(file);
  }
}
