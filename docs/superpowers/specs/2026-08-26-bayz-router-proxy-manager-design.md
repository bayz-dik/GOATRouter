# Bayz Router — Proxy Manager Design (Phase 4)

Status: Accepted · Date: 2026-08-26 · Predecessors: Phase 2 Fortress, Phase 3 Provider Manager

## 1. Goal

Let a Bayz provider reach its upstream through an operator-configured proxy.
Phase 4 adds proxy registration, encrypted per-proxy password custody, a
hand-rolled SOCKS5 client, an HTTP `CONNECT` tunnel client, and a reachability
check — all on `node:net`/`node:tls`, with no shell, no `spawn`, and no new
dependency.

## 2. Non-goals

- No routing decisions, no combos, no usage accounting.
- No proxy for global `fetch`. Node's `fetch` is undici-backed and cannot be
  given a custom connector through a public, stable API; claiming otherwise would
  be fiction. Phase 4 ships a real `node:http`/`node:https` path (proven against
  a live local server) and documents the `fetch` gap honestly.
- No SOCKS4/4a, no GSSAPI, no proxy chaining, no PAC files, no UDP `ASSOCIATE`
  or `BIND` — only `CONNECT`, which is what an LLM API call needs.
- No TLS-to-proxy (`https://` proxy endpoints) yet: proving it needs a
  certificate fixture this workspace has no trustworthy way to generate, and an
  unverified code path must not be advertised.
- No dashboard change. No change to `/api/health`.

## 3. Package layout

```text
packages/storage/
  src/migrations.ts            MODIFY: migration v3 adds `proxies`
  test/migrations.test.ts      MODIFY: pin v3, keep the remaining bans
packages/proxy/
  package.json                 NEW (@bayz/proxy; deps: @bayz/security, @bayz/storage)
  tsconfig.json                NEW
  src/errors.ts                NEW: ProxyError, fixed messages, cause discarded
  src/endpoint.ts              NEW: host/port validation, kinds
  src/config.ts                NEW: strict config parsing
  src/socks5.ts                NEW: RFC 1928 + RFC 1929 client
  src/http-connect.ts          NEW: CONNECT tunnel client
  src/dial.ts                  NEW: kind dispatch + node agent factory
  src/repository.ts            NEW: registry CRUD
  src/manager.ts               NEW: ProxyManager
  src/index.ts                 NEW
  test/*.test.ts               NEW: validation, repository, socks5, http-connect,
                                    dial, manager, adversarial
scripts/proxy-smoke.mjs        NEW (non-mocked: real SOCKS5 + CONNECT servers)
```

## 4. Registry

Migration v3 adds exactly one table:

```sql
CREATE TABLE proxies (
  id          TEXT PRIMARY KEY,
  kind        TEXT    NOT NULL CHECK (kind IN ('socks5','http')),
  host        TEXT    NOT NULL,
  port        INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  username    TEXT,
  enabled     INTEGER NOT NULL CHECK (enabled IN (0,1)),
  config_json TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
)
```

`username` is stored in cleartext because it is not a secret and the SOCKS5
greeting needs it before any credential is offered. The **password** never
appears here: it lives in the encrypted `secrets` table under the scoped name
`proxy:<id>:password`, using the Phase 3 `scopedSecretStorage` primitive
unchanged.

Proxy ids reuse the provider id alphabet (`^[a-z0-9][a-z0-9-]{0,62}$`) for the
same reason: the id becomes part of a physical secret name.

## 5. Host and port validation

`parseProxyEndpoint({ host, port })`:

- `port` must be an integer in 1–65535.
- `host` must be a bare hostname or IP literal — never a URL. `://`, `/`, `@`,
  `?`, `#`, whitespace, and NUL are rejected, which keeps a credential or a
  second endpoint from being smuggled into the host field.
- Hostname length ≤ 253, each label 1–63 of `[A-Za-z0-9-]` not starting or ending
  with `-`; IPv4 dotted quad and bracketed IPv6 (`[::1]`) accepted explicitly.
- Hostnames are lowercased. The stored form is exactly what goes on the wire.

## 6. Strict config

Accepted keys exactly: `connectTimeoutMs` (int 500–60000, default 10000),
`healthCheckHost` (a validated host, default `1.1.1.1`), `healthCheckPort` (int
1–65535, default 443). Unknown keys are rejected, so no header-like or
command-like field can be represented. Non-plain prototypes are refused.

## 7. SOCKS5 client (RFC 1928 / RFC 1929)

`socks5Connect({ socket, target, username?, password?, timeoutMs })` drives the
handshake over an already-connected socket:

