# BAYZ Router — Chat → Work handoff

## Current execution state

- Foundation Plan (Phase 1): **COMPLETE**, 8 commits, `runtime:verify` green.
- Phase 2 Security + SQLite Storage: **COMPLETE**, Task 1–8, `runtime:verify` green.
- Phase 3 Provider Manager: **COMPLETE**, Task 1–8, `runtime:verify` green.
- Phase 4 Proxy Manager: **COMPLETE**, Task 1–8, `runtime:verify` green.
- Approved plans:
  - `docs/superpowers/plans/2026-08-26-bayz-router-foundation.md`
  - `docs/superpowers/plans/2026-08-26-bayz-router-security-sqlite.md`
  - `docs/superpowers/plans/2026-08-26-bayz-router-provider-manager.md`
  - `docs/superpowers/plans/2026-08-26-bayz-router-proxy-manager.md`
- Approved specs:
  - `docs/superpowers/specs/2026-08-26-bayz-router-security-sqlite-design.md` (Revision 2, Fortress)
  - `docs/superpowers/specs/2026-08-26-bayz-router-provider-manager-design.md`
  - `docs/superpowers/specs/2026-08-26-bayz-router-proxy-manager-design.md`
- Every task followed RED → verify RED → GREEN → verify GREEN.
- No push to GitHub. All work is local commits on `master`.

## Verified totals

- `@bayz/storage`: 153 tests pass (schema is now v3).
- `@bayz/providers`: 105 tests pass.
- `@bayz/proxy`: 105 tests pass.
- `@bayz/server`: 14 tests pass (includes the `/api/health` Phase 1 contract guard).
- `@bayz/contracts`: 3, `@bayz/security`: 6, `@bayz/dashboard`: 2.
- `npm run runtime:verify` exits 0; every build exits 0.
- `node scripts/storage-smoke.mjs`: 42/42 against a real database, including a
  reopen in a separate child process.
- `node scripts/provider-smoke.mjs`: 36/36 against a real database, a real
  loopback HTTP upstream, real `fetch`, and a separate-process reopen.
- `node scripts/proxy-smoke.mjs`: 39/39 against a real database plus real SOCKS5
  and HTTP `CONNECT` servers, completing real tunneled HTTP requests to a real
  loopback origin, with a separate-process reopen.
- Live boot on `127.0.0.1:20996` (20128 and 20993 are occupied by unrelated
  processes in this environment): logged
  `{schemaVersion:3, journalMode:"wal", driver:"node:sqlite", keyProvider:"environment", keyId:"kek_…"}`,
  served `/api/health` as exactly `{status, version, uptimeSeconds}`, wrote
  `bayz.db` to disk. No key material appeared anywhere in the log.
- Secret scan over tracked non-test source for `sk-live`, `hunter2`,
  `BEGIN … PRIVATE KEY`, and `AIza…`: no matches.
- `node:sqlite` still imported in exactly one file, enforced by the Phase 2
  source-scan test.

## Environment facts

- Node `v24.19.0`, `linux arm64`. `node:sqlite` present, SQLite `3.53.3`, no
  ExperimentalWarning.
- Zero new dependencies added in Phase 2, 3, or 4 — runtime or dev.
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

## Phase 3 architecture as built

```text
ProviderManager               packages/providers/src/manager.ts
  ├─ ProviderRepository       registry rows, all values validated pre-SQL
  ├─ scopedSecretStorage      credential custody at provider:<id>:api_key
  └─ discovery (openai | gemini) over fetchJsonCapped
                              ↓ injected `fetcher`, AbortSignal.timeout, byte cap
                              upstream HTTP
```

The manager sees `SecretStorage` and a `SqlDatabase` interface — never a driver,
an envelope, a DEK, or a KEK. `node:sqlite` is still imported in exactly one
file, and the source-scan test that enforces it is unchanged.

## Phase 3 deviations from the plan text

1. **No zod.** The design sketch named zod for strict parsing. Adding it would
   have broken the zero-new-dependency rule that keeps Termux/ARM64 install-free,
   so validation is hand-rolled and typed instead. The guarantees are the ones
   zod would have provided: unknown keys rejected, ranges enforced, prototypes
   refused.
2. **`SecretStorage.sql` added.** Phase 3 needs the provider registry in the same
   database, with the same pragmas, as the credentials it points at. Exposing the
   existing `SqlDatabase` is additive and keeps the driver boundary intact; the
   alternative — a second connection — would have meant a second set of pragmas
   and a second lock holder.
3. **Timeout covers body streaming.** The plan bounded the request; a response
   that stalls after its headers also has to be bounded, so an abort during the
   capped read maps to `unreachable` rather than to a malformed payload.
4. **Discovery with zero usable entries fails.** Returning `[]` would make "the
   upstream has no models" indistinguishable from "every entry was malformed",
   which call for different operator action, so the latter raises
   `discovery_failed`.
5. **Phase 2 schema pin updated, not deleted.** The test that forbade a
   `providers` table was correct for Phase 2 and expired here. It now pins the v2
   column set and asserts no credential-like column exists; the bans on
   `proxies`, `routes`, `combos`, and `usage` are untouched.

