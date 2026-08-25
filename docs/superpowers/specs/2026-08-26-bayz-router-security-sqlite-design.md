# Bayz Router — Security and SQLite Storage Design

**Status:** Design / Phase 2 of the approved scope decomposition.
**Phase 1:** `docs/superpowers/plans/2026-08-26-bayz-router-foundation.md` — complete and verified.
**Date:** 2026-08-26

## 1. Purpose

Phase 1 produced a runnable Core with a health endpoint, request tracing, safe
error envelopes, and a dashboard served from one process. It has no persistence
and no way to hold a secret.

Phase 2 adds exactly two things:

1. A local SQLite storage layer with versioned, idempotent migrations.
2. An encrypted-at-rest secret primitive so that Phase 3 can store provider
   credentials without ever writing them as plaintext.

Phase 2 deliberately ships **no** Provider Manager, **no** Proxy Manager, **no**
routing, **no** combos, **no** usage data, and **no** dashboard changes. It
creates the storage boundary those phases will consume.

## 2. Non-goals

- No ORM, no query builder, no migration framework dependency.
- No provider/proxy/route/combo tables, and no seed or demo rows.
- No new API routes and no dashboard UI work.
- No multi-user auth, no key rotation implementation (the envelope is designed
  to *permit* later rotation, which is not the same as implementing it).
- No remote key management service.

## 3. Driver decision: `node:sqlite`

The runtime uses the **built-in `node:sqlite` module** (`DatabaseSync`).

Verified on the target machine (Node `v24.19.0`, `linux arm64`):

| Capability | Result |
| --- | --- |
| `node:sqlite` present | yes, SQLite `3.53.3` |
| `ExperimentalWarning` on import | none emitted |
| ESM `import { DatabaseSync }` | works |
| `pragma journal_mode=wal` | returns `wal` |
| `pragma foreign_keys=ON` | enforced; FK violation raises `ERR_SQLITE_ERROR` |
| `pragma busy_timeout` | settable |
| BLOB round-trip | `typeof=blob`, exact length |
| `BEGIN` / `ROLLBACK` | rolls back correctly |

Rejected alternatives and why:

- **`better-sqlite3`** — native addon requiring `node-gyp`, a C++ toolchain, and
  a prebuilt binary matching the ABI. On Termux/ARM64 prebuilds are frequently
  absent and source builds are slow or fail. Constraint G forbids picking a
  native dependency that cannot realistically be installed on ARM64 Android
  without strong justification. There is no such justification when the runtime
  already ships SQLite.
- **`node-sqlite3-wasm` / `sql.js`** — no native build, but slower, and WAL plus
  real file-locking semantics are weaker. Unnecessary once `node:sqlite` exists.

Consequence: **zero new runtime dependencies** for storage. This is the single
biggest Termux compatibility win available and it directly satisfies
constraint G.

`DatabaseSync` is synchronous. That is acceptable and in fact preferable here:
migrations and secret access are short, local, and infrequent, and synchronous
access removes a whole class of interleaving bugs. Should a future phase find a
hot path, that phase can revisit; it is not a Phase 2 concern.

## 4. Package boundary

A new workspace package `packages/storage` (`@bayz/storage`).

```text
packages/storage/
  package.json
  tsconfig.json
  src/
    index.ts          public surface only
    errors.ts         StorageError + stable codes
    paths.ts          data-dir resolution and private-permission creation
    database.ts       open, pragmas, close
    migrations.ts     versioned idempotent migration runner
    master-key.ts     master key load-or-create
    crypto.ts         AES-256-GCM envelope seal/open
    secret-repository.ts SQLite-backed secret persistence
  test/
    paths.test.ts
    database.test.ts
    migrations.test.ts
    master-key.test.ts
    crypto.test.ts
    secret-repository.test.ts
    persistence.test.ts
```

Boundary rule (constraint D): **no SQL string and no `DatabaseSync` value may
appear outside `packages/storage/src`.** Route handlers and `apps/server` see
only the typed interfaces below. `apps/server` gains a startup wiring module; it
gains no inline SQL.

