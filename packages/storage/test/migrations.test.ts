import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MIGRATIONS,
  StorageError,
  TARGET_SCHEMA_VERSION,
  readSchemaVersion,
  runMigrations,
  selectDriver,
  type SqlDatabase,
} from "../src/index.js";

function freshDb(): SqlDatabase {
  const dir = mkdtempSync(join(tmpdir(), "bayz-migrate-"));
  const db = selectDriver().open(join(dir, "bayz.db"));
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function tableNames(db: SqlDatabase): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(row.name))
    .filter((name) => !name.startsWith("sqlite_"));
}

test("migrations are ordered, start at 1, and increase strictly", () => {
  assert.ok(MIGRATIONS.length > 0);
  MIGRATIONS.forEach((migration, index) => {
    assert.equal(migration.version, index + 1, "versions must be 1..n with no gaps");
    assert.ok(migration.statements.length > 0);
  });
  assert.equal(TARGET_SCHEMA_VERSION, MIGRATIONS.length);
});

test("a fresh database migrates to the target version", () => {
  const db = freshDb();
  try {
    assert.equal(readSchemaVersion(db), 0);
    const applied = runMigrations(db);
    assert.equal(applied, MIGRATIONS.length);
    assert.equal(readSchemaVersion(db), TARGET_SCHEMA_VERSION);
  } finally {
    db.close();
  }
});

test("a fresh database gains exactly the tables of the current schema", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    assert.deepEqual(tableNames(db), [
      "client_identities",
      "identity_audit",
      "providers",
      "proxies",
      "routes",
      "runtime_metadata",
      "schema_migrations",
      "secrets",
      "usage_attempts",
      "usage_requests",
    ]);
  } finally {
    db.close();
  }
});

test("running migrations twice applies zero and changes nothing", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    const before = tableNames(db);
    const version = readSchemaVersion(db);
    const rows = db.prepare("SELECT version FROM schema_migrations").all().length;

    assert.equal(runMigrations(db), 0, "second run must apply no migrations");
    assert.equal(readSchemaVersion(db), version);
    assert.deepEqual(tableNames(db), before);
    assert.equal(
      db.prepare("SELECT version FROM schema_migrations").all().length,
      rows,
      "no duplicate audit rows",
    );
  } finally {
    db.close();
  }
});

test("running migrations a third time is still a no-op", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    runMigrations(db);
    assert.equal(runMigrations(db), 0);
    assert.equal(readSchemaVersion(db), TARGET_SCHEMA_VERSION);
  } finally {
    db.close();
  }
});

test("user_version agrees with the schema_migrations audit table", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    const maxAudited = Number(
      db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()?.v,
    );
    assert.equal(readSchemaVersion(db), maxAudited);
    assert.equal(maxAudited, TARGET_SCHEMA_VERSION);

    const applied = db
      .prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version")
      .all();
    assert.equal(applied.length, MIGRATIONS.length);
    for (const row of applied) {
      assert.match(String(row.applied_at), /^\d{4}-\d{2}-\d{2}T/);
    }
  } finally {
    db.close();
  }
});

