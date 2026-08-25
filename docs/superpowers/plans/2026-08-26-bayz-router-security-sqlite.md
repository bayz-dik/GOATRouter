# Bayz Router — Security and SQLite Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local SQLite storage layer with versioned idempotent migrations
and an AES-256-GCM encrypted-secret primitive, isolated in `@bayz/storage`, wired
into Core startup, with no provider/proxy/routing/usage feature and no dashboard
change.

**Spec:** `docs/superpowers/specs/2026-08-26-bayz-router-security-sqlite-design.md`

**Phase 1:** `docs/superpowers/plans/2026-08-26-bayz-router-foundation.md` — complete, 8 commits, `runtime:verify` green. Do not modify or revert those commits.

**Tech Stack:** TypeScript, Node.js 24+, built-in `node:sqlite` (`DatabaseSync`), built-in `node:crypto` (AES-256-GCM), Node test runner through `tsx`. **Zero new runtime dependencies.**

## Global Constraints

- Do not repeat Foundation Task 1–8 work.
- Do not redesign the dashboard or touch `apps/dashboard`.
- Do not implement Provider Manager, Proxy Manager, routing, combos, or usage.
- Do not create fake/demo provider rows.
- No SQL and no `DatabaseSync` outside `packages/storage/src`.
- Never log or return a master key, plaintext secret, credential, authorization
  header, cookie, proxy password, or token.
- Reuse `redactSecrets` from `@bayz/security`; do not duplicate the key list.
- Master key must never be stored in SQLite.
- Decryption must fail closed — never return `""`, `null`, or partial plaintext.
- Raw SQLite and raw crypto error text must not cross the storage boundary.
- Default host `127.0.0.1`, default port `20128`, default data dir `~/.bayz` all unchanged.
- Termux/proot ARM64 is a first-class target; no native addon.
- Do not push to GitHub.

## File structure locked by this phase

```text
packages/storage/
  package.json
  tsconfig.json
  src/errors.ts
  src/paths.ts
  src/database.ts
  src/migrations.ts
  src/master-key.ts
  src/crypto.ts
  src/secret-repository.ts
  src/index.ts
  test/errors.test.ts
  test/paths.test.ts
  test/crypto.test.ts
  test/master-key.test.ts
  test/database.test.ts
  test/migrations.test.ts
  test/secret-repository.test.ts
  test/persistence.test.ts
apps/server/src/storage.ts
apps/server/test/storage.test.ts
scripts/storage-smoke.mjs
```

---

### Task 1: Scaffold `@bayz/storage` with stable error semantics

