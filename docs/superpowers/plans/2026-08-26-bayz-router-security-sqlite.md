# Bayz Router — Security and SQLite Storage Implementation Plan (Fortress)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local SQLite storage layer behind a driver adapter boundary, with
versioned idempotent migrations, envelope encryption (per-secret DEK wrapped by a
KEK), a KeyProvider abstraction, and transactional root-key rotation — isolated in
`@bayz/storage`, wired into Core startup, with no provider/proxy/routing/usage
feature and no dashboard change.

**Spec:** `docs/superpowers/specs/2026-08-26-bayz-router-security-sqlite-design.md` (Revision 2)

**Phase 1:** `docs/superpowers/plans/2026-08-26-bayz-router-foundation.md` — complete, 8 commits, `runtime:verify` green. Do not modify or revert those commits.

**Tech Stack:** TypeScript, Node.js 24+, `node:sqlite` (`DatabaseSync`) behind an adapter, `node:crypto` (AES-256-GCM, `randomBytes`, `scryptSync`, `hkdfSync`, `timingSafeEqual`), Node test runner through `tsx`. **Zero new dependencies.**

## Global Constraints

- Do not repeat Foundation Task 1–8 work.
- Do not touch `apps/dashboard`.
- Do not implement Provider Manager, Proxy Manager, routing, combos, or usage.
- Do not create fake/demo provider rows or speculative schema.
- `node:sqlite` may be imported in **exactly one file**; migrations, repository,
  and crypto see only the `SqlDatabase` interface.
- No SQL outside `packages/storage/src`.
- Never log or return a KEK, DEK, passphrase, `BAYZ_MASTER_KEY`, plaintext
  secret, or full authorization header.
- Extend `redactSecrets` in `@bayz/security`; do not fork the key list.
- Never persist a plaintext DEK. Never reuse an IV. No deterministic encryption.
- Decryption must fail closed — never `""`, `null`, or partial plaintext.
- Raw SQLite and raw OpenSSL text must not cross the storage boundary.
- Do not implement `better-sqlite3`, `sql.js`, or a real OS keystore in this phase.
- Do not fake Argon2id or full anti-rollback.
- Default host `127.0.0.1`, port `20128`, data dir `~/.bayz` unchanged.
- Zero native dependency; Termux/ARM64 first-class.
- Do not push to GitHub.

## File structure locked by this phase

```text
packages/security/
  src/redact.ts                    MODIFY: alias/casing-aware key matching
  test/redact.test.ts              MODIFY: alias coverage
packages/storage/
  package.json
  tsconfig.json
  src/errors.ts
  src/sql.ts                       SqlDriver/SqlDatabase/SqlStatement contracts
  src/drivers/node-sqlite.ts       ONLY file importing node:sqlite
  src/paths.ts
  src/key-provider.ts              Env / Passphrase / OsKeystore(iface) / SecureFile
  src/crypto.ts                    DEK+KEK envelope, AAD binding, keyId
  src/migrations.ts
  src/database.ts
  src/secret-repository.ts
  src/index.ts
  test/errors.test.ts
  test/sql-driver.test.ts
  test/driver-boundary.test.ts
  test/paths.test.ts
  test/key-provider.test.ts
  test/crypto.test.ts
  test/migrations.test.ts
  test/database.test.ts
  test/secret-repository.test.ts
  test/rotation.test.ts
  test/persistence.test.ts
  test/logging.test.ts
apps/server/src/storage.ts
apps/server/test/storage.test.ts
scripts/storage-smoke.mjs
```

---

### Task 1: Extend redaction for aliases and casing

Done first so every later task logs through a hardened redactor.

**Files:**
- Modify: `packages/security/test/redact.test.ts`
- Modify: `packages/security/src/redact.ts`

**Interfaces:** `redactSecrets<T>(value: T): T` — unchanged signature, wider coverage.

- [ ] **Step 1: Write failing alias/casing tests**

