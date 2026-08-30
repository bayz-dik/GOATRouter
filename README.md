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

### Free-first is the default, and the claim is narrow

Model discovery classifies each model from the provider's own catalogue metadata,
and a free-only route uses only models that classification says are free. Free-only
is a per-route decision, defaulting on. A model the catalogue has no row for is
**not** treated as free — "we never checked" is precisely the reading that produces
a bill — and the classification is re-checked on every failover attempt rather than
once up front, so a model reclassified mid-request cannot be spent on. There is no
branch that widens a free-only candidate set when an attempt fails.

The honest boundary, and it is deliberately narrower than it could be written:
BAYZ never selected a paid model on your behalf without metadata saying it was
free. That is not the same promise as "you will never be charged". BAYZ classifies
from what the provider reports, so a provider that misreports its own pricing is
misclassified, and BAYZ has no way to detect that.

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

## Local HTTP API

Phase 6 exposes the managers over an authenticated local API, plus an
OpenAI-compatible chat endpoint.

```text
GET    /api/health                      unauthenticated liveness probe
GET    /api/status                      runtime summary, no key material
GET    /api/providers                   POST /api/providers
GET    /api/providers/:id               PATCH, DELETE
PUT    /api/providers/:id/credential    DELETE (write-only)
POST   /api/providers/:id/discover
GET    /api/proxies                     POST /api/proxies
GET    /api/proxies/:id                 PATCH, DELETE
PUT    /api/proxies/:id/password        DELETE (write-only)
POST   /api/proxies/:id/check
GET    /api/routes                      POST /api/routes
GET    /api/routes/:id                  PATCH, DELETE
POST   /v1/chat/completions
GET    /v1/models
```

Verify the API against a real listener: `node scripts/api-smoke.mjs`

### The token

A bearer token is required for every endpoint except `/api/health`. On first
start Bayz generates one, stores it envelope-encrypted like any other secret, and
prints it **once**:

```text
Bayz local API token (shown only once, store it now): <64 hex characters>
```

It is never printed again, never logged, and no endpoint returns it. Set
`BAYZ_API_TOKEN` to manage it externally instead — that value is used directly and
deliberately not copied into the database, so there is no second stale copy at
rest.

Comparison is `timingSafeEqual` over SHA-256 digests, so neither length nor
content leaks through timing. Only one exactly-shaped `Authorization: Bearer
<token>` header is accepted: no query parameter, no `Basic`, no comma-joined
duplicate, no trailing junk. A wrong token and a missing token produce byte-
identical responses.

### Browser and rebinding defences

- **No CORS headers are emitted, ever.** Permissive CORS on `127.0.0.1` is exactly
  how local-daemon compromise happens.
- A request whose `Origin` is not loopback is refused with `403`, so a
  cross-site POST cannot cause side effects even with a valid token.
- A request whose `Host` is not loopback is refused with `403` on **every** path
  including `/api/health`, which blocks DNS rebinding.
- `Content-Type: application/json` is required for bodies, which also removes the
  CORS "simple request" shape a cross-site form could send without a preflight.

### Limits

Bodies are capped at 1 MiB. Authenticated requests are limited to 120 per minute
per address and failed authentications to 10 per minute, after which the API
answers `429` with `Retry-After`. `/api/health` is exempt so an attacker burning
the auth budget cannot starve a supervisor's health check.

This is a brute-force brake implemented in-process, not a DDoS defence. It will
not survive a distributed attack, and Bayz does not claim it will.

### Secrets are write-only

`PUT /api/providers/:id/credential` and `PUT /api/proxies/:id/password` accept
exactly `{ value: string }` and return `204` with no body. There is **no** GET at
any path shape for either. Listings report `credentialPresent` and
`passwordPresent` as booleans. An adversarial test enumerates every route from
Fastify's own table — so a newly added endpoint cannot silently skip
authentication — and scans every response body from a full exercise for the stored
credential, password, API token, and root key.

### Chat

`POST /v1/chat/completions` takes the OpenAI request shape and returns the OpenAI
response shape. Routing facts travel in `x-bayz-route`, `x-bayz-provider`, and
`x-bayz-proxy` headers rather than being mixed into the body. `stream` in the body
is a `400` naming streaming as unimplemented. Prompts and completions are never
persisted and never logged; the smoke script proves this against the raw database
bytes and the captured log output.

