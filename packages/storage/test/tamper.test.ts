import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  CONFIG_HMAC_KEY,
  MIGRATIONS,
  MIGRATION_CHAIN_KEY,
  OPEN_COUNTER_KEY,
  StorageError,
  TARGET_SCHEMA_VERSION,
  databasePath,
  integrityWitnessPath,
  migrationChain,
  openSecretStorage,
  type SecretStorage,
} from "../src/index.js";

/**
 * Tamper suite: edits the stored artifacts directly, like the Phase 2 adversarial
 * file, because an attacker with write access to `bayz.db` will not politely use our
 * adapter. Opening a raw `DatabaseSync` here is the same permitted exception.
 */

const KEY = Buffer.alloc(32, 0x9e).toString("hex");

function dataDir(): string {
  return join(mkdtempSync(join(tmpdir(), "bayz-tamper-")), ".bayz");
}

function open(dir: string, logs?: Array<Record<string, unknown>>): SecretStorage {
  return openSecretStorage({
    dataDir: dir,
    env: { BAYZ_MASTER_KEY: KEY },
    ...(logs === undefined ? {} : { logger: (payload) => logs.push(payload) }),
  });
}

function raw<T>(dir: string, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(databasePath(dir));
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function metadata(dir: string, key: string): string | undefined {
  return raw(dir, (db) => {
    const row = db.prepare("SELECT value FROM runtime_metadata WHERE key = ?").get(key);
    return row === undefined ? undefined : String(row.value);
  });
}

function seedConfig(storage: SecretStorage): void {
  storage.sql
    .prepare(
      `INSERT INTO providers
         (id, kind, display_name, base_url, enabled, config_json, proxy_id,
          created_at, updated_at)
       VALUES ('p1', 'openai-compatible', 'P1', 'https://one.invalid', 1, '{}', NULL,
               't', 't')`,
    )
    .run();
  storage.sql
    .prepare(
      `INSERT INTO routes
         (id, model, provider_id, proxy_id, priority, enabled, config_json,
          force_direct, free_only, created_at, updated_at)
       VALUES ('r1', 'gpt-4o', 'p1', NULL, 100, 1, '{}', 0, 1, 't', 't')`,
    )
    .run();
}

test("the migration chain is recorded on first open and is stable across reopens", () => {
  const dir = dataDir();
  const first = open(dir);
  const recorded = first.activeKeyId();
  assert.ok(recorded);
  first.close();

  const chain = metadata(dir, MIGRATION_CHAIN_KEY);
  assert.match(String(chain), /^[0-9a-f]{64}$/);
  // Independently recomputed, so the test does not merely echo whatever was stored.
  assert.equal(chain, migrationChain(MIGRATIONS, TARGET_SCHEMA_VERSION));

  const second = open(dir);
  try {
    assert.equal(metadata(dir, MIGRATION_CHAIN_KEY), chain, "the chain must not drift");
  } finally {
    second.close();
  }
});

test("the chain covers migration SQL, not just version numbers", () => {
  // A tampered build that changed a migration's statements while keeping its number
  // would produce the same schema version and a different chain. Hashing only versions
  // would miss it entirely.
  const altered = MIGRATIONS.map((migration) =>
    migration.version === 1
      ? { ...migration, statements: [...migration.statements, "-- injected"] }
      : migration,
  );
  assert.notEqual(
    migrationChain(altered, TARGET_SCHEMA_VERSION),
    migrationChain(MIGRATIONS, TARGET_SCHEMA_VERSION),
  );
  // And the chain is order-sensitive, so swapping two migrations is also visible.
  const swapped = [MIGRATIONS[1]!, MIGRATIONS[0]!, ...MIGRATIONS.slice(2)];
  assert.notEqual(
    migrationChain(swapped, TARGET_SCHEMA_VERSION),
    migrationChain(MIGRATIONS, TARGET_SCHEMA_VERSION),
  );
});

test("a tampered migration chain is detected at open with a distinct stage", () => {
  const dir = dataDir();
  open(dir).close();

  raw(dir, (db) =>
    db
      .prepare("UPDATE runtime_metadata SET value = ? WHERE key = ?")
      .run("0".repeat(64), MIGRATION_CHAIN_KEY),
  );

  assert.throws(
    () => open(dir),
    (error: unknown) => {
      assert.ok(error instanceof StorageError);
      assert.equal(error.code, "storage_unavailable");
      assert.equal(error.stage, "verify-migration-chain");
      return true;
    },
  );
});

test("editing user_version out of band is detected at open", () => {
  const dir = dataDir();
  open(dir).close();

  // Rolling `user_version` back would make the migration runner re-apply migrations
  // over an existing schema, so this is caught *before* the runner acts, by comparing
  // against `schema_migrations` — the independent record of what actually ran.
  raw(dir, (db) => db.exec("PRAGMA user_version = 3"));

  assert.throws(
    () => open(dir),
    (error: unknown) => {
      assert.ok(error instanceof StorageError);
      assert.equal(error.code, "storage_unavailable");
      assert.equal(error.stage, "verify-user-version");
      return true;
    },
  );
});

test("advancing user_version to skip a migration is also detected", () => {
  const dir = dataDir();
  open(dir).close();

  // The other direction: a raised version makes the runner skip migrations that were
  // never applied, leaving domain SQL to hit tables that do not exist.
  raw(dir, (db) => db.exec(`PRAGMA user_version = ${TARGET_SCHEMA_VERSION + 3}`));

  assert.throws(
    () => open(dir),
    (error: unknown) =>
      error instanceof StorageError && error.stage === "verify-user-version",
  );
});

test("a forged schema_migrations row is detected", () => {
  const dir = dataDir();
  open(dir).close();

  raw(dir, (db) =>
    db
      .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(TARGET_SCHEMA_VERSION + 5, "forged"),
  );

  // Caught by the `user_version` ↔ `schema_migrations` agreement check rather than by
  // the chain digest: the attacker did not touch the chain, but they made the audit
  // table claim a migration that never ran. The two checks cover different halves of
  // the same attack, which is why both exist.
  assert.throws(
    () => open(dir),
    (error: unknown) => {
      assert.ok(error instanceof StorageError);
      assert.equal(error.code, "storage_unavailable");
      assert.equal(error.stage, "verify-user-version");
      return true;
    },
  );
});

test("a deleted schema_migrations row is detected", () => {
  const dir = dataDir();
  open(dir).close();

  // Removing the head row makes the audit table under-report, which would let a
  // tampered build claim an older schema than the one actually present.
  raw(dir, (db) =>
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(TARGET_SCHEMA_VERSION),
  );

  assert.throws(
    () => open(dir),
    (error: unknown) =>
      error instanceof StorageError && error.stage === "verify-user-version",
  );
});

test("the open counter increments monotonically", () => {
  const dir = dataDir();
  for (let expected = 1; expected <= 4; expected += 1) {
    const storage = open(dir);
    assert.equal(Number(metadata(dir, OPEN_COUNTER_KEY)), expected);
    storage.close();
  }
});

test("a decreased open counter is reported as a rollback warning, not a refusal", () => {
  const dir = dataDir();
  open(dir).close();
  open(dir).close();
  open(dir).close();
  assert.equal(Number(metadata(dir, OPEN_COUNTER_KEY)), 3);

  // Simulate a restored older database: the counter goes backwards while the sidecar
  // witness still remembers the higher value.
  raw(dir, (db) =>
    db.prepare("UPDATE runtime_metadata SET value = ? WHERE key = ?").run("1", OPEN_COUNTER_KEY),
  );

  const logs: Array<Record<string, unknown>> = [];
  const storage = open(dir, logs);
  try {
    // Detection, not prevention: the database still opens, because refusing would
    // turn a detection aid into an unbootable install.
    const warning = logs.find((entry) => entry.event === "storage_rollback_detected");
    assert.ok(warning, "a rollback must be reported");
    assert.equal(warning.rolledBack, true);
    // Metadata only. No row contents, no secret, no key material.
    assert.deepEqual(
      Object.keys(warning).sort(),
      ["event", "opens", "rolledBack", "witnessed"],
    );
    assert.doesNotMatch(JSON.stringify(warning), /[0-9a-f]{64}/);
  } finally {
    storage.close();
  }
});

test("a normal open reports no rollback", () => {
  const dir = dataDir();
  open(dir).close();
  const logs: Array<Record<string, unknown>> = [];
  const storage = open(dir, logs);
  try {
    assert.equal(
      logs.some((entry) => entry.event === "storage_rollback_detected"),
      false,
    );
  } finally {
    storage.close();
  }
});

/**
 * The honest boundary, asserted rather than claimed away.
 *
 * An attacker who restores the database *and* the sidecar witness together defeats
 * this entirely, and the test proves it instead of pretending otherwise. Preventing a
 * whole-directory rollback needs a monotonic counter in storage the attacker cannot
 * rewrite — a TPM, a secure element, or a trusted remote service. None exists on this
 * Termux/Android target and none is reachable from Node here.
 */
test("a whole-directory rollback is NOT detected, and that limit is the documented one", () => {
  const dir = dataDir();
  open(dir).close();
  open(dir).close();
  open(dir).close();

  // Snapshot both artifacts, exactly as a backup tool would.
  const dbBytes = readFileSync(databasePath(dir));
  const witnessBytes = readFileSync(integrityWitnessPath(dir));

  open(dir).close();
  open(dir).close();

  // Restore the pair. The counter and the witness agree, so nothing looks wrong.
  writeFileSync(databasePath(dir), dbBytes);
  writeFileSync(integrityWitnessPath(dir), witnessBytes);

  const logs: Array<Record<string, unknown>> = [];
  const storage = open(dir, logs);
  try {
    assert.equal(
      logs.some((entry) => entry.event === "storage_rollback_detected"),
      false,
      "this is the stated limitation: a consistent rollback is invisible here",
    );
  } finally {
    storage.close();
  }
});

test("the config HMAC is sealed at close and verifies on the next open", () => {
  const dir = dataDir();
  const first = open(dir);
  seedConfig(first);
  first.close();

  assert.match(String(metadata(dir, CONFIG_HMAC_KEY)), /^[0-9a-f]{64}$/);

  const logs: Array<Record<string, unknown>> = [];
  const second = open(dir, logs);
  try {
    const ready = logs.find((entry) => entry.event === "storage_ready");
    assert.equal(ready?.configIntegrity, "ok");
  } finally {
    second.close();
  }
});

test("an out-of-band provider row edit is detected by the config HMAC", () => {
  const dir = dataDir();
  const first = open(dir);
  seedConfig(first);
  first.close();

  // Repointing a provider's base URL is the attack: it silently redirects every
  // request for that provider's models to an endpoint the operator never approved.
  raw(dir, (db) =>
    db
      .prepare("UPDATE providers SET base_url = ? WHERE id = ?")
      .run("https://attacker.invalid", "p1"),
  );

  const logs: Array<Record<string, unknown>> = [];
  const storage = open(dir, logs);
  try {
    const ready = logs.find((entry) => entry.event === "storage_ready");
    assert.equal(ready?.configIntegrity, "mismatch");
    const warning = logs.find((entry) => entry.event === "storage_config_tampered");
    assert.ok(warning, "a config mismatch must be reported explicitly");
    assert.doesNotMatch(JSON.stringify(warning), /attacker\.invalid/);
  } finally {
    storage.close();
  }
});

test("an out-of-band identity scope widening is detected", () => {
  const dir = dataDir();
  const first = open(dir);
  first.sql
    .prepare(
      `INSERT INTO client_identities
         (id, display_name, scopes_json, preset, revoked, expires_at, created_at,
          updated_at, last_used_at)
       VALUES ('c1', 'C1', '["chat.completions"]', NULL, 0, NULL, 't', 't', NULL)`,
    )
    .run();
  first.close();

  // 9C's residual risk: a valid `["admin"]` written straight into the row is honoured
  // by scope validation because it *is* valid. The HMAC is what makes it visible.
  raw(dir, (db) =>
    db
      .prepare("UPDATE client_identities SET scopes_json = ? WHERE id = ?")
      .run('["admin"]', "c1"),
  );

  const logs: Array<Record<string, unknown>> = [];
  const storage = open(dir, logs);
  try {
    assert.equal(
      logs.find((entry) => entry.event === "storage_ready")?.configIntegrity,
      "mismatch",
    );
  } finally {
    storage.close();
  }
});

test("a change made through BAYZ reseals and does not report tampering", () => {
  const dir = dataDir();
  const first = open(dir);
  seedConfig(first);
  first.close();

  const second = open(dir);
  second.sql
    .prepare("UPDATE providers SET display_name = ? WHERE id = ?")
    .run("Renamed", "p1");
  second.close();

  const logs: Array<Record<string, unknown>> = [];
  const third = open(dir, logs);
  try {
    // Legitimate edits are resealed on close, so only changes made while BAYZ was not
    // running are reported. That is the actual property, and it is what makes the
    // signal useful rather than constant noise.
    assert.equal(
      logs.find((entry) => entry.event === "storage_ready")?.configIntegrity,
      "ok",
    );
  } finally {
    third.close();
  }
});

test("a stripped config HMAC reports unsealed rather than passing silently", () => {
  const dir = dataDir();
  const first = open(dir);
  seedConfig(first);
  first.close();

  raw(dir, (db) =>
    db.prepare("DELETE FROM runtime_metadata WHERE key = ?").run(CONFIG_HMAC_KEY),
  );

  const logs: Array<Record<string, unknown>> = [];
  const storage = open(dir, logs);
  try {
    // Deleting the witness must not look like "verified": an attacker who can edit
    // rows can also delete the HMAC, so absence is its own reported state.
    assert.equal(
      logs.find((entry) => entry.event === "storage_ready")?.configIntegrity,
      "unsealed",
    );
  } finally {
    storage.close();
  }
});

test("no integrity value is a usable key and none leaks a secret", () => {
  const dir = dataDir();
  const storage = open(dir);
  seedConfig(storage);
  storage.put("provider:p1:api_key", "sk-tamper-sentinel");
  storage.close();

  const values = raw(dir, (db) =>
    (db.prepare("SELECT key, value FROM runtime_metadata").all() as Array<
      Record<string, unknown>
    >).map((row) => `${String(row.key)}=${String(row.value)}`),
  ).join("\n");

  assert.equal(values.includes("sk-tamper-sentinel"), false);
  // The config HMAC key is HKDF-derived from the KEK with its own info string, so the
  // KEK itself must not appear anywhere in the metadata table.
  assert.equal(values.includes(KEY), false);
});
