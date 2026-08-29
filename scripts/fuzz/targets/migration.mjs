/**
 * Fuzz target: schema migration state transitions — 9I Task 3.
 *
 * The plan's requirement: a database whose `user_version` is any value 0–255, including beyond
 * the current head, either opens or fails closed, and **never silently downgrades or
 * half-applies** — the schema after the attempt is either the original or the head, never in
 * between.
 *
 * ## What "the boundary" is here, and why the first version had it wrong
 *
 * The first draft called `runMigrations` directly and reported a failure at iteration 48: a
 * head-shaped schema stamped `user_version = 10` had migration 11 re-applied over it, ending at
 * a schema that was neither the original nor the head.
 *
 * That is a real hazard, but it is **not a defect** — because nothing in BAYZ calls
 * `runMigrations` on an unverified database. `openDatabase` calls
 * `verifyRecordedSchemaVersion(db, readSchemaVersion(db))` **first**, and that guard refuses the
 * exact state the fuzzer built: it cross-checks `user_version` against `MAX(version)` in
 * `schema_migrations` and throws `storage_unavailable/verify-user-version` on a mismatch. The
 * source comment says so directly — a `user_version` edited down would re-apply migrations over
 * an existing schema, and one edited up would skip migrations that never ran.
 *
 * So the fuzzer was testing a private half of a two-part boundary and calling the missing half a
 * bug. The target now models the real open sequence, guard included, which turns that finding
 * into a proof the guard is load-bearing: with it, every hostile `user_version` either opens at
 * head or fails closed.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertGlobalStateUnchanged, expectBayzError, globalStateSnapshot } from "./shared.mjs";

const { MIGRATIONS, TARGET_SCHEMA_VERSION, readSchemaVersion, runMigrations } = await import(
  "../../../packages/storage/src/migrations.ts"
);
const { verifyRecordedSchemaVersion } = await import("../../../packages/storage/src/integrity.ts");
const { nodeSqliteDriver } = await import("../../../packages/storage/src/drivers/node-sqlite.ts");

const CODES = new Set(["storage_unavailable", "secret_corrupt", "invalid_argument"]);

const root = mkdtempSync(join(tmpdir(), "bayz-fuzz-migration-"));
let fileCounter = 0;

/** The full schema shape: every table, index, and trigger name plus its SQL. */
function schemaShape(db) {
  const rows = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
  return rows.map((row) => `${row.type}:${row.name}:${row.sql ?? ""}`).join("\n");
}

function openFresh() {
  // In-memory for the fuzz loop; see `diskProof` below for the on-disk path.
  return nodeSqliteDriver.open(":memory:");
}

/** The head schema, as a reference shape. Defined before `diskProof`, which compares against it. */
const HEAD = (() => {
  const db = nodeSqliteDriver.open(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    return { shape: schemaShape(db), version: readSchemaVersion(db) };
  } finally {
    db.close?.();
  }
})();

/**
 * The on-disk path, exercised outside the fuzz loop — and the reason it is outside.
 *
 * The plan's contract is that **no iteration exceeds 250 ms**. On this Termux/proot ARM64 host a
 * file-backed full migration run costs ~370–400 ms against ~2.5 ms in memory, essentially all of
 * it fsync. Running file-backed iterations inside the loop produced budget failures at
 * iterations 0 and 250 — measured, reproducible, and nothing to do with the code under test.
 *
 * Two dishonest ways out were available: raise the budget (which would blind the target to a
 * genuine hang) or drop the on-disk case (which would leave WAL and fsync behaviour unproven).
 * Neither is acceptable, so the on-disk path runs as a bounded, timed pre-check with its cost
 * reported, and the 5,000-iteration loop stays in memory where the 250 ms budget is a real
 * signal about the migration runner rather than about the filesystem.
 *
 * Same driver, same DDL, same transactions in both cases; only the journal target differs.
 */
const diskProof = (() => {
  const observations = [];
  for (const version of [0, 3, 11, 12, 255]) {
    fileCounter += 1;
    const db = nodeSqliteDriver.open(join(root, `disk-${fileCounter}.db`));
    const started = Date.now();
    try {
      db.exec("PRAGMA foreign_keys = ON");
      db.exec("PRAGMA journal_mode = WAL");
      if (version > 0 && version <= MIGRATIONS.length) runMigrations(db, MIGRATIONS.slice(0, version));
      db.exec(`PRAGMA user_version = ${version}`);

      const shapeBefore = schemaShape(db);
      let refused = false;
      try {
        verifyRecordedSchemaVersion(db, readSchemaVersion(db));
        runMigrations(db);
      } catch (error) {
        refused = true;
        expectBayzError(error, CODES, `migration/disk@${version}`);
      }

      const shapeAfter = schemaShape(db);
      if (shapeAfter !== shapeBefore && shapeAfter !== HEAD.shape) {
        throw new Error(`migration/disk@${version}: schema is neither original nor head`);
      }
      const integrity = db.prepare("PRAGMA integrity_check").get();
      const verdict = integrity?.integrity_check ?? Object.values(integrity ?? {})[0];
      if (verdict !== "ok") {
        throw new Error(`migration/disk@${version}: integrity_check returned ${JSON.stringify(verdict)}`);
      }
      observations.push({ version, ms: Date.now() - started, refused });
    } finally {
      db.close?.();
    }
  }
  return observations;
})();