`GET /v1/models` lists models from enabled routes only, and omits wildcard
patterns — `gpt-4*` is route configuration, not a model a client could request.

## Operator dashboard

Phase 7 wires the existing dashboard shell to the Phase 6 API. It serves from the
same origin as the Core, so no CORS relaxation is involved.

- Panels: runtime status, providers, proxies, routes, and a one-shot test chat.
- Verify the built artifact: `node scripts/dashboard-smoke.mjs`

### The token is not remembered

On load the dashboard asks for the API token and holds it in **memory only**. It is
never written to `localStorage`, `sessionStorage`, a cookie, `window.name`, or the
URL, and it is never logged. A reload means entering it again.

That is a real inconvenience, accepted on purpose: any of those storage locations
is readable by a script that achieves XSS on this origin, which would turn a
transient injection into permanent API access. A "Lock session" button clears the
token immediately, and a `401` from any request clears it and returns to the entry
form so a rotated token cannot leave panels silently failing.

Both a source scan and a scan of the **built bundle** enforce this, so the
guarantee holds for the artifact a browser actually runs, not just for the source.

### Nothing secret is rendered

Credential and password fields are write-only: the value is sent, then cleared from
component state in the same tick, so it is never re-rendered. Listings show
`Credential stored` / `Password stored` as indicators only. If a future or
compromised Core returned a credential field, the panels would still not display it
— they read only the fields they know about, which a test verifies by feeding them a
response containing extra secret-shaped keys.

All values from the API, from upstream providers, and from model discovery are
rendered as React text. There is no `dangerouslySetInnerHTML`, no `innerHTML`
assignment, no `insertAdjacentHTML`, and no `eval` anywhere in the dashboard
source; tests assert a hostile display name, host, model id, completion, and
routing header all render as inert text.

### The test chat keeps nothing

The transcript lives in component state for the current view and is gone on
navigation or reload. Nothing is written to browser storage and nothing is sent back
to the Core for persistence — the router refuses to store prompts, and the
dashboard does not undo that from the other side. There is no streaming control,
because the API rejects `stream`.

### Flux Core V2 and the provider constellation
`apps/dashboard/src/flux/` holds the approved BAYZ Flux Core V2 relay usage track,
mounted through `apps/dashboard/src/FluxCoreSlot.tsx`. The canvas engine
(`flux/engine.ts`) is a port of the approved standalone source: same geometry,
point-cloud topology, multilayer core depth, organic deformation, internal ribbons,
braided provider traffic, packet travel and acceleration, packet/core impact,
topology reaction, provider positions, adaptive-quality thresholds, and Calm / Live
/ Surge semantics.

**At 1–5 providers the approved layout is used verbatim** — the original `.p1`–`.p5`
CSS positions, full chip detail, one filament per provider. The scalable field only
engages past five, so the approved baseline never drifts.

#### Scaling to many providers

BAYZ supports arbitrarily many registered providers. Beyond five, the space *around*
the core expands into a zoomable constellation; the core itself is untouched.

- **Every provider is always a node.** Density reduces label detail, never node
  count. A 120-provider field renders 120 nodes.
- **Traffic bundles, state does not.** Past five providers, spatially adjacent
  filaments braid into sector trunks — 40 providers become 12 trunks rather than 40
  cables. Bundling is purely a rendering decision: `trunkFor()` maps any provider
  back to its trunk, so focusing one still identifies its own traffic.
- **Semantic zoom.** Far out, marks only with a small priority label budget; medium,
  more names; near, full identity with state and share. Label slots are allocated by
  priority: selected, then failed, then degraded/recovering, then active, then
  traffic share, with ties broken by id so ordering is stable frame to frame.
- **Overlap is never solved by deleting nodes.** When there are more exceptions than
  label slots, the unlabelled ones appear in a named **Incidents** list; clicking a
  row focuses that provider in the constellation. There is no `+N providers`
  abstraction anywhere.

#### Provider identity

Every provider keeps an identity: a local monochrome mark, a display name, and a
stable non-secret short id (`PVD-1A2F`, FNV-1a over the provider id alone).
Custom providers sharing a display name are disambiguated automatically as
`CUSTOM — PVD-1A2F`. The short id derives from nothing but the id — a test changes
every other field and asserts it is unchanged.

