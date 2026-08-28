import { createHash, createHmac, hkdfSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StorageError, asStorageError } from "./errors.js";
import type { Migration } from "./migrations.js";
import type { SqlDatabase } from "./sql.js";

export const MIGRATION_CHAIN_KEY = "migration_chain";
export const OPEN_COUNTER_KEY = "open_counter";
export const CONFIG_HMAC_KEY = "config_hmac";

/** Domain separation, so no digest here can be confused with another. */
const CHAIN_SEED = "bayz-migration-chain-v1";
const CONFIG_HMAC_INFO = "bayz-config-hmac-v1";
const HMAC_LENGTH = 32;

/** Sidecar witness for the open counter. See `checkRollback`. */
export const INTEGRITY_WITNESS_FILENAME = "integrity.json";

export function integrityWitnessPath(dataDir: string): string {
  return join(dataDir, INTEGRITY_WITNESS_FILENAME);
}

/**
 * Fold the applied migrations into one digest.
 *
 * Each link covers the version *and* its statements, so the chain detects three
 * different attacks with one value: a forged `schema_migrations` row claiming a
 * version that was never applied, an edited `user_version`, and a migration whose SQL
 * was altered in a tampered build. Hashing only the version numbers would catch the
 * first two and miss the third.
 */
export function migrationChain(
  migrations: readonly Migration[],
  upTo: number,
): string {
  let accumulator = createHash("sha256").update(CHAIN_SEED, "utf8").digest();
  for (const migration of migrations) {
    if (migration.version > upTo) {
      continue;
    }
    accumulator = createHash("sha256")
      .update(accumulator)
      .update(String(migration.version), "utf8")
      .update(migration.statements.join(";"), "utf8")
      .digest();
  }
  return accumulator.toString("hex");
}

function readMetadata(db: SqlDatabase, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM runtime_metadata WHERE key = ?").get(key);
  return row === undefined ? undefined : String(row.value);
}