test("secrets.name is unique", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    const insert = db.prepare(
      `INSERT INTO secrets
         (name, version, algorithm, kdf, key_id, wrapped_dek, wrap_iv, wrap_tag,
          ciphertext, iv, tag, created_at, updated_at)
       VALUES (?, 1, 'aes-256-gcm', 'none', 'kek_x', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const bytes = new Uint8Array([1, 2, 3]);
    const now = new Date().toISOString();
    insert.run("dup", bytes, bytes, bytes, bytes, bytes, bytes, now, now);

    assert.throws(
      () => insert.run("dup", bytes, bytes, bytes, bytes, bytes, bytes, now, now),
      (error: unknown) =>
        error instanceof StorageError && error.code === "storage_unavailable",
    );
  } finally {
    db.close();
  }
});

test("a failing migration is atomic and leaves the version untouched", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    const versionBefore = readSchemaVersion(db);
    const tablesBefore = tableNames(db);

    assert.throws(
      () =>
        runMigrations(db, [
          ...MIGRATIONS,
          {
            version: TARGET_SCHEMA_VERSION + 1,
            statements: [
              "CREATE TABLE partial_side_effect (id INTEGER PRIMARY KEY)",
              "THIS IS NOT VALID SQL",
            ],
          },
        ]),
      (error: unknown) =>
        error instanceof StorageError && error.code === "storage_unavailable",
    );

    assert.equal(readSchemaVersion(db), versionBefore, "version must not advance");
    assert.deepEqual(
      tableNames(db),
      tablesBefore,
      "the rolled-back migration must leave no table behind",
    );
    assert.equal(
      db
        .prepare("SELECT version FROM schema_migrations WHERE version = ?")
        .get(TARGET_SCHEMA_VERSION + 1),
      undefined,
      "no audit row for a failed migration",
    );
  } finally {
    db.close();
  }
});

test("the usage tables store metadata only and cannot hold content", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    for (const table of ["usage_requests", "usage_attempts"]) {
      const columns = db
        .prepare(`SELECT name FROM pragma_table_info('${table}')`)
        .all()
        .map((row) => String(row.name).toLowerCase());
      assert.ok(columns.length > 0, `${table} must exist`);
      // A column able to hold content would make the metadata-only guarantee
      // unenforceable at the schema level.
      for (const forbidden of [
        "prompt",
        "completion",
        "content",
        "message",
        "messages",
        "body",
        "request_body",
        "response_body",
        "system_prompt",
        "tool_arguments",
        "authorization",
        "credential",
        "api_key",
        "password",
        "token",
        "secret",
        "cookie",
        "error_body",
        "error_message",
      ]) {
        assert.equal(
          columns.includes(forbidden),
          false,
          `${table} must not have a ${forbidden} column`,
        );
      }
    }
  } finally {
    db.close();
  }
});

test("usage_requests pins its exact metadata column set", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('usage_requests')")
      .all()
      .map((row) => String(row.name))
      .sort();
    assert.deepEqual(columns, [
      "attempts",
      "cached_tokens",
      "completion_tokens",
      "failure_category",
      "latency_ms",
      "model",
      "occurred_at",
      "outcome",
      "prompt_tokens",
      "provider_id",
      "proxy_id",
      "request_id",
      "route_id",
      "routing_mode",
    ]);
  } finally {
    db.close();
  }
});

test("usage rows constrain outcome, routing mode, and non-negative numbers", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    const insert = db.prepare(
      `INSERT INTO usage_requests
         (request_id, occurred_at, route_id, provider_id, proxy_id, model, routing_mode,
          outcome, failure_category, latency_ms, attempts, prompt_tokens,
          completion_tokens, cached_tokens)
       VALUES (?, '2026-08-26T00:00:00.000Z', 'r1', 'p1', NULL, 'gpt-4o', ?, ?, NULL, ?, 1,
               NULL, NULL, NULL)`,
    );
    insert.run("ok-1", "combo", "ok", 10);

    assert.throws(
      () => insert.run("bad-mode", "sideways", "ok", 10),
      (error: unknown) =>
        error instanceof StorageError && error.code === "storage_unavailable",
    );
    assert.throws(
      () => insert.run("bad-outcome", "combo", "maybe", 10),
      (error: unknown) =>
        error instanceof StorageError && error.code === "storage_unavailable",
    );
    assert.throws(
      () => insert.run("bad-latency", "combo", "ok", -1),
      (error: unknown) =>
        error instanceof StorageError && error.code === "storage_unavailable",
    );
    assert.throws(
      () => insert.run("ok-1", "combo", "ok", 10),
      (error: unknown) =>
        error instanceof StorageError && error.code === "storage_unavailable",
      "request ids must be unique",
    );
  } finally {
    db.close();
  }
});

test("no speculative combo schema exists", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    const names = tableNames(db);
    // `providers` (v2), `proxies` (v3), `routes` (v4), and the usage tables (v5)
    // are intentionally absent from this list: Phases 3-8 own them. Everything
    // below still belongs to a later phase, or would be a content store, so
    // creating it now would be speculative or unsafe.
    for (const forbidden of [
      "provider",
      "proxy",
      "route",
      "routing",
      "combos",
      "combo",
      "usage",
      "requests",
      "prompts",
      "completions",
      "messages",
      "logs",
      "clients",
    ]) {
      assert.equal(
        names.includes(forbidden),
        false,
        `the current schema must not create a ${forbidden} table`,
      );
    }
  } finally {
    db.close();
  }
});

test("the routes table binds a model to a provider and stores no prompt", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('routes')")
      .all()
      .map((row) => String(row.name))
      .sort();

    assert.deepEqual(columns, [
      "config_json",
      "created_at",
      "enabled",
      "id",
      "model",
      "priority",
      "provider_id",
      "proxy_id",
      "updated_at",
    ]);
    // Prompts and completions are never persisted; a column able to hold one
    // would make that guarantee unenforceable.
    for (const forbidden of [
      "prompt",
      "messages",
      "content",
      "body",
      "completion",
      "response",
      "api_key",
      "credential",
      "password",
    ]) {
      assert.equal(
        columns.includes(forbidden),
        false,
        `routes must never store ${forbidden}`,
      );
    }
  } finally {
    db.close();
  }
});

test("a route cannot reference a provider that does not exist", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO routes
               (id, model, provider_id, proxy_id, priority, enabled, config_json,
                created_at, updated_at)
             VALUES ('r1', 'gpt-4o', 'ghost', NULL, 100, 1, '{}',
                     '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z')`,
          )
          .run(),
      (error: unknown) =>
        error instanceof StorageError && error.code === "storage_unavailable",
      "the foreign key must be enforced, not advisory",
    );
  } finally {
    db.close();
  }
});

