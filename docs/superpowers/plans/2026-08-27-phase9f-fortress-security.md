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

- [ ] RED `os-keystore.test.ts`: each provider reports `available` by **probing the platform**, not by reading `process.platform` alone — a Linux box without a Secret Service reports unavailable; on this device all three report `available: false` and `loadKek()` throws `master_key_invalid`; `resolveKeyProvider` with mode `FORTRESS` prefers an available OS provider and falls back to passphrase with a logged reason (metadata only); a provider that claims availability but fails to load raises rather than silently generating a key; no provider shells out through a string-interpolated command (source scan for `exec(` with template literals).
- [ ] RED same file: the platform matrix is recorded as data — `keystoreSupport()` returns per-platform `IMPLEMENTED | UNVERIFIED | N/A`, and this device yields `UNVERIFIED` for all three.
- [ ] Verify RED.
- [ ] GREEN. Use `node:child_process.execFile` with an argument array, never a shell string.
- [ ] Verify: `npm run test --workspace @bayz/storage` exits 0; `node scripts/storage-smoke.mjs` still 42/42.
- [ ] Commit — `feat: add OS-backed Bayz key providers with honest availability`

### Task 2 — Root-key rotation surface and audit

**Modify:** `apps/server/src/routes/identities.ts` (or a new `apps/server/src/routes/security.ts`), `packages/storage/src/secret-repository.ts`
**Test:** `apps/server/test/key-rotation-api.test.ts`

**Route:** `POST /api/security/rotate-root-key` (scope `admin`)

- [ ] RED `key-rotation-api.test.ts`: rotation requires `admin`; it rewraps every secret and every secret still decrypts afterwards; the old root key stops working; a failed rotation leaves **every** secret readable by the old key (atomicity, already guaranteed by `rotateRootKey` — this pins it at the API level); the response carries the new `keyId` fingerprint and no key material; an audit row records the rotation with counts and timestamps, no key; rotating twice in a row works.
- [ ] RED same file: stale-key detection — a database whose `active_key_id` disagrees with the provider's key yields `master_key_mismatch` at open, before any ciphertext is touched (pins the Phase 2 behaviour at this layer).
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/server` exits 0; `npm run test --workspace @bayz/storage` exits 0.
- [ ] Commit — `feat: add a Bayz root-key rotation surface with audit`

### Task 3 — Credential rotation, revocation, cryptographic erasure

**Modify:** `packages/providers/src/manager.ts`, `packages/proxy/src/manager.ts`
**Test:** `packages/providers/test/credential-lifecycle.test.ts`

- [ ] RED `credential-lifecycle.test.ts`: replacing a credential produces a **new DEK and IV** (assert via `inspect()` that `wrappedDek` and `iv` both changed); deleting a credential removes the row so the ciphertext is unrecoverable — the honest erasure guarantee; after deletion the old ciphertext bytes may still exist in the WAL until checkpoint, and the test **asserts that fact** rather than claiming otherwise, with a comment explaining flash storage cannot be securely overwritten from Node; a revoked credential fails the next request with `credential_missing`, not with a stale success; rotation is atomic — a mid-write failure leaves the previous credential intact.
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/providers` and `--workspace @bayz/proxy` exit 0.
- [ ] Commit — `feat: add Bayz credential rotation with honest erasure semantics`

### Task 4 — Encrypted export and import

**Create:** `packages/storage/src/portable.ts`
**Test:** `packages/storage/test/portable.test.ts`

**Interface produced:** `exportSecrets(storage, passphrase): Uint8Array`, `importSecrets(storage, blob, passphrase): { imported: number }`

- [ ] RED `portable.test.ts`: an export blob is AES-256-GCM sealed under a scrypt-derived key using the Phase 2 `SCRYPT_PARAMS`; the plaintext of no secret appears in the blob bytes; a wrong passphrase fails with `master_key_invalid` and imports nothing; a bit-flipped blob fails closed; an import into a database with an existing secret of the same name refuses by default and replaces only with an explicit flag; the blob carries a format version and an unknown version is refused; the blob contains no root key.
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/storage` exits 0.
- [ ] Commit — `feat: add encrypted Bayz secret export and import`

### Task 5 — Tamper evidence and rollback detection

**Modify:** `packages/storage/src/migrations.ts`, `packages/storage/src/database.ts`
**Test:** `packages/storage/test/tamper.test.ts`

- [ ] RED `tamper.test.ts`: a migration hash chain is stored in `runtime_metadata`; editing `user_version` out of band is detected at open and raises `storage_unavailable` with a distinct stage; a monotonic open counter increments each open and a **decrease** is detected and logged as a rollback warning; the warning is metadata only; a config HMAC over the provider/proxy/route registry detects an out-of-band row edit; **the test asserts that an attacker restoring an older whole database is only detected, never prevented**, with a comment naming the missing primitive (trusted monotonic storage).
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/storage` exits 0; `node scripts/storage-smoke.mjs` exits 0.
- [ ] Commit — `feat: add Bayz tamper evidence and rollback detection`

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
