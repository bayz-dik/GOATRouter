# Bayz Router — Security and SQLite Storage Design (Fortress Architecture)

**Status:** Design / Phase 2 of the approved scope decomposition. Revision 2.
**Supersedes:** Revision 1 (single master key + flat AES-GCM). Revision 1's flat
key model is explicitly rejected below and must not be implemented.
**Phase 1:** `docs/superpowers/plans/2026-08-26-bayz-router-foundation.md` — complete and verified.
**Date:** 2026-08-26

## 1. Purpose and scope

Phase 1 produced a runnable Core with health, request tracing, safe error
envelopes, and a dashboard served from one process. It has no persistence and no
way to hold a secret.

Phase 2 adds:

1. A local SQLite storage layer behind a **driver adapter boundary**, with
   versioned idempotent migrations.
2. **Envelope encryption** with a per-secret Data Encryption Key wrapped by a
   Key Encryption Key, so compromising one record yields no key for any other.
3. A **KeyProvider abstraction** so key custody can move to OS-backed or
   passphrase-derived storage without touching crypto, repository, or domain code.
4. **Root-key rotation** that rewraps DEKs without ever writing plaintext
   secrets to disk.

Phase 2 ships **no** Provider Manager, **no** Proxy Manager, **no** routing, **no**
combos, **no** usage data, **no** new HTTP route, and **no** dashboard change.

### Non-goals

- No ORM, no query builder, no migration framework, no crypto library.
- No provider/proxy/route/combo/usage tables, no seed or demo rows.
- No OS keychain *implementation* (interface only — see §4).
- No native dependency of any kind.
- No claim of unhackability. See §13.

## 2. Storage driver boundary

Requirement: the repository and migrations must not depend directly on
`node:sqlite`, so a future release can add a `better-sqlite3 → node:sqlite →
sql.js` fallback chain without changing the repository or domain API.

The minimal synchronous surface actually needed:

```ts
export interface SqlStatement {
  run(...params: SqlParam[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: SqlParam[]): Record<string, SqlValue> | undefined;
  all(...params: SqlParam[]): Record<string, SqlValue>[];
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
  close(): void;
}

export interface SqlDriver {
  readonly name: string;              // "node:sqlite"
  open(filename: string): SqlDatabase;
}
```

`SqlParam` / `SqlValue` are `null | number | bigint | string | Uint8Array`, which
is the intersection all three candidate drivers support. Notably it excludes
`boolean`, which `node:sqlite` rejects — booleans are stored as `0`/`1` integers
at the repository layer, so the adapter contract stays honest.

Phase 2 implements exactly one driver: `nodeSqliteDriver` in
`src/drivers/node-sqlite.ts`. `better-sqlite3` and `sql.js` are **not**
implemented, not depended on, and not stubbed. `selectDriver()` returns the
Node driver and is the single place a future chain gets added.

Migrations, the repository, and crypto import only `SqlDatabase`/`SqlStatement`.
`node:sqlite` is imported in exactly one file, which a test asserts by scanning
sources.

Driver-thrown errors are translated at the adapter edge, so `ERR_SQLITE_ERROR`
text — which embeds absolute filesystem paths — never propagates.

### Driver choice for the first adapter

Verified on this machine (Node `v24.19.0`, `linux arm64`):

| Capability | Result |
| --- | --- |
| `node:sqlite` present | yes, SQLite `3.53.3` |
| `ExperimentalWarning` on import | none emitted |
| `pragma journal_mode=wal` | returns `wal` |
| `pragma foreign_keys=ON` | enforced; violation raises `ERR_SQLITE_ERROR` |
| `pragma busy_timeout` | settable, reads back |
| BLOB round-trip | `typeof=blob`, exact length |
| `BEGIN` / `ROLLBACK` | rolls back correctly |

`better-sqlite3` is rejected for the baseline: it needs `node-gyp`, a C++
toolchain, and an ABI-matched prebuild, which is routinely unavailable on
Termux/ARM64. `sql.js` avoids native builds but weakens WAL and file locking.
Neither is justified when the runtime already ships SQLite. `DatabaseSync` is
synchronous, which suits short, local, infrequent migration and secret access
and removes a class of interleaving bugs.

## 3. Key hierarchy — envelope encryption