function writeMetadata(db: SqlDatabase, key: string, value: string): void {
  db.prepare(
    `INSERT INTO runtime_metadata (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

/**
 * Detect an out-of-band `user_version` edit **before** the migration runner acts.
 *
 * Ordering is the whole point. `runMigrations` decides what to apply from
 * `user_version`, so a value edited *down* makes it re-run migrations over an existing
 * schema (which fails with an opaque `exec` error on a duplicate table) and a value
 * edited *up* makes it silently skip migrations that were never applied. Either way
 * the damage is done before any post-migration check could speak.
 *
 * `schema_migrations` is the independent witness: it records every version actually
 * applied, so its head must equal `user_version` on an untampered database. Called
 * with the *recorded* version, before anything is applied.
 *
 * A database with no `schema_migrations` table is brand new and has nothing to verify.
 */
export function verifyRecordedSchemaVersion(db: SqlDatabase, userVersion: number): void {
  if (userVersion === 0) {
    return;
  }
  const present = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();
  if (present === undefined) {
    // `user_version` claims migrations ran, but the table recording them is absent.
    // That is not a state any BAYZ build produces.
    throw new StorageError("storage_unavailable", "verify-user-version-orphan");
  }
  const head = Number(
    db.prepare("SELECT MAX(version) AS head FROM schema_migrations").get()?.head ?? 0,
  );
  if (head !== userVersion) {
    throw new StorageError("storage_unavailable", "verify-user-version");
  }
}

/**
 * Verify or record the migration chain.
 *
 * A mismatch is `storage_unavailable` with a distinct stage rather than a generic
 * failure: the database is structurally not what this build applied, and continuing
 * would run domain SQL against an unknown schema.
 */
export function verifyMigrationChain(
  db: SqlDatabase,
  migrations: readonly Migration[],
  schemaVersion: number,
): void {
  const expected = migrationChain(migrations, schemaVersion);
  const recorded = readMetadata(db, MIGRATION_CHAIN_KEY);

  if (recorded === undefined) {
    // First open on this database, or an upgrade from a build that predates the
    // chain. Recording rather than refusing is correct: there is nothing to compare
    // against yet, and refusing would brick every existing install.
    writeMetadata(db, MIGRATION_CHAIN_KEY, expected);
    return;
  }
  if (recorded !== expected) {
    throw new StorageError("storage_unavailable", "verify-migration-chain");
  }

  // The audit table must agree with `user_version` too. A forged row is the other
  // half of the same attack: the chain pins *what* was applied, this pins that
  // nothing claims to have been applied beyond it.
  const audited = db
    .prepare("SELECT MAX(version) AS head, COUNT(*) AS total FROM schema_migrations")
    .get();
  if (Number(audited?.head) !== schemaVersion) {
    throw new StorageError("storage_unavailable", "verify-migration-head");
  }
  if (Number(audited?.total) !== schemaVersion) {
    throw new StorageError("storage_unavailable", "verify-migration-count");
  }
}

export type RollbackVerdict = {
  /** Monotonic count of opens recorded inside the database. */
  readonly opens: number;
  /**
   * True when the database's counter went *backwards* relative to the sidecar
   * witness, which is what a restored older `bayz.db` looks like.
   */
  readonly rolledBack: boolean;
  /** Highest counter ever witnessed, from the sidecar. */
  readonly witnessed: number;
};

/**
 * Increment the open counter and compare it against a sidecar witness.
 *
 * **This detects; it does not prevent.** An attacker with write access to the data
 * directory can restore an older `bayz.db` *and* an older `integrity.json`, and the
 * two will agree. Preventing that needs a monotonic counter in storage the attacker
 * cannot rewrite — a TPM, a secure element, or a trusted remote service — none of
 * which exists on this target and none of which Node can reach here. The honest
 * guarantee is therefore: rolling back the database alone is caught, rolling back
 * everything is not.
 *
 * The verdict is metadata only. No row contents, no secret, no key.
 */
export function checkRollback(db: SqlDatabase, dataDir: string): RollbackVerdict {
  const recorded = Number(readMetadata(db, OPEN_COUNTER_KEY) ?? "0");
  const previous = Number.isInteger(recorded) && recorded >= 0 ? recorded : 0;
  const opens = previous + 1;
  writeMetadata(db, OPEN_COUNTER_KEY, String(opens));

  const witnessFile = integrityWitnessPath(dataDir);
  let witnessed = 0;
  if (existsSync(witnessFile)) {
    try {
      const parsed = JSON.parse(readFileSync(witnessFile, "utf8")) as {
        maxOpenCounter?: unknown;
      };
      const value = Number(parsed.maxOpenCounter);
      witnessed = Number.isInteger(value) && value >= 0 ? value : 0;
    } catch {
      // A corrupt or hand-edited witness is treated as absent rather than fatal: it
      // is evidence, not custody, and refusing to start over it would turn a
      // detection aid into a denial of service.
      witnessed = 0;
    }
  }

  // Strictly less than: equal means this is the first open since the witness was
  // written, which is the normal case.
  const rolledBack = opens < witnessed;

  try {
    writeFileSync(
      witnessFile,
      `${JSON.stringify({ maxOpenCounter: Math.max(opens, witnessed) }, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Best-effort for the same reason the directory mode is: some Android and
    // FAT-derived mounts refuse it, and Bayz must still start.
  }

  return { opens, rolledBack, witnessed };
}

/**
 * Canonical serialization of the operator's configuration registries.
 *
 * Explicit column lists in a fixed order, sorted by primary key: `SELECT *` would
 * silently change the fingerprint when a later migration adds a column, turning every
 * upgrade into a false tamper alarm. Credentials are absent because no registry table
 * has a column able to hold one.
 */
function canonicalConfig(db: SqlDatabase): string {
  const parts: string[] = [];

  const push = (label: string, sql: string): void => {
    const rows = db.prepare(sql).all() as Record<string, unknown>[];
    parts.push(
      `${label}:${rows
        .map((row) =>
          Object.values(row)
            .map((value) => (value === null ? "\u0000" : String(value)))
            .join("\u001f"),
        )
        .join("\u001e")}`,
    );
  };

  push(
    "providers",
    `SELECT id, kind, display_name, base_url, enabled, config_json, proxy_id
       FROM providers ORDER BY id`,
  );
  push(
    "proxies",
    `SELECT id, kind, host, port, username, enabled, config_json
       FROM proxies ORDER BY id`,
  );
  push(
    "routes",
    `SELECT id, model, provider_id, proxy_id, priority, enabled, config_json,
            force_direct, free_only
       FROM routes ORDER BY id`,
  );
  push(
    "identities",
    `SELECT id, display_name, scopes_json, preset, revoked, expires_at
       FROM client_identities ORDER BY id`,
  );

  return parts.join("\u001d");
}

/**
 * HMAC over the configuration, keyed by material derived from the root key.
 *
 * Keyed rather than a plain digest: an attacker who can edit rows can also edit a
 * stored digest, so an unkeyed hash would detect nothing. Deriving from the KEK via
 * HKDF with its own info string means the config key is not the KEK and cannot be
 * used to unwrap a DEK.
 */
export function configHmac(kek: Buffer, db: SqlDatabase): string {
  const key = Buffer.from(
    hkdfSync("sha256", kek, Buffer.alloc(0), CONFIG_HMAC_INFO, HMAC_LENGTH),
  );
  try {
    return createHmac("sha256", key).update(canonicalConfig(db), "utf8").digest("hex");
  } catch (error) {
    throw asStorageError("storage_unavailable", "config-hmac", error);
  } finally {
    key.fill(0);
  }
}

export type ConfigIntegrity = "ok" | "unsealed" | "mismatch";

/**
 * Compare the stored config HMAC against the rows actually present.
 *
 * Verified at open and resealed at close, so the property is: **rows that changed
 * while BAYZ was not running are detected.** Changes made through BAYZ are legitimate
 * and get resealed on the way out.
 *
 * The limitation is stated rather than hidden: an unclean shutdown after a
 * configuration change leaves a stale HMAC, and the next open reports `mismatch`
 * indistinguishably from a genuine out-of-band edit. That is why this is a **warning
 * surface, not a startup refusal** — failing closed here would turn a crash into an
 * unbootable install, and the registries hold no secret whose exposure would justify
 * that.
 */
export function verifyConfigHmac(db: SqlDatabase, kek: Buffer): ConfigIntegrity {
  const recorded = readMetadata(db, CONFIG_HMAC_KEY);
  if (recorded === undefined) {
    return "unsealed";
  }
  return recorded === configHmac(kek, db) ? "ok" : "mismatch";
}

export function sealConfigHmac(db: SqlDatabase, kek: Buffer): void {
  writeMetadata(db, CONFIG_HMAC_KEY, configHmac(kek, db));
}