Assert every spec §12 key redacts, in `camelCase`, `snake_case`, `kebab-case`,
and `UPPERCASE`: `authorization`, `proxy-authorization`, `cookie`, `set-cookie`,
`apiKey`, `password`, `proxyPassword`, `token`, `accessToken`, `refreshToken`,
`clientSecret`, `masterKey`, `privateKey`, `secret`, `credential`, `dek`, `kek`,
`wrappedDek`, `passphrase`, `ciphertext`. Assert non-secret neighbours
(`model`, `tokenCount`, `secretName`) are **not** redacted — substring matching
would be a silent data-destroying bug. Keep the existing Phase 1 assertions.

- [ ] **Step 2: Verify RED** — `npm run test --workspace @bayz/security`

- [ ] **Step 3: Implement**

Normalize each key by lowercasing and stripping `-`/`_`, then match against a
normalized set. Preserve non-mutation, array recursion, and `Date`/primitive
passthrough from Phase 1.

- [ ] **Step 4: Verify GREEN + `npm run build --workspace @bayz/security`**

- [ ] **Step 5: Commit** — `git commit -m "feat: harden secret redaction aliases"`

---

### Task 2: Storage package, error boundary, SQL driver adapter

**Files:**
- Create: `packages/storage/{package.json,tsconfig.json}`
- Create: `packages/storage/test/{errors.test.ts,sql-driver.test.ts,driver-boundary.test.ts}`
- Create: `packages/storage/src/{errors.ts,sql.ts,drivers/node-sqlite.ts,index.ts}`

**Interfaces:** `StorageError`, `StorageErrorCode`, `asStorageError`, `SqlDriver`, `SqlDatabase`, `SqlStatement`, `nodeSqliteDriver`, `selectDriver()`.

- [ ] **Step 1: Write failing error + driver tests**

Errors: `code` and optional `stage` present; `instanceof Error`; `asStorageError`
wraps a thrown value without copying its message and **without** setting `cause`.

Driver: `selectDriver().name === "node:sqlite"`; open a temp file, `exec` DDL,
`prepare` + `run`/`get`/`all`; BLOB (`Uint8Array`) round-trips byte-exact;
`bigint`/`null`/`number`/`string` round-trip; opening under an `ENOTDIR` parent
raises `StorageError` `storage_unavailable` whose message contains neither the
absolute path nor `"unable to open database file"`.

Boundary: read every file under `packages/storage/src` and assert `node:sqlite`
appears **only** in `drivers/node-sqlite.ts`. This makes the layering rule
executable rather than aspirational.

- [ ] **Step 2: Verify RED** — `npm run test --workspace @bayz/storage`

- [ ] **Step 3: Implement**

`package.json` mirrors Phase 1 package shape (`type: module`, `exports:
./src/index.ts`, tsx test script, `tsc --noEmit` build), `engines.node >=
24.0.0`, dependency `@bayz/security@0.1.0` only.

`sql.ts` holds interfaces plus `SqlParam`/`SqlValue` =
`null | number | bigint | string | Uint8Array` — deliberately no `boolean`, which
`node:sqlite` rejects; callers store `0`/`1`.

`drivers/node-sqlite.ts` wraps `DatabaseSync`, translating every throw into
`StorageError`.

- [ ] **Step 4: Verify GREEN + typecheck**

- [ ] **Step 5: Commit** — `git commit -m "feat: add Bayz storage driver boundary"`

---

### Task 3: Private data-directory resolution

**Files:** Create `test/paths.test.ts`, `src/paths.ts`; modify `src/index.ts`.

**Interfaces:** `ensureDataDir`, `databasePath`, `masterKeyPath`.

- [ ] **Step 1: Write failing tests**

Fresh nested dir created; mode `0o700` where the platform reports one;
`bayz.db` / `master.key` suffixes; existing dir accepted idempotently; a parent
that is a **regular file** raises `storage_unavailable`.

