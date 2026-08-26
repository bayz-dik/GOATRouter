# BAYZ Router — Chat → Work handoff

## Current execution state

- Foundation Plan (Phase 1): **COMPLETE**, 8 commits, `runtime:verify` green.
- Phase 2 Security + SQLite Storage: **COMPLETE**, Task 1–8, `runtime:verify` green.
- Phase 3 Provider Manager: **COMPLETE**, Task 1–8, `runtime:verify` green.
- Phase 4 Proxy Manager: **COMPLETE**, Task 1–8, `runtime:verify` green.
- Phase 5 Router: **COMPLETE**, Task 1–8, `runtime:verify` green.
- Phase 6 Local HTTP API: **COMPLETE**, Task 1–8, `runtime:verify` green.
- Phase 7 Operator Dashboard: **COMPLETE**, Task 1–8, `runtime:verify` green.
- Approved plans:
  - `docs/superpowers/plans/2026-08-26-bayz-router-foundation.md`
  - `docs/superpowers/plans/2026-08-26-bayz-router-security-sqlite.md`
  - `docs/superpowers/plans/2026-08-26-bayz-router-provider-manager.md`
  - `docs/superpowers/plans/2026-08-26-bayz-router-proxy-manager.md`
  - `docs/superpowers/plans/2026-08-26-bayz-router-router.md`
  - `docs/superpowers/plans/2026-08-26-bayz-router-http-api.md`
  - `docs/superpowers/plans/2026-08-26-bayz-router-dashboard.md`
- Approved specs:
  - `docs/superpowers/specs/2026-08-26-bayz-router-security-sqlite-design.md` (Revision 2, Fortress)
  - `docs/superpowers/specs/2026-08-26-bayz-router-provider-manager-design.md`
  - `docs/superpowers/specs/2026-08-26-bayz-router-proxy-manager-design.md`
  - `docs/superpowers/specs/2026-08-26-bayz-router-router-design.md`
  - `docs/superpowers/specs/2026-08-26-bayz-router-http-api-design.md`
  - `docs/superpowers/specs/2026-08-26-bayz-router-dashboard-design.md`
- Every task followed RED → verify RED → GREEN → verify GREEN.
- No push to GitHub. All work is local commits on `master`.

## Verified totals

- `@bayz/storage`: 157 tests pass (schema is v4).
- `@bayz/providers`: 111 tests pass.
- `@bayz/proxy`: 105 tests pass.
- `@bayz/router`: 122 tests pass.
- `@bayz/server`: 111 tests pass (includes the `/api/health` Phase 1 contract guard).
- `@bayz/dashboard`: 128 tests pass across 10 files.
- `@bayz/contracts`: 3, `@bayz/security`: 6.
- `npm run runtime:verify` exits 0; all eight builds exit 0.
- `node scripts/storage-smoke.mjs`: 42/42 against a real database, including a
  reopen in a separate child process.
- `node scripts/provider-smoke.mjs`: 36/36 against a real database, a real
  loopback HTTP upstream, real `fetch`, and a separate-process reopen.
- `node scripts/proxy-smoke.mjs`: 39/39 against a real database plus real SOCKS5
  and HTTP `CONNECT` servers, completing real tunneled HTTP requests.
- `node scripts/router-smoke.mjs`: 46/46 against a real database, four real
  origins, and a real `CONNECT` proxy.
- `node scripts/api-smoke.mjs`: 62/62 against a **real listener** driven by real
  `fetch`.
- `node scripts/dashboard-smoke.mjs`: 35/35 against the **built bundle** — no
  `localStorage`/`sessionStorage`/cookie/`indexedDB`/`window.name` write, no
  `dangerouslySetInnerHTML` prop, no `eval`/`new Function`/`document.write`, no
  credential getter, no 64-hex or `sk-`/`Bearer` literal, token input declared
  `type="password"` with `autoComplete="off"`, approved Flux Core mounted, and no
  remote font/script/stylesheet or loadable remote origin.
- Live boot on `127.0.0.1:20998` with `BAYZ_DASHBOARD_ROOT` pointed at the built
  dashboard: `schemaVersion:4`, `/api/health` unauthenticated and byte-identical,
  `/api/status` 401 unauthenticated, dashboard shell served, and the served bundle
  contains `data-bayz-flux-core-slot`, `relay-wrap`, `flux-vignette`,
  `requestAnimationFrame`, `OPENROUTER`, and `Surge`. Served CSS contains zero
  `@import` and zero `googleapis`. Root key absent from the log.
