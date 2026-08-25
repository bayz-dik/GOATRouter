import { redactSecrets } from "@bayz/security";
import {
  openSecretStorage,
  type BayzSecurityMode,
  type KeyProviderKind,
  type SecureSecretRepository,
  type StorageLogger,
} from "@bayz/storage";
import type { RuntimeConfig } from "./config.js";

export type StorageHandle = {
  secrets: SecureSecretRepository;
  schemaVersion: number;
  journalMode: string;
  driver: string;
  keyProvider: KeyProviderKind;
  keyId: string;
  close(): void;
};

export type InitializeStorageOptions = {
  env?: Record<string, string | undefined>;
  logger?: StorageLogger;
};

function resolveMode(
  env: Record<string, string | undefined>,
): BayzSecurityMode | undefined {
  const raw = env.BAYZ_SECURITY_MODE;
  return raw === undefined ? undefined : (raw as BayzSecurityMode);
}

/**
 * Thin wiring between the runtime config and the storage package.
 *
 * The dashboard and every HTTP route are deliberately kept away from this layer:
 * Phase 2 adds no storage route, no secret in a response, and no storage field on
 * /api/health.
 */
export function initializeStorage(
  config: RuntimeConfig,
  options: InitializeStorageOptions = {},
): StorageHandle {
  const env = options.env ?? process.env;
  const storage = openSecretStorage({
    dataDir: config.dataDir,
    env,
    mode: resolveMode(env),
    logger: options.logger,
  });

  return {
    secrets: storage,
    schemaVersion: storage.schemaVersion,
    journalMode: storage.journalMode,
    driver: storage.driver,
    keyProvider: storage.keyProvider,
    keyId: storage.keyId,
    close(): void {
      storage.close();
    },
  };
}

/**
 * Operational summary safe to log. Contains no key material and no secret: the
 * key is represented only by its one-way fingerprint.
 */
export function describeStorage(
  handle: StorageHandle,
  dataDir: string,
): Record<string, unknown> {
  return redactSecrets({
    schemaVersion: handle.schemaVersion,
    journalMode: handle.journalMode,
    driver: handle.driver,
    keyProvider: handle.keyProvider,
    keyId: handle.keyId,
    dataDir,
  });
}
