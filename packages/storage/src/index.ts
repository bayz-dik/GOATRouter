export {
  StorageError,
  asStorageError,
  type StorageErrorCode,
} from "./errors.js";
export {
  type SqlDatabase,
  type SqlDriver,
  type SqlParam,
  type SqlRow,
  type SqlRunResult,
  type SqlStatement,
  type SqlValue,
} from "./sql.js";
export { nodeSqliteDriver, selectDriver } from "./drivers/node-sqlite.js";
export {
  DATABASE_FILENAME,
  MASTER_KEY_FILENAME,
  databasePath,
  ensureDataDir,
  masterKeyPath,
  restrictDatabaseFileModes,
  restrictFileMode,
} from "./paths.js";
export {
  EnvKeyProvider,
  KEK_LENGTH,
  OsKeystoreKeyProvider,
  PassphraseKeyProvider,
  SCRYPT_PARAMS,
  SecureFileKeyProvider,
  resolveKeyProvider,
  type BayzSecurityMode,
  type KeyProvider,
  type KeyProviderKind,
  type KeyProviderLogger,
  type ResolveKeyProviderOptions,
  type SecureFileOptions,
} from "./key-provider.js";
export {
  OsKeystoreAdapter,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
  type KeystoreAdapterOptions,
  type KeystoreBackend,
  type KeystoreProbe,
} from "./keystore/index.js";
export {
  DPAPI_BLOB_FILENAME,
  DpapiKeyProvider,
  KeychainKeyProvider,
  SecretServiceKeyProvider,
  keystoreSupport,
  resolveOsKeystore,
  type DpapiOptions,
  type KeystoreResolveOptions,
  type KeystoreSupportEntry,
  type KeystoreSupportStatus,
} from "./keystore/index.js";
export {
  ENVELOPE_VERSION,
  SECRET_ALGORITHM,
  computeKeyId,
  openSecret,
  rewrapEnvelope,
  sealSecret,
  type SecretEnvelope,
} from "./crypto.js";
export {
  MIGRATIONS,
  TARGET_SCHEMA_VERSION,
  readSchemaVersion,
  runMigrations,
  type Migration,
} from "./migrations.js";
export {
  openDatabase,
  type BayzDatabase,
  type OpenDatabaseOptions,
} from "./database.js";
export {
  openSecretStorage,
  type CorruptibleColumn,
  type OpenSecretStorageOptions,
  type SecretEnvelopeView,
  type SecretRecordMetadata,
  type SecretStorage,
  type SecureSecretRepository,
  type StorageLogger,
} from "./secret-repository.js";
export {
  scopedSecretStorage,
  type ScopedSecretView,
} from "./scoped.js";