- Secret scan over tracked non-test source for `sk-*`, `hunter2`, `PROMPT-`,
  `API-SMOKE`, `BEGIN … PRIVATE KEY`, `AIza…`, and any 64-hex literal: no matches.
- Getter scan for `getCredential`/`getPassword`/`reveal*`/`export*` across all
  `src`: no matches. `withCredential` exists only in
  `packages/providers/src/manager.ts`, consumed only by
  `packages/router/src/router.ts`.
- Dashboard persistence scan (`localStorage.`/`sessionStorage.`/`document.cookie`)
  over `apps/dashboard/src`: no code matches; the only textual hits are the two
  comments explaining why persistence is refused.
- Unsafe-DOM scan over `apps/dashboard/src`: no matches.
- `node:sqlite` imported in exactly one file, enforced by a source-scan test.
- The only tracked files matching `flux` are `apps/dashboard/src/FluxCoreSlot.tsx`
  and `apps/dashboard/src/flux/*`, which hold the **approved Flux Core V2 source**
  integrated from `/mnt/sdcard/Download/animasi/animasi usage.html` (47,833 bytes).
  Nothing was recreated from memory.

## Flux Core V2 integration

Source of truth: `/mnt/sdcard/Download/animasi/animasi usage.html`, 47,833 bytes,
`<title>BAYZ — Relay Track / Flux Core v2</title>`. The 0-byte
`/mnt/sdcard/Download/animasi usage.html` stub was **not** used.

```text
apps/dashboard/src/FluxCoreSlot.tsx   mount point, still data-bayz-flux-core-slot
apps/dashboard/src/flux/types.ts      display-safe view model (no secret fields)
apps/dashboard/src/flux/engine.ts     ported canvas engine, no DOM ownership
apps/dashboard/src/flux/FluxCore.tsx  React shell, controls, throttled labels
apps/dashboard/src/flux/flux.css      ported styles, scoped, no remote font
```

### Preserved from the approved source

Geometry and topology (720/280-point Fibonacci shells, 110-point deterministic
nucleus with the same LCG seed 42), provider positions (`p1`–`p5` at the same
percentages, including the mobile overrides), packet physics and beat clock
(`1.45`s, the same acceleration curve), wave/dent/flash pool sizes (8/6/6) and
firing amplitudes, bezier filament bends and braided strand counts, adaptive
quality thresholds (`ema>27` heat, `ema<15` cold, `q` 0–2 with the same point
reductions), Calm/Live/Surge constants (`sp/en/den` unchanged), DPR cap of 2,
monochrome additive `lighter` compositing on `#040404`, the quantized alpha cache,
core copy, legend, HUD layout, and the full failover-drill timing sequence
(900 / 4300 / 7600 ms).

### Production changes

1. **Google Fonts `@import` removed.** Local stacks lead with `Archivo`,
   `Archivo Black`, `IBM Plex Mono` so an operator with those faces installed sees
   the approved typography exactly; otherwise the nearest local grotesque/monospace
   is used. No network dependency, no CSP `font-src` exception.
2. **`innerHTML` removed.** The standalone activity feed used
   `row.innerHTML = '...' + name + ...`. Every dynamic string now renders as a React
   text node. Provider, model, route, and event strings are untrusted.
3. **Engine no longer touches the document.** It receives the canvas, wrapper, and
   chip elements, and reports state through callbacks. That is what makes React
   cleanup possible and keeps per-frame work out of React.
4. **CSS scoped to `.flux-panel`.** The standalone file styled `html`, `body`, and
   bare `button`; mounting it unscoped would have restyled the whole dashboard.
5. **Display-safe boundary added** (`flux/types.ts`). Until real telemetry exists,
   the approved simulation drives the view and the panel is labelled `SIM`.

### Known discrepancies from the standalone HTML

Stated plainly rather than claimed equivalent — **pixel and motion equivalence has
not been verified**, because this environment has no browser to compare rendered
output frame by frame:

1. **Typography may differ** wherever Archivo / Archivo Black / IBM Plex Mono are
   not installed locally. This is the deliberate cost of removing the remote font.
2. **The surrounding page is not ported.** The standalone file also contains a
   sidebar, mobile header, score strip, recent-requests table, token-pace chart, and
   period tabs. Only the Relay Usage Track was extracted, as instructed; the Phase 7
   dashboard remains the shell.
3. **When a live model is supplied, the interactive HUD is disabled.** Provider
   toggles, the count buttons, and the failover drill are simulation affordances;
   driving them against real routing state would fake control the API does not yet
   expose. Tempo remains interactive because it only affects animation.
