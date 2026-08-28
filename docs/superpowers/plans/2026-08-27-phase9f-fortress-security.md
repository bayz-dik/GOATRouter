# Phase 9F — Fortress / GOAT Security Expansion

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Spec:** `docs/superpowers/specs/2026-08-27-bayz-phase9-goat-release-design.md` §10

**Depends on:** Tasks 1, 3, 4, 5, and 8 depend on nothing and run fully parallel with 9C, 9D, and 9E. Tasks 2, 6, and 7 need the **scope vocabulary** from 9C Task 1, because `admin`-gated routes and the posture ladder's "no `admin` over the wire" rule cannot be expressed without it. The spec's dependency graph shows 9F as fully parallel; that is true at the *package* level (storage and security touch nothing of 9C's) but not at the *server route* level, so the honest ordering is: 9C Task 1 → 9F Tasks 2, 6, 7. If 9C has not landed, do 9F Tasks 1, 3, 4, 5, 8 first.

**Goal:** Defence in depth across the attack surfaces that actually exist, with honest boundaries where a guarantee is impossible.

**Locks:** No faked hardware or keychain support. No claim of JavaScript memory zeroization. No claim of rollback prevention without trusted monotonic storage. Remote exposure fails closed.

**Measured device reality:** this machine is Termux/Android ARM64 with no `secret-tool`, no `security`, and no `keyctl`. OS-keystore providers stay `available = false` here and are marked UNVERIFIED, not PASS.

---

### Task 1 — OS-backed key providers (honest availability)

**Modify:** `packages/storage/src/key-provider.ts`
**Create:** `packages/storage/src/keystore/{dpapi,keychain,secret-service}.ts`
**Test:** `packages/storage/test/os-keystore.test.ts`

**Deviation, as built:** four supporting modules were added beside the three named
adapters — `keystore/exec.ts` (the single `node:child_process` choke point),
`keystore/adapter.ts` (shared probe/load/store lifecycle), `keystore/material.ts`
(hex encode/decode with strict rejection), `keystore/support.ts` (the platform
matrix), and `keystore/index.ts`. The `exec.ts` split is what makes the
"no interpolated command" rule mechanically checkable: the source scan asserts
`exec.ts` is the **only** file in the directory importing `node:child_process`, so
no adapter can quietly grow a shell string later.

- [x] RED `os-keystore.test.ts`: each provider reports `available` by **probing the platform**, not by reading `process.platform` alone — a Linux box without a Secret Service reports unavailable; on this device all three report `available: false` and `loadKek()` throws `master_key_invalid`; `resolveKeyProvider` with mode `FORTRESS` prefers an available OS provider and falls back to passphrase with a logged reason (metadata only); a provider that claims availability but fails to load raises rather than silently generating a key; no provider shells out through a string-interpolated command (source scan for `exec(` with template literals).
- [x] RED same file: the platform matrix is recorded as data — `keystoreSupport()` returns per-platform `IMPLEMENTED | UNVERIFIED | N/A`, and this device yields `UNVERIFIED` for all three.
- [x] Verify RED. First run failed to import (`does not provide an export named 'DpapiKeyProvider'`), then 16/17 with the keychain write asserting the wrong stdin shape.
- [x] GREEN. Use `node:child_process.execFile` with an argument array, never a shell string.
- [x] Verify: `npm run test --workspace @bayz/storage` exits 0 (**202/202**, up from 185); `node scripts/storage-smoke.mjs` still **42/42**; `tsc --noEmit -p packages/storage` exit 0; `@bayz/providers` 276/276 and `@bayz/server` 252/252 unaffected.
- [x] Commit — `feat: add OS-backed Bayz key providers with honest availability`

**Findings worth carrying forward:**
- A store that accepts a write and then holds nothing is the one failure that
  silently destroys data, so `loadKek()` **reads back and compares** what it just
  wrote (`*-store-unconfirmed`, `*-store-mismatch` stages) instead of trusting a
  zero exit status.
- `secret-tool lookup` signals "no such item" with a non-zero status and *no*
  output. Treating every non-zero status as "empty store" would mint a fresh key
  on a transient D-Bus failure and orphan every ciphertext, so only a silent
  non-zero counts as absent; anything with a diagnostic raises.
- Secret material never enters argv — `/proc/<pid>/cmdline` and `ps` are readable
  by other processes — so `secret-tool store` takes it on stdin and the Keychain
  write goes through `security -i` rather than `-w <password>`.
- DPAPI is a wrapping API, not a named store, so the sealed blob is written to
  `master.key.dpapi` at 0600. A blob that exists but will not unwrap (different
  user, different machine, corruption) **raises**; generating a new key there
  would leave every existing secret undecryptable.
- Android is `N/A`, not `UNVERIFIED`: the Keystore is reachable from the Android
  framework and not from Node, so there is nothing left to verify rather than
  something written but unproven.
- The FORTRESS downgrade log is threaded through `openSecretStorage`'s existing
  `logger`, so the "running on a derived key, not platform custody" signal reaches
  an operator instead of being swallowed at the resolver.

### Task 2 — Root-key rotation surface and audit

**Modify:** `apps/server/src/routes/identities.ts` (or a new `apps/server/src/routes/security.ts`), `packages/storage/src/secret-repository.ts`
**Test:** `apps/server/test/key-rotation-api.test.ts`

**Route:** `POST /api/security/rotate-root-key` (scope `admin`)

**Deviation, as built:** the surface needed three things the plan did not name, each
found by making the test pass honestly rather than by inspection.

1. **A `RotatableKeyProvider` capability, not an attempt-and-see.** `rotateRootKey(next)`
   takes a caller-supplied provider, which is wrong for an HTTP surface twice over: an
   admin must not choose the key, and environment/passphrase custody cannot persist a
   replacement at all. `rotateManagedRootKey()` mints the key inside custody, and
   `canRotateRootKey` lets the route refuse **before reading a row**, so the refusal is a
   genuine no-op rather than a half-rotation reported as an error.
2. **Two-phase key promotion.** Rotation spans a file and a database and nothing here
   can move both at once. The replacement is written to `master.key.next` *before* the
   rewrap, and promoted by `rename(2)` *after* the commit. `openSecretStorage` now
   recovers the crash-between-those-two window by promoting a staged key **only** when
   its fingerprint matches the recorded `active_key_id`. Without this, a crash in that
   window left every secret permanently unreadable.
3. **`storage.keyId` became a getter.** It was a captured value, so after a rotation
   `/api/status` would have reported the superseded fingerprint — telling an operator
   the rotation had not happened. The test that pins status agreement is what caught it.

Migration **v11** adds `security_audit`, kept separate from `identity_audit` because
the subject differs: one records what a client credential did, the other what happened
to the deployment's own custody. Folding them together would have meant an
`identity_id` foreign key on a row that refers to no identity.

- [x] RED `key-rotation-api.test.ts`: rotation requires `admin`; it rewraps every secret and every secret still decrypts afterwards; the old root key stops working; a failed rotation leaves **every** secret readable by the old key (atomicity, already guaranteed by `rotateRootKey` — this pins it at the API level); the response carries the new `keyId` fingerprint and no key material; an audit row records the rotation with counts and timestamps, no key; rotating twice in a row works.
- [x] RED same file: stale-key detection — a database whose `active_key_id` disagrees with the provider's key yields `master_key_mismatch` at open, before any ciphertext is touched (pins the Phase 2 behaviour at this layer).
- [x] Verify RED. The file survived a SIGKILL mid-RED and was recovered: 1/8 passing, and its fixtures used a `kind: "openai"` and a `credential` field neither of which exists, so it failed on setup rather than on the assertions. Fixtures corrected to the real `openai-compatible` + `setCredential` custody path; no assertion weakened.
- [x] GREEN.
- [x] Verify: `npm run test --workspace @bayz/server` exits 0 (**260/260**, up from 252); `npm run test --workspace @bayz/storage` exits 0 (**202/202**); `tsc --noEmit` clean for both; `node scripts/storage-smoke.mjs` 42/42; `node scripts/api-smoke.mjs` 70/70.
- [x] Commit — `feat: add a Bayz root-key rotation surface with audit`

**Findings worth carrying forward:**
- Two pinned counts moved and both were *supposed* to: `migrations.test.ts` gained
  `security_audit` in its exact table list, and `scope-enforcement.test.ts` went 41 → 43
  `/api/*` routes with both new routes declared `admin`. That is the enumeration doing
  its job — a route added without a scope decision fails there.
- The v10 migration test hardcoded `runMigrations(db) === 1`, which the ledger rule
  forbids. It now counts migrations above v9 so a later phase does not break it.
- `@bayz/providers` `slow-loris` and `@bayz/proxy` `never answers` are **pre-existing
  timing flakes**, measured at 1-in-3 failures on `851dc68` with this work stashed.
  Not regressions, and not fixed here; recorded so they are not rediscovered as new.

### Task 3 — Credential rotation, revocation, cryptographic erasure

**Modify:** `packages/providers/src/manager.ts`, `packages/proxy/src/manager.ts`
**Test:** `packages/providers/test/credential-lifecycle.test.ts`,
`packages/proxy/test/password-lifecycle.test.ts`

**Deviation, as built — the WAL caveat was understated, and measuring it found a
real defect.** The plan said to assert that deleted ciphertext "may still exist in
the WAL until checkpoint" and to comment that flash cannot be securely overwritten.
A probe of the actual on-disk bytes showed something worse: with SQLite's default
`secure_delete = 0`, deleting a secret left its superseded page in the WAL and the
next checkpoint **copied that page into `bayz.db`**, where it persisted indefinitely.
The exposure was not a transient WAL window; it was permanent recoverable ciphertext
in the main database file.

`openDatabase` now sets `PRAGMA secure_delete = ON`, measured to remove the bytes
from both files after a checkpoint. Two things this deliberately does **not** become:

- It is **not** a secure-overwrite claim. The physical NAND page is not rewritten in
  place by this or by anything reachable from Node; the FTL may retain the old page
  until wear levelling reclaims it. Stated in the code and in the test.
- It does **not** replace the erasure guarantee. That is still cryptographic — the
  wrapped DEK is gone, so surviving bytes cannot be decrypted. `secure_delete` only
  removes a needless forensic exposure that one pragma was already able to close.

No manager code needed changing: per-write DEK/IV freshness, pre-transaction
validation, and credential-deletion-before-row-deletion were already correct, and the
tests now pin all three rather than leaving them incidental.

- [x] RED `credential-lifecycle.test.ts`: replacing a credential produces a **new DEK and IV** (assert via `inspect()` that `wrappedDek` and `iv` both changed); deleting a credential removes the row so the ciphertext is unrecoverable — the honest erasure guarantee; after deletion the old ciphertext bytes may still exist in the WAL until checkpoint, and the test **asserts that fact** rather than claiming otherwise, with a comment explaining flash storage cannot be securely overwritten from Node; a revoked credential fails the next request with `credential_missing`, not with a stale success; rotation is atomic — a mid-write failure leaves the previous credential intact.
- [x] RED `password-lifecycle.test.ts`: proxy parity, plus a revoked password failing `agentFor` **before a socket is opened** (a SOCKS5 greeting that offers username/password and cannot supply one would hang or, worse, downgrade to no-auth) and a password without a username refused rather than stored as dead state.
- [x] Verify RED. 8/10 on the provider file; both failures genuine, not fixture faults — the checkpoint assertion and the `secure_delete` pin.
- [x] GREEN.
- [x] Verify: `npm run test --workspace @bayz/providers` exits 0 (**286/286**, up from 276) and `--workspace @bayz/proxy` exits 0 (**112/112**, up from 105); `@bayz/storage` 202/202, `@bayz/router` 276/276, `@bayz/server` 260/260 unaffected; three `tsc --noEmit` clean; `storage-smoke` 42/42, `proxy-smoke` 39/39, `provider-smoke` 36/36.
- [x] Commit — `feat: add Bayz credential rotation with honest erasure semantics`

**Findings worth carrying forward:**
- A 25-round rotation sweep asserting 25 distinct wrapped DEKs and 25 distinct IVs is
  cheap and catches the one bug that would be catastrophic and invisible: an IV reused
  under a single key. A single before/after comparison would not have caught a
  counter-style IV.
- Deleting a *provider* must delete its credential first, and deleting a *proxy* its
  password, or the secret is orphaned — undeletable through any API, because the
  resource it was scoped to no longer exists. Both directions are now pinned.

### Task 4 — Encrypted export and import

**Create:** `packages/storage/src/portable.ts`
**Test:** `packages/storage/test/portable.test.ts`

**Interface produced:** `exportSecrets(storage, passphrase): Uint8Array`, `importSecrets(storage, blob, passphrase, { replace? }): { imported: number }`

**Blob layout:** `BAYZEXP1` magic ‖ version byte ‖ 16-byte salt ‖ 12-byte IV ‖ 16-byte
GCM tag ‖ ciphertext. The header is passed as AAD, so the version cannot be edited to
steer a future reader down a different parse without failing the tag.

**Two assertions beyond the plan text, both deliberate:**

1. **Secret *names* are inside the sealed region, not just their values.** The plan
   required no plaintext in the blob. A backup whose header leaked
   `provider:openai:api_key` would tell an attacker exactly what the deployment holds
   and which credentials are worth targeting, so the entire payload is sealed.
2. **Two exports of identical content must produce different bytes.** Identical output
   would mean a fixed salt or a reused IV, and a reused IV under one derived key leaks
   the XOR of both payloads. A round-trip test alone would never catch that.

**Deviation, as built:** a wrong passphrase and a tampered blob are indistinguishable
at the GCM tag, so both raise `master_key_invalid` rather than `secret_corrupt` —
nothing *stored* is corrupt, the supplied key is simply wrong. A blob that is not an
export at all is refused on its magic with a distinct stage instead, because "this
file is not a BAYZ export" and "your passphrase is wrong" are different operator
problems with different remedies.

- [x] RED `portable.test.ts`: an export blob is AES-256-GCM sealed under a scrypt-derived key using the Phase 2 `SCRYPT_PARAMS`; the plaintext of no secret appears in the blob bytes; a wrong passphrase fails with `master_key_invalid` and imports nothing; a bit-flipped blob fails closed; an import into a database with an existing secret of the same name refuses by default and replaces only with an explicit flag; the blob carries a format version and an unknown version is refused; the blob contains no root key.
- [x] Verify RED. Failed at module load — `exportSecrets` did not exist — which is the correct RED for a new module.
- [x] GREEN.
- [x] Verify: `npm run test --workspace @bayz/storage` exits 0 (**216/216**, up from 202); `tsc --noEmit -p packages/storage` exit 0; `node scripts/storage-smoke.mjs` still 42/42.
- [x] Commit — `feat: add encrypted Bayz secret export and import`

**Findings worth carrying forward:**
- Import decrypts, parses, **and conflict-checks before writing a single row**. Without
  that ordering an attacker grinding passphrases would accumulate rows on the way, and
  a single name collision would leave a half-restored database.
- The blob is deliberately **not** root-key-bound: it re-seals plaintext, so it
  restores into a database with a different root key. That is the whole purpose of a
  backup, and it is why the passphrase carries the full Phase 2 scrypt cost — offline
  ciphertext an attacker can grind at leisure needs *at least* the hardness the live
  root key gets.
- `storage.get` rather than `find` when collecting: a corrupt row must fail the export
  instead of being silently dropped, or the backup is quietly incomplete.
- An empty database exports to a valid, importable blob reporting `imported: 0`. An
  operator backing up before configuring anything should not get something
  indistinguishable from a corrupt file.

### Task 5 — Tamper evidence and rollback detection

**Create:** `packages/storage/src/integrity.ts`
**Modify:** `packages/storage/src/database.ts`, `packages/storage/src/secret-repository.ts`
**Test:** `packages/storage/test/tamper.test.ts`

**Deviation, as built — ordering was the real problem, not the digest.** The plan put
the `user_version` check alongside the migration hash chain. That does not work:
`runMigrations` decides what to apply *from* `user_version`, so by the time any
post-migration check could speak the damage is done. A version edited **down** re-runs
migrations over an existing schema (failing with an opaque `exec` error on a duplicate
table), and one edited **up** silently skips migrations that never ran. So
`verifyRecordedSchemaVersion` runs inside `openDatabase` **before** the runner, using
`schema_migrations` as the independent witness of what actually executed. The chain
digest is a separate, later check covering a different half of the attack.

Four independent mechanisms, each with its own distinct stage:

| Mechanism | Catches | Where |
|---|---|---|
| `verifyRecordedSchemaVersion` | edited `user_version`, forged/deleted audit row | before migrations |
| `migrationChain` | altered migration SQL, reordered migrations | after migrations |
| `checkRollback` | restored older `bayz.db` alone | at open, warning only |
| `configHmac` | out-of-band registry row edit | at open, warning only |

The chain hashes each migration's **version and its statements**, so a tampered build
that changed a migration's SQL while keeping its number is visible — hashing version
numbers alone would have missed it. Order-sensitivity is pinned too.

The config HMAC is keyed by HKDF from the KEK with its own info string. Keyed, not a
plain digest: an attacker who can edit rows can also edit a stored digest, so an
unkeyed hash would detect nothing. The derived key is not the KEK and cannot unwrap a
DEK. It closes 9C's residual risk — a valid `["admin"]` written straight into
`client_identities.scopes_json` is honoured by scope validation *because it is valid*,
and the HMAC is what makes it visible.

**Honest boundaries, asserted rather than claimed:**

- **A whole-directory rollback is NOT detected.** An attacker who restores `bayz.db`
  *and* `integrity.json` together defeats `checkRollback` entirely, and a test proves
  it instead of pretending otherwise. Prevention needs a monotonic counter in storage
  the attacker cannot rewrite — TPM, secure element, or trusted remote service — none
  of which exists on this target or is reachable from Node here.
- **Rollback and config tampering warn; they do not refuse.** Failing closed would turn
  a crash into an unbootable install, and the registries hold no secret whose exposure
  would justify that. Structural schema damage *does* refuse, because running domain
  SQL against an unknown shape is a different class of risk.
- **An unclean shutdown after a config change leaves a stale HMAC**, reported as
  `mismatch` indistinguishably from a genuine edit. Stated in the code, and the reason
  the verdict is a warning surface.

- [x] RED `tamper.test.ts`: a migration hash chain is stored in `runtime_metadata`; editing `user_version` out of band is detected at open and raises `storage_unavailable` with a distinct stage; a monotonic open counter increments each open and a **decrease** is detected and logged as a rollback warning; the warning is metadata only; a config HMAC over the provider/proxy/route registry detects an out-of-band row edit; **the test asserts that an attacker restoring an older whole database is only detected, never prevented**, with a comment naming the missing primitive (trusted monotonic storage).
- [x] Verify RED. 3/15 passing, then 14/15, then 15/16 — each failure a real gap: the chain was checked too late for `user_version`, and a forged audit row needed the agreement check rather than the digest.
- [x] GREEN. 17 tests.
- [x] Verify: `npm run test --workspace @bayz/storage` exits 0 (**233/233**, up from 216); `node scripts/storage-smoke.mjs` exits 0 (42/42); `tsc --noEmit` clean; `@bayz/providers` 286, `@bayz/proxy` 112, `@bayz/router` 276, `@bayz/server` 260, `@bayz/identity` 69, `@bayz/telemetry` 55 all unaffected; `api-smoke` 70/70, `router-smoke` 46/46, `usage-smoke` 119/119.
- [x] Commit — `feat: add Bayz tamper evidence and rollback detection`

**Findings worth carrying forward:**
- `storage_ready` gained a `configIntegrity` field, so the pinned key set in
  `logging.test.ts` moved by one. That guard exists to stop content leaking into
  diagnostics; the verdict is a three-value enum with no row data and no key material.
- The canonical config serialization uses **explicit column lists**, not `SELECT *`. A
  later migration adding a column would otherwise change the fingerprint and turn every
  upgrade into a false tamper alarm.
- A corrupt or hand-edited `integrity.json` is treated as absent rather than fatal: it
  is evidence, not custody, and refusing to start over it would convert a detection aid
  into a denial of service.

### Task 6 — Security posture ladder

**Create:** `apps/server/src/posture.ts`
**Modify:** `apps/server/src/config.ts`, `apps/server/src/index.ts`, `apps/server/src/auth.ts`
**Test:** `apps/server/test/posture.test.ts`

| Posture | Bind | Mandatory |
|---|---|---|
| `loopback` | `127.0.0.1`, `::1` | token |
| `lan` | private range | token + TLS + tightened limits + no `admin` over the wire |
| `remote` | anything else | token + TLS + (mTLS or request signing) + strict limits + explicit opt-in |

- [ ] RED `posture.test.ts`: the posture is derived from the bind address, not from a flag; `lan` without TLS is a **startup failure**, not a warning; `remote` without mTLS or signing is a startup failure; `remote` without `BAYZ_ALLOW_REMOTE` is a startup failure (existing behaviour, pinned); a generated token is refused for `lan` and `remote` (existing behaviour, extended); `lan` and `remote` tighten the rate limit and add a concurrency cap; `admin` scope is rejected over a non-loopback connection even with a valid admin key; the posture appears in `/api/status` as a string; binding loopback keeps today's behaviour exactly (regression guard).
- [ ] RED same file: **no silent downgrade** — enumerate every mandatory protection per posture and assert each absence produces a distinct startup error naming what is missing.
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/server` exits 0; `node scripts/api-smoke.mjs` still 62/62.
- [ ] Commit — `feat: add the Bayz security posture ladder`

### Task 7 — TLS, mTLS, and request signing

**Create:** `apps/server/src/tls.ts`, `apps/server/src/signing.ts`
**Test:** `apps/server/test/tls.test.ts`, `apps/server/test/signing.test.ts`

- [ ] RED `tls.test.ts`: TLS is configured from `BAYZ_TLS_CERT` and `BAYZ_TLS_KEY` file paths; a missing or unreadable file is a startup failure with a fixed message that does not include the path; TLS 1.2 is the floor and 1.3 preferred; optional mTLS requires `BAYZ_TLS_CLIENT_CA` and rejects an unsigned client cert; a real HTTPS request over a self-signed pair succeeds end to end.
- [ ] RED `signing.test.ts`: a signed request carries `x-bayz-timestamp`, `x-bayz-nonce`, and `x-bayz-signature` (HMAC-SHA256 over method, path, timestamp, nonce, and body hash, keyed by the client key); a stale timestamp beyond ±60s is refused; a replayed nonce is refused (bounded LRU of 4096 nonces); a tampered body is refused; the signature is compared with `timingSafeEqual`; signing is required only in `remote` posture.
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/server` exits 0.
- [ ] Commit — `feat: add Bayz TLS, optional mTLS, and request signing`

### Task 8 — Outbound concurrency cap and egress hardening

**Create:** `packages/router/src/concurrency.ts`
**Modify:** `packages/router/src/transport.ts`, `packages/proxy/src/dial.ts`
**Test:** `packages/router/test/concurrency.test.ts`

- [ ] RED `concurrency.test.ts`: a bounded semaphore caps in-flight upstream requests (default 32, configurable 1–512); the 33rd request waits rather than opening a socket (assert via origin connection count); a queued request beyond a bounded queue depth is rejected with `rate_limited` rather than queued forever; releasing happens on success, failure, and abort (assert the cap recovers after 100 mixed outcomes); the cap applies per-process, not per-provider, since sockets are a process resource.
- [ ] RED same file: a proxy pivot is refused — a proxy whose target resolves to the BAYZ listener itself is rejected, preventing a self-referential loop.
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/router` and `--workspace @bayz/proxy` exit 0.
- [ ] Commit — `feat: cap Bayz outbound concurrency and refuse proxy pivots`

### Task 9 — Fortress adversarial suite and security smoke

**Create:** `packages/storage/test/fortress-adversarial.test.ts`, `scripts/security-smoke.mjs`

- [ ] RED `fortress-adversarial.test.ts`: the existing Phase 2 adversarial suite still passes unchanged; a swapped `master.key` is detected before ciphertext is touched; a bit-flip in each of six columns fails closed; an export blob cannot be imported into a database with a different root key without the passphrase; the migration hash chain detects a forged `schema_migrations` row; `keystoreSupport()` reports `UNVERIFIED` on this device and the test asserts that rather than expecting success.
- [ ] `scripts/security-smoke.mjs`: real listener on loopback proving today's posture; a second listener attempting `lan` bind without TLS proving startup failure with a non-zero exit; a third with TLS proving success; a real HTTPS chat; a signed request accepted and a replayed one refused; root-key rotation with every secret still readable; a credential rotation and a revocation; a concurrency burst of 200 requests proving the cap holds and no socket leaks; scan db/wal/shm/logs for the root key, both credentials, and the TLS private key.
- [ ] Verify: `node scripts/security-smoke.mjs` exits 0; `npm run runtime:verify` exits 0; `git diff --check` clean.
- [ ] Commit — `test: add Bayz fortress adversarial suite and security smoke`

## Completion checklist

- [ ] OS keystore providers probe the platform; all three `UNVERIFIED` on this device, never faked.
- [ ] Root-key rotation has an admin surface, is atomic, and audits metadata only.
- [ ] Credential rotation produces a new DEK; erasure is cryptographic and the WAL caveat is stated.
- [ ] Encrypted export/import with a distinct passphrase and versioned format.
- [ ] Tamper evidence via hash chain and config HMAC; rollback **detected**, not claimed prevented.
- [ ] Posture ladder fails closed; `lan`/`remote` require TLS; no silent downgrade.
- [ ] Request signing with timestamp, bounded nonce cache, and timing-safe comparison.
- [ ] Outbound concurrency capped; proxy pivot refused.
- [ ] No memory-zeroization claim anywhere in code or docs.
