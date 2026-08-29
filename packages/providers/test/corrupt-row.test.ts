import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase, openSecretStorage, type SqlDatabase } from "@bayz/storage";
import { createProviderRepository } from "../src/repository.js";
import { createProviderManager } from "../src/manager.js";
import { ProviderError } from "../src/errors.js";
import type { ProviderRepository } from "../src/repository.js";

/**
 * One unreadable provider row must not brick the install — Phase 9J Task 6.
 *
 * Found by the 9J upgrade ladder, against the installed artifact: a `providers` row with
 * unparseable `config_json` made the daemon **exit at startup**, because
 * `apps/server/src/runtime.ts:219` builds its status counts from `listProviders()`, which maps every
 * row through `rowToRecord` and rethrows. So a single corrupt field — a truncated write, a hand-edit,
 * a future build writing a shape this one rejects — took the whole deployment offline, including
 * every healthy provider and every stored credential.
 *
 * The contract these tests pin:
 *   - the corrupt row yields `invalid_provider_config` **for itself** (`requireProvider`),
 *   - listing does not throw, so startup and the dashboard survive,
 *   - listing does not *hide* it either: the ids of unreadable rows are reported, because an
 *     operator cannot repair a provider they cannot see,
 *   - and the row remains deletable, which is the documented repair.
 */

const NOW = "2026-01-01T00:00:00.000Z";
/** A fixed KEK, so the manager case gets a real secret store without a keyring. */
const KEK_HEX = Buffer.alloc(32, 0x5a).toString("hex");

function seed(): { db: SqlDatabase; repository: ProviderRepository; close(): void } {
  const dir = join(mkdtempSync(join(tmpdir(), "bayz-corrupt-row-")), ".bayz");
  const database = openDatabase({ dataDir: dir });
  const repository = createProviderRepository(database.db, { now: () => NOW });
  repository.create({
    id: "healthy",
    kind: "openai-compatible",
    displayName: "Healthy",
    baseUrl: "https://healthy.example/v1",
  });
  return { db: database.db, repository, close: () => database.close() };
}

/** Write a row the repository itself would never produce, as a corrupt install would hold. */
function insertCorruptRow(db: SqlDatabase, id = "broken", configJson = "{not json"): void {
  db.prepare(
    `INSERT INTO providers
       (id, kind, display_name, base_url, enabled, config_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, "openai-compatible", "Broken", "https://broken.example/v1", 1, configJson, NOW, NOW);
}

test("listing providers survives one unreadable config row", () => {
  const context = seed();
  try {
    insertCorruptRow(context.db);

    // The load-bearing assertion: this threw before 9J Task 6, and the throw reached the server's
    // startup path.
    const listed = context.repository.list();
    assert.deepEqual(
      listed.map((record) => record.id),
      ["healthy"],
      "a healthy provider was lost because another row was corrupt",
    );
  } finally {
    context.close();
  }
});

test("an unreadable row is reported rather than silently dropped", () => {
  const context = seed();
  try {
    insertCorruptRow(context.db);

    /*
     * Skipping quietly would be worse than throwing: the operator would see a provider vanish from
     * the dashboard with nothing to act on, and a credential would sit encrypted in the database
     * attached to a row nothing admits exists.
     */
    assert.deepEqual(context.repository.listUnreadable(), ["broken"]);
  } finally {
    context.close();
  }
});

test("the unreadable row still names its own failure", () => {
  const context = seed();
  try {
    insertCorruptRow(context.db);

    // `assert.throws` returns `undefined`, so the error has to be caught by hand to read `.code`.
    let caught: unknown;
    try {
      context.repository.require("broken");
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof ProviderError, `threw ${String(caught)}`);
    assert.equal(caught.code, "invalid_provider_config");
  } finally {
    context.close();
  }
});

test("a config that parses but fails validation is treated the same way", () => {
  // JSON.parse succeeding is not the same as the config being usable; both paths throw
  // `load-config` in `rowToRecord`, so both must be tolerated by `list`.
  const context = seed();
  try {
    insertCorruptRow(context.db, "invalid-shape", JSON.stringify({ timeoutMs: -5, unknownKey: true }));

    assert.deepEqual(
      context.repository.list().map((record) => record.id),
      ["healthy"],
    );
    assert.deepEqual(context.repository.listUnreadable(), ["invalid-shape"]);
  } finally {
    context.close();
  }
});

test("the unreadable row can be deleted, which is the documented repair", () => {
  const context = seed();
  try {
    insertCorruptRow(context.db);

    assert.equal(context.repository.delete("broken"), true);
    assert.deepEqual(context.repository.listUnreadable(), []);
    assert.deepEqual(
      context.repository.list().map((record) => record.id),
      ["healthy"],
    );
  } finally {
    context.close();
  }
});

test("the manager surfaces unreadable rows without throwing", () => {
  /*
   * The manager builds its own repository from the storage handle, so this case needs a real
   * `openSecretStorage` rather than the bare database the repository tests use. That is the point:
   * `runtime.describe()` calls `listProviders()` on the *manager*, so the manager is the layer whose
   * tolerance keeps startup alive.
   */
  const dir = join(mkdtempSync(join(tmpdir(), "bayz-corrupt-mgr-")), ".bayz");
  const storage = openSecretStorage({ dataDir: dir, env: { BAYZ_MASTER_KEY: KEK_HEX } });
  try {
    const manager = createProviderManager({ storage, now: () => NOW });
    manager.createProvider({
      id: "healthy",
      kind: "openai-compatible",
      displayName: "Healthy",
      baseUrl: "https://healthy.example/v1",
    });
    insertCorruptRow(storage.sql);

    assert.deepEqual(
      manager.listProviders().map((view) => view.id),
      ["healthy"],
    );
    assert.deepEqual(manager.listUnreadableProviders(), ["broken"]);
  } finally {
    storage.close();
  }
});

test("the manager can delete an unreadable row, which is the documented repair", () => {
  /*
   * The API's `DELETE /api/providers/:id` goes through the manager, and the manager checked
   * existence with `repository.get`, which decodes the row — so deleting a corrupt provider failed
   * with `invalid_provider_config` (measured: HTTP 400 from the installed artifact). The documented
   * repair did not work on the only rows that ever need it.
   */
  const dir = join(mkdtempSync(join(tmpdir(), "bayz-corrupt-del-")), ".bayz");
  const storage = openSecretStorage({ dataDir: dir, env: { BAYZ_MASTER_KEY: KEK_HEX } });
  try {
    const manager = createProviderManager({ storage, now: () => NOW });
    manager.createProvider({
      id: "healthy",
      kind: "openai-compatible",
      displayName: "Healthy",
      baseUrl: "https://healthy.example/v1",
    });
    insertCorruptRow(storage.sql);

    assert.equal(manager.deleteProvider("broken"), true);
    assert.deepEqual(manager.listUnreadableProviders(), []);
    assert.deepEqual(
      manager.listProviders().map((view) => view.id),
      ["healthy"],
    );

    // An id that never existed still reports false, so tolerance did not become "always true".
    assert.equal(manager.deleteProvider("never-existed"), false);
  } finally {
    storage.close();
  }
});