The `ENOTDIR` approach is deliberate: the suite may run as uid 0, where a
`chmod 0o500` dir is still writable and a permission test would pass vacuously.
`ENOTDIR` fails for root too.

- [ ] **Step 2: Verify RED** — `node --import tsx --test packages/storage/test/paths.test.ts`

- [ ] **Step 3: Implement** — `mkdirSync(recursive, mode 0o700)` then best-effort
`chmodSync`, whose failure is swallowed (Android mounts). Other failures become
`storage_unavailable` stage `"ensure-data-dir"`.

- [ ] **Step 4: Verify GREEN + typecheck**

- [ ] **Step 5: Commit** — `git commit -m "feat: add private Bayz data directory resolution"`

---

### Task 4: KeyProvider abstraction

**Files:** Create `test/key-provider.test.ts`, `src/key-provider.ts`; modify `src/index.ts`.

**Interfaces:** `KeyProvider`, `KeyProviderKind`, `EnvKeyProvider`, `PassphraseKeyProvider`, `SecureFileKeyProvider`, `OsKeystoreKeyProvider` (unavailable), `resolveKeyProvider({ dataDir, env, mode })`, `SCRYPT_PARAMS`.

- [ ] **Step 1: Write failing provider tests**

Env: 64-char hex accepted, `kind: "environment"`; base64 decoding to 32 bytes
accepted; malformed/short/long raises `master_key_invalid` and is **not** hashed,
padded, or truncated.

SecureFile: generates on first use, `kind: "secure-file"`, file mode `0o600`;
second call returns the identical key rather than regenerating; wrong-size file
raises `master_key_invalid`; a group/world-readable file **warns** but still
loads (Android mounts cannot represent modes; hard-failing would make BAYZ
unusable there) and the warning contains no key bytes.

Passphrase: same passphrase + stored salt ⇒ same KEK; different passphrase ⇒
different KEK; salt is 16 random bytes persisted alongside `SCRYPT_PARAMS`;
`kind: "passphrase"`; empty passphrase rejected.

OsKeystore: `available === false` and `loadKek()` throws — asserting it is an
unimplemented interface, so nobody can mistake it for working custody.

`resolveKeyProvider`: `FORTRESS` ⇒ passphrase (throws without one); `SECURE` ⇒
env, and errors rather than silently downgrading to file; `STANDARD` ⇒ env when
`BAYZ_MASTER_KEY` is set, else secure-file.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement**

`SCRYPT_PARAMS = { N: 1<<16, r: 8, p: 1, keyLength: 32 }` — 194 ms / 64 MiB
measured on this ARM64 device; `maxmem` set to `256*N*r + (1<<24)` since the Node
default is too low for N=2¹⁶. Params persisted so they can be raised later.

Generated key files use `{ flag: "wx", mode: 0o600 }` so a concurrent start
cannot clobber an existing key. Hex detected by `/^[0-9a-fA-F]{64}$/`, else
base64 that must decode to exactly 32 bytes.

- [ ] **Step 4: Verify GREEN + typecheck**

- [ ] **Step 5: Commit** — `git commit -m "feat: add Bayz key provider abstraction"`

---

### Task 5: Envelope encryption with DEK/KEK and AAD binding

**Files:** Create `test/crypto.test.ts`, `src/crypto.ts`; modify `src/index.ts`.

**Interfaces:** `SecretEnvelope`, `ENVELOPE_VERSION`, `SECRET_ALGORITHM`, `sealSecret(kek, name, plaintext)`, `openSecret(kek, name, envelope)`, `rewrapEnvelope(oldKek, newKek, name, envelope)`, `computeKeyId(kek)`.

- [ ] **Step 1: Write failing crypto tests**

Round-trip including a UTF-8 multi-byte string. Envelope shape: `version: 1`,
`algorithm: "aes-256-gcm"`, 12-byte `iv` and `wrapIv`, 16-byte `tag` and
`wrapTag`, 32-byte `wrappedDek`, `keyId` prefixed `kek_`.

