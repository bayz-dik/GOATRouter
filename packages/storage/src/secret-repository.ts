import { timingSafeEqual } from "node:crypto";
import { redactSecrets } from "@bayz/security";
import { openDatabase } from "./database.js";
import {
  ENVELOPE_VERSION,
  SECRET_ALGORITHM,
  computeKeyId,
  openSecret,
  rewrapEnvelope,
  sealSecret,
  type SecretEnvelope,
} from "./crypto.js";
import { StorageError, asStorageError } from "./errors.js";
import {
  checkRollback,
  sealConfigHmac,
  verifyConfigHmac,
  verifyMigrationChain,
  type ConfigIntegrity,
} from "./integrity.js";
import {
  isRotatableKeyProvider,
  resolveKeyProvider,
  type BayzSecurityMode,
  type KeyProvider,
  type KeyProviderKind,
} from "./key-provider.js";
import { MIGRATIONS } from "./migrations.js";
import type { SqlDatabase, SqlRow } from "./sql.js";

const ACTIVE_KEY_ID = "active_key_id";
const CRYPTO_FORMAT_VERSION = "crypto_format_version";

export type SecretRecordMetadata = {
  name: string;
  version: number;
  algorithm: string;
  kdf: string;
  keyId: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * The only storage contract the domain may depend on.
 *
 * Provider Manager, Proxy Manager, Router, Usage, and the dashboard must never
 * know how encryption works: they pass and receive plain strings and never see
 * an envelope, a DEK, or a KEK.
 */
export interface SecureSecretRepository {
  put(name: string, plaintext: string): void;
  get(name: string): string;
  find(name: string): string | undefined;
  list(): SecretRecordMetadata[];
  delete(name: string): boolean;
  rotateRootKey(next: KeyProvider): { rotated: number; keyId: string };
  close(): void;
}

/** What a rotation driven by the resolved custody reports back. */
export type ManagedRotationResult = {
  rotated: number;
  keyId: string;
  previousKeyId: string;
};

/** Envelope view used by diagnostics and adversarial tests, never by the domain. */
export type SecretEnvelopeView = {
  keyId: string;
  wrappedDek: Uint8Array;
  wrapIv: Uint8Array;
  wrapTag: Uint8Array;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  createdAt: string;
  updatedAt: string;
};

export type CorruptibleColumn =
  | "ciphertext"
  | "wrapped_dek"
  | "tag"
  | "wrap_tag"
  | "iv"
  | "wrap_iv";

export interface SecretStorage extends SecureSecretRepository {
  readonly schemaVersion: number;
  readonly journalMode: string;
  readonly driver: string;
  readonly keyProvider: KeyProviderKind;
  readonly keyId: string;
  readonly appliedMigrations: number;
  /**
   * The shared connection, for domain tables that are not secrets.
   *
   * Phase 3 owns the `providers` registry and needs the same connection so a
   * provider row and its credential live in one database with one set of
   * pragmas. It is the `SqlDatabase` interface, not a concrete driver, so the
   * single-import rule for `node:sqlite` is unaffected.
   */
  readonly sql: SqlDatabase;
  activeKeyId(): string | undefined;
  /**
   * Whether the resolved custody can persist a replacement root key.
   *
   * Honest capability rather than an attempt-and-see: environment and passphrase
   * custody cannot be rewritten by BAYZ, so a rotation there would commit a rewrap
   * against a key nothing holds. Callers check this and refuse *before* touching a
   * row, which is what makes the refusal a no-op rather than a half-rotation.
   */
  readonly canRotateRootKey: boolean;
  /**
   * Rotate the root key using the resolved custody.
   *
   * Distinct from `rotateRootKey(next)`, which takes a caller-supplied provider and
   * is what the Phase 2 tests and the smoke script drive. This variant mints and
   * persists the replacement itself, so an operator surface does not have to know
   * how custody works — and cannot be handed a key of its own choosing over HTTP.
   */
  rotateManagedRootKey(): ManagedRotationResult;
  /** Envelope introspection for diagnostics and tests; returns no plaintext. */
  inspect(name: string): SecretEnvelopeView;
  /** Test seam: simulate an attacker flipping bytes inside the database. */
  corruptForTest(name: string, column: CorruptibleColumn): void;
  /** Test seam: simulate a truncated record. */
  truncateForTest(name: string, column: CorruptibleColumn): void;
  /** Test seam: simulate an unknown future envelope version. */
  setVersionForTest(name: string, version: number): void;
  /** Test seam: simulate relocating an envelope onto another secret's name. */
  renameForTest(name: string, nextName: string): void;
}

export type StorageLogger = (payload: Record<string, unknown>) => void;

export type OpenSecretStorageOptions = {
  dataDir: string;
  env?: Record<string, string | undefined>;
  mode?: BayzSecurityMode;
  logger?: StorageLogger;
};

function bytes(row: SqlRow, column: string): Uint8Array {
  const value = row[column];
  if (!(value instanceof Uint8Array)) {
    throw new StorageError("secret_corrupt", `column-${column}`);
  }
  return value;
}

function rowToEnvelope(row: SqlRow): SecretEnvelope {
  return {
    version: Number(row.version) as typeof ENVELOPE_VERSION,
    algorithm: String(row.algorithm) as typeof SECRET_ALGORITHM,
    kdf: String(row.kdf) as "none" | "scrypt",
    keyId: String(row.key_id),
    wrappedDek: bytes(row, "wrapped_dek"),
    wrapIv: bytes(row, "wrap_iv"),
    wrapTag: bytes(row, "wrap_tag"),
    ciphertext: bytes(row, "ciphertext"),
    iv: bytes(row, "iv"),
    tag: bytes(row, "tag"),
  };
}

function readMetadata(db: SqlDatabase, key: string): string | undefined {
  const row = db
    .prepare("SELECT value FROM runtime_metadata WHERE key = ?")
    .get(key);
  return row === undefined ? undefined : String(row.value);
}

function writeMetadata(db: SqlDatabase, key: string, value: string): void {
  db.prepare(
    `INSERT INTO runtime_metadata (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

function keyIdsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

export function openSecretStorage(
  options: OpenSecretStorageOptions,
): SecretStorage {
  const env = options.env ?? {};
  const log: StorageLogger = options.logger ?? (() => {});

  const provider = resolveKeyProvider({
    dataDir: options.dataDir,
    env,
    mode: options.mode,
    // The FORTRESS keystore-to-passphrase downgrade is metadata only, and must
    // reach the operator's log rather than being swallowed here.
    logger: log,
  });

  let kek = provider.loadKek();
  const database = openDatabase({ dataDir: options.dataDir });
  const db = database.db;

  try {
    /*
     * Structural integrity before anything else.
     *
     * A database whose schema is not what this build applied must be refused before a
     * single domain statement runs: the alternative is running Phase 3-9 SQL against
     * an unknown shape. This precedes even the key check, because a rolled-back
     * `user_version` would otherwise re-run migrations over an existing schema.
     */
    verifyMigrationChain(db, MIGRATIONS, database.schemaVersion);

    const rollback = checkRollback(db, options.dataDir);
    if (rollback.rolledBack) {
      // Detected, not prevented, and deliberately not fatal — refusing here would turn
      // a detection aid into an unbootable install. See `checkRollback` for why a
      // whole-directory rollback defeats this and what primitive is missing.
      log({
        event: "storage_rollback_detected",
        opens: rollback.opens,
        witnessed: rollback.witnessed,
        rolledBack: true,
      });
    }

    const recorded = readMetadata(db, ACTIVE_KEY_ID);
    let keyId = computeKeyId(kek);

    if (recorded === undefined) {
      writeMetadata(db, ACTIVE_KEY_ID, keyId);
      writeMetadata(db, CRYPTO_FORMAT_VERSION, String(ENVELOPE_VERSION));
    } else if (!keyIdsMatch(recorded, keyId)) {
      /*
       * Before declaring a mismatch, check for an interrupted rotation.
       *
       * A rotation stages its replacement key, commits the rewrap, then promotes the
       * staged file. A crash in the window between commit and promotion leaves a
       * database wrapped under a key that is on disk but not yet live — and refusing
       * to open there would strand every secret permanently. The staged key is
       * promoted only when its fingerprint matches what the database recorded, so
       * this is recovery, not a second accepted key.
       */
      const rotatable = isRotatableKeyProvider(provider) ? provider : undefined;
      const recovered = rotatable?.stagedKek();
      if (
        rotatable !== undefined &&
        recovered !== undefined &&
        keyIdsMatch(recorded, computeKeyId(recovered))
      ) {
        rotatable.promoteStaged();
        kek.fill(0);
        kek = recovered;
        keyId = computeKeyId(kek);
        log({ event: "root_key_rotation_recovered", keyId });
      } else {
        if (rotatable !== undefined && recovered !== undefined) {
          // A staged key the database does not need is the residue of a rotation
          // that failed before committing. Leaving it would make the next open
          // consider it again forever.
          rotatable.discardStaged();
        }
        // Detected before any ciphertext is touched, so an operator sees one clear
        // signal instead of a cascade of secret_corrupt failures.
        throw new StorageError("master_key_mismatch", "verify-active-key");
      }
    } else if (isRotatableKeyProvider(provider)) {
      // The live key is correct, so any staged key is stale.
      provider.discardStaged();
    }

    let activeKeyId = keyId;

    const requireRow = (name: string): SqlRow => {
      const row = db.prepare("SELECT * FROM secrets WHERE name = ?").get(name);
      if (row === undefined) {
        throw new StorageError("secret_not_found", "get-secret");
      }
      return row;
    };

    /**
     * Rewrap every envelope onto `nextKek` in one transaction.
     *
     * Shared by both rotation entry points so there is exactly one place the
     * atomicity guarantee lives. A failure leaves every record wrapped by the old
     * KEK, which the caller still holds — rotation degrades to "nothing happened"
     * rather than to a half-readable database.
     */
    const rewrapAll = (nextKek: Buffer): { rotated: number; keyId: string } => {
      const nextKeyId = computeKeyId(nextKek);
      const rows = db.prepare("SELECT * FROM secrets").all();

      db.exec("BEGIN IMMEDIATE");
      try {
        let rotated = 0;
        const update = db.prepare(
          `UPDATE secrets
              SET key_id = ?, wrapped_dek = ?, wrap_iv = ?, wrap_tag = ?
            WHERE name = ?`,
        );
        for (const row of rows) {
          const name = String(row.name);
          // Rewrap only: the DEK is unwrapped with the old KEK and rewrapped with
          // the new one, so no plaintext is ever produced and the secret ciphertext
          // is untouched.
          const rewrapped = rewrapEnvelope(kek, nextKek, name, rowToEnvelope(row));
          update.run(
            rewrapped.keyId,
            rewrapped.wrappedDek,
            rewrapped.wrapIv,
            rewrapped.wrapTag,
            name,
          );
          rotated += 1;
        }
        writeMetadata(db, ACTIVE_KEY_ID, nextKeyId);
        db.exec("COMMIT");

        kek.fill(0);
        kek = nextKek;
        activeKeyId = nextKeyId;
        log(
          redactSecrets({
            event: "root_key_rotated",
            rotated,
            keyId: nextKeyId,
          }),
        );
        return { rotated, keyId: nextKeyId };
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Already unwound.
        }
        throw asStorageError("secret_corrupt", "rotate-root-key", error);
      }
    };

    const storage: SecretStorage = {
      schemaVersion: database.schemaVersion,
      journalMode: database.journalMode,
      driver: database.driver,
      appliedMigrations: database.appliedMigrations,
      keyProvider: provider.kind,
      /**
       * A getter, not a captured value.
       *
       * `/api/status` reports this fingerprint, and after a rotation a frozen value
       * would tell an operator the rotation had not happened. `readonly` in the
       * interface still holds: there is no setter.
       */
      get keyId(): string {
        return activeKeyId;
      },
      sql: db,
      canRotateRootKey: isRotatableKeyProvider(provider),

      activeKeyId(): string | undefined {
        return readMetadata(db, ACTIVE_KEY_ID);
      },

      put(name: string, plaintext: string): void {
        if (typeof name !== "string" || name.length === 0) {
          throw new StorageError("secret_corrupt", "put-name");
        }
        if (typeof plaintext !== "string") {
          // Rejected before the transaction opens, so a bad call cannot leave a
          // partial row behind.
          throw new StorageError("secret_corrupt", "put-plaintext");
        }

        const envelope = sealSecret(kek, name, plaintext);
        const now = new Date().toISOString();

        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare(
            `INSERT INTO secrets
               (name, version, algorithm, kdf, key_id, wrapped_dek, wrap_iv,
                wrap_tag, ciphertext, iv, tag, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(name) DO UPDATE SET
               version = excluded.version,
               algorithm = excluded.algorithm,
               kdf = excluded.kdf,
               key_id = excluded.key_id,
               wrapped_dek = excluded.wrapped_dek,
               wrap_iv = excluded.wrap_iv,
               wrap_tag = excluded.wrap_tag,
               ciphertext = excluded.ciphertext,
               iv = excluded.iv,
               tag = excluded.tag,
               updated_at = excluded.updated_at`,
          ).run(
            name,
            envelope.version,
            envelope.algorithm,
            envelope.kdf,
            envelope.keyId,
            envelope.wrappedDek,
            envelope.wrapIv,
            envelope.wrapTag,
            envelope.ciphertext,
            envelope.iv,
            envelope.tag,
            now,
            now,
          );
          db.exec("COMMIT");
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // Already unwound.
          }
          throw asStorageError("storage_unavailable", "put-secret", error);
        }
        log(redactSecrets({ event: "secret_written", name }));
      },

      get(name: string): string {
        return openSecret(kek, name, rowToEnvelope(requireRow(name)));
      },

      find(name: string): string | undefined {
        const row = db.prepare("SELECT * FROM secrets WHERE name = ?").get(name);
        if (row === undefined) {
          return undefined;
        }
        // Corruption is never reported as "absent": that would let a tampered
        // record masquerade as an unset credential.
        return openSecret(kek, name, rowToEnvelope(row));
      },

      list(): SecretRecordMetadata[] {
        return db
          .prepare(
            `SELECT name, version, algorithm, kdf, key_id, created_at, updated_at
               FROM secrets ORDER BY name`,
          )
          .all()
          .map((row) => ({
            name: String(row.name),
            version: Number(row.version),
            algorithm: String(row.algorithm),
            kdf: String(row.kdf),
            keyId: String(row.key_id),
            createdAt: String(row.created_at),
            updatedAt: String(row.updated_at),
          }));
      },

      delete(name: string): boolean {
        const result = db.prepare("DELETE FROM secrets WHERE name = ?").run(name);
        return result.changes > 0;
      },

      rotateRootKey(next: KeyProvider): { rotated: number; keyId: string } {
        // Resolved before the transaction so an unusable replacement key cannot
        // half-rotate the database.
        const nextKek = next.loadKek();
        return rewrapAll(nextKek);
      },

      rotateManagedRootKey(): ManagedRotationResult {
        const rotatable = isRotatableKeyProvider(provider) ? provider : undefined;
        if (rotatable === undefined) {
          // Refused before a single row is read. BAYZ cannot rewrite the operator's
          // environment or change their passphrase, so committing a rewrap here would
          // leave a database whose key nothing holds — the one failure that destroys
          // every secret at once.
          throw new StorageError("rotation_unsupported", provider.kind);
        }

        const previousKeyId = activeKeyId;
        const handle = rotatable.beginRotation();
        let result: { rotated: number; keyId: string };
        try {
          result = rewrapAll(handle.kek);
        } catch (error) {
          // The rewrap did not commit, so the live key is still correct and the
          // staged one is garbage.
          handle.rollback();
          throw error;
        }
        // Promotion is last: until it happens the database and the staged key
        // disagree with the live file, and `openSecretStorage` recovers from exactly
        // that state by fingerprint match.
        handle.commit();
        return { ...result, previousKeyId };
      },

      inspect(name: string): SecretEnvelopeView {
        const row = requireRow(name);
        return {
          keyId: String(row.key_id),
          wrappedDek: bytes(row, "wrapped_dek"),
          wrapIv: bytes(row, "wrap_iv"),
          wrapTag: bytes(row, "wrap_tag"),
          ciphertext: bytes(row, "ciphertext"),
          iv: bytes(row, "iv"),
          tag: bytes(row, "tag"),
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
        };
      },

      corruptForTest(name: string, column: CorruptibleColumn): void {
        const current = bytes(requireRow(name), column);
        const flipped = Uint8Array.from(current);
        flipped[0] = flipped[0]! ^ 0xff;
        db.prepare(`UPDATE secrets SET ${column} = ? WHERE name = ?`).run(
          flipped,
          name,
        );
      },

      truncateForTest(name: string, column: CorruptibleColumn): void {
        const current = bytes(requireRow(name), column);
        db.prepare(`UPDATE secrets SET ${column} = ? WHERE name = ?`).run(
          current.slice(0, Math.max(1, current.byteLength - 4)),
          name,
        );
      },

      setVersionForTest(name: string, version: number): void {
        db.prepare("UPDATE secrets SET version = ? WHERE name = ?").run(
          version,
          name,
        );
      },

      renameForTest(name: string, nextName: string): void {
        db.prepare("UPDATE secrets SET name = ? WHERE name = ?").run(
          nextName,
          name,
        );
      },

      close(): void {
        // Reseal before the connection goes away, so legitimate changes made through
        // BAYZ do not look like out-of-band tampering on the next open. The property
        // this buys is precise: rows that changed while BAYZ was *not running* are
        // what gets reported.
        try {
          sealConfigHmac(db, kek);
        } catch {
          // A reseal failure must not prevent a clean shutdown; the next open reports
          // `mismatch`, which is the safe direction to fail.
        }
        kek.fill(0);
        database.close();
      },
    };

    const configIntegrity: ConfigIntegrity = verifyConfigHmac(db, kek);
    if (configIntegrity === "mismatch") {
      log({ event: "storage_config_tampered", configIntegrity });
    }

    log(
      redactSecrets({
        event: "storage_ready",
        schemaVersion: database.schemaVersion,
        journalMode: database.journalMode,
        driver: database.driver,
        keyProvider: provider.kind,
        keyId: activeKeyId,
        configIntegrity,
      }),
    );

    return storage;
  } catch (error) {
    kek.fill(0);
    try {
      database.close();
    } catch {
      // Already unusable.
    }
    throw error instanceof StorageError
      ? error
      : asStorageError("storage_unavailable", "open-secret-storage", error);
  }
}