4. **`onBeat` uses `Math.random()`**, exactly as approved, so packet timing is
   non-deterministic between runs — identical to the standalone behavior, but it
   means two side-by-side renders will never match frame for frame.
5. **jsdom has no Canvas 2D**, so tests assert engine lifecycle, bounds, and safety
   rather than pixel output. Visual confirmation needs a real browser.

## Environment facts

- Node `v24.19.0`, `linux arm64`. `node:sqlite` present, SQLite `3.53.3`, no
  ExperimentalWarning.
- Zero new dependencies added in Phases 2–7 — runtime or dev. `apps/dashboard`
  dependencies remain exactly `@bayz/contracts`, `react`, `react-dom`, asserted by
  a test.
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

## Phase 5 architecture as built

```text
Router                        packages/router/src/router.ts
  ├─ RouteRepository          model→provider bindings, validated pre-SQL
  ├─ resolveCandidates        deterministic: specificity → priority → id
  ├─ providers.withCredential scoped lend, never a getter
  ├─ proxies.agentFor         proxy-bound routes traverse their proxy
  └─ sendChatRequest          node:http POST, byte-capped, strict response parse
```

The router closes the Phase 4 `fetch` gap for its own path: because it uses
`node:http`, the Phase 4 agent works and a proxied request genuinely tunnels.
Global `fetch` (still used by provider discovery) remains direct.

## Phase 5 deviations from the plan text

1. **`withCredential` instead of a getter.** The plan already called for this; the
   implementation detail worth recording is that the callback never runs when no
   credential is stored, so a caller cannot accidentally send an unauthenticated
   request believing it was signed. A corrupt credential raises `secret_corrupt`
   rather than being treated as absent.
2. **A disabled provider is skipped, not counted as a failed attempt.** The plan
   did not say which. Counting it would inflate `attempts` and imply a network
   call that never happened; if every candidate is skipped the result is
   `all_routes_failed` with a `chat-skipped-<n>` stage, which is distinct from
   `no_route` (routes exist, they are just unusable right now).
3. **Malformed `usage` degrades; malformed content does not.** Token counts are
   informational, so a bad `usage` block yields `undefined` instead of failing an
   otherwise good response. Content is not informational, so a bad content field
   is always a hard failure — never an empty string.
4. **Model ids reject `//` and `:/` beyond the character class.** A name like
   `https://evil.example.com/m` otherwise passed the slug regex, and since the
   model is appended to a provider base URL it could have redirected the request.
   Found by a failing test, not anticipated.
5. **`(model, provider_id)` is unique.** The same model cannot be bound twice to
   one provider, which surfaced in the smoke script and is the correct constraint:
   two identical bindings would make selection order arbitrary.
6. **Route identity is immutable.** `id`, `model`, and `providerId` are not
   patchable, so an operator creates a new reviewable binding instead of silently
   repointing an existing one.

## Phase 6 architecture as built

```text
buildApp                      apps/server/src/app.ts
  ├─ installApiGuards         Host → Origin → guarded-path → rate → bearer token
  ├─ installContentTypeGuard  application/json required for bodies
  ├─ /api/health              unauthenticated, Phase 1 contract pinned
  ├─ /api/status              operational facts only
  ├─ routes/providers|proxies|routes|chat
  └─ installErrorHandling     framework + domain codes → stable envelope
createBayzRuntime             one SecretStorage → providers, proxies, router
```

The guard is a global `onRequest` hook, not a per-route decorator. That is the
whole reason a newly added endpoint cannot forget to authenticate, and it is what
the adversarial test verifies by enumerating Fastify's own route table.

## Phase 6 deviations from the plan text

1. **`Host` and `Origin` validation added, including on `/api/health`.** The plan
   named CSRF and rebinding as requirements without specifying placement. Health
   is exempt from *authentication* and *rate limiting* but not from Host checking,
   otherwise it would be a usable rebinding oracle.
2. **Health is exempt from rate limiting.** Not in the plan. Without it, an
   attacker burning the 10/min auth budget would also take down a supervisor's
   liveness probe, turning a brute-force brake into a self-inflicted outage.
3. **`DELETE` is idempotent and always `204`.** The plan did not say. Returning
   `404` for a missing id would let an unauthenticated-adjacent caller enumerate
   ids through delete responses; the end state is identical either way.
4. **Framework error codes mapped explicitly.** Fastify raises
   `FST_ERR_CTP_BODY_TOO_LARGE`, `FST_ERR_CTP_INVALID_JSON_BODY`, and friends
   before any handler, so they never reach the domain mapping and would all have
   answered `500`. They now map to `413`/`400`/`415`. The exact code
   (`..._INVALID_JSON_BODY`, not `..._INVALID_JSON`) was found by inspecting a real
   throw, not from documentation.