Two seals of identical plaintext under one KEK differ in `iv`, `ciphertext`,
`wrappedDek`, **and** the unwrapped DEK — proving per-record DEKs, not just fresh
IVs. Plaintext bytes absent from `ciphertext`.

Fail closed with `secret_corrupt` for: wrong KEK; flipped `ciphertext` byte;
flipped `tag` byte; flipped `wrappedDek` byte; flipped `wrapTag` byte; unsupported
`version`; unknown `algorithm`; truncated `iv`; truncated `wrappedDek`;
**mismatched `name`** (AAD binding — verified that GCM rejects a different AAD).
Wrong-length KEK ⇒ `master_key_invalid`.

Every failure asserted with `assert.throws`, so an accidental `return ""` fails
the suite.

`rewrapEnvelope`: output opens under the new KEK, fails under the old, preserves
`ciphertext`/`iv`/`tag` byte-identically, and changes `keyId`.

`computeKeyId`: stable for one KEK, differs across KEKs, 16 bytes hex, and does
**not** contain any 8-byte run of the KEK — guarding the non-secret-fingerprint
claim.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement**

Per spec §3/§5. AAD = `Buffer.from(\`bayz:v1:${name}\`)` on both layers. DEK from
`randomBytes(32)` per `put`. IVs from `randomBytes(12)` per encryption. All
lengths and the version validated **before** any cipher runs. Transient DEK
buffers `fill(0)` in `finally`. `keyId` via
`hkdfSync("sha256", kek, "", "bayz-kek-id-v1", 16)`, compared with
`timingSafeEqual`. Any cipher throw becomes `secret_corrupt` with the OpenSSL
message discarded.

- [ ] **Step 4: Verify GREEN + typecheck**

- [ ] **Step 5: Commit** — `git commit -m "feat: add envelope encryption with per-secret DEKs"`

---

### Task 6: Migrations and database initialization

**Files:** Create `test/migrations.test.ts`, `test/database.test.ts`, `src/migrations.ts`, `src/database.ts`; modify `src/index.ts`.

**Interfaces:** `MIGRATIONS`, `TARGET_SCHEMA_VERSION`, `runMigrations(db)`, `readSchemaVersion(db)`, `openDatabase({ dataDir, driver })`.

- [ ] **Step 1: Write failing tests**

Migrations: fresh DB reaches `TARGET_SCHEMA_VERSION` with `schema_migrations`,
`secrets`, `runtime_metadata` present; second run applies **0** and leaves
`user_version` and the table set unchanged; `user_version` equals
`max(schema_migrations.version)`; `secrets.name` is `UNIQUE`; an invalid statement
leaves `user_version` at its prior value and creates none of that migration's
tables (atomicity); and **no** `providers`/`proxies`/`routes`/`combos`/`usage`
table exists — pinning "no speculative schema" as an executable test.

Database: `bayz.db` created; `foreign_keys` is `1` **and** an FK violation
actually throws; `busy_timeout` is `5000`; `journalMode` reported, `wal` where
supported; `ENOTDIR` parent ⇒ `storage_unavailable` whose message leaks neither
the path nor raw SQLite text.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement**

Schema exactly as spec §7. Each pending migration in `BEGIN IMMEDIATE` →
statements → `schema_migrations` row → `pragma user_version` → `COMMIT`, with
`ROLLBACK` and `storage_unavailable` stage `"migrate:<version>"` on error.
`user_version` interpolated only behind `Number.isInteger`; no external input
reaches it.

`openDatabase` order per spec §7: ensure dir → driver open → `foreign_keys` ON
(asserted, fatal) → `busy_timeout` → WAL best-effort with read-back →
`synchronous = NORMAL` → migrate.

- [ ] **Step 4: Verify GREEN + typecheck + full storage suite**

- [ ] **Step 5: Commit** — `git commit -m "feat: add transactional storage migrations"`