Dependency direction: `@bayz/storage` depends on `@bayz/security` (for
`redactSecrets`) and on nothing else. It does not depend on Fastify. It stays
independently testable.

## 5. Filesystem and data directory

- Database path: `<BAYZ_DATA_DIR>/bayz.db`.
- Master key path: `<BAYZ_DATA_DIR>/master.key`.
- `BAYZ_DATA_DIR` default remains `~/.bayz`, unchanged from Phase 1
  `loadRuntimeConfig`.
- The data directory is created recursively with mode `0o700`.
- `master.key` is written with mode `0o600` via an exclusive-create open flag
  (`wx`) so a concurrent start cannot clobber an existing key.
- Modes are applied best-effort. On a filesystem that ignores POSIX modes the
  runtime proceeds; it does not hard-fail, because Termux and some Android
  mounts legitimately cannot honor them. Nothing in the design *relies* on the
  mode for correctness — the mode is defense in depth.
- Verified caveat: when the process runs as uid 0, a `0o500` directory is still
  writable, so a chmod-based "unwritable directory" test would be vacuous. The
  unwritable-path test therefore forces a genuine failure via an `ENOTDIR`
  parent (a regular file used as a directory component), which was verified to
  produce `ERR_SQLITE_ERROR: unable to open database file`.

## 6. Database initialization

`openDatabase({ dataDir })` performs, in order:

1. Ensure the data directory exists with private permissions.
2. Open `<dataDir>/bayz.db`.
3. `pragma foreign_keys = ON` — required, and asserted.
4. `pragma busy_timeout = 5000`.
5. `pragma journal_mode = WAL` — **best effort.** If the filesystem refuses WAL
   the runtime keeps the journal mode SQLite fell back to and continues. A
   refusal is not a startup failure; requirement A says "WAL jika didukung".
6. `pragma synchronous = NORMAL` (safe and appropriate under WAL).
7. Run migrations.

Any failure in steps 1–4 or 7 raises a `StorageError` with code
`storage_unavailable` and a message that names the failing stage but **never**
embeds the raw SQLite message, since SQLite error text can contain full
filesystem paths.

## 7. Migrations

A hand-rolled, ordered, idempotent runner. No dependency.

- Migrations are an ordered array of `{ version: number, statements: string[] }`
  with strictly increasing versions starting at 1.
- Applied version is tracked in **two** places, both of which must agree:
  - `pragma user_version` — cheap to read, survives everything.
  - a `schema_migrations` table recording `version` and `applied_at` for audit.
- The runner reads `user_version`, then applies only migrations with
  `version > current`, in ascending order.
- Each migration runs inside `BEGIN IMMEDIATE` … `COMMIT`, with `ROLLBACK` on
  error, so a failed migration leaves no partial schema. `user_version` is set
  inside the same transaction as the migration's statements, which is what makes
  it atomic (constraint E).
- Running the runner twice is a no-op: the second pass sees `user_version`
  already at the target and applies nothing. This is asserted by test.

Phase 2 schema, migration version 1:

