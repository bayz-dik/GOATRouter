import { DatabaseSync } from "node:sqlite";
import { asStorageError } from "../errors.js";
import type {
  SqlDatabase,
  SqlDriver,
  SqlParam,
  SqlRow,
  SqlRunResult,
  SqlStatement,
} from "../sql.js";

/**
 * The only file in this package permitted to import a concrete SQL driver.
 * Every throw is translated at this edge so `ERR_SQLITE_ERROR` text — which
 * embeds absolute filesystem paths — never propagates to callers.
 */

function wrapStatement(statement: {
  run(...params: SqlParam[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlParam[]): unknown;
  all(...params: SqlParam[]): unknown[];
}): SqlStatement {
  return {
    run(...params: SqlParam[]): SqlRunResult {
      try {
        const result = statement.run(...params);
        return {
          changes: Number(result.changes),
          lastInsertRowid: result.lastInsertRowid,
        };
      } catch (error) {
        throw asStorageError("storage_unavailable", "statement-run", error);
      }
    },
    get(...params: SqlParam[]): SqlRow | undefined {
      try {
        return (statement.get(...params) as SqlRow | undefined) ?? undefined;
      } catch (error) {
        throw asStorageError("storage_unavailable", "statement-get", error);
      }
    },
    all(...params: SqlParam[]): SqlRow[] {
      try {
        return statement.all(...params) as SqlRow[];
      } catch (error) {
        throw asStorageError("storage_unavailable", "statement-all", error);
      }
    },
  };
}

function wrapDatabase(db: DatabaseSync): SqlDatabase {
  return {
    prepare(sql: string): SqlStatement {
      try {
        return wrapStatement(db.prepare(sql) as never);
      } catch (error) {
        throw asStorageError("storage_unavailable", "prepare", error);
      }
    },
    exec(sql: string): void {
      try {
        db.exec(sql);
      } catch (error) {
        throw asStorageError("storage_unavailable", "exec", error);
      }
    },
    close(): void {
      try {
        db.close();
      } catch (error) {
        throw asStorageError("storage_unavailable", "close", error);
      }
    },
  };
}

export const nodeSqliteDriver: SqlDriver = {
  name: "node:sqlite",
  open(filename: string): SqlDatabase {
    try {
      return wrapDatabase(new DatabaseSync(filename));
    } catch (error) {
      throw asStorageError("storage_unavailable", "open-database", error);
    }
  },
};

/**
 * Single seam for a future driver fallback chain. A later release may try
 * `better-sqlite3`, then `node:sqlite`, then `sql.js` here without any change to
 * migrations, the repository, or the domain API. Neither alternative is
 * implemented or depended on today.
 */
export function selectDriver(): SqlDriver {
  return nodeSqliteDriver;
}