test("deleting a provider cascades its routes and deleting a proxy nulls the binding", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    db.prepare(
      `INSERT INTO providers
         (id, kind, display_name, base_url, enabled, config_json, created_at, updated_at)
       VALUES ('p1', 'openai-compatible', 'P1', 'https://example.com', 1, '{}',
               '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO proxies
         (id, kind, host, port, username, enabled, config_json, created_at, updated_at)
       VALUES ('x1', 'socks5', '127.0.0.1', 1080, NULL, 1, '{}',
               '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO routes
         (id, model, provider_id, proxy_id, priority, enabled, config_json,
          created_at, updated_at)
       VALUES ('r1', 'gpt-4o', 'p1', 'x1', 100, 1, '{}',
               '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z')`,
    ).run();

    // Removing a proxy must degrade the route to direct, not break it.
    db.prepare("DELETE FROM proxies WHERE id = 'x1'").run();
    assert.equal(
      db.prepare("SELECT proxy_id FROM routes WHERE id = 'r1'").get()?.proxy_id,
      null,
    );

    // Removing a provider must take its routes with it, leaving none dangling.
    db.prepare("DELETE FROM providers WHERE id = 'p1'").run();
    assert.equal(
      Number(db.prepare("SELECT COUNT(*) AS n FROM routes").get()?.n),
      0,
    );
  } finally {
    db.close();
  }
});

test("routes constrain priority, the enabled flag, and the model/provider pair", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    db.prepare(
      `INSERT INTO providers
         (id, kind, display_name, base_url, enabled, config_json, created_at, updated_at)
       VALUES ('p1', 'openai-compatible', 'P1', 'https://example.com', 1, '{}',
               '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z')`,
    ).run();
    const insert = db.prepare(
      `INSERT INTO routes
         (id, model, provider_id, proxy_id, priority, enabled, config_json,
          created_at, updated_at)
       VALUES (?, ?, 'p1', NULL, ?, ?, '{}', '2026-08-26T00:00:00.000Z',
               '2026-08-26T00:00:00.000Z')`,
    );

    insert.run("ok-low", "gpt-4o", 0, 1);
    insert.run("ok-high", "gpt-4o-mini", 1000, 0);

    for (const priority of [-1, 1001]) {
      assert.throws(
        () => insert.run(`bad-priority-${priority}`, "m", priority, 1),
        (error: unknown) =>
          error instanceof StorageError && error.code === "storage_unavailable",
        `priority ${priority} must be refused`,
      );
    }
    assert.throws(
      () => insert.run("bad-enabled", "m2", 100, 2),
      (error: unknown) =>
        error instanceof StorageError && error.code === "storage_unavailable",
    );
    assert.throws(
      () => insert.run("dup-pair", "gpt-4o", 100, 1),
      (error: unknown) =>
        error instanceof StorageError && error.code === "storage_unavailable",
      "the same model must not be bound twice to one provider",
    );
  } finally {
    db.close();
  }
});