```sql
CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE secrets (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL UNIQUE,
  cipher_version INTEGER NOT NULL,
  algorithm      TEXT    NOT NULL,
  iv             BLOB    NOT NULL,
  auth_tag       BLOB    NOT NULL,
  ciphertext     BLOB    NOT NULL,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

CREATE TABLE runtime_metadata (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

`secrets.name` is the caller's namespaced identifier. Phase 3 will use values
shaped like `provider:<providerId>:api_key`. Phase 2 does not create any such
row; the naming convention is documented, not populated.

There is no `providers` table, no `proxies` table, and no usage table. Those
belong to their own phases and would be speculative here.

## 8. Master key

`loadMasterKey({ dataDir, env })` resolves a 32-byte key:

1. If `BAYZ_MASTER_KEY` is set, decode it. Accepted encodings: 64-character hex,
   or base64 that decodes to exactly 32 bytes. Anything else — wrong length,
   undecodable, empty — raises `StorageError` code `master_key_invalid`. No
   silent padding, hashing, or truncation of a malformed key; a caller who
   supplied a bad key must be told, not quietly given a different key.
2. Otherwise, if `<dataDir>/master.key` exists, read it and validate it is
   exactly 32 bytes.
3. Otherwise generate `crypto.randomBytes(32)` and write it to
   `<dataDir>/master.key` with `flag: "wx"`, `mode: 0o600`.

The key is returned as a `Buffer` and held only in memory. It is **never**
written to SQLite — that is the whole point, since a stolen `bayz.db` must not
be sufficient to decrypt. It is never logged, never returned from any API, and
never included in an error message. A dedicated test asserts the key material
does not appear in the database bytes.

`describeMasterKeySource()` returns `"environment"` or `"generated"` for
operator-facing diagnostics. It returns the *source*, never the key.

### Threat model (explicit, per requirement C)

This design protects secrets **at rest**, against:

- someone who obtains a copy of `bayz.db` alone (backup, sync folder, careless
  copy, cloud snapshot) — the ciphertext is useless without the key;
- accidental plaintext disclosure through logs, error envelopes, or API
  responses.

It does **not** protect against:

- an attacker with full or root access to the running device, who can read
  `master.key` (mode `0o600` stops other unprivileged users, not root) or dump
  process memory;
- a malicious process running as the same user;
- anyone who obtains `BAYZ_MASTER_KEY` from the environment or a shell history.

This is the honest ceiling for a local-first, single-admin runtime with no
hardware keystore and no external KMS. Claiming more would be false. Operators
who need a stronger boundary must supply `BAYZ_MASTER_KEY` from an external
secret manager at start time and not persist it on the device.

## 9. Encryption envelope

`sealSecret(key, plaintext)` → `SecretEnvelope`; `openSecret(key, envelope)` →
`string`.

```ts
type SecretEnvelope = {
  cipherVersion: 1;
  algorithm: "aes-256-gcm";
  iv: Buffer;         // 12 bytes, crypto.randomBytes per call
  authTag: Buffer;    // 16 bytes
  ciphertext: Buffer;
};
```

- AES-256-GCM, 96-bit random IV generated **per encryption call**. Two
  encryptions of identical plaintext under the same key therefore produce
  different IVs and different ciphertexts. Asserted by test.
- The 16-byte GCM authentication tag is stored and verified on every open.
- `cipherVersion` and `algorithm` are persisted so a later phase can introduce
  version 2 and migrate records without guessing how existing rows were
  encrypted. Phase 2 reads only version 1 and rejects anything else with
  `secret_corrupt`.
- **Fail closed.** A wrong key, a flipped ciphertext byte, a flipped tag byte, a
  truncated IV, or an unknown `cipherVersion` all raise `StorageError` code
  `secret_corrupt`. The function never returns `""`, never returns `null`, and
  never returns partially-decrypted bytes. Node's `decipher.final()` throws on
  tag mismatch, and that throw is translated — not swallowed — into
  `secret_corrupt`. The underlying OpenSSL message is discarded so that crypto
  internals do not leak (constraint E).

## 10. Repository interface

```ts
export type SecretRecordMetadata = {
  name: string;
  cipherVersion: number;
  algorithm: string;
  createdAt: string;
  updatedAt: string;
};

export interface SecretRepository {
  put(name: string, plaintext: string): void;
  get(name: string): string;              // throws secret_not_found
  find(name: string): string | undefined; // undefined when absent
  list(): SecretRecordMetadata[];         // metadata only, never plaintext
  delete(name: string): boolean;
  close(): void;
}
```

Design points:

- `put` is an upsert on `name`, executed inside a transaction. A failure mid-way
  leaves no partial row (constraint E), which is asserted by a rollback test.
- `get` throws `secret_not_found` rather than returning a falsy value, so a
  caller cannot mistake "absent" for "empty secret". `find` exists for the
  genuinely optional case.
- `list` returns metadata only. There is no code path that bulk-returns
  plaintext, because such a path is the most likely future source of a leak.
- Encryption happens inside the repository. Callers pass and receive plain
  strings and never see an envelope, so no caller can accidentally persist
  plaintext.

## 11. Error semantics

```ts
type StorageErrorCode =
  | "storage_unavailable"
  | "master_key_invalid"
  | "secret_not_found"
  | "secret_corrupt";

