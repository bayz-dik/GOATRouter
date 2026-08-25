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
  type ResolveKeyProviderOptions,
  type SecureFileOptions,
} from "./key-provider.js";
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