**Files:**
- Create: `packages/storage/package.json`
- Create: `packages/storage/tsconfig.json`
- Create: `packages/storage/test/errors.test.ts`
- Create: `packages/storage/src/errors.ts`
- Create: `packages/storage/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `StorageError`, `StorageErrorCode`, `asStorageError`.

- [ ] **Step 1: Create the package manifests and the failing error test**

`package.json` mirrors the Phase 1 package shape (`type: module`, `exports:
./src/index.ts`, `test` via `node --import tsx --test test/*.test.ts`, `build`
via `tsc --noEmit`), with `engines.node >= 24.0.0`, a dependency on
`@bayz/security` at `0.1.0`, and no other dependency.

`tsconfig.json` matches `packages/security/tsconfig.json` plus `"types": ["node"]`.

Test asserts: `StorageError` carries `code` and optional `stage`; `instanceof
Error` holds; `asStorageError` wraps an arbitrary thrown value into a
`StorageError` with the supplied code and **does not** copy the original message
or attach it as `cause`.

- [ ] **Step 2: Verify RED**

```bash
npm run test --workspace @bayz/storage
```

Expected: FAIL — `packages/storage/src/index.ts` does not exist.

- [ ] **Step 3: Implement `errors.ts` and a placeholder `index.ts`**

`StorageErrorCode` = `"storage_unavailable" | "master_key_invalid" |
"secret_not_found" | "secret_corrupt"`. `asStorageError(code, stage, cause)`
returns a `StorageError` whose message is a fixed safe string derived from the
code and stage only.

- [ ] **Step 4: Verify GREEN and typecheck**

```bash
npm run test --workspace @bayz/storage
npm run build --workspace @bayz/storage
```

- [ ] **Step 5: Commit**

```bash
git add packages/storage package.json package-lock.json
git commit -m "feat: add Bayz storage error boundary"
```

---

### Task 2: Private data-directory resolution

**Files:**
- Create: `packages/storage/test/paths.test.ts`
- Create: `packages/storage/src/paths.ts`
- Modify: `packages/storage/src/index.ts`

**Interfaces:**
- Produces: `ensureDataDir(dataDir: string): void`, `databasePath(dataDir)`, `masterKeyPath(dataDir)`.

- [ ] **Step 1: Write the failing path tests**

Assert: a fresh nested dir is created; on a POSIX filesystem its mode is `0o700`;
`databasePath` ends in `bayz.db`; `masterKeyPath` ends in `master.key`; an
already-existing dir is accepted idempotently; a path whose parent is a **regular
file** raises `StorageError` with code `storage_unavailable`.

The `ENOTDIR` approach is deliberate: the suite may run as uid 0, where a
`chmod 0o500` directory is still writable, so a permission-based test would pass
vacuously. `ENOTDIR` fails for root too.

- [ ] **Step 2: Verify RED**

```bash
node --import tsx --test packages/storage/test/paths.test.ts
```

- [ ] **Step 3: Implement `paths.ts`**

`mkdirSync(dataDir, { recursive: true, mode: 0o700 })`, then a best-effort
`chmodSync(dataDir, 0o700)` whose failure is swallowed (some Android mounts
ignore modes; the spec states nothing depends on the mode for correctness). Any
other failure becomes `storage_unavailable` with stage `"ensure-data-dir"`.

- [ ] **Step 4: Verify GREEN and typecheck**

- [ ] **Step 5: Commit**

```bash
git add packages/storage
git commit -m "feat: add private Bayz data directory resolution"
```

---

### Task 3: AES-256-GCM secret envelope

**Files:**
- Create: `packages/storage/test/crypto.test.ts`
- Create: `packages/storage/src/crypto.ts`
- Modify: `packages/storage/src/index.ts`

**Interfaces:**
- Produces: `SecretEnvelope`, `CIPHER_VERSION`, `SECRET_ALGORITHM`, `sealSecret`, `openSecret`.

- [ ] **Step 1: Write the failing crypto tests**

Cover, per spec §9 and requirement F:

1. round-trip returns the exact plaintext, including a UTF-8 multi-byte string;
2. two seals of identical plaintext under one key yield different `iv` **and**
   different `ciphertext`;
3. envelope carries `cipherVersion: 1`, `algorithm: "aes-256-gcm"`, 12-byte iv,
   16-byte authTag;
4. plaintext bytes do not appear in `ciphertext`;
5. wrong key → `StorageError` code `secret_corrupt`;
6. flipped ciphertext byte → `secret_corrupt`;
7. flipped authTag byte → `secret_corrupt`;
8. unknown `cipherVersion` → `secret_corrupt`;
9. wrong-length key → `master_key_invalid`;
10. a failure never returns a value — asserted via `assert.throws`, so an
    accidental `return ""` would fail the suite.

- [ ] **Step 2: Verify RED**

```bash
node --import tsx --test packages/storage/test/crypto.test.ts
```

- [ ] **Step 3: Implement `crypto.ts`**

`sealSecret` uses `randomBytes(12)`, `createCipheriv("aes-256-gcm", key, iv)`,
and captures `getAuthTag()`. `openSecret` validates key length, `cipherVersion`,
and `algorithm` before touching the cipher, calls `setAuthTag`, and wraps **any**
throw from `update`/`final` as `secret_corrupt` with the original message
discarded.

- [ ] **Step 4: Verify GREEN and typecheck**

- [ ] **Step 5: Commit**

```bash
git add packages/storage
git commit -m "feat: add authenticated secret encryption"
```

---

### Task 4: Master key load-or-create

**Files:**
- Create: `packages/storage/test/master-key.test.ts`
- Create: `packages/storage/src/master-key.ts`
- Modify: `packages/storage/src/index.ts`

**Interfaces:**
- Produces: `loadMasterKey({ dataDir, env }): MasterKey` where `MasterKey = { key: Buffer; source: "environment" | "generated" }`.

- [ ] **Step 1: Write the failing master-key tests**

Assert: hex `BAYZ_MASTER_KEY` is accepted and reported as `source:
"environment"`; base64 decoding to 32 bytes is accepted; a malformed or
wrong-length `BAYZ_MASTER_KEY` raises `master_key_invalid` **and is not silently
hashed or truncated**; with no env var a key file is generated with mode `0o600`
and `source: "generated"`; a second call reads the same key back rather than
regenerating; a key file of the wrong size raises `master_key_invalid`; the
returned object exposes no method that stringifies the key.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement `master-key.ts`**

Resolution order exactly as spec §8. Generated keys are written with
`{ flag: "wx", mode: 0o600 }` so a concurrent starter cannot clobber an existing
key. Hex is detected by `/^[0-9a-fA-F]{64}$/`; otherwise base64 is attempted and
must decode to exactly 32 bytes.

- [ ] **Step 4: Verify GREEN and typecheck**

- [ ] **Step 5: Commit**

```bash
git add packages/storage
git commit -m "feat: add local master key management"
```

---

### Task 5: Database open with enforced pragmas

**Files:**
- Create: `packages/storage/test/database.test.ts`
- Create: `packages/storage/src/database.ts`
- Modify: `packages/storage/src/index.ts`

**Interfaces:**
- Produces: `openDatabase({ dataDir }): BayzDatabase` exposing `db`, `path`, `journalMode`, `close()`.

- [ ] **Step 1: Write the failing database tests**

Assert: opening in a temp dir creates `bayz.db`; `pragma foreign_keys` is `1` and
an FK violation actually throws; `busy_timeout` is `5000`; `journalMode` is
reported and is `wal` on a filesystem that supports it; a data dir whose parent
is a regular file raises `storage_unavailable`; the raised message contains
neither `"unable to open database file"` nor the absolute db path — this is the
concrete guard for "raw SQLite errors must not leak".

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement `database.ts`**

Order per spec §6. WAL is best-effort: attempt it, read back whatever mode
resulted, and continue. `foreign_keys` is asserted and a failure to enable it is
fatal.

- [ ] **Step 4: Verify GREEN and typecheck**

- [ ] **Step 5: Commit**

```bash
git add packages/storage
git commit -m "feat: open Bayz SQLite with safe pragmas"
```

---

### Task 6: Versioned idempotent migrations

**Files:**
- Create: `packages/storage/test/migrations.test.ts`
- Create: `packages/storage/src/migrations.ts`
- Modify: `packages/storage/src/database.ts`
- Modify: `packages/storage/src/index.ts`

**Interfaces:**
- Produces: `MIGRATIONS`, `TARGET_SCHEMA_VERSION`, `runMigrations(db): number`, `readSchemaVersion(db): number`.

- [ ] **Step 1: Write the failing migration tests**

Assert, per requirement F: a fresh database reaches `TARGET_SCHEMA_VERSION` and
gains the `schema_migrations`, `secrets`, and `runtime_metadata` tables; a second
`runMigrations` applies **0** migrations and leaves `user_version` and the table
set unchanged; `pragma user_version` equals `max(schema_migrations.version)`;
`secrets.name` is `UNIQUE`; a migration whose statement is invalid leaves
`user_version` at the previous value and creates none of its tables — the
atomicity guarantee; and there is **no** `providers`/`proxies`/`routes`/`usage`
table, which pins the "no speculative schema" constraint as an executable test.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement `migrations.ts`**

Each pending migration runs inside `BEGIN IMMEDIATE`, applies its statements,
inserts its `schema_migrations` row, sets `pragma user_version`, then `COMMIT`;
on any throw, `ROLLBACK` and raise `storage_unavailable` with stage
`"migrate:<version>"`.

`pragma user_version` cannot be parameterized, so the version is interpolated
only after an `Number.isInteger` guard — no external input reaches it.

Wire `runMigrations` into `openDatabase`.

- [ ] **Step 4: Verify GREEN, then re-run the database suite for regression**

```bash
npm run test --workspace @bayz/storage
npm run build --workspace @bayz/storage
```

- [ ] **Step 5: Commit**

```bash
git add packages/storage
git commit -m "feat: add versioned idempotent storage migrations"
```

---

### Task 7: Encrypted secret repository with transactional writes

**Files:**
- Create: `packages/storage/test/secret-repository.test.ts`
- Create: `packages/storage/test/persistence.test.ts`
- Create: `packages/storage/src/secret-repository.ts`
- Modify: `packages/storage/src/index.ts`

**Interfaces:**
- Produces: `openSecretStorage({ dataDir, env }): SecretStorage` (a `SecretRepository` plus `journalMode`, `schemaVersion`, `masterKeySource`).

- [ ] **Step 1: Write the failing repository and persistence tests**

Repository: `put`/`get` round-trip; `put` twice upserts rather than duplicating
and `updated_at` advances; `find` returns `undefined` for an absent name while
`get` throws `secret_not_found`; `list` returns metadata and **no** field whose
value equals the plaintext; `delete` returns `true` then `false`; a `put` that
fails mid-transaction leaves the prior row intact and adds no partial row; a row
whose `ciphertext` is tampered with directly in SQL causes `get` to throw
`secret_corrupt` rather than returning anything.

Persistence: write a sentinel secret, `close()`, reopen from the same `dataDir`,
read it back; then read `bayz.db` (plus `-wal`) as raw bytes and assert the
sentinel plaintext does **not** occur; assert the master key bytes do not occur
either; and assert reopening with a *different* `BAYZ_MASTER_KEY` yields
`secret_corrupt` instead of plaintext.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement `secret-repository.ts`**

All SQL is parameterized. `put` wraps delete+insert (or `INSERT … ON CONFLICT DO
UPDATE`) in `BEGIN IMMEDIATE`/`COMMIT` with `ROLLBACK` on error. Encryption
happens inside `put`; decryption inside `get`/`find`. No method returns a
`SecretEnvelope` to a caller.

- [ ] **Step 4: Verify GREEN and typecheck**

- [ ] **Step 5: Commit**

```bash
git add packages/storage
git commit -m "feat: add encrypted secret repository"
```

---

### Task 8: Core startup wiring, real-runtime proof, and phase verification

**Files:**
- Create: `apps/server/src/storage.ts`
- Create: `apps/server/test/storage.test.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/package.json`
- Create: `scripts/storage-smoke.mjs`
- Modify: `README.md`
- Modify: `WORK-HANDOFF.md`

**Interfaces:**
- Produces: `initializeStorage(config): StorageHandle`; startup fails safely when storage cannot initialize.

- [ ] **Step 1: Write the failing server storage tests**

Assert: `initializeStorage` with a temp `dataDir` returns a handle whose
`schemaVersion` equals the target and whose secret round-trip works; an
unopenable `dataDir` raises `StorageError` `storage_unavailable`; the thrown
message leaks neither the absolute path nor raw SQLite text; and — the
regression guard — `GET /api/health` still returns exactly
`{status, version, uptimeSeconds}` with no storage field, so Phase 1's contract
and the dashboard are untouched.

- [ ] **Step 2: Verify RED**

```bash
node --import tsx --test apps/server/test/storage.test.ts
```

- [ ] **Step 3: Implement `storage.ts` and wire startup**

`apps/server/src/storage.ts` calls `openSecretStorage` and logs, through
`redactSecrets`, only `{ schemaVersion, journalMode, masterKeySource, dataDir }`
— never the key and never a secret. `src/index.ts` calls it before `listen`; a
`StorageError` logs a redacted diagnostic and sets a non-zero exit code without
starting the listener. Add `@bayz/storage` to `apps/server` dependencies.

- [ ] **Step 4: Write and run the non-mocked storage smoke script**

`scripts/storage-smoke.mjs` must, against a real on-disk database:

1. create a fresh temp data dir;
2. open storage, write a sentinel secret, report schema version and journal mode;
3. close, reopen, and read the secret back — proving persistence;
4. scan `bayz.db`, `bayz.db-wal`, `bayz.db-shm` raw bytes for the sentinel and
   fail if found;
5. scan the captured log output for the sentinel and for the master key and fail
   if found;
6. confirm a wrong master key fails closed;
7. exit non-zero on any check failure.

```bash
node scripts/storage-smoke.mjs
```

This satisfies requirement H's "jalankan storage nyata, bukan hanya mocked tests".

- [ ] **Step 5: Boot the real server and confirm no regression**

Start the Core with a temp `BAYZ_DATA_DIR`, confirm it logs storage readiness and
serves `/api/health`, confirm `bayz.db` exists on disk afterwards, and confirm
the log contains no secret. Use a free port if `20128` is occupied, and record
which port was used.

- [ ] **Step 6: Document the phase honestly**

Append a Phase 2 section to `README.md` covering the data dir, `BAYZ_MASTER_KEY`,
and the threat-model ceiling from spec §8. Update `WORK-HANDOFF.md` with Phase 2
state, deviations, and the still-DEFERRED Sites build.

Do not describe key rotation, provider storage, or any Phase 3+ feature as
working.

- [ ] **Step 7: Run the full completion gate**

```bash
npm run test --workspace @bayz/storage
npm run test --workspace @bayz/server
node --test tests/runtime-structure.test.mjs
npm run runtime:verify
node scripts/storage-smoke.mjs
git diff --check
git status --short
```

- [ ] **Step 8: Commit**

```bash
git add apps/server packages/storage scripts README.md WORK-HANDOFF.md docs package.json package-lock.json
git commit -m "feat: wire Bayz storage into Core startup"
```

## Phase completion checklist

- [ ] `@bayz/storage` tests pass and its `tsc --noEmit` exits 0.
- [ ] `@bayz/server` tests pass, including the health-contract regression guard.
- [ ] `npm run runtime:verify` exits 0 with every Foundation test still green.
- [ ] `node scripts/storage-smoke.mjs` exits 0 against a real database file.
- [ ] Database reopened in a separate process and persistence proven.
- [ ] Sentinel plaintext absent from `bayz.db`, `-wal`, `-shm`, and logs.
- [ ] Master key absent from the database and from all logs.
- [ ] Wrong key and tampered ciphertext both fail closed with `secret_corrupt`.
- [ ] Migrations idempotent; re-run applies zero and is asserted.
- [ ] Failed write leaves no partial row.
- [ ] Unwritable/invalid data dir yields `storage_unavailable`, not raw SQLite text.
- [ ] No SQL or `DatabaseSync` outside `packages/storage/src`.
- [ ] No new runtime dependency; Termux/ARM64 needs no native build.
- [ ] Default host `127.0.0.1`, port `20128`, data dir `~/.bayz` unchanged.
- [ ] No provider, proxy, route, combo, or usage schema or record introduced.
- [ ] `apps/dashboard` untouched.
- [ ] `git diff --check` clean.
- [ ] No push to GitHub.
- [ ] Sites/UI build remains documented as DEFERRED, not as failing or passing.