Icons are chosen by *key* from a local SVG table. Provider metadata can select which
local mark to draw; it can never supply markup, a URL, or a data URI. An unknown or
hostile key falls back to a generic mark plus initials, so provider icon information
is neither an injection surface nor a remote dependency.

#### Zoom and pan

Wheel/trackpad zoom about the cursor, drag to pan, pinch zoom on touch, click to
select, double-click to focus, and a reset control. Zoom is clamped to 0.45–4×, pan
to ±2000px, and every operation repairs a non-finite state, so the Flux Core cannot
be permanently lost off-screen. Wheel handling is scoped to the stage, so page
scrolling past the panel is unaffected.

#### Failure and recovery

Monochrome only — no colour is used to signal state. A failed provider keeps its
node, its mark, and its position, gains a dashed border and diagonal hatch, gets a
stepped pulse instead of a smooth one, and receives label priority. Recovery moves
`failed → recovering → active`, with the wake pulse from the approved source, after
which the label returns to normal semantic-zoom behaviour.

#### Production changes from the standalone source

1. **No remote font.** The Google Fonts `@import` is removed; local stacks lead with
   Archivo / Archivo Black / IBM Plex Mono and fall back to local grotesques.
2. **No `innerHTML`.** The standalone activity feed built rows with `innerHTML`.
   Every dynamic string is now a React text node.
3. **CSP-compatible.** No remote font, script, or stylesheet; no `eval`, no
   `Function` constructor, no inline handler, no injected code.
4. **Scoped CSS.** The standalone file styled `html`, `body`, and bare `button`.

The engine owns all per-frame work and reports a snapshot roughly three times a
second — no per-frame React state. Label and collision resolution runs on
viewport/selection change, slower than the physics loop. Bounded pools (8 waves,
6 dents, 6 flashes, 3 packets per filament), DPR capped at 2, adaptive quality,
visibility pause, and `prefers-reduced-motion` all carry over; braid strand count
steps down as provider count rises so dense fields cost less per frame, not more.

`flux/types.ts` is the display-safe boundary: provider id, display name, icon key,
state, share, route participation, load, latency, incident reason, plus global
routing mode, request count, and period. It cannot carry a credential, proxy
password, API token, or Authorization header. `buildLiveViewModel` produces a
`source: "live"` model from real telemetry; `buildDemoViewModel` is the only
producer of `source: "simulation"`, and the two never merge — an empty live field
stays empty rather than being backfilled with demo values.

## Usage telemetry

Phase 8 records what the router did, as **metadata only**. No prompt, completion,
message, system prompt, tool argument, request body, response body, Authorization
header, credential, proxy password, or upstream error body is stored anywhere — not
truncated, not hashed, not sampled.

### The closed field set

A stored row is built by copying named scalar fields onto a fresh object. Nothing is
filtered out, because nothing is copied in unless it is named:

```text
requestId  occurredAt  routeId  providerId  proxyId  model  routingMode
outcome    failureCategory  latencyMs  attempts
promptTokens  completionTokens  cachedTokens
```

That is the difference between a boundary and a denylist. A denylist needs updating
every time an upstream type gains a field, and forgetting once leaks a prompt. Tests
assert the row's key set matches exactly, and that an event carrying thirty hostile
keys (`prompt`, `messages`, `completion`, `body`, `authorization`, `apiKey`,
`cookie`, `upstreamError`, `stack`, …) produces a clean row.

`failureCategory` is a closed enum of sixteen values, enforced both at the boundary
and by a SQLite `CHECK` constraint. Arbitrary upstream error text has no column it
could occupy: `"rate_limited from sk-…"` normalizes to `unknown_error`.

### Unknown is not zero

A token count the provider did not report is `undefined` in the boundary, `NULL` in
storage, and `null` in the API. A genuine zero is `0` everywhere. These are
different facts and merging them would falsify every aggregate built on top, so
tests pin both.

Cost is reported as `costAvailable: false` with `costReason: "no_pricing_data"`.
Bayz has no pricing table and no billing API; an estimate would be a fabricated
number wearing a real label.

### Events

Five kinds, each tied to a real router observation point:

```text
provider.attempted   provider.failed   failover.started
request.completed    request.failed
```

