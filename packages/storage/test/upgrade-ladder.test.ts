import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MIGRATIONS,
  StorageError,
  TARGET_SCHEMA_VERSION,
  computeKeyId,
  migrationChain,
  openDatabase,
  openSecretStorage,
  readSchemaVersion,
  runMigrations,
  sealSecret,
  selectDriver,
  type SqlDatabase,
} from "../src/index.js";

/**
 * Upgrade ladder from every prior schema version — 9J Task 6.
 *
 * The claim being defended is the one an operator cares about most: **upgrading BAYZ
 * does not lose data.** Every version from v1 to head is built as a real database with
 * real rows — real envelope-encrypted secrets, real providers, proxies, routes,
 * identities, and telemetry — then opened with the *current* code and inspected.
 *
 * The head is read from `TARGET_SCHEMA_VERSION` rather than hardcoded, so a new
 * migration extends the ladder automatically instead of silently leaving its own
 * upgrade untested.
 */

/** 32 bytes, so the envelope crypto below is real rather than stubbed. */
const KEK = Buffer.alloc(32, 0x5c);
const KEK_HEX = KEK.toString("hex");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bayz-upgrade-"));
}

function rawOpen(dataDir: string): SqlDatabase {
  const db = selectDriver().open(join(dataDir, "bayz.db"));
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

/** Which tables exist at a given schema version, so a fixture only writes what it can. */
function tablesAt(version: number): Set<string> {
  const names = new Set<string>();
  for (const migration of MIGRATIONS) {
    if (migration.version > version) continue;
    for (const statement of migration.statements) {
      const created = /CREATE TABLE (\w+)/.exec(statement)?.[1];
      if (created !== undefined) names.add(created);
      const renamed = /ALTER TABLE \w+ RENAME TO (\w+)/.exec(statement)?.[1];
      if (renamed !== undefined) names.add(renamed);
    }
  }
  // v7 rebuilds `providers` through a temporary name; the rename lands it back.
  names.delete("providers_v7");
  return names;
}

const NOW = "2026-01-01T00:00:00.000Z";

/**
 * Run `fn` and return the `StorageError` it threw.
 *
 * `assert.throws(fn, StorageError)` returns `undefined`, so reading `.code` off its
 * result is a `TypeError` rather than an assertion — which is how the first version of
 * this file reported four "failures" that were really one mistake in the harness. The
 * code and stage are what these tests are about, so they have to be readable.
 */
function expectStorageError(fn: () => unknown, label: string): StorageError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof StorageError, `${label}: threw ${String(error)} rather than a StorageError`);
    return error;
  }
  assert.fail(`${label}: no error was thrown`);
}

/**
 * Build a database at exactly `version`, populated with real rows.
 *
 * `runMigrations` is given a truncated migration list, which is the only honest way to
 * produce a genuine older database: writing the head schema and then editing
 * `user_version` down would produce a shape no BAYZ build ever created.
 *
 * Returns the fixture's own expectations so the post-upgrade assertions compare against
 * what was actually written rather than against a duplicated literal.
 */