Revision 1 used one key for every secret. That is rejected: it makes every
record a single-key compromise and makes rotation require decrypting and
rewriting every plaintext.

```text
KeyProvider
    │  supplies 32-byte Key Encryption Key (KEK), memory only
    ▼
KEK ── AES-256-GCM wrap ──►  wrappedDek + wrapIv + wrapTag     (in SQLite)
                                   │
                                   ▼ unwrap at read time
                            per-secret DEK (256-bit, memory only)
                                   │
                                   ▼ AES-256-GCM
                            ciphertext + iv + tag              (in SQLite)
```

Rules:

- Every `put` mints a **fresh random 256-bit DEK** via `randomBytes(32)`. DEKs
  are never shared between records and never reused across writes of the same
  name.
- Every encryption — both the secret and the DEK wrap — uses its own fresh
  96-bit `randomBytes(12)` IV. No IV is ever reused. No deterministic or
  convergent encryption anywhere.
- SQLite stores only: wrapped DEK, wrap IV, wrap tag, ciphertext, IV, tag, and
  non-secret metadata. A plaintext DEK is never persisted.
- Both GCM tags are verified on every read.
- **AAD binding.** The secret's `name` and `cipherVersion` are passed as GCM
  Additional Authenticated Data on both layers. Verified behavior: decryption
  with a different AAD fails. This makes a row's ciphertext cryptographically
  bound to its identity, so an attacker with write access to `bayz.db` cannot
  move a known-value envelope onto a different secret name (a confusion attack
  that plain GCM would allow).

Compromise containment: recovering one DEK — by any means — decrypts exactly one
record. Recovering the KEK is required to reach the rest.

## 4. KeyProvider abstraction

```ts
export type KeyProviderKind = "environment" | "passphrase" | "os-keystore" | "secure-file";

export interface KeyProvider {
  readonly kind: KeyProviderKind;
  readonly available: boolean;
  loadKek(): Buffer;                 // 32 bytes; throws master_key_invalid
  persistKek?(kek: Buffer): void;    // only for providers with durable custody
}
```

Resolution order for public release, highest custody first:

| Priority | Provider | Phase 2 status |
| --- | --- | --- |
| A | `EnvKeyProvider` — `BAYZ_MASTER_KEY` | **implemented** |
| B | `PassphraseKeyProvider` — operator unlock factor | **implemented**, opt-in (§10) |
| C | `OsKeystoreKeyProvider` — DPAPI / Keychain / Secret Service / Android Keystore | **interface only, deliberately unimplemented** |
| D | `SecureFileKeyProvider` — `<BAYZ_DATA_DIR>/master.key` | **implemented**, zero-config fallback |

Every OS-backed option needs a native module or a platform binary, which breaks
the zero-native-dependency Termux baseline. So `OsKeystoreKeyProvider` exists as
an interface and a `available: false` placeholder that throws if forced. It is
**not** faked and must not be described as working. It is scheduled for the
packaging/stabilization phase, where per-platform artifacts already exist and a
native optional dependency can be gated per platform.

The file fallback is a **compatibility fallback, not the architecture.**

`EnvKeyProvider` accepts 64-char hex or base64 decoding to exactly 32 bytes.
Malformed input raises `master_key_invalid` — never silently hashed, padded, or
truncated, because a caller who supplied a bad key must be told rather than
quietly handed a different key.

`SecureFileKeyProvider` generates `randomBytes(32)` and writes with
`{ flag: "wx", mode: 0o600 }` — exclusive create, so a concurrent start cannot
clobber an existing key. On read it checks the mode where the platform reports
one and **warns** (not fails) if the file is group/world-readable, since some
Android and FAT-derived mounts cannot represent POSIX modes and a hard failure
would make BAYZ unusable there. The warning names the path, never the key.

## 5. Versioned crypto envelope

```ts
export type SecretEnvelope = {
  version: 1;                    // envelope format
  algorithm: "aes-256-gcm";      // both layers
  kdf: "none" | "scrypt";        // how the KEK was derived, for rotation logic
  keyId: string;                 // NON-SECRET KEK fingerprint, see §9
  wrappedDek: Uint8Array;
  wrapIv: Uint8Array;
  wrapTag: Uint8Array;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
};
```