test("the proxies table holds endpoint metadata and no password", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('proxies')")
      .all()
      .map((row) => String(row.name))
      .sort();

    assert.deepEqual(columns, [
      "config_json",
      "created_at",
      "enabled",
      "host",
      "id",
      "kind",
      "port",
      "updated_at",
      "username",
    ]);
    // A password column here would bypass envelope encryption entirely. The
    // username is not a secret: SOCKS5 sends it before any credential exchange.
    for (const forbidden of [
      "password",
      "passwd",
      "secret",
      "token",
      "credential",
      "authorization",
      "api_key",
    ]) {
      assert.equal(
        columns.includes(forbidden),
        false,
        `proxies must never store ${forbidden}`,
      );
    }
  } finally {
    db.close();
  }
});

test("proxies constrain the kind, the port range, and the enabled flag", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    const insert = db.prepare(
      `INSERT INTO proxies
         (id, kind, host, port, username, enabled, config_json, created_at, updated_at)
       VALUES (?, ?, '127.0.0.1', ?, NULL, ?, '{}', '2026-08-26T00:00:00.000Z',
               '2026-08-26T00:00:00.000Z')`,
    );
    insert.run("ok-socks5", "socks5", 1080, 1);
    insert.run("ok-http", "http", 8080, 0);

    assert.throws(
      () => insert.run("bad-kind", "socks4", 1080, 1),
      (error: unknown) =>
        error instanceof StorageError && error.code === "storage_unavailable",
    );
    for (const port of [0, 65536, -1]) {
      assert.throws(
        () => insert.run(`bad-port-${port}`, "socks5", port, 1),
        (error: unknown) =>
          error instanceof StorageError && error.code === "storage_unavailable",
        `port ${port} must be refused`,
      );
    }
    assert.throws(
      () => insert.run("bad-enabled", "socks5", 1080, 2),
      (error: unknown) =>
        error instanceof StorageError && error.code === "storage_unavailable",
    );
    assert.throws(
      () => insert.run("ok-http", "http", 8080, 0),
      (error: unknown) =>
        error instanceof StorageError && error.code === "storage_unavailable",
      "proxy ids must be unique",
    );
  } finally {
    db.close();
  }
});

test("the providers table holds registry metadata and no credential", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('providers')")
      .all()
      .map((row) => String(row.name))
      .sort();

    assert.deepEqual(columns, [
      "base_url",
      "config_json",
      "created_at",
      "display_name",
      "enabled",
      "id",
      "kind",
      "updated_at",
    ]);
    // A credential column here would bypass envelope encryption entirely.
    for (const forbidden of [
      "api_key",
      "apikey",
      "credential",
      "key",
      "password",
      "secret",
      "token",
      "authorization",
      "headers",
    ]) {
      assert.equal(
        columns.includes(forbidden),
        false,
        `providers must never store ${forbidden}`,
      );
    }
  } finally {
    db.close();
  }
});

test("providers.kind is constrained to the supported kinds", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    const insert = db.prepare(
      `INSERT INTO providers
         (id, kind, display_name, base_url, enabled, config_json, created_at, updated_at)
       VALUES (?, ?, 'Display', 'https://example.com', 1, '{}', '2026-08-26T00:00:00.000Z',
               '2026-08-26T00:00:00.000Z')`,
    );
    for (const kind of [
      "openai-compatible",
      "openrouter",
      "gemini",
      "codex-oauth",
    ]) {
      insert.run(`ok-${kind}`, kind);
    }
    assert.throws(
      () => insert.run("bad-kind", "anthropic-secret-backdoor"),
      (error: unknown) =>
        error instanceof StorageError && error.code === "storage_unavailable",
    );
  } finally {
    db.close();
  }
});

