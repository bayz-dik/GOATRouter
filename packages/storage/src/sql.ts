/**
 * Minimal synchronous SQL surface used by Bayz storage.
 *
 * Migrations, the repository, and crypto depend only on these interfaces so the
 * concrete driver can be swapped later (a `better-sqlite3 -> node:sqlite ->
 * sql.js` fallback chain is planned) without changing the repository or domain
 * API. Exactly one file in this package may import a concrete driver.
 */

/**
 * Value types every candidate driver can bind and return.
 *
 * `boolean` is deliberately absent: `node:sqlite` rejects boolean bindings, so
 * including it here would create a contract the first adapter cannot honor.
 * Callers store 0 / 1 integers instead.
 */
export type SqlValue = null | number | bigint | string | Uint8Array;
export type SqlParam = SqlValue;

export type SqlRow = Record<string, SqlValue>;

export type SqlRunResult = {
  changes: number;
  lastInsertRowid: number | bigint;
};

export interface SqlStatement {
  run(...params: SqlParam[]): SqlRunResult;
  get(...params: SqlParam[]): SqlRow | undefined;
  all(...params: SqlParam[]): SqlRow[];
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
  close(): void;
}

export interface SqlDriver {
  readonly name: string;
  open(filename: string): SqlDatabase;
}
