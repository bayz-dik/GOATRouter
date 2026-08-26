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
`packages/storage`. It stores encrypted secrets, schema version, the active key
fingerprint, the provider registry (Phase 3), the proxy registry (Phase 4), and
the route registry (Phase 5). There is no combo or usage schema yet, no table can
hold a prompt or a completion, and no HTTP route or dashboard control touches
storage.

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

## Providers

Phase 3 adds `packages/providers`: a provider registry, per-provider credential
custody, and model discovery. There is still no routing, no proxy support, no
combos, and no HTTP route or dashboard control for any of it — the manager is a
library API today.

- Kinds: `openai-compatible`, `openrouter`, `gemini`, `codex-oauth`
- Registry table: `providers` (id, kind, display name, base URL, enabled, config).
  It has **no** credential column; keys live only in the encrypted `secrets`
  table under the scoped name `provider:<id>:api_key`.
- Verify providers against a real database and a real HTTP upstream:
  `node scripts/provider-smoke.mjs`

### Credential handling

`ProviderManager` can set, test, and delete a credential. It deliberately cannot
return one: there is no `getCredential`, and a test scans the package source to
keep it that way. A stored key leaves the process only inside an upstream request
header — `Authorization: Bearer …` for the OpenAI-compatible family, or
`x-goog-api-key` for Gemini. It is never placed in a URL, where it would land in
proxy logs and error text.

A tampered credential raises an error rather than reporting "no credential set",
so corruption can never be mistaken for an unconfigured provider. Deleting a
provider deletes its credential in the same call.

### Configuration is strict

A provider accepts exactly three config keys: `timeoutMs` (1000–120000),
`discoveryPath` (an absolute path, no query, no traversal), and `modelLimit`
(1–500). Unknown keys are rejected rather than ignored, which is what makes
header smuggling impossible to express — there is no key that can carry an
`Authorization` value.

Base URLs must be absolute `http`/`https`. Userinfo (`https://user:pass@host`)
is rejected, and any query string or fragment is stripped before storage, so a
credential cannot be smuggled into the endpoint itself.

### Discovery treats upstreams as hostile

A model list from a remote provider is attacker-controlled data. Every response
is size-capped (64 KiB by default) while streaming, decoded as strict UTF-8,
parsed once, and required to match a known envelope. Model ids must be
conservative slugs; a malformed entry is skipped rather than allowed to poison or
block the rest of the list. Results are deduplicated and capped at 500 ids
regardless of configuration. Upstream response bodies never appear in an error
message or log line.

`401`/`403` surface as `auth_failed`, `429` as `rate_limited`, other failures as
`upstream_error`, timeouts and network failures as `unreachable`, and an
unintelligible payload as `discovery_failed`.

### Deferred honestly

`codex-oauth` providers can be registered, but `setCredential` and
`discoverModels` refuse with `unsupported_operation`. The OAuth flow needs an
external account and is not implemented; nothing here pretends otherwise.

## Proxies

Phase 4 adds `packages/proxy`: a proxy registry, encrypted per-proxy password
custody, a hand-rolled SOCKS5 client, an HTTP `CONNECT` client, and a
reachability check. All of it runs on `node:net`, with no shell, no `spawn`, and
no native dependency. There is still no routing and no HTTP route or dashboard
control — the manager is a library API today.

- Kinds: `socks5` (RFC 1928, with RFC 1929 username/password) and `http`
  (`CONNECT` with Basic auth)
- Registry table: `proxies` (id, kind, host, port, username, enabled, config).
  It has **no** password column; passwords live only in the encrypted `secrets`
  table under the scoped name `proxy:<id>:password`. The username is stored in
  cleartext because it is not a secret — SOCKS5 must name it before any
  credential is exchanged.
- Verify proxies against real SOCKS5 and CONNECT servers:
  `node scripts/proxy-smoke.mjs`

### What is actually proxied

`proxyManager.agentFor(id)` returns a `node:http`/`node:https` agent, so requests
made with those modules really do traverse the proxy — the smoke script proves it
end-to-end against a live local origin.

Node's global `fetch` is **not** proxied. It is undici-backed and exposes no
stable public way to supply a custom connector, so provider discovery still goes
out directly. This is a real limitation, not an oversight, and it will be closed
when the router owns its own request path.

### Password handling

`ProxyManager` can set, test, and delete a password. It deliberately cannot
return one: there is no `getPassword`, and a test scans the package source to keep
it that way. A password leaves the process only inside the RFC 1929
sub-negotiation or a `Proxy-Authorization` header. A password cannot be stored for
a proxy that has no username, because neither protocol could ever send it.