test("providers.enabled is constrained to 0 or 1 and the id is the primary key", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    const insert = db.prepare(
      `INSERT INTO providers
         (id, kind, display_name, base_url, enabled, config_json, created_at, updated_at)
       VALUES (?, 'gemini', 'Display', 'https://example.com', ?, '{}',
               '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z')`,
    );
    insert.run("enabled-zero", 0);
    insert.run("enabled-one", 1);
    assert.throws(
      () => insert.run("enabled-two", 2),
      (error: unknown) =>
        error instanceof StorageError && error.code === "storage_unavailable",
    );
    assert.throws(
      () => insert.run("enabled-one", 1),
      (error: unknown) =>
        error instanceof StorageError && error.code === "storage_unavailable",
      "provider ids must be unique",
    );
  } finally {
    db.close();
  }
});

test("the secrets table stores only an encrypted envelope and metadata", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('secrets')")
      .all()
      .map((row) => String(row.name))
      .sort();

    assert.deepEqual(columns, [
      "algorithm",
      "ciphertext",
      "created_at",
      "id",
      "iv",
      "kdf",
      "key_id",
      "name",
      "tag",
      "updated_at",
      "version",
      "wrap_iv",
      "wrap_tag",
      "wrapped_dek",
    ]);
    // No column may exist that could hold a plaintext secret or a bare DEK.
    for (const forbidden of ["plaintext", "value", "secret", "dek", "password"]) {
      assert.equal(columns.includes(forbidden), false);
    }
  } finally {
    db.close();
  }
});

test("readSchemaVersion rejects a non-integer target", () => {
  const db = freshDb();
  try {
    assert.throws(
      () => runMigrations(db, [{ version: 1.5, statements: ["SELECT 1"] }]),
      (error: unknown) =>
        error instanceof StorageError && error.code === "storage_unavailable",
    );
  } finally {
    db.close();
  }
});

test("migration v6 adds the client identity tables", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    const tables = tableNames(db);
    assert.ok(tables.includes("client_identities"), "client_identities must exist");
    assert.ok(tables.includes("identity_audit"), "identity_audit must exist");
  } finally {
    db.close();
  }
});

test("client_identities has its exact column set and holds no secret", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('client_identities')")
      .all()
      .map((row) => String(row.name));
    assert.deepEqual(columns, [
      "id",
      "display_name",
      "scopes_json",
      "preset",
      "revoked",
      "expires_at",
      "created_at",
      "updated_at",
      "last_used_at",
    ]);
    // The key lives in the envelope-encrypted `secrets` table under
    // `client:<id>:key`, never here. A column able to hold it — even a hash —
    // would put credential material in a table with no encryption.
    for (const forbidden of ["key", "secret", "token", "hash", "credential", "password"]) {
      assert.ok(
        !columns.some((column) => column.toLowerCase().includes(forbidden)),
        `client_identities must not have a ${forbidden} column`,
      );
    }
  } finally {
    db.close();
  }
});

test("identity_audit is metadata only and cannot hold content", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('identity_audit')")
      .all()
      .map((row) => String(row.name));
    assert.deepEqual(columns, [
      "id",
      "occurred_at",
      "identity_id",
      "action",
      "scope",
      "route",
      "outcome",
    ]);
    for (const forbidden of [
      "key",
      "secret",
      "token",
      "credential",
      "password",
      "body",
      "message",
      "prompt",
      "content",
      "detail",
      "error",
    ]) {
      assert.ok(
        !columns.some((column) => column.toLowerCase().includes(forbidden)),
        `identity_audit must not have a ${forbidden} column`,
      );
    }
  } finally {
    db.close();
  }
});

test("the identity audit outcome and action are enum-constrained", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    db.prepare(
      `INSERT INTO client_identities
         (id, display_name, scopes_json, preset, revoked, expires_at, created_at, updated_at, last_used_at)
       VALUES ('c1', 'Client', '["chat.completions"]', NULL, 0, NULL, 't', 't', NULL)`,
    ).run();

    const insertAudit = (action: string, outcome: string): void => {
      db.prepare(
        `INSERT INTO identity_audit (occurred_at, identity_id, action, scope, route, outcome)
         VALUES ('t', 'c1', ?, NULL, NULL, ?)`,
      ).run(action, outcome);
    };
    insertAudit("authenticated", "allowed");

    // A free-text action or outcome is how arbitrary error prose gets smuggled into
    // a table that is supposed to be metadata only.
    assert.throws(() => insertAudit("arbitrary text", "allowed"));
    assert.throws(() => insertAudit("authenticated", "sk-leaked-credential"));
  } finally {
    db.close();
  }
});

