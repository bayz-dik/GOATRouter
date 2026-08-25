export type StorageErrorCode =
  | "storage_unavailable"
  | "master_key_invalid"
  | "master_key_mismatch"
  | "secret_not_found"
  | "secret_corrupt";

/**
 * Fixed, caller-independent messages. Raw SQLite text embeds absolute
 * filesystem paths and raw OpenSSL text describes cipher internals; neither may
 * cross the storage boundary, so no underlying message is ever interpolated
 * here.
 */
const MESSAGES: Record<StorageErrorCode, string> = {
  storage_unavailable: "storage_unavailable: local storage could not be initialized",
  master_key_invalid: "master_key_invalid: the configured root key is not usable",
  master_key_mismatch: "master_key_mismatch: the root key does not match this database",
  secret_not_found: "secret_not_found: no stored secret with that name",
  secret_corrupt: "secret_corrupt: the stored secret failed authentication",
};

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly stage: string | undefined;

  constructor(code: StorageErrorCode, stage?: string) {
    super(stage ? `${MESSAGES[code]} (stage: ${stage})` : MESSAGES[code]);
    this.name = "StorageError";
    this.code = code;
    this.stage = stage;
  }
}

/**
 * Translate an arbitrary throw into a StorageError.
 *
 * The original value is deliberately discarded rather than attached as `cause`,
 * because several structured loggers serialize `cause` and would reintroduce the
 * raw SQLite path or OpenSSL detail we just removed.
 */
export function asStorageError(
  code: StorageErrorCode,
  stage: string | undefined,
  cause: unknown,
): StorageError {
  if (cause instanceof StorageError) {
    return cause;
  }
  return new StorageError(code, stage);
}