---

### Task 7: SecureSecretRepository, rotation, persistence, logging

**Files:** Create `test/secret-repository.test.ts`, `test/rotation.test.ts`, `test/persistence.test.ts`, `test/logging.test.ts`, `src/secret-repository.ts`; modify `src/index.ts`.

**Interfaces:** `SecureSecretRepository`, `SecretRecordMetadata`, `openSecretStorage({ dataDir, env, mode, driver })`.

- [ ] **Step 1: Write failing tests**

Repository: `put`/`get` round-trip; `put` twice upserts (no duplicate row,
`updated_at` advances, and the new row has a **different** DEK and IV); two
different names have different DEKs; `find` ⇒ `undefined` while `get` throws
`secret_not_found`; `list()` returns metadata and **no** field equal to the
plaintext; `delete` ⇒ `true` then `false`; a `put` failing mid-transaction leaves
the prior row intact and adds no partial row; direct SQL tampering of
`ciphertext`, `wrapped_dek`, or `tag` makes `get` throw `secret_corrupt`; a
malformed envelope (bad lengths) fails closed.

Rotation: after `rotateRootKey`, every secret reads under the new KEK and fails
under the old; `ciphertext` bytes are unchanged (rewrap-only); `active_key_id` in
`runtime_metadata` updated; a rotation that throws part-way leaves **every**
record readable by the **old** key.

Persistence: sentinel written, `close()`, reopened in the same `dataDir`, read
back; raw `bayz.db`, `-wal`, `-shm` bytes contain neither the sentinel plaintext
nor the KEK bytes; reopening with a different `BAYZ_MASTER_KEY` yields
`master_key_mismatch` or `secret_corrupt`, never plaintext.

Logging: capture the logger, exercise a full write/read/rotate cycle, and assert
the captured output contains no sentinel, no KEK hex, no DEK, and no passphrase.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement**

All SQL parameterized. `put` wraps upsert in `BEGIN IMMEDIATE`/`COMMIT` with
`ROLLBACK`. Encryption inside `put`, decryption inside `get`/`find`. No method
returns an envelope, a DEK, or a KEK. On open, compare the provider's `keyId`
against `active_key_id` and raise `master_key_mismatch` before touching
ciphertext. `rotateRootKey` rewraps every row in one transaction.

- [ ] **Step 4: Verify GREEN + typecheck**

- [ ] **Step 5: Commit** — `git commit -m "feat: add secure secret repository with key rotation"`

---

### Task 8: Core wiring, real-runtime proof, phase verification

**Files:** Create `apps/server/src/storage.ts`, `apps/server/test/storage.test.ts`, `scripts/storage-smoke.mjs`; modify `apps/server/{src/index.ts,package.json}`, `README.md`, `WORK-HANDOFF.md`.

**Interfaces:** `initializeStorage(config): StorageHandle`.

- [ ] **Step 1: Write failing server tests**

`initializeStorage` with a temp `dataDir` returns a handle whose `schemaVersion`
is the target and whose secret round-trip works; an unopenable `dataDir` raises
`storage_unavailable`; the message leaks neither the absolute path nor raw SQLite
text; and the regression guard — `GET /api/health` still returns exactly
`{status, version, uptimeSeconds}` with no storage field, so Phase 1's contract
and the dashboard stay untouched.

- [ ] **Step 2: Verify RED** — `node --import tsx --test apps/server/test/storage.test.ts`

- [ ] **Step 3: Implement and wire startup**

`storage.ts` calls `openSecretStorage` and logs, through `redactSecrets`, only
`{ schemaVersion, journalMode, driver, keyProvider, keyId, dataDir }`. `index.ts`
calls it before `listen`; a `StorageError` logs a redacted diagnostic and exits
non-zero without starting the listener. Add `@bayz/storage` to `apps/server`
dependencies. No new route; no `/api/health` change.

- [ ] **Step 4: Write and run the non-mocked smoke script**