test("deleting an identity cascades its audit rows away", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    db.prepare(
      `INSERT INTO client_identities
         (id, display_name, scopes_json, preset, revoked, expires_at, created_at, updated_at, last_used_at)
       VALUES ('c1', 'Client', '["chat.completions"]', NULL, 0, NULL, 't', 't', NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO identity_audit (occurred_at, identity_id, action, scope, route, outcome)
       VALUES ('t', 'c1', 'authenticated', NULL, NULL, 'allowed')`,
    ).run();

    db.prepare("DELETE FROM client_identities WHERE id = 'c1'").run();
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM identity_audit").get()?.n,
      0,
      "an orphaned audit row would outlive the identity it describes",
    );
  } finally {
    db.close();
  }
});

test("the revoked flag is boolean-constrained", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO client_identities
             (id, display_name, scopes_json, preset, revoked, expires_at, created_at, updated_at, last_used_at)
           VALUES ('c2', 'Client', '[]', NULL, 2, NULL, 't', 't', NULL)`,
        )
        .run(),
    );
  } finally {
    db.close();
  }
});

test("migration v7 accepts the custom-openai kind", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    db.prepare(
      `INSERT INTO providers
         (id, kind, display_name, base_url, enabled, config_json, created_at, updated_at)
       VALUES ('relay', 'custom-openai', 'Relay', 'https://relay.example.com', 1, '{}', 't', 't')`,
    ).run();
    assert.equal(
      db.prepare("SELECT kind FROM providers WHERE id = 'relay'").get()?.kind,
      "custom-openai",
    );
  } finally {
    db.close();
  }
});

test("migration v7 still refuses an unknown kind", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO providers
             (id, kind, display_name, base_url, enabled, config_json, created_at, updated_at)
           VALUES ('bad', 'anthropic', 'Bad', 'https://x.example.com', 1, '{}', 't', 't')`,
        )
        .run(),
    );
  } finally {
    db.close();
  }
});

test("migration v7 preserves existing provider rows and their routes", () => {
  const db = freshDb();
  try {
    // Migrate only to v6, populate, then finish. This is the real upgrade path: the
    // table rebuild must carry every row and leave the dependent foreign key working.
    runMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version <= 6),
    );
    db.prepare(
      `INSERT INTO providers
         (id, kind, display_name, base_url, enabled, config_json, created_at, updated_at)
       VALUES ('legacy', 'openai-compatible', 'Legacy', 'http://127.0.0.1:8080', 1,
               '{"timeoutMs":30000}', 'created', 'updated')`,
    ).run();
    db.prepare(
      `INSERT INTO routes
         (id, model, provider_id, proxy_id, priority, enabled, config_json, created_at, updated_at)
       VALUES ('r1', 'gpt-4o', 'legacy', NULL, 100, 1, '{}', 't', 't')`,
    ).run();

    assert.equal(runMigrations(db), 1);

    const provider = db.prepare("SELECT * FROM providers WHERE id = 'legacy'").get();
    assert.equal(provider?.display_name, "Legacy");
    assert.equal(provider?.base_url, "http://127.0.0.1:8080");
    assert.equal(provider?.config_json, '{"timeoutMs":30000}');
    assert.equal(provider?.created_at, "created");
    assert.equal(provider?.updated_at, "updated");
    assert.equal(
      db.prepare("SELECT provider_id FROM routes WHERE id = 'r1'").get()?.provider_id,
      "legacy",
    );

    // The rebuilt table must still be the one the foreign key points at: deleting the
    // provider has to cascade its route away, exactly as before the rebuild.
    db.exec("PRAGMA foreign_keys = ON");
    db.prepare("DELETE FROM providers WHERE id = 'legacy'").run();
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM routes").get()?.n,
      0,
      "the route cascade must survive the table rebuild",
    );
  } finally {
    db.close();
  }
});

test("migration v7 leaves no temporary table behind", () => {
  const db = freshDb();
  try {
    runMigrations(db);
    assert.ok(!tableNames(db).includes("providers_v7"));
    assert.ok(tableNames(db).includes("providers"));
  } finally {
    db.close();
  }
});
