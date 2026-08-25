# BAYZ Router — Chat → Work handoff

## Current execution state

- Foundation Plan (Phase 1): **COMPLETE**, 8 commits, `runtime:verify` green.
- Phase 2 Security + SQLite Storage: **COMPLETE**, Task 1–8, `runtime:verify` green.
- Approved plans:
  - `docs/superpowers/plans/2026-08-26-bayz-router-foundation.md`
  - `docs/superpowers/plans/2026-08-26-bayz-router-security-sqlite.md`
- Approved spec: `docs/superpowers/specs/2026-08-26-bayz-router-security-sqlite-design.md` (Revision 2, Fortress)
- Every task followed RED → verify RED → GREEN → verify GREEN.
- No push to GitHub. All work is local commits on `master`.

## Verified totals

- `@bayz/storage`: 131 tests pass.
- `@bayz/server`: 14 tests pass (includes the `/api/health` Phase 1 contract guard).
- `@bayz/contracts`: 3, `@bayz/security`: 6, `@bayz/dashboard`: 2.
- `npm run runtime:verify` exits 0; all four builds exit 0.
- `node scripts/storage-smoke.mjs`: 42/42 checks pass against a real database,
  including a reopen in a separate child process.
- Live boot on `127.0.0.1:20993` (20128 was occupied by an unrelated process in
  this environment): logged
  `{schemaVersion:1, journalMode:"wal", driver:"node:sqlite", keyProvider:"environment", keyId:"kek_…"}`,
  served `/api/health` and the dashboard, wrote `bayz.db` to disk, and shut down
  cleanly on SIGTERM. No key and no 64-hex run appeared anywhere in the log.

## Environment facts

- Node `v24.19.0`, `linux arm64`. `node:sqlite` present, SQLite `3.53.3`, no
  ExperimentalWarning.
- Zero new dependencies added in Phase 2 — runtime or dev.
- scrypt measured on this device: N=2^14 49 ms/16 MiB, 2^15 95 ms/32 MiB,
  **2^16 194 ms/64 MiB (selected)**, 2^17 393 ms/128 MiB.

## Phase 2 architecture as built

```text
Domain (Provider Manager, Proxy Manager, Router, Usage, UI) — none exist yet
      ↓ sees only plain strings
SecureSecretRepository        packages/storage/src/secret-repository.ts
      ↓
CryptoEnvelope (KEK → per-secret DEK, AES-256-GCM, AAD name binding)
      ↓
KeyProvider + SqlDatabase
      ↓
SQLite adapter               packages/storage/src/drivers/node-sqlite.ts
```

`node:sqlite` is imported in exactly one file, enforced by a source-scanning
test. Migrations, repository, and crypto see only the `SqlDatabase` interface, so
a `better-sqlite3 → node:sqlite → sql.js` chain can be added later at
`selectDriver()` without touching the repository or domain API.

## Deviations from the plan text

1. **Plaintext framing byte.** AES-GCM of an empty string yields zero ciphertext
   bytes, indistinguishable from an emptied column. A `0x01` frame byte is
   prepended before encryption so an empty secret stays storable while an emptied
   ciphertext is still rejected as corrupt. Not in the plan; found by a test that
   demanded empty and absent be distinguishable.
2. **Database file modes.** The plan only specified `0700` on the directory and
   `0600` on the key file. A `0700` directory does not stop a backup tool from
   copying `bayz.db` out with loose permissions, so `bayz.db`, `-wal`, and `-shm`
   are chmod'ed `0600` too, best-effort.
3. **`SqlParam` excludes `boolean`.** `node:sqlite` rejects boolean bindings, so
   including it would have been a contract the first adapter cannot honor.
   Integers `0`/`1` are used instead.
4. **Smoke script self-relaunches with tsx.** The storage package is TypeScript,
   so `node scripts/storage-smoke.mjs` re-execs itself once with `--import tsx`
   rather than requiring callers to remember the flag.
5. **`isSecretKey` exported** from `@bayz/security` alongside `redactSecrets`.
   Additive; the Phase 1 public API and all Phase 1 assertions are unchanged.

## Deliberately NOT implemented, and not faked

- **OS keychain custody** — `OsKeystoreKeyProvider` exists as an interface with
  `available: false` and a `loadKek()` that throws. Every platform option needs a
  native module, which would break the zero-native-dependency Termux baseline.
  Scheduled for the packaging phase.
- **Argon2id** — awaits a Termux-safe binding. The envelope's `kdf` field is
  reserved for it. scrypt is a real implementation, not a placeholder.
- **Full anti-rollback** — `keyId` detects a wrong key and casual tampering, but
  an attacker with write access can restore an older `bayz.db` wholesale. Real
  anti-rollback needs OS-backed monotonic secure storage.
- **Rotation operator surface** — `rotateRootKey` works and is tested; there is no
  route, CLI command, or UI for it.
- **Provider / proxy / route / combo / usage schema** — a test asserts these
  tables do *not* exist, so speculative schema cannot creep in.

## Residual risk, stated honestly

Protected: stolen `bayz.db` or backup, database inspection without the key,
ciphertext tampering, envelope relocation between records, single-DEK compromise,
accidental log/error/API disclosure.

Not protected: root or kernel-level attacker on the device, malicious code inside
the Bayz process, compromised dependency or build, hardware/OS compromise while
unlocked, database rollback, and guaranteed memory zeroization (buffers are
zeroed, but the GC may have copied them and immutable strings cannot be wiped).

## DEFERRED — blocked until the original UI/Sites source is added here

The private BAYZ Sites/UI review surface is **still not present** in this
workspace. `BAYZ-responsive-master.html`, the Sites build, and the Next.js root
`package.json` scripts have not been merged in.

These checks are DEFERRED and have **not** been verified. They are not passing:

- Root Sites build. `npm run build` at the root fails with
  `Missing script: "build"` because no Sites source exists.
- Foundation phase item "The existing root Sites build still passes."
- Merging the approved workspace fields into the real Next.js root
  `package.json` without discarding its existing scripts/dependencies.

`apps/dashboard` is the runtime foundation shell only. It is **not** a redesign
and does **not** replace `BAYZ-responsive-master.html` as the locked visual
source of truth. Phase 2 made no dashboard change whatsoever.

## Resume steps once the real BAYZ repo/UI is available

1. Copy the Sites/UI source and the real root `package.json` into this workspace.
2. Merge the workspace fields (`workspaces`, `runtime:*` scripts) into the real
   root `package.json` instead of overwriting it.
3. Move the README runtime and storage sections into the real README.
4. Run the root Sites build and confirm it still exits 0.
5. Re-run `npm run runtime:verify` and `node scripts/storage-smoke.mjs`.

## Next phase

Phase 3 is Provider Manager and model discovery. It consumes
`SecureSecretRepository` and must never learn how encryption works.