## Phase 4 architecture as built

```text
ProxyManager                  packages/proxy/src/manager.ts
  ├─ ProxyRepository          registry rows, all values validated pre-SQL
  ├─ scopedSecretStorage      password custody at proxy:<id>:password
  └─ dialThroughProxy         kind dispatch → socks5Connect | httpConnect
                              ↓ bounded HandshakeReader, socket destroyed on failure
                              createProxyAgent → node:http / node:https
```

`HandshakeReader` is the security-relevant core: it reads exactly the bytes each
protocol stage requires and pushes leftovers back with `socket.unshift`, so a
proxy that coalesces its reply with the tunneled payload cannot leak handshake
bytes into the stream and a truncated reply cannot hang the client.

## Phase 4 deviations from the plan text

1. **`fetch` is not proxied, and this is stated rather than worked around.**
   Node's `fetch` is undici-backed with no stable public connector hook. Phase 4
   therefore ships a `node:http`/`node:https` agent — proven end-to-end against a
   real proxy and a real origin — and documents that provider discovery still goes
   out directly. Faking it with a global patch would have produced a proxy that
   silently stops working on a Node upgrade.
2. **`net.Server` has no `closeAllConnections`.** Every loopback test server
   tracks accepted sockets and destroys them before `close()`, or the suite hangs
   forever on a peer the test already abandoned. Discovered by an actual hang, not
   anticipated.
3. **Host validation trims before rejecting.** A trailing `\r\n` is whitespace and
   is trimmed; an *embedded* CRLF is rejected. Both behaviours are pinned by
   tests, because "reject anything containing CR" would refuse harmless pasted
   input while "strip all control characters" would silently accept an injection
   attempt.
4. **A password requires a username.** Neither RFC 1929 nor Basic proxy auth can
   send a password alone, so storing one would be dead, misleading state; the
   manager refuses it.
5. **`socks5Connect` refuses a server-selected method that was never offered.**
   Not in the plan, but accepting one would mean speaking a protocol variant that
   was never negotiated.

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
- **Codex OAuth** — `codex-oauth` providers can be registered, but
  `setCredential` and `discoverModels` refuse with `unsupported_operation`. The
  device flow needs an external ChatGPT account, which is outside what can be
  verified here.
- **Provider HTTP surface** — the Provider Manager is a library API. There is no
  route, no CLI, and no dashboard control for creating providers or storing keys.
- **Proxied `fetch`** — see Phase 4 deviation 1. `node:http`/`node:https` through
  `agentFor()` is real and proven; global `fetch` is still direct.
- **SOCKS4/4a, proxy chaining, PAC files, UDP ASSOCIATE/BIND, TLS-to-proxy** —
  none implemented. Only SOCKS5 `CONNECT` and HTTP `CONNECT` exist.
- **Route / combo / usage schema** — a test asserts these tables do *not* exist,
  so speculative schema cannot creep in.

## Phase 4 residual risk

Protected: a stolen `bayz.db` yields no proxy password, one proxy's password
cannot be reached through another, a tampered password fails closed instead of
reading as absent, a hostile proxy cannot exhaust memory or hang the client
through the handshake, CRLF and URL smuggling into a `CONNECT` request line or a
SOCKS5 domain field are impossible, and a proxy that declines authentication never
receives the password.

Not protected: Basic proxy auth over a plaintext `http` proxy is observable on the
path — base64 is encoding, not encryption. There is also no egress allowlist, so an
operator who registers a proxy pointing at an internal address will reach it; that
is a deliberate admin capability, not an SSRF guard.

## Phase 3 residual risk

Protected: a stolen `bayz.db` still yields no credential, one provider's key
cannot be read through another, a tampered credential fails closed instead of
reading as absent, a hostile upstream cannot flood memory or inject a model id,
and no credential reaches a URL, a log line, or an error message.

Not protected: an operator who configures a base URL pointing at an internal
address will have discovery reach it — this is a deliberate admin capability, not
an SSRF guard, since the base URL is operator-supplied by design. There is also no
egress allowlist and no per-provider rate limit yet.

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
source of truth. Phases 2, 3, and 4 made no dashboard change whatsoever
(`git log -- apps/dashboard` still ends at the Phase 1 commit).

## Resume steps once the real BAYZ repo/UI is available

1. Copy the Sites/UI source and the real root `package.json` into this workspace.
2. Merge the workspace fields (`workspaces`, `runtime:*` scripts) into the real
   root `package.json` instead of overwriting it.
3. Move the README runtime, storage, provider, and proxy sections into the real
   README.
4. Run the root Sites build and confirm it still exits 0.
5. Re-run `npm run runtime:verify` and all three smoke scripts.

## Next phase

Phase 5 is the Router: model routing across registered providers, using the proxy
agent where a provider names one. It consumes the Provider and Proxy managers and
must not learn how encryption works. The `fetch` limitation from Phase 4 is the
first thing it has to resolve, because the router owns the request path.