/** Reported by `fuzz-run.mjs` so the on-disk cost is on the record, not hidden. */
export function summary() {
  const parts = diskProof.map((o) => `v${o.version}=${o.ms}ms${o.refused ? "/refused" : "/head"}`);
  return `on-disk migration opens (outside the loop, fsync-bound on this host): ${parts.join(" ")}`;
}

function generate(rng, { iteration }) {
  /*
   * `user_version` sweeps 0–255 as the plan requires, plus values outside that range — a
   * negative or huge version is the "database from the future, or from a corrupt write" case.
   * The sweep is index-driven so every value in 0–255 is actually visited.
   */
  const swept = iteration % 256;
  const version = rng.int(0, 12) === 0 ? rng.pick([-1, 256, 1000, 2 ** 31 - 1]) : swept;

  return {
    version,
    // `populated` decides whether the version is stamped onto a real schema or an empty file.
    // A downgrade attempt on a populated schema is the dangerous case.
    populated: rng.bool(),
    // Stop partway through, which is how a genuinely half-applied database arises.
    subset: rng.int(0, 6) === 0 ? rng.int(1, Math.max(1, MIGRATIONS.length - 1)) : undefined,
  };
}

function run(input, { iteration }) {
  const before = globalStateSnapshot();
  const context = `migration#${iteration}`;
  const db = openFresh();

  try {
    db.exec("PRAGMA foreign_keys = ON");

    if (input.populated) {
      runMigrations(db, input.subset === undefined ? MIGRATIONS : MIGRATIONS.slice(0, input.subset));
    }

    // Stamped directly: what a corrupt write or a rollback to an older binary leaves behind.
    // Guarded as an integer because PRAGMA cannot be parameterised.
    if (Number.isInteger(input.version)) {
      db.exec(`PRAGMA user_version = ${input.version}`);
    }

    const shapeBefore = schemaShape(db);
    const versionBefore = readSchemaVersion(db);

    /*
     * The real open sequence: verify, then migrate. A refusal from the guard is a *pass* — that
     * is fail-closed behaviour, and it must leave the schema untouched.
     */
    let refused = false;
    try {
      verifyRecordedSchemaVersion(db, versionBefore);
      runMigrations(db);
    } catch (error) {
      refused = true;
      expectBayzError(error, CODES, context);
    }

    const shapeAfter = schemaShape(db);
    const versionAfter = readSchemaVersion(db);

    const unchanged = shapeAfter === shapeBefore;
    const atHead = shapeAfter === HEAD.shape;

    if (!unchanged && !atHead) {
      throw new Error(
        `${context}: schema is neither original nor head (user_version ${versionBefore} → ${versionAfter}, ${refused ? "refused" : "opened"})`,
      );
    }
    if (refused && !unchanged) {
      // A guard that refuses must not have changed anything on the way to refusing.
      throw new Error(`${context}: the open was refused but the schema changed anyway`);
    }
    if (!refused && !atHead) {
      // Accepting means the database is usable, which means it is at head.
      throw new Error(`${context}: the open succeeded at a non-head schema (version ${versionAfter})`);
    }
    if (versionAfter < versionBefore) {
      throw new Error(`${context}: user_version went backwards, ${versionBefore} → ${versionAfter}`);
    }
    if (!refused && versionAfter !== TARGET_SCHEMA_VERSION) {
      throw new Error(`${context}: opened at user_version ${versionAfter}, expected head ${TARGET_SCHEMA_VERSION}`);
    }

    const integrity = db.prepare("PRAGMA integrity_check").get();
    const verdict = integrity?.integrity_check ?? Object.values(integrity ?? {})[0];
    if (verdict !== "ok") {
      throw new Error(`${context}: PRAGMA integrity_check returned ${JSON.stringify(verdict)}`);
    }
  } finally {
    db.close?.();
  }

  assertGlobalStateUnchanged(before, context);
}

export const target = {
  name: "migration",
  seed: "9i-migration-1",
  iterations: 5000,
  generate,
  run,
};