A tampered password raises an error rather than reporting "no password set".
Deleting a proxy deletes its password in the same call.

Basic proxy auth is base64, which is encoding and not encryption. Against a
plaintext `http` proxy the password is observable by anyone on the path. Bayz does
not claim otherwise; use a proxy you control or a SOCKS5 endpoint on loopback.

### Handshakes treat the proxy as hostile

Every handshake read asks for the exact number of bytes the protocol requires. No
allocation is driven by a length the proxy has not justified, a truncated reply
fails immediately instead of hanging, a header block over 16 KiB is refused, and
the whole exchange is bounded by `connectTimeoutMs` (500–60000 ms). Proxy hosts
and target hosts must be bare hostnames or IP literals, so CRLF or URL smuggling
into a `CONNECT` request line or a SOCKS5 domain field is impossible by
construction.

Failures map to fixed codes — `auth_failed`, `forbidden`, `unreachable`,
`refused`, `timeout`, `protocol_error`, `proxy_error` — and no proxy response body
or header ever appears in an error message or log line.

### Deferred honestly

No SOCKS4/4a, no proxy chaining, no PAC files, no UDP `ASSOCIATE` or `BIND`, and
no TLS connection to the proxy itself (`https://` proxy endpoints). Only
`CONNECT` is implemented, which is what an LLM API call needs.

## Router

Phase 5 adds `packages/router`: model-to-provider routes, deterministic
selection, an OpenAI-compatible chat client, and failover. The router owns its
own request path over `node:http`/`node:https`, which is what lets a
proxy-bound route actually traverse its proxy.

- Registry table: `routes` (id, model, provider, proxy, priority, enabled,
  config). Deleting a provider removes its routes; deleting a proxy degrades its
  routes to direct rather than breaking them.
- Verify the router against real origins and a real `CONNECT` proxy:
  `node scripts/router-smoke.mjs`

### Route selection is deterministic

A route's `model` is either an exact id or a single trailing wildcard
(`gpt-4*`). It is never a regex — an operator-supplied regex is a
denial-of-service surface — and a bare `*` is refused because it would silently
shadow every specific binding.

Candidates are ordered by specificity (exact beats wildcard, longer prefix beats
shorter), then `priority`, then id. The id tiebreak matters: without it, routing
would depend on insertion order, and nobody could explain after the fact why a
request went where it did.

### Prompts are never stored and never logged

No table can hold a prompt or a completion, and the router's log records only
route id, provider id, whether a proxy was used, latency, and outcome. A test
scans the package source for any `INSERT`/`UPDATE` touching message content, and
the smoke script scans the raw database bytes for the prompt after a completed
request.

Credentials are borrowed, not fetched: `ProviderManager.withCredential(id, fn)`
lends the plaintext for the duration of one call. There is still no
`getCredential` anywhere, and a source scan enforces it. A corrupt credential
fails the request rather than degrading to an unauthenticated one, and failover
to a second provider never carries the first provider's key.

### Requests and responses are strictly validated

A request accepts exactly `model`, `messages`, `temperature`, `maxTokens`,
`topP`, and `stop`. Unknown keys are rejected, which is what stops a caller from
smuggling `stream: true`, a tool definition, a header bag, or a provider
override past the router. The serialized body is capped at 1 MiB.

A response must carry `choices[0].message.content` as a string; a malformed one
is an error, never an empty completion. Only known fields are copied onto a fresh
object, so an upstream cannot inject properties into a Bayz result or reach
`Object.prototype`. Responses are capped at 2 MiB on the wire and 512 KiB of
content.

### Failover is bounded and semantic

The router walks candidate routes in order, advancing only on `unreachable`,
`rate_limited`, or `upstream_error` — failures where a different provider may
legitimately succeed. It stops immediately on `auth_failed`, a missing
credential, and any validation or response-shape failure, because retrying
elsewhere would mask a misconfiguration instead of surfacing it. When every
candidate fails, the last real error code is raised rather than a generic one.

### Deferred honestly

**Streaming (SSE) is not implemented.** A correct implementation needs
incremental parsing and cancellation semantics, and a half-verified version would
be worse than none. `stream: true` is rejected rather than ignored, so no caller
can believe it is streaming when it is not.

Combos (multi-provider fan-out) and usage accounting are also not implemented,
and no schema for either exists. Global `fetch` still is not proxied — only the
router's own `node:http` path honors a proxy.

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