`scripts/storage-smoke.mjs`, against a real on-disk DB, must:

1. create a fresh temp data dir;
2. open storage, write a sentinel, report schema version, journal mode, driver,
   provider kind, `keyId`;
3. close, reopen **in a separate child process**, read the sentinel back —
   proving cross-process persistence, not just in-process reuse;
4. scan `bayz.db`, `-wal`, `-shm` raw bytes for the sentinel and the KEK, failing
   if either is found;
5. scan captured log output for the sentinel, KEK, and DEK;
6. rotate the root key, then re-read every secret successfully;
7. confirm the old key now fails closed;
8. confirm a tampered ciphertext fails closed;
9. exit non-zero on any failure.

```bash
node scripts/storage-smoke.mjs
```

- [ ] **Step 5: Boot the real server**

Start the Core with a temp `BAYZ_DATA_DIR`, confirm it logs storage readiness and
serves `/api/health`, confirm `bayz.db` exists afterwards, and confirm the log
holds no secret. Use a free port if `20128` is occupied and record which.

- [ ] **Step 6: Document honestly**

Append a Phase 2 section to `README.md`: data dir, `BAYZ_MASTER_KEY`, the three
modes, and the threat-model ceiling from spec §13 including the "does not
protect" list. Update `WORK-HANDOFF.md` with Phase 2 state, deviations, and the
still-DEFERRED Sites build.

Do **not** describe the OS keystore, Argon2id, full anti-rollback, provider
storage, or any Phase 3+ feature as working.

- [ ] **Step 7: Run the completion gate**

```bash
npm run test --workspace @bayz/security
npm run test --workspace @bayz/storage
npm run test --workspace @bayz/server
node --test tests/runtime-structure.test.mjs
npm run runtime:verify
node scripts/storage-smoke.mjs
git diff --check
git status --short
```

- [ ] **Step 8: Commit** — `git commit -m "feat: wire Bayz secure storage into Core startup"`

## Phase completion checklist

- [ ] `@bayz/security`, `@bayz/storage`, `@bayz/server` tests pass; each `tsc --noEmit` exits 0.
- [ ] `npm run runtime:verify` exits 0 with every Foundation test still green.
- [ ] `node scripts/storage-smoke.mjs` exits 0 against a real database file.
- [ ] Persistence proven by reopening in a **separate process**.
- [ ] Sentinel plaintext absent from `bayz.db`, `-wal`, `-shm`, and all logs.
- [ ] KEK and DEK absent from the database and all logs.
- [ ] Two records provably use different DEKs.
- [ ] Identical plaintexts produce different ciphertext.
- [ ] Wrong KEK, tampered ciphertext, tampered wrapped DEK, tampered tag,
      unsupported version, and mismatched name all fail closed with `secret_corrupt`.
- [ ] Root-key rotation preserves readability; failed rotation leaves old state usable.
- [ ] Migrations idempotent; re-run applies zero, asserted.
- [ ] Failed write leaves no partial row or half-written envelope.
- [ ] Invalid data dir yields `storage_unavailable`, not raw SQLite text.
- [ ] `node:sqlite` imported in exactly one file, asserted by a source-scan test.
- [ ] `master.key` mode restrictive where the platform supports it.
- [ ] Redaction covers aliases and casing; non-secret neighbours untouched.
- [ ] No new dependency; Termux/ARM64 needs no native build.
- [ ] Default host `127.0.0.1`, port `20128`, data dir `~/.bayz` unchanged; remote off.
- [ ] No provider, proxy, route, combo, or usage schema or record introduced.
- [ ] `apps/dashboard` untouched; no storage/crypto path reachable from the UI.
- [ ] OS keystore, Argon2id, and anti-rollback documented as deferred, not working.
- [ ] `git diff --check` clean.
- [ ] No push to GitHub.
- [ ] Sites/UI build remains documented as DEFERRED, not as failing or passing.