5. **The 404 handler is owned by whichever layer is present.** Fastify permits one
   per scope, and the static dashboard already installs one that serves
   `index.html` for client routes while keeping `/api/*` misses as JSON. The core
   handler is therefore conditional rather than unconditional.
6. **`Host` cannot be set through `fetch`.** The API smoke script issues a raw
   HTTP/1.1 request over a socket for the rebinding probe, because `fetch` treats
   `Host` as a forbidden header and silently refuses to override it. A test that
   used `fetch` here would have passed vacuously.
7. **`apps/server/src/storage.ts` is now unused by startup** but left in place: it
   is still covered by Phase 2 regression tests that pin the storage-init contract,
   and deleting it would remove that coverage for no benefit.

## Phase 7 architecture as built

```text
App                           apps/dashboard/src/App.tsx
  ├─ FluxCoreSlot             EMPTY mount point for approved Flux Core V2
  ├─ CoreStatus               unauthenticated /api/health liveness
  └─ TokenGate                in-memory token; children hidden until unlocked
       ├─ StatusPanel         /api/status
       ├─ ProvidersPanel      CRUD + write-only credential + discover
       ├─ ProxiesPanel        CRUD + write-only password + check
       ├─ RoutesPanel         CRUD + priority + proxy binding
       └─ ChatPanel           one-shot chat, in-memory transcript only
createApiClient               bearer injection, credentials:"omit", ApiError
```

## Phase 7 deviations from the plan text

1. **`CoreStatus` split out of `App`.** The plan implied panels inside the shell
   without saying where liveness lives. It is now outside the token gate, because an
   operator must be able to distinguish "the Core is down" from "I have not unlocked
   the session yet" — `/api/health` needs no token, so gating it would have hidden
   useful information.
2. **Testing Library cleanup was missing.** Vitest is not run with
   `globals: true`, so the automatic `afterEach(cleanup)` was never registered and
   DOM leaked between tests, which surfaced as duplicate-role query failures. Fixed
   in `test/setup.ts`. This was a pre-existing gap that only became visible once
   more than one component test existed.
3. **`@testing-library/user-event` is not installed**, so panel interaction uses
   `fireEvent`. Adding the package would have been a new dependency; `fireEvent` is
   sufficient for these assertions.
4. **The source scan strips comments and string literals** before applying its
   rules. Without that, documenting *why* we refuse to use `localStorage` would fail
   the test that forbids `localStorage` — which would push the reasoning out of the
   source. The scan therefore checks code, and the comments remain.
5. **The bundle scan cannot forbid bare `dangerouslySetInnerHTML` or
   `.innerHTML =`.** React's own runtime contains both, so those two rules are
   enforced against `apps/dashboard/src` in the adversarial test, where React is not
   in scope; the bundle scan asserts the narrower `dangerouslySetInnerHTML:` prop
   form plus `eval`/`new Function`/`document.write`. Stated plainly because a reader
   would otherwise expect the bundle scan to be the stronger of the two.
6. **`useAsync` and `PanelError` were extracted** into `panels/shared.tsx` rather
   than repeated five times. Still no state library: it is roughly forty lines and
   the panels share no cache that would justify a dependency.
7. **Flux Core V2 is an empty slot.** `FluxCoreSlot.tsx` renders one empty `div`
   with `data-bayz-flux-core-slot`. No animation primitive appears anywhere, and both
   a test and the build smoke assert that. The approved source is supplied
   separately; approximating it from memory would have produced a different
   animation wearing its name.

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
- **Streaming (SSE)** — not implemented. `stream: true` is *rejected*, not
  ignored, so no caller can believe it is streaming when it is not. A correct
  implementation needs incremental parsing plus cancellation semantics.
- **Combos (multi-provider fan-out) and usage accounting** — not implemented, and
  no schema for either exists. A migration test asserts the tables are absent.
- **Router HTTP surface** — now exists as of Phase 6. Chat and management routes
  are authenticated; see the README API section.
- **Combo / usage schema and endpoints** — not implemented. A migration test
  asserts the tables are absent and no route exposes them.
- **Streaming over HTTP** — `POST /v1/chat/completions` with `stream` returns
  `400 streaming_unsupported`. Not faked, not silently ignored.
- **Dashboard controls for any of this** — added in Phase 7. Providers, proxies,
  routes, and a test chat are all manageable from the shell.
