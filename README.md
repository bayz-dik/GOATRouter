# BAYZ Router

Private development repository for the BAYZ All-in-One runtime.

## Bayz All-in-One Runtime

The private foundation runtime lives in `apps/server`, `apps/dashboard`, and
`packages/*`. It currently provides only the verified Core health surface and
dashboard status shell. Providers, proxies, combos, routes, integrations, and
usage remain visibly marked as planned until their real implementations pass
their dedicated phases.

- Node.js: 24 or newer
- Default URL: `http://127.0.0.1:20128`
- Verify: `npm run runtime:verify`
- Start after building the dashboard: `npm run start --workspace @bayz/server`

Do not expose the runtime on a non-loopback interface unless authentication and
the explicit remote-access setting are configured.

## Secure local storage

Phase 2 adds a local SQLite store and an encrypted-at-rest secret primitive in
`packages/storage`. It stores encrypted secrets, schema version, and the active
key fingerprint — nothing else. There is no provider, proxy, route, combo, or
usage schema yet, and no HTTP route or dashboard control touches storage.

- Database: `<BAYZ_DATA_DIR>/bayz.db` (default `~/.bayz/bayz.db`)
- Driver: Node's built-in `node:sqlite`, behind a swappable adapter. No native
  dependency, so Termux/ARM64 needs no compiler.
- `foreign_keys` is enforced, `busy_timeout` is 5s, and WAL is used where the
  filesystem supports it.
- Migrations are versioned, transactional, and idempotent.
- Verify storage against a real database: `node scripts/storage-smoke.mjs`

### Encryption

Each secret gets a fresh random 256-bit Data Encryption Key. The DEK encrypts the
secret with AES-256-GCM, and a Key Encryption Key wraps the DEK. Only the wrapped
DEK, ciphertext, nonces, tags, and non-secret metadata reach SQLite. The secret's
name is bound in as authenticated data, so a stored envelope cannot be moved onto
another secret. Compromising one record yields no key for any other.

Wrong key, tampered ciphertext, tampered wrapped DEK, a bad auth tag, an unknown
format version, or a truncated record all fail closed with an error. None of them
ever returns an empty string or a partial value.

### Key custody

| Mode | `BAYZ_SECURITY_MODE` | Key source |
| --- | --- | --- |
| Standard (default) | unset or `STANDARD` | `BAYZ_MASTER_KEY` if set, otherwise a generated `<BAYZ_DATA_DIR>/master.key` (mode `0600`) |
| Secure | `SECURE` | `BAYZ_MASTER_KEY` required; never silently downgrades |
| Fortress | `FORTRESS` | `BAYZ_PASSPHRASE`, stretched with scrypt (N=2^16, r=8, p=1); the key lives only in process memory and is locked again on restart |

`BAYZ_MASTER_KEY` accepts 64 hex characters or base64 that decodes to exactly 32
bytes. A malformed value is rejected rather than hashed or truncated into
something else.

The root key can be rotated by rewrapping each DEK. Plaintext secrets are never
written out during rotation, and a failed rotation rolls back so the previous key
still works. No operator surface for rotation exists yet — the API is tested, but
there is no route or UI for it.

### What this protects, and what it does not

Protects against: a stolen `bayz.db` or backup of it, database inspection without
the key, ciphertext tampering, an envelope relocated between records, a single
leaked DEK, and accidental disclosure through logs, errors, or API responses.

Does **not** protect against: an attacker with root or kernel control of the
device (they can read `master.key`, read the environment, or dump process
memory), malicious code inside the Bayz process, a compromised dependency or
build, hardware/OS compromise while secrets are unlocked, or rollback of the
database file to an earlier state. JavaScript also cannot guarantee that key
material is erased from memory — buffers are zeroed after use, which narrows the
window without closing it.

Bayz is not unhackable, and no part of this project claims otherwise.

Not implemented yet, and deliberately not faked: OS keychain custody (DPAPI,
macOS Keychain, Linux Secret Service, Android Keystore) exists as an interface
that reports itself unavailable; Argon2id awaits a binding that does not break
the Termux baseline; full anti-rollback needs OS-backed monotonic storage.

## Deferred verification

The existing private BAYZ Sites/UI review surface is not present in this
workspace. `BAYZ-responsive-master.html`, the Sites build, and its root
`package.json` scripts have not been merged here yet.

Therefore the following Foundation Plan checks are **DEFERRED**, not passing:

- Root Sites build (`npm run build`) — no Sites source exists to build.
- "The existing root Sites build still passes" phase-completion item.

`apps/dashboard` is the runtime foundation shell only. It is not a replacement
for the locked BAYZ visual direction, and it does not supersede
`BAYZ-responsive-master.html` as the visual source of truth. These deferred
checks must be run after the original UI/Sites source is added to this
workspace.
