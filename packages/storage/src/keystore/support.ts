import { DpapiKeyProvider } from "./dpapi.js";
import { KeychainKeyProvider } from "./keychain.js";
import { SecretServiceKeyProvider } from "./secret-service.js";
import {
  type KeystoreAdapterOptions,
  type KeystoreBackend,
  type OsKeystoreAdapter,
} from "./adapter.js";

/**
 * Three-valued support status, following the Phase 9 evidence rule: a cell may
 * read `IMPLEMENTED` only when this machine actually exercised it. `UNVERIFIED`
 * is never collapsed into a claim of success.
 */
export type KeystoreSupportStatus = "IMPLEMENTED" | "UNVERIFIED" | "N/A";

export type KeystoreSupportEntry = {
  readonly backend: KeystoreBackend;
  readonly platform: string;
  readonly status: KeystoreSupportStatus;
  /** Metadata-only; safe to log and to print in a release report. */
  readonly reason: string;
};

export type KeystoreResolveOptions = KeystoreAdapterOptions & {
  readonly dataDir: string;
};

/** The adapter for the platform we are running on, whether or not it is usable. */
export function resolveOsKeystore(
  options: KeystoreResolveOptions,
): OsKeystoreAdapter {
  const platform = options.platform ?? process.platform;
  switch (platform) {
    case "darwin":
      return new KeychainKeyProvider(options);
    case "win32":
      return new DpapiKeyProvider({ ...options, dataDir: options.dataDir });
    default:
      return new SecretServiceKeyProvider(options);
  }
}

/**
 * The platform matrix as data, measured on the host that calls it.
 *
 * Android is `N/A` rather than `UNVERIFIED`: the Keystore is reachable from the
 * Android framework, not from Node, so there is nothing here left to verify. The
 * distinction matters — `UNVERIFIED` means "written but unproven here", `N/A`
 * means "no such facility to write against".
 */
export function keystoreSupport(
  options: Partial<KeystoreResolveOptions> = {},
): readonly KeystoreSupportEntry[] {
  const dataDir = options.dataDir ?? process.cwd();
  const shared = { env: options.env, runner: options.runner };

  const adapters: readonly { adapter: OsKeystoreAdapter; platform: string }[] = [
    {
      adapter: new DpapiKeyProvider({ ...shared, dataDir, platform: "win32" }),
      platform: "win32",
    },
    {
      adapter: new KeychainKeyProvider({ ...shared, platform: "darwin" }),
      platform: "darwin",
    },
    {
      adapter: new SecretServiceKeyProvider({ ...shared, platform: "linux" }),
      platform: "linux",
    },
  ];

  const host = options.platform ?? process.platform;
  const entries: KeystoreSupportEntry[] = adapters.map(
    ({ adapter, platform }) => {
      if (platform !== host) {
        return {
          backend: adapter.backend,
          platform,
          status: "UNVERIFIED",
          reason: `adapter implemented; this host is ${host}, so it was never exercised`,
        };
      }
      const probed = adapter.probe();
      return probed.available
        ? {
            backend: adapter.backend,
            platform,
            status: "IMPLEMENTED",
            reason: probed.reason,
          }
        : {
            backend: adapter.backend,
            platform,
            status: "UNVERIFIED",
            reason: probed.reason,
          };
    },
  );

  entries.push({
    backend: "android-keystore",
    platform: "android",
    status: "N/A",
    reason:
      "the Android Keystore is reachable from the Android framework, not from Node; " +
      "no adapter can be written against it here",
  });

  return entries;
}