`request.started` and `route.selected` are deliberately absent — the router has no
observation point that distinguishes them. `combo.member.*` is `provider.*` under a
different name. A 40-provider Combo emits one attempt event per provider, so
membership and failover handoff are observable per provider by safe id.

`failover.started` is a marker, not an attempt: it names the promoted provider but
is not stored as a second attempt row, because the same success also emits
`provider.attempted`. The failover fact lives in the request row's
`routing_mode = 'failover'`.

Telemetry is observational. A recorder that throws, or storage that fails, never
breaks a chat request — proven by a test whose recorder throws on every call.

### Retention

Count-based, default 5,000 requests and 20,000 attempts, configurable through
`BAYZ_USAGE_RETENTION`. Pruning runs on write and deletes only rows outside the
newest N **within the two usage tables**. Count rather than age because a count
bounds disk deterministically.

A malformed retention value cannot disable retention: it falls back to the
documented default. Tests seed a provider, proxy, route, and secret, drive 500
events through a repository configured to keep 10, and assert all four domain rows
survive.

### Endpoints

```text
GET    /api/usage/summary?period=today|24h|7d|30d
GET    /api/usage/requests?limit=1..200
GET    /api/usage/providers?period=…
DELETE /api/usage/requests          purge, idempotent, usage-only
```

All authenticated. `/api/health` is unchanged. An unrecognized `period` or `limit`
is a `400`, never a silent default. There is no endpoint that returns request
content, at any path shape.

## Content-Security-Policy

The Core serves a strict local-first policy on every response, including 401, 403,
404, and 500:

```text
default-src 'none'; script-src 'self'; style-src 'self';
img-src 'self' data:; font-src 'self'; connect-src 'self';
manifest-src 'self'; object-src 'none'; frame-src 'none';
worker-src 'none'; base-uri 'none'; form-action 'none';
frame-ancestors 'none'
```

No `unsafe-inline`, no `unsafe-eval`, no remote origin. The policy is a constant
with no configuration knob — deliberately, because a "relax CSP" option is what gets
reached for the first time something breaks.

Flux Core needed no changes to comply. React's `style` prop sets DOM properties,
which CSP does not govern; only a literal `style="…"` attribute in served HTML or an
injected `<style>` element would need `'unsafe-inline'`, and the built dashboard has
neither. The dashboard smoke script verifies that against the emitted artifact
rather than trusting the reasoning.

Companion headers: `nosniff`, `no-referrer`, `X-Frame-Options: DENY`, COOP and CORP
`same-origin`, and a `Permissions-Policy` denying eight device sensors.
`x-powered-by` and `server` are both absent.

## Platform support

One platform is verified. Six are not, and that is a statement about what has been *observed*, not a
claim that BAYZ is broken elsewhere.

**Verified: Termux/Android ARM64** (Ubuntu proot, Node v24.19.0 arm64). Every mandatory capability —
install, first boot, schema creation, chat, streaming, proxying, dashboard serving, restart, upgrade
from schema v1, data-directory permissions, uninstall — has been observed on this device against the
**installed release artifact**, not the source tree. Evidence: `scripts/install-smoke.mjs` (64/64) and
`scripts/upgrade-smoke.mjs` (83/83).

**Do not claim support for:** Linux x64, Linux ARM64, Windows x64, Windows ARM64, macOS x64,
macOS ARM64. Nothing has been run on any of them.

The runtime is plausibly portable — zero native runtime dependencies, no install scripts in the
closure, no POSIX shell on any user-facing path, and a data-directory resolver with per-platform
fallbacks — but *plausible* is not *observed*, and the matrix does not promote a cell without evidence
from that machine.

Two platforms cannot be covered by CI at all: Termux/Android has no hosted runner (it is this device),
and Windows ARM64 has none available here. On Windows generally, the `0700`/`0600` data-directory
modes have no `chmod`-settable NTFS equivalent, so file-permission parity is not claimed even once
Windows is otherwise verified.

The authoritative record is `docs/superpowers/2026-08-27-bayz-platform-matrix.md`, and
`node scripts/platform-gate.mjs --report` prints the list above directly from it. A `FAIL` on any
platform blocks a release; an `UNVERIFIED` on a platform nobody has access to narrows this support
claim instead.

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