class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly stage?: string;
}
```

Rules:

- Raw SQLite errors (`ERR_SQLITE_ERROR`, which can embed absolute paths) and raw
  OpenSSL crypto errors are caught at the storage boundary and re-thrown as
  `StorageError`. The original is **not** attached as `cause` on the object that
  crosses the boundary, because `cause` is serialized by several loggers.
- The Phase 1 error handler in `apps/server/src/errors.ts` already returns a
  fixed `internal_error` / `"Request failed"` envelope for anything uncaught, so
  a `StorageError` reaching an HTTP path cannot leak its message to a client.
  Phase 2 does not weaken that handler.
- Startup storage failure is fatal and safe: the process logs a redacted
  diagnostic and exits non-zero rather than serving traffic with no storage.

All storage logging passes through `redactSecrets` from `@bayz/security`
(constraint B), reusing the Phase 1 primitive rather than duplicating a key list.

## 12. Server integration

`apps/server/src/storage.ts` is a thin wiring module:

```ts
initializeStorage(config: RuntimeConfig): StorageHandle
```

It is called from `src/index.ts` during startup, before `listen`. On
`StorageError` the process logs a redacted message and exits non-zero.

Deliberately **not** in Phase 2:

- no new HTTP route,
- no secret exposed through `/api/health`,
- no dashboard change.

`/api/health` keeps its exact Phase 1 contract. Adding a storage field would
change a shape Phase 1 tests and the dashboard already depend on, for no Phase 2
benefit.

## 13. Test plan

Mapping requirement F to concrete tests:

| Requirement | Test |
| --- | --- |
| fresh DB migration | `migrations.test.ts` — fresh file reaches target version, tables exist |
| migration twice is safe | `migrations.test.ts` — second run applies 0, schema unchanged |
| schema version correct | `migrations.test.ts` — `user_version` and `schema_migrations` agree |
| DB persists across reopen | `persistence.test.ts` — write, close, reopen, read back |
| encrypted round-trip | `crypto.test.ts`, `secret-repository.test.ts` |
| plaintext absent from DB bytes | `persistence.test.ts` — scan raw `bayz.db` bytes for the sentinel |
| distinct IV for equal plaintext | `crypto.test.ts` — two seals differ in IV and ciphertext |
| wrong master key fails | `crypto.test.ts` — `secret_corrupt` |
| tampered ciphertext fails | `crypto.test.ts` — flipped ciphertext byte and flipped tag byte both fail |
| redaction still works | Phase 1 `redact.test.ts` stays green; `storage` logs a redacted payload |
| transaction rollback | `secret-repository.test.ts` — failed write leaves no row |
| invalid/unwritable data dir fails safely | `paths.test.ts` / `database.test.ts` — `ENOTDIR` parent yields `storage_unavailable`, not a raw SQLite error |
| Foundation tests stay green | `npm run runtime:verify` |

Plus a **non-mocked runtime proof** (constraint H): a real script that opens a
real database file on disk, writes a real secret, closes, reopens, reads it
back, greps the raw file bytes for the plaintext, and greps captured logs for
the plaintext and the key. Mocked tests alone do not satisfy H.

## 14. Compatibility

- Node.js 24+ (`node:sqlite` is the hard floor; it does not exist in Node 20).
- Zero new runtime dependencies, so nothing to compile on Termux/ARM64.
- One process, local-first. Default host `127.0.0.1`, default port `20128`,
  both unchanged from Phase 1.
- `~/.bayz` default data dir unchanged.

## 15. Open items intentionally deferred

- Key rotation and re-encryption — the envelope carries `cipherVersion` so this
  is possible later; it is not implemented and must not be described as working.
- Provider, proxy, route, combo, and usage schemas — their own phases.
- The existing private BAYZ Sites/UI source is still absent from this workspace,
  so the root Sites build remains DEFERRED from Phase 1. This is not a Phase 2
  regression and Phase 2 does not attempt to recreate that UI.