1. Greeting `05 nn <methods>`: `00` (none) always offered, `02`
   (username/password) additionally when a username is configured.
2. Server method reply validated: version must be `05`; `FF` means no acceptable
   method (`auth_failed`); an offered-but-unrequested method is a protocol error.
3. If `02` was selected, RFC 1929 sub-negotiation: version `01`, username and
   password each 1–255 bytes; a non-zero status is `auth_failed`.
4. `CONNECT` request with `ATYP` chosen by target shape — `01` IPv4, `04` IPv6,
   `03` domain (length-prefixed, ≤ 255 bytes).
5. Reply `REP` mapped to fixed codes: `00` success; `01` `proxy_error`; `02`
   `forbidden`; `03`/`04` `unreachable`; `05` `refused`; `06` `timeout`; `07`
   `unsupported_operation`; `08` `unsupported_operation`; anything else
   `protocol_error`.
6. Bound address parsed and discarded so the stream is positioned exactly at the
   first payload byte.

Every read is bounded: the handshake reads only the bytes each stage requires,
never "until data stops", and an unparseable prefix fails immediately rather than
waiting for more. A stalled handshake is bounded by `connectTimeoutMs`.

## 8. HTTP CONNECT client

`httpConnect({ socket, target, username?, password?, timeoutMs })` writes
`CONNECT host:port HTTP/1.1` with a `Host` header, plus
`Proxy-Authorization: Basic <base64(user:pass)>` when credentials exist. The
status line is parsed from a header block capped at 16 KiB; `2xx` succeeds, `407`
is `auth_failed`, `403` is `forbidden`, `502`/`504` are `unreachable`, other
statuses are `proxy_error`. Response headers are discarded and never logged.

The target host is validated before it reaches the request line, so CRLF
injection into the `CONNECT` request is impossible by construction.

## 9. Dial and agent

`dialThroughProxy({ proxy, password?, target, connect? })` opens a TCP socket to
the proxy (`connect` is injectable for tests), runs the kind-appropriate
handshake, and returns the tunneled socket. Failure destroys the socket before
throwing — a leaked half-open socket on a hostile proxy would be a slow resource
exhaustion.

`createProxyAgent(...)` returns a `node:https`/`node:http` `Agent` whose
`createConnection` performs the dial, which makes a real request through a real
proxy verifiable end-to-end. `fetch` remains direct-only and is documented as
such.

## 10. ProxyManager

Surface: `createProxy`, `getProxy`, `requireProxy`, `listProxies`,
`updateProxy`, `deleteProxy`, `setPassword`, `hasPassword`, `deletePassword`,
`checkProxy`, `agentFor`, `close`. As in Phase 3 there is deliberately **no**
password read accessor; a source-scan test enforces it. Views expose
`passwordPresent: boolean`.

`checkProxy(id)` dials the configured health-check target through the proxy and
reports `{ ok, kind, latencyMs }` or throws a fixed-code `ProxyError`. A disabled
proxy refuses with `unsupported_operation` rather than silently succeeding.

`deleteProxy` removes the password first, so a row cannot leave an unreachable
credential behind.

## 11. Errors

`ProxyError` mirrors `StorageError`/`ProviderError`: fixed message table, optional
`stage`, cause discarded. Codes: `invalid_proxy_id`, `invalid_proxy_config`,
`proxy_already_exists`, `proxy_not_found`, `password_missing`,
`unsupported_operation`, `unreachable`, `refused`, `timeout`, `auth_failed`,
`forbidden`, `protocol_error`, `proxy_error`.

## 12. Threat-model notes

- A proxy password is a credential with the same custody as a provider key:
  envelope-encrypted, no read accessor, absent from logs and error text.
- Proxy handshakes parse attacker-controlled bytes. Every length is bounded, no
  allocation is driven by an unvalidated length, and a malformed reply fails
  closed instead of being retried or partially trusted.
- Basic proxy auth is base64, not encryption. Over a plaintext `http` proxy the
  password is observable on the wire; the README states this rather than implying
  protection.
- Host validation prevents CRLF and URL smuggling into the `CONNECT` request line
  and into the SOCKS5 domain field.

## 13. Verification

Per-task RED→GREEN with `node --import tsx --test`, then the phase gate:
`npm run runtime:test`, `npm run runtime:verify`,
`node --test tests/runtime-structure.test.mjs`, `node scripts/storage-smoke.mjs`,
`node scripts/provider-smoke.mjs`, `node scripts/proxy-smoke.mjs`,
`git diff --check`. The SOCKS5 and CONNECT tests run against hand-written
servers on loopback, so the wire format is proven rather than asserted.