The metadata is sufficient to migrate the algorithm, rotate the KEK, re-encrypt
old records, and detect format corruption. Phase 2 reads only `version: 1` and
rejects any other value as `secret_corrupt`. A record whose lengths are wrong
(IV ≠ 12, tag ≠ 16, DEK unwrap ≠ 32) is rejected before any cipher runs.

## 6. Key rotation

```ts
rotateRootKey(next: KeyProvider): { rotated: number; keyId: string };
```

Algorithm: for each secret row, unwrap the DEK with the **old** KEK, rewrap the
same DEK with the **new** KEK, and write back the new `wrappedDek`, `wrapIv`,
`wrapTag`, and `keyId`. The secret ciphertext, IV, and tag are untouched because
the DEK and algorithm did not change.

Consequences, all of which are the point of the hierarchy:

- No plaintext secret is ever produced, held, or written during rotation.
- Cost is O(rows) tiny wraps, not O(bytes) re-encryption.
- The whole rotation runs in one `BEGIN IMMEDIATE` transaction. On any failure it
  rolls back, leaving every row readable by the **old** key — a failed rotation
  degrades to "nothing happened", never to a half-rotated unreadable database.
- The active `keyId` in `runtime_metadata` is updated in the same transaction.

Rotation is invoked programmatically in Phase 2 and covered by tests. No HTTP
route or dashboard control is added for it.

## 7. Filesystem, database, migrations

- Database: `<BAYZ_DATA_DIR>/bayz.db`. Key file: `<BAYZ_DATA_DIR>/master.key`.
  `BAYZ_DATA_DIR` default stays `~/.bayz`.
- Data dir created `mkdirSync(recursive, mode 0o700)`, then best-effort chmod.
  Mode failures are tolerated (Android mounts); nothing relies on the mode for
  correctness — it is defense in depth.
- Open sequence: ensure dir → open via driver → `foreign_keys = ON` (asserted,
  fatal if it fails) → `busy_timeout = 5000` → `journal_mode = WAL`
  (**best-effort**, read back whatever resulted) → `synchronous = NORMAL` →
  migrate.
- Migrations are an ordered array `{ version, statements[] }`. The runner reads
  `pragma user_version`, applies only greater versions ascending, and records
  each in `schema_migrations` for audit. Both must agree.
- Each migration runs in `BEGIN IMMEDIATE` … `COMMIT` with `ROLLBACK` on error,
  and sets `user_version` **inside the same transaction** — that is what makes it
  atomic. A failed migration leaves no partial schema.
- Re-running is a no-op: the second pass applies zero migrations. Asserted.
- `pragma user_version` cannot be parameterized; the value is interpolated only
  behind an `Number.isInteger` guard and never derives from external input.

Schema, migration version 1:

```sql
CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE secrets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL UNIQUE,
  version      INTEGER NOT NULL,
  algorithm    TEXT    NOT NULL,
  kdf          TEXT    NOT NULL,
  key_id       TEXT    NOT NULL,
  wrapped_dek  BLOB    NOT NULL,
  wrap_iv      BLOB    NOT NULL,
  wrap_tag     BLOB    NOT NULL,
  ciphertext   BLOB    NOT NULL,
  iv           BLOB    NOT NULL,
  tag          BLOB    NOT NULL,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);

CREATE TABLE runtime_metadata (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

`secrets.name` is a namespaced identifier; Phase 3 will use shapes like
`provider:<id>:api_key`. Phase 2 documents the convention and creates no such
row. There is no `providers`, `proxies`, `routes`, or `usage` table — a test
asserts their absence so speculative schema cannot creep in.

## 8. Repository boundary

```ts
export interface SecureSecretRepository {
  put(name: string, plaintext: string): void;
  get(name: string): string;               // throws secret_not_found
  find(name: string): string | undefined;
  list(): SecretRecordMetadata[];          // metadata only, never plaintext
  delete(name: string): boolean;
  rotateRootKey(next: KeyProvider): { rotated: number; keyId: string };
  close(): void;
}
```

Mandatory layering (requirement 14):

```text
Domain (Provider Manager, Proxy Manager, Router, Usage, UI)
        ▼   knows only this interface
SecureSecretRepository
        ▼