function buildAt(version: number): {
  dataDir: string;
  secretName: string;
  secretValue: string;
  tables: Set<string>;
} {
  const dataDir = tempDir();
  const db = rawOpen(dataDir);
  const tables = tablesAt(version);
  const secretName = "provider:legacy:api_key";
  const secretValue = `legacy-credential-v${version}`;

  try {
    const applied = runMigrations(db, MIGRATIONS.slice(0, version));
    assert.equal(applied, version, `fixture did not reach v${version}`);
    assert.equal(readSchemaVersion(db), version);

    // A real envelope, sealed with the real KEK. A fabricated blob would make the
    // "every pre-existing secret still decrypts" assertion meaningless.
    const envelope = sealSecret(KEK, secretName, secretValue);
    db.prepare(
      `INSERT INTO secrets
         (name, version, algorithm, kdf, key_id, wrapped_dek, wrap_iv, wrap_tag,
          ciphertext, iv, tag, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      secretName,
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
      NOW,
      NOW,
    );
    // The active key fingerprint, which `openSecretStorage` compares on open. Without
    // it the upgrade would be testing a first-ever open rather than an existing install.
    db.prepare("INSERT INTO runtime_metadata (key, value) VALUES (?, ?)").run(
      "active_key_id",
      computeKeyId(KEK),
    );
    db.prepare("INSERT INTO runtime_metadata (key, value) VALUES (?, ?)").run(
      "crypto_format_version",
      "1",
    );

    if (tables.has("providers")) {
      db.prepare(
        `INSERT INTO providers
           (id, kind, display_name, base_url, enabled, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("legacy", "openai-compatible", "Legacy Provider", "https://legacy.example/v1", 1, "{}", NOW, NOW);
    }
    if (tables.has("proxies")) {
      db.prepare(
        `INSERT INTO proxies
           (id, kind, host, port, username, enabled, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("legacy-proxy", "http", "127.0.0.1", 3128, "operator", 1, "{}", NOW, NOW);
    }
    if (tables.has("routes")) {
      db.prepare(
        `INSERT INTO routes
           (id, model, provider_id, proxy_id, priority, enabled, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("legacy-route", "legacy-model", "legacy", "legacy-proxy", 10, 1, "{}", NOW, NOW);
    }
    if (tables.has("usage_requests")) {
      db.prepare(
        `INSERT INTO usage_requests
           (request_id, occurred_at, route_id, provider_id, proxy_id, model, routing_mode,
            outcome, failure_category, latency_ms, attempts, prompt_tokens, completion_tokens, cached_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("req-legacy", NOW, "legacy-route", "legacy", "legacy-proxy", "legacy-model", "direct", "ok", null, 42, 1, 7, 5, null);
      db.prepare(
        `INSERT INTO usage_attempts
           (request_id, occurred_at, route_id, provider_id, outcome, failure_category, latency_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("req-legacy", NOW, "legacy-route", "legacy", "ok", null, 42);
    }
    if (tables.has("client_identities")) {
      db.prepare(
        `INSERT INTO client_identities
           (id, display_name, scopes_json, preset, revoked, expires_at, created_at, updated_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("legacy-client", "Legacy Client", '["chat.completions"]', null, 0, null, NOW, NOW, null);
    }
    if (tables.has("security_audit")) {
      db.prepare(
        `INSERT INTO security_audit
           (occurred_at, action, actor, outcome, key_id, previous_key_id, subject_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(NOW, "root_key_rotated", "operator", "ok", computeKeyId(KEK), null, 1);
    }
  } finally {
    db.close();
  }

  return { dataDir, secretName, secretValue, tables };
}

/**
 * The ladder. Every version from 1 to head, each in its own subtest so a single broken
 * step names itself instead of failing the whole file.
 */
for (let version = 1; version <= TARGET_SCHEMA_VERSION; version += 1) {
  test(`a v${version} database upgrades to head with every row intact`, () => {
    const fixture = buildAt(version);

    // The real open path: key resolution, integrity checks, migrations, everything.
    const storage = openSecretStorage({
      dataDir: fixture.dataDir,
      env: { BAYZ_MASTER_KEY: KEK_HEX },
    });

    try {
      assert.equal(storage.schemaVersion, TARGET_SCHEMA_VERSION, `v${version} did not reach head`);
      assert.equal(
        storage.appliedMigrations,
        TARGET_SCHEMA_VERSION - version,
        `expected ${TARGET_SCHEMA_VERSION - version} migrations to apply from v${version}`,
      );

      /*
       * **The assertion that matters most.** The secret was sealed by the old fixture and
       * must still decrypt after every migration in between. A migration that touched the
       * `secrets` table incorrectly would surface here rather than the first time an
       * operator tried to use a provider.
       */
      assert.equal(storage.get(fixture.secretName), fixture.secretValue, "a pre-existing secret no longer decrypts");

      const db = storage.sql;

      if (fixture.tables.has("providers")) {
        const provider = db.prepare("SELECT * FROM providers WHERE id = ?").get("legacy");
        assert.ok(provider !== undefined, "the provider row was dropped by the upgrade");
        assert.equal(provider.kind, "openai-compatible");
        assert.equal(provider.display_name, "Legacy Provider");
        assert.equal(provider.base_url, "https://legacy.example/v1");
        assert.equal(Number(provider.enabled), 1);
        // v7 rebuilt this table. A rebuild that lost a column, or cascaded rows away, is
        // exactly what this pins.
        if (TARGET_SCHEMA_VERSION >= 8) {
          assert.equal(provider.proxy_id, null, "the v8 proxy default did not arrive as NULL");
        }
      }

      if (fixture.tables.has("proxies")) {
        const proxy = db.prepare("SELECT * FROM proxies WHERE id = ?").get("legacy-proxy");
        assert.ok(proxy !== undefined, "the proxy row was dropped by the upgrade");
        assert.equal(proxy.host, "127.0.0.1");
        assert.equal(Number(proxy.port), 3128);
        assert.equal(proxy.username, "operator");
      }

      if (fixture.tables.has("routes")) {
        const route = db.prepare("SELECT * FROM routes WHERE id = ?").get("legacy-route");
        /*
         * **The v7 regression this ladder exists to catch.** v7 rebuilds `providers`, and
         * `routes.provider_id` references it with ON DELETE CASCADE. Without the
         * migration's `suspendForeignKeys`, `DROP TABLE providers` would take every route
         * with it — an upgrade that silently destroys the operator's routing.
         */
        assert.ok(route !== undefined, "the route row was destroyed by the upgrade (v7 cascade?)");
        assert.equal(route.model, "legacy-model");
        assert.equal(route.provider_id, "legacy");
        assert.equal(route.proxy_id, "legacy-proxy");
        assert.equal(Number(route.priority), 10);

        if (TARGET_SCHEMA_VERSION >= 9) {
          assert.equal(Number(route.force_direct), 0, "v9 force_direct did not default to inherit");
        }
        if (TARGET_SCHEMA_VERSION >= 10) {
          /*
           * Free-first (spec §25 rule 6) makes paid routing opt-in, so a migrated row must
           * arrive with `free_only = 1`. A default of 0 would silently let every
           * pre-existing route spend money after an upgrade.
           */
          assert.equal(Number(route.free_only), 1, "a migrated route was allowed to spend by default");
        }
      }

      if (fixture.tables.has("usage_requests")) {
        const usage = db.prepare("SELECT * FROM usage_requests WHERE request_id = ?").get("req-legacy");
        assert.ok(usage !== undefined, "a usage row was dropped by the upgrade");
        assert.equal(Number(usage.latency_ms), 42);
        assert.equal(Number(usage.prompt_tokens), 7);
        const attempts = db.prepare("SELECT COUNT(*) AS n FROM usage_attempts WHERE request_id = ?").get("req-legacy");
        assert.equal(Number(attempts?.n), 1, "a usage attempt row was dropped");
      }

      if (fixture.tables.has("client_identities")) {
        const identity = db.prepare("SELECT * FROM client_identities WHERE id = ?").get("legacy-client");
        assert.ok(identity !== undefined, "the identity row was dropped by the upgrade");
        assert.equal(identity.scopes_json, '["chat.completions"]', "an identity's scopes changed during upgrade");
        assert.equal(Number(identity.revoked), 0);
      }

      if (fixture.tables.has("security_audit")) {
        const audit = db.prepare("SELECT COUNT(*) AS n FROM security_audit").get();
        assert.equal(Number(audit?.n), 1, "a security audit row was dropped");
      }

      // Nothing silently dropped: exactly the rows written are the rows present.
      const secretCount = db.prepare("SELECT COUNT(*) AS n FROM secrets").get();
      assert.equal(Number(secretCount?.n), 1, "the secret count changed during upgrade");

      // And the migration ledger agrees with the version it claims.
      const ledger = db.prepare("SELECT COUNT(*) AS n, MAX(version) AS head FROM schema_migrations").get();
      assert.equal(Number(ledger?.head), TARGET_SCHEMA_VERSION);
      assert.equal(Number(ledger?.n), TARGET_SCHEMA_VERSION, "schema_migrations has a gap after upgrade");

      assert.equal(String(db.prepare("PRAGMA integrity_check").get()?.integrity_check), "ok");
    } finally {
      storage.close();
    }
  });
}

test("a database above head is refused, not downgraded", () => {
  /*
   * **A downgrade must fail closed.** There is no safe way to remove a column that
   * already holds data, so a database written by a newer BAYZ than the binary opening it
   * has to stop rather than be "migrated backwards" — and it must not merely open either,
   * because the newer schema has constraints this build's SQL knows nothing about.
   *
   * The forged state is deliberately **internally consistent**: `user_version` 14 with
   * ledger rows 1..14, so every pre-existing check agrees with it. That is what a real
   * newer build would leave behind, and it is what exposed the gap — see the note on the
   * defect below.
   */
  const fixture = buildAt(TARGET_SCHEMA_VERSION);
  // A normal open first, so the chain metadata is exactly what a real install carries.
  openSecretStorage({ dataDir: fixture.dataDir, env: { BAYZ_MASTER_KEY: KEK_HEX } }).close();

  const db = rawOpen(fixture.dataDir);
  try {
    for (const version of [TARGET_SCHEMA_VERSION + 1, TARGET_SCHEMA_VERSION + 2, TARGET_SCHEMA_VERSION + 3]) {
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, NOW);
    }
    db.exec(`PRAGMA user_version = ${TARGET_SCHEMA_VERSION + 3}`);
  } finally {
    db.close();
  }

  const error = expectStorageError(
    () => openSecretStorage({ dataDir: fixture.dataDir, env: { BAYZ_MASTER_KEY: KEK_HEX } }),
    "an ahead-of-head database",
  );
  assert.equal(error.code, "storage_unavailable");
  // A distinct stage, so an operator who downgraded by accident is told what happened
  // rather than "storage broken".
  assert.equal(error.stage, "verify-schema-ahead-of-head");
});

test("an ahead-of-head database is refused before any migration or domain SQL runs", () => {
  /*
   * **This is the defect the ladder found, and it was a live one.**
   *
   * Nothing refused an ahead-of-head database before 9J Task 6. Measured: a forged
   * `user_version` 14 with a consistent ledger passed `verifyRecordedSchemaVersion`
   * (its head matched), applied **zero** migrations (every version this build knows was
   * already `<= current`), and passed `verifyMigrationChain` — because the chain folds
   * only the migrations this build *has*, so `chain(MIGRATIONS, 14)` and
   * `chain(MIGRATIONS, 11)` are byte-identical. The database opened and reported
   * `schemaVersion: 14`.
   *
   * So `openDatabase` now calls `verifySchemaNotAheadOfHead` before the runner. Asserted
   * at the `openDatabase` layer too, not just through `openSecretStorage`, because that is
   * where the check lives and every caller reaches it.
   */
  const fixture = buildAt(TARGET_SCHEMA_VERSION);
  const db = rawOpen(fixture.dataDir);
  try {
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(TARGET_SCHEMA_VERSION + 1, NOW);
    db.exec(`PRAGMA user_version = ${TARGET_SCHEMA_VERSION + 1}`);
  } finally {
    db.close();
  }

  let caught: unknown;
  try {
    openDatabase({ dataDir: fixture.dataDir });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof StorageError, `openDatabase accepted an ahead-of-head database: ${String(caught)}`);
  assert.equal(caught.stage, "verify-schema-ahead-of-head");

  // One version ahead is enough: the refusal is not a "far in the future" heuristic.
  const atHead = buildAt(TARGET_SCHEMA_VERSION);
  const ok = openDatabase({ dataDir: atHead.dataDir });
  try {
    assert.equal(ok.schemaVersion, TARGET_SCHEMA_VERSION, "a head-version database was refused");
  } finally {
    ok.close();
  }
});

test("a gap in schema_migrations is refused", () => {
  /*
   * `user_version` and the ledger are independent witnesses. A gap means one of them is
   * lying about what ran, and continuing would execute domain SQL against a schema
   * assembled from an unknown subset of migrations.
   *
   * **Also a live defect found here.** `verifyMigrationChain` does check the ledger count,
   * but it returns early when no chain has been recorded — the normal state for a database
   * upgrading from a build that predates the chain, which is exactly the 9J upgrade path.
   * A v11 database with ledger row 3 deleted opened cleanly. The count check now lives in
   * `verifyRecordedSchemaVersion`, before the runner, where no early return can skip it.
   */
  const fixture = buildAt(TARGET_SCHEMA_VERSION);
  const db = rawOpen(fixture.dataDir);
  try {
    db.exec("DELETE FROM schema_migrations WHERE version = 3");
  } finally {
    db.close();
  }

  const error = expectStorageError(
    () => openSecretStorage({ dataDir: fixture.dataDir, env: { BAYZ_MASTER_KEY: KEK_HEX } }),
    "a ledger gap",
  );
  assert.equal(error.code, "storage_unavailable");
  assert.equal(error.stage, "verify-migration-ledger-gap");
});

test("an edited user_version is caught before migrations run", () => {
  // Edited *down*: the runner would otherwise re-apply migrations over an existing
  // schema and fail with an opaque duplicate-table error from `exec`.
  const fixture = buildAt(TARGET_SCHEMA_VERSION);
  const db = rawOpen(fixture.dataDir);
  try {
    db.exec("PRAGMA user_version = 4");
  } finally {
    db.close();
  }

  const error = expectStorageError(
    () => openSecretStorage({ dataDir: fixture.dataDir, env: { BAYZ_MASTER_KEY: KEK_HEX } }),
    "an edited user_version",
  );
  assert.equal(error.code, "storage_unavailable");
  assert.equal(error.stage, "verify-user-version");
});

test("the migration hash chain validates after every upgrade step", () => {
  /*
   * The 9F Task 5 chain covers each migration's version *and* its statements, so it
   * detects a forged ledger row, an edited `user_version`, and altered migration SQL.
   * Recomputed here from the same source and compared against what the upgraded database
   * recorded, at every rung of the ladder.
   */
  for (let version = 1; version <= TARGET_SCHEMA_VERSION; version += 1) {
    const fixture = buildAt(version);
    const storage = openSecretStorage({ dataDir: fixture.dataDir, env: { BAYZ_MASTER_KEY: KEK_HEX } });
    try {
      const recorded = storage.sql
        .prepare("SELECT value FROM runtime_metadata WHERE key = ?")
        .get("migration_chain");
      assert.equal(
        String(recorded?.value),
        migrationChain(MIGRATIONS, TARGET_SCHEMA_VERSION),
        `the chain recorded after upgrading from v${version} is not the head chain`,
      );
    } finally {
      storage.close();
    }
  }
});

test("a tampered migration chain is refused", () => {
  // Non-vacuous companion to the test above: the chain is only worth recording if a
  // mismatch actually stops the open.
  const fixture = buildAt(TARGET_SCHEMA_VERSION);
  const first = openSecretStorage({ dataDir: fixture.dataDir, env: { BAYZ_MASTER_KEY: KEK_HEX } });
  first.close();

  const db = rawOpen(fixture.dataDir);
  try {
    db.prepare("UPDATE runtime_metadata SET value = ? WHERE key = ?").run("0".repeat(64), "migration_chain");
  } finally {
    db.close();
  }

  const error = expectStorageError(
    () => openSecretStorage({ dataDir: fixture.dataDir, env: { BAYZ_MASTER_KEY: KEK_HEX } }),
    "a tampered migration chain",
  );
  assert.equal(error.stage, "verify-migration-chain");
});

test("a mid-migration failure leaves the database at its pre-migration version", () => {
  /*
   * **Atomicity, proven by making a migration fail rather than by reading the code.**
   *
   * A synthetic migration whose second statement is invalid SQL is appended to a
   * truncated list. Each migration runs inside BEGIN IMMEDIATE and sets `user_version` in
   * the same transaction, so the failure must roll back *both* the DDL and the version
   * bump — otherwise an interrupted upgrade would leave a half-applied schema that no
   * retry could repair.
   */
  const dataDir = tempDir();
  const db = rawOpen(dataDir);
  try {
    runMigrations(db, MIGRATIONS.slice(0, 4));
    assert.equal(readSchemaVersion(db), 4);

    const poisoned = [
      ...MIGRATIONS.slice(0, 4),
      {
        version: 5,
        statements: [
          "CREATE TABLE half_applied (id TEXT PRIMARY KEY)",
          "THIS IS NOT VALID SQL",
        ],
      },
    ];

    assert.throws(() => runMigrations(db, poisoned), StorageError);

    // Pre-migration version, and no partial DDL.
    assert.equal(readSchemaVersion(db), 4, "a failed migration advanced user_version");
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'half_applied'")
      .get();
    assert.equal(table, undefined, "a failed migration left its table behind");
    const ledger = db.prepare("SELECT MAX(version) AS head FROM schema_migrations").get();
    assert.equal(Number(ledger?.head), 4, "a failed migration recorded a ledger row");

    // And the retry works, which is the point of atomicity.
    const applied = runMigrations(db, MIGRATIONS.slice(0, 5));
    assert.equal(applied, 1);
    assert.equal(readSchemaVersion(db), 5);
  } finally {
    db.close();
  }
});

test("one unparseable provider config does not stop storage from opening", () => {
  /*
   * **One bad row must not be a bricked install.**
   *
   * A provider row whose `config_json` cannot be parsed — a truncated write, a hand-edit,
   * a future build writing a shape this one rejects — must not prevent BAYZ from starting.
   * The alternative, refusing to open, would take an operator's entire deployment offline
   * over one corrupt field.
   *
   * This asserts the **storage half**: the database opens, migrations complete, secrets
   * still decrypt, and the healthy rows are all readable. The domain half — that the
   * corrupt provider yields `invalid_provider_config` for itself while the rest of the API
   * keeps serving — is asserted in `scripts/upgrade-smoke.mjs`, because `@bayz/providers`
   * depends on `@bayz/storage` and importing it here would be a dependency cycle.
   */
  const fixture = buildAt(TARGET_SCHEMA_VERSION);
  const db = rawOpen(fixture.dataDir);
  try {
    db.prepare(
      `INSERT INTO providers
         (id, kind, display_name, base_url, enabled, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("broken", "openai-compatible", "Broken", "https://broken.example/v1", 1, "{not json", NOW, NOW);
  } finally {
    db.close();
  }

  const storage = openSecretStorage({ dataDir: fixture.dataDir, env: { BAYZ_MASTER_KEY: KEK_HEX } });
  try {
    assert.equal(storage.schemaVersion, TARGET_SCHEMA_VERSION, "a corrupt provider row blocked the upgrade");
    // Credentials are unaffected by a bad provider row.
    assert.equal(storage.get(fixture.secretName), fixture.secretValue);

    // Both rows are present and the healthy one is intact: nothing was dropped in the name
    // of tolerating the corrupt one.
    const rows = storage.sql.prepare("SELECT id, config_json FROM providers ORDER BY id").all();
    assert.deepEqual(rows.map((row) => String(row.id)), ["broken", "legacy"]);
    assert.equal(String(rows.find((row) => row.id === "legacy")?.config_json), "{}");

    // And the corrupt row is deletable, which is the documented repair.
    storage.sql.prepare("DELETE FROM providers WHERE id = ?").run("broken");
    const after = storage.sql.prepare("SELECT COUNT(*) AS n FROM providers").get();
    assert.equal(Number(after?.n), 1, "deleting the corrupt row did not leave the healthy one");
  } finally {
    storage.close();
  }
});

test("the corrupted-config recovery path is documented", () => {
  // The plan requires the recovery to be documented, and a documented procedure that
  // drifts from the behaviour is worse than none — so the doc is asserted alongside the
  // behaviour it describes.
  const guide = readFileSync(fileURLToPath(new URL("../../../docs/install.md", import.meta.url)), "utf8");
  assert.match(guide, /invalid_provider_config/, "docs/install.md does not name the error code");
  assert.match(guide, /DELETE \/api\/providers/, "docs/install.md does not give the repair step");
  assert.match(guide, /still starts/i, "docs/install.md does not state that one bad row is survivable");
});

test("re-opening an already-migrated database applies nothing", () => {
  // Idempotence, which is what makes a restart safe. Asserted through two real opens
  // rather than by calling `runMigrations` twice on a bare connection.
  const fixture = buildAt(1);
  const first = openSecretStorage({ dataDir: fixture.dataDir, env: { BAYZ_MASTER_KEY: KEK_HEX } });
  const appliedFirst = first.appliedMigrations;
  first.close();

  const second = openSecretStorage({ dataDir: fixture.dataDir, env: { BAYZ_MASTER_KEY: KEK_HEX } });
  try {
    assert.equal(appliedFirst, TARGET_SCHEMA_VERSION - 1);
    assert.equal(second.appliedMigrations, 0, "a second open re-applied migrations");
    assert.equal(second.schemaVersion, TARGET_SCHEMA_VERSION);
    assert.equal(second.get(fixture.secretName), fixture.secretValue);
  } finally {
    second.close();
  }
});