- **Flux Core V2 visual implementation** — deliberately NOT built. The slot is
  empty and awaits the approved source.

## Phase 7 residual risk

Protected: the API token is held in memory only, proven by a source scan *and* a
scan of the built bundle; no credential, password, or token is ever rendered, and
panels read only known fields so a compromised Core cannot get a secret onto the
screen; every API/upstream/model/route string renders as React text with no
`dangerouslySetInnerHTML`, `innerHTML`, `insertAdjacentHTML`, or `eval` anywhere in
the source; no prompt or completion is persisted, and the transcript dies with the
view; the dashboard is same-origin so the Phase 6 `Origin` check applies without any
CORS relaxation; zero new dependencies.

Not protected: XSS on this origin during an unlocked session can still act as the
operator for the lifetime of that session and can read the in-memory token. Memory
storage bounds the damage to a session rather than eliminating it. There is also no
Content-Security-Policy header yet — the Core serves the dashboard without one,
which is the obvious next hardening step and is not claimed to be done. The token is
still a single shared credential with no scopes or expiry.

## Phase 6 residual risk

Protected: `/api/health` is the only unauthenticated route and its Phase 1
contract is pinned; every other route is authenticated, verified by enumerating
Fastify's route table rather than a hand-written list; malformed, duplicated, and
query-string token forms all fail closed and are indistinguishable from a missing
token; no endpoint returns a credential, password, or the API token, and every
response body in a full exercise is scanned for all three; prompts and completions
never touch the database or the logs; `Origin` and `Host` are validated so
cross-site requests and DNS rebinding fail; no CORS header is ever emitted; bodies
are capped at 1 MiB; failed authentication is throttled.

Not protected: the rate limiter is an in-process fixed-window counter keyed by
address — a brute-force brake, not a DDoS defence, and it resets on restart. The
token is a single shared operator credential with no scopes, expiry, or rotation
endpoint; rotation today means deleting the stored secret and restarting. A root
attacker on the device can still read `master.key` or the environment, unchanged
from Phase 2. Prompts still travel to whatever upstream the operator configured, in
plaintext if that upstream is `http`.

## Phase 5 residual risk

Protected: prompts and completions are never persisted or logged (proven against
raw database bytes and captured logs), no credential can be read out of any
manager, failover never carries one provider's credential to another, a corrupt
credential fails the request instead of silently going unauthenticated, an
upstream cannot inject fields into a router result or reach `Object.prototype`,
response sizes are capped, model names cannot escape into a URL, and route
selection is deterministic and explainable.

Not protected: an operator who binds a model to a provider pointing at an internal
address will reach it — that is an admin capability, not an SSRF guard. Prompts
still travel to whatever upstream the operator configured, in plaintext if that
upstream is `http`. There is no per-route rate limit and no request-level audit
trail (deliberately, since an audit trail would mean storing prompts).

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

`apps/dashboard` is the runtime foundation shell plus the Phase 7 operator panels.
It is **not** a redesign and does **not** replace `BAYZ-responsive-master.html` as
the locked visual source of truth.

The **BAYZ Flux Core V2 motion system is now integrated** from the approved
47,833-byte source. `apps/dashboard/src/flux/` holds the port and
`apps/dashboard/src/FluxCoreSlot.tsx` mounts it; `data-bayz-flux-core-slot` remains
the anchor. See the Flux Core V2 integration section above for what was preserved,
what was changed for production, and the known discrepancies.

## Resume steps once the real BAYZ repo/UI is available

1. Copy the Sites/UI source and the real root `package.json` into this workspace.
2. Merge the workspace fields (`workspaces`, `runtime:*` scripts) into the real
   root `package.json` instead of overwriting it.
3. Move the README runtime, storage, provider, proxy, router, API, and dashboard
   sections into the real README.
4. Run the root Sites build and confirm it still exits 0.
5. Re-run `npm run runtime:verify` and all six smoke scripts.

## Next steps

1. **Verify Flux Core in a real browser.** Motion and typography equivalence with
   the approved standalone file is *unverified* — this environment has no browser.
   Compare side by side before treating the port as visually final.
2. **Wire real usage telemetry** into `flux/types.ts`. Until then the panel runs the
   approved simulation and labels itself `SIM`.
3. **Content-Security-Policy** — the Core serves the dashboard with no CSP header.
   Flux Core is already CSP-compatible (no remote font, no `eval`, no injected
   code), so a strict policy can now be added without exceptions.
4. **Combos and usage** — still unimplemented, with no schema, per the phase plans.
