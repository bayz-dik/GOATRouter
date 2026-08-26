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
  resolveKeyProvider,
  type BayzSecurityMode,
  type KeyProvider,
  type KeyProviderKind,
} from "./key-provider.js";
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
  });

  let kek = provider.loadKek();
  const database = openDatabase({ dataDir: options.dataDir });
  const db = database.db;

  try {
    const keyId = computeKeyId(kek);
    const recorded = readMetadata(db, ACTIVE_KEY_ID);

    if (recorded === undefined) {
      writeMetadata(db, ACTIVE_KEY_ID, keyId);
      writeMetadata(db, CRYPTO_FORMAT_VERSION, String(ENVELOPE_VERSION));
    } else if (!keyIdsMatch(recorded, keyId)) {
      // Detected before any ciphertext is touched, so an operator sees one clear
      // signal instead of a cascade of secret_corrupt failures.
      throw new StorageError("master_key_mismatch", "verify-active-key");
    }

    let activeKeyId = keyId;

    const requireRow = (name: string): SqlRow => {
      const row = db.prepare("SELECT * FROM secrets WHERE name = ?").get(name);
      if (row === undefined) {
        throw new StorageError("secret_not_found", "get-secret");
      }
      return row;
    };

    const storage: SecretStorage = {
      schemaVersion: database.schemaVersion,
      journalMode: database.journalMode,
      driver: database.driver,
      appliedMigrations: database.appliedMigrations,
      keyProvider: provider.kind,
      keyId,
      sql: db,

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
            // Rewrap only: the DEK is unwrapped with the old KEK and rewrapped
            // with the new one, so no plaintext is ever produced and the secret
            // ciphertext is untouched.
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
          // A failed rotation degrades to "nothing happened": every record is
          // still wrapped by the old KEK, which the caller still holds.
          throw asStorageError("secret_corrupt", "rotate-root-key", error);
        }
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
        kek.fill(0);
        database.close();
      },
    };

    log(
      redactSecrets({
        event: "storage_ready",
        schemaVersion: database.schemaVersion,
        journalMode: database.journalMode,
        driver: database.driver,
        keyProvider: provider.kind,
        keyId: activeKeyId,
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