CryptoEnvelope (DEK/KEK, GCM, AAD)
        ▼
KeyProvider + SqlDatabase
        ▼
SQLite adapter (node:sqlite today)
```

Provider Manager, Proxy Manager, Router, Usage, and UI must never know how
encryption works. They receive and return plain strings; they never see an
envelope, a DEK, or a KEK. `list()` returns metadata only — there is
deliberately no bulk-plaintext path, because that is the most likely future
source of a leak.

`get` throws `secret_not_found` rather than returning a falsy value so a caller
cannot confuse "absent" with "empty secret". `find` covers the genuinely
optional case.

`put` is an upsert inside `BEGIN IMMEDIATE`/`COMMIT` with `ROLLBACK` on error,
so a failed write cannot leave a partial or half-written envelope.

## 9. Integrity and anti-rollback metadata

`runtime_metadata` records, all non-secret:

- `crypto_format_version` — envelope format in use.
- `active_key_id` — KEK fingerprint.
- schema version, mirroring `user_version`.

`keyId` is computed as `hkdfSync("sha256", kek, salt="", info="bayz-kek-id-v1",
16)` rendered hex, prefixed `kek_`. HKDF is one-way, the output is 16 bytes, and
the info string is domain-separated, so the identifier permits no practical key
recovery while still detecting "you started with the wrong key" before any
ciphertext is touched. Comparison uses `timingSafeEqual`.

A mismatch between `active_key_id` and the supplied KEK raises
`master_key_mismatch` at startup — a clear, safe signal instead of a confusing
cascade of `secret_corrupt` failures.

**Honest limit:** this detects accidental key mismatch and casual tampering. It
is **not** rollback protection. An attacker with write access to `bayz.db` can
restore an older file wholesale, and nothing in a plain local SQLite file can
prevent that. Real anti-rollback needs OS-backed monotonic secure storage; it is
recorded here as a future hardening capability and must not be presented as
available.

## 10. Operating modes

| Mode | KEK custody | Phase 2 |
| --- | --- | --- |
| `STANDARD` (default) | `SecureFileKeyProvider`, zero config | implemented |
| `SECURE` | `EnvKeyProvider`, or OS keystore when it exists | env implemented; keystore interface only |
| `FORTRESS` | `PassphraseKeyProvider`, KEK only in process memory, locked on restart | implemented, opt-in |

`STANDARD` stays the default because the runtime must remain usable with no
configuration.

**Fortress KDF.** `scryptSync` is memory-hard, in-tree, vetted, and needs no
native dependency. Measured on this ARM64 device:

| Params | Time | Memory |
| --- | --- | --- |
| N=2¹⁴, r=8, p=1 | 49 ms | 16 MiB |
| N=2¹⁵, r=8, p=1 | 95 ms | 32 MiB |
| **N=2¹⁶, r=8, p=1** | **194 ms** | **64 MiB** |
| N=2¹⁷, r=8, p=1 | 393 ms | 128 MiB |

Phase 2 selects **N=2¹⁶, r=8, p=1, 32-byte output, 16-byte random salt**. 194 ms
and 64 MiB is a real cost for an attacker while staying tolerable on a phone.
Parameters are stored in `runtime_metadata` so they can be raised later without
guessing how an existing KEK was derived.

PBKDF2/SHA-256 is explicitly rejected as a final design: it is not memory-hard.
Argon2id would be preferable on paper but every Node binding is native, which
breaks the Termux baseline; the `kdf` envelope field exists precisely so Argon2id
can be added when a compatibility plan exists. `scrypt` is a genuine implementation,
not a placeholder.

Fortress additionally implies stricter network defaults: remote access stays off
and no unlock factor is ever accepted over HTTP in this phase.

## 11. Secret lifetime and memory hygiene

- Plaintext is materialized only inside `put`/`get`, only when asked for.
- No plaintext credential cache, no plaintext in module or global state.
- No plaintext crosses into React, the dashboard, or any API response. Future
  credential responses expose masked metadata only.
- Key material is held in `Buffer`, and transient DEK and KEK buffers are
  `fill(0)` in a `finally` block once used. Verified that `Buffer.fill(0)`
  observably clears the bytes.
- Secret-bearing objects are never `JSON.stringify`-ed for debugging.

**Honest limit:** JavaScript cannot guarantee zeroization. The garbage collector
may copy a `Buffer`, V8 may retain intermediate `string` values, and strings are
immutable so a plaintext `string` cannot be wiped at all. Zeroing reduces the
window; it does not close it. Any claim of guaranteed erasure would be false.

## 12. Errors, logging, redaction

```ts
type StorageErrorCode =
  | "storage_unavailable"
  | "master_key_invalid"
  | "master_key_mismatch"
  | "secret_not_found"
  | "secret_corrupt";
```

**Fail closed.** Wrong KEK, corrupt wrapped DEK, modified ciphertext, invalid
auth tag on either layer, unsupported version, wrong-length field, truncated
record, or malformed envelope all raise `secret_corrupt`. The code never returns
`""`, never returns `null`, never falls back to plaintext, never silently resets
a credential, and never treats corruption as an empty credential.

Raw `ERR_SQLITE_ERROR` and raw OpenSSL messages are caught at the boundary and
replaced with a fixed safe message derived from code and stage only. The original
is **not** attached as `cause`, because several loggers serialize `cause`.

Phase 1's error handler already returns a fixed `internal_error` / `"Request
failed"` envelope for anything uncaught, so a `StorageError` reaching an HTTP
path cannot leak to a client. Phase 2 does not weaken it.

`@bayz/security` `redactSecrets` is **extended** (not duplicated) to cover
`authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `apikey`,
`api_key`, `api-key`, `password`, `proxypassword`, `proxy_password`, `token`,
`accesstoken`, `access_token`, `refreshtoken`, `refresh_token`, `clientsecret`,
`client_secret`, `masterkey`, `master_key`, `privatekey`, `private_key`,
`secret`, `credential`, plus `dek`, `kek`, `wrappeddek`, `passphrase`, and
`ciphertext`. Matching normalizes case and `-`/`_` so alias and casing variants
are caught. Existing Phase 1 redaction tests must stay green.

Never logged, under any level: KEK, DEK, `BAYZ_MASTER_KEY`, passphrase, plaintext
credential, or a full authorization header.

## 13. Threat model — truthful

**Protects against:**

- A stolen `bayz.db`, or a stolen backup/sync/cloud snapshot of it: rows hold
  only ciphertext and KEK-wrapped DEKs.
- Database inspection by anyone with read access to the file but not the KEK.
- Ciphertext modification: both GCM tags plus AAD binding make tampering a
  detected failure, not a silent wrong value.
- Envelope relocation between records, via AAD name binding.
- One-record compromise: a leaked DEK decrypts exactly one secret.
- Accidental disclosure through logs, error envelopes, or API responses.
- Wrong/rotated root key: detected up front via `keyId`, with rotation that never
  materializes plaintext and rolls back cleanly on failure.

**Does NOT protect against:**

- An attacker with active root or kernel control of the device — they can read
  `master.key` (mode `0o600` stops other unprivileged users, not root), read the
  environment, or dump process memory while secrets are unlocked.
- Malicious code running inside the BAYZ process.
- A compromised dependency or build pipeline.
- Hardware or OS compromise while secrets are unlocked.
- Rollback of the database file to an earlier state (§9).
- Anyone who obtains `BAYZ_MASTER_KEY` from the environment or shell history, or
  the Fortress passphrase.

Fortress mode narrows the at-rest window by keeping the KEK out of persistent
storage entirely, at the cost of an unlock on every start. It does not change any
"does not protect" item above.

BAYZ is not unhackable. No such claim is made anywhere in this design.

## 14. Server integration

`apps/server/src/storage.ts` is thin wiring: `initializeStorage(config)` selects
the provider, opens storage, and logs — through `redactSecrets` — only
`{ schemaVersion, journalMode, keyProvider, keyId, dataDir, driver }`. Never a
key, never a secret. `src/index.ts` calls it before `listen`; a `StorageError`
logs a redacted diagnostic and exits non-zero rather than serving with no storage.

Deliberately **not** added: any HTTP route, any storage field on `/api/health`
(its Phase 1 shape is depended on by Phase 1 tests and the dashboard), and any
dashboard change. The dashboard has no path to the storage or crypto layer.

Default host `127.0.0.1`, default port `20128`, remote access off by default —
all unchanged.

## 15. Test plan

Mapping requirement 12 to tests:

| Requirement | Test |
| --- | --- |
| identical plaintexts → different ciphertext | `crypto.test.ts` |
| two records have different DEKs | `secret-repository.test.ts` (compare unwrapped DEKs) |
| DB bytes contain no plaintext | `persistence.test.ts` (scan `.db`, `-wal`, `-shm`) |
| wrong KEK fails | `crypto.test.ts`, `persistence.test.ts` |
| tampered ciphertext fails | `crypto.test.ts` |
| tampered wrapped DEK fails | `crypto.test.ts` |
| tampered auth tag fails (both layers) | `crypto.test.ts` |
| unsupported crypto version fails | `crypto.test.ts` |
| AAD/name binding enforced | `crypto.test.ts` |
| rotation preserves readability | `rotation.test.ts` |
| failed rotation leaves old state usable | `rotation.test.ts` |
| repeated migration safe | `migrations.test.ts` |
| records survive close/reopen | `persistence.test.ts` |
| plaintext never in logged output | `logging.test.ts`, smoke script |
| redaction covers aliases/casing | `packages/security/test/redact.test.ts` |
| `master.key` permissions restrictive | `key-provider.test.ts` |
| transaction failure leaves no half envelope | `secret-repository.test.ts` |
| malformed envelope fails closed | `crypto.test.ts`, `secret-repository.test.ts` |
| driver boundary respected | `driver-boundary.test.ts` (source scan) |
| no speculative schema | `migrations.test.ts` |
| Foundation stays green | `npm run runtime:verify` |

Plus a **non-mocked runtime proof**: a script against a real on-disk database
that writes a sentinel, closes, reopens in a fresh process, reads it back, greps
raw `.db`/`-wal`/`-shm` bytes and captured logs for the sentinel and the key,
rotates the root key and re-reads, and confirms a wrong key fails closed. Mocked
tests alone do not satisfy the completion gate.

## 16. Compatibility

- Node.js 24+ (`node:sqlite` does not exist in Node 20).
- **Zero new dependencies**, runtime or dev. Nothing to compile on Termux/ARM64.
- One process, local-first. Host `127.0.0.1`, port `20128`, data dir `~/.bayz`.
- All crypto from `node:crypto`: AES-256-GCM, `randomBytes`, `scryptSync`,
  `hkdfSync`, `timingSafeEqual`.

## 17. Self-review

- **Crypto ambiguity** — Algorithm, key sizes, IV sizes, tag sizes, AAD content,
  and KDF parameters are all pinned to exact values above. Both layers are named.
- **Key lifecycle** — Provider → KEK (memory) → per-write DEK (memory) → wrapped
  DEK (disk). Zeroing and its JS limits stated in §11.
- **Rotation** — Rewrap-only, transactional, no plaintext, degrades to no-op.
- **Corruption semantics** — One code, `secret_corrupt`, for every failure class,
  enumerated in §12, with an explicit prohibition on empty-string fallback.
- **Termux compatibility** — Zero native deps; scrypt cost measured on ARM64;
  chmod tolerated as best-effort; OS keystore honestly deferred.
- **Migration safety** — `user_version` set inside the migration transaction;
  idempotence asserted; no speculative tables.
- **Accidental plaintext paths** — Audited: `list()` returns metadata only, no
  method returns an envelope, no plaintext in logs/errors/API/dashboard,
  redaction extended with aliases, and a test greps raw DB bytes and log output.
- **Known residual risks** — Rollback of the DB file, root-level attackers, and
  guaranteed memory zeroization. All three documented as *not* protected rather
  than papered over.

## 18. Deferred, and honestly labeled

- `OsKeystoreKeyProvider` — interface only; needs per-platform native support.
- Argon2id KDF — awaits a Termux-safe binding; `kdf` field reserved.
- Full anti-rollback — needs OS monotonic secure storage.
- Key rotation *UI/route* — the API exists and is tested; no operator surface.
- Provider/proxy/route/combo/usage schemas — their own phases.
- The private BAYZ Sites/UI source is still absent from this workspace, so the
  root Sites build remains **DEFERRED** from Phase 1. Not a Phase 2 regression,
  and Phase 2 does not attempt to recreate that UI.
