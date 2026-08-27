# BAYZ Router — Chat → Work handoff

## Current execution state

- Foundation Plan (Phase 1): **COMPLETE**, 8 commits, `runtime:verify` green.
- Phase 2 Security + SQLite Storage: **COMPLETE**, Task 1–8, `runtime:verify` green.
- Phase 3 Provider Manager: **COMPLETE**, Task 1–8, `runtime:verify` green.
- Phase 4 Proxy Manager: **COMPLETE**, Task 1–8, `runtime:verify` green.
- Phase 5 Router: **COMPLETE**, Task 1–8, `runtime:verify` green.
- Phase 6 Local HTTP API: **COMPLETE**, Task 1–8, `runtime:verify` green.
- Phase 7 Operator Dashboard: **COMPLETE**, Task 1–8, `runtime:verify` green.
- Flux Core V2 + scalable provider constellation: **INTEGRATED**, visually LOCKED.
- Phase 8 Usage Telemetry: **COMPLETE**, Task 1–8, `runtime:verify` green.
- Phase 9 GOAT Release: **IN EXECUTION.**
  - Free-first model economics amendment: **COMMITTED** (`8069b65`), spec §25.
  - 9A Universal Client Gateway: **COMPLETE**, Tasks 1–6.
  - 9B Streaming + Tool Calling: **COMPLETE**, Tasks 1–8.
  - 9C Per-Client Security: **COMPLETE**, Tasks 1–8.
  - 9D–9L: **NOT STARTED.**
  - Plans and spec are committed at `bad8325` and amended at `8069b65`; every
    subsequent commit is implementation.
- Approved plans:
  - `docs/superpowers/plans/2026-08-26-bayz-router-foundation.md`
  - `docs/superpowers/plans/2026-08-26-bayz-router-security-sqlite.md`
  - `docs/superpowers/plans/2026-08-26-bayz-router-provider-manager.md`
  - `docs/superpowers/plans/2026-08-26-bayz-router-proxy-manager.md`
  - `docs/superpowers/plans/2026-08-26-bayz-router-router.md`
  - `docs/superpowers/plans/2026-08-26-bayz-router-http-api.md`
  - `docs/superpowers/plans/2026-08-26-bayz-router-dashboard.md`
  - `docs/superpowers/plans/2026-08-26-bayz-router-usage-telemetry.md`
- Phase 9 plans (approved, **unexecuted**):
  - `docs/superpowers/plans/2026-08-27-phase9a-universal-client-gateway.md`
  - `docs/superpowers/plans/2026-08-27-phase9b-streaming-and-tools.md`
  - `docs/superpowers/plans/2026-08-27-phase9c-client-identity-scoped-keys.md`
  - `docs/superpowers/plans/2026-08-27-phase9d-custom-provider-completeness.md`
  - `docs/superpowers/plans/2026-08-27-phase9e-multi-proxy-easy-ux.md`
  - `docs/superpowers/plans/2026-08-27-phase9f-fortress-security.md`
  - `docs/superpowers/plans/2026-08-27-phase9g-agent-tool-injection-security.md`
  - `docs/superpowers/plans/2026-08-27-phase9h-client-compatibility-matrix.md`
  - `docs/superpowers/plans/2026-08-27-phase9i-fuzz-chaos-load-soak.md`
  - `docs/superpowers/plans/2026-08-27-phase9j-cross-platform-packaging.md`
  - `docs/superpowers/plans/2026-08-27-phase9k-supply-chain-release-integrity.md`
  - `docs/superpowers/plans/2026-08-27-phase9l-feature-completeness-gate.md`
- Approved specs:
  - `docs/superpowers/specs/2026-08-26-bayz-router-security-sqlite-design.md` (Revision 2, Fortress)
  - `docs/superpowers/specs/2026-08-26-bayz-router-provider-manager-design.md`
  - `docs/superpowers/specs/2026-08-26-bayz-router-proxy-manager-design.md`
  - `docs/superpowers/specs/2026-08-26-bayz-router-router-design.md`
  - `docs/superpowers/specs/2026-08-26-bayz-router-http-api-design.md`
  - `docs/superpowers/specs/2026-08-26-bayz-router-dashboard-design.md`
  - `docs/superpowers/specs/2026-08-26-bayz-router-usage-telemetry-design.md`
  - `docs/superpowers/specs/2026-08-27-bayz-phase9-goat-release-design.md`
- Every task followed RED → verify RED → GREEN → verify GREEN.
- No push to GitHub. All work is local commits on `master`.

## Verified totals

- `@bayz/telemetry`: 55 tests pass.
- `@bayz/storage`: 160 tests pass (schema is v5).
- `@bayz/providers`: 111 tests pass.
- `@bayz/proxy`: 105 tests pass.
- `@bayz/router`: 140 tests pass.
- `@bayz/server`: 142 tests pass (includes the `/api/health` Phase 1 contract guard).
- `@bayz/dashboard`: 253 tests pass across 17 files.
- `@bayz/contracts`: 3, `@bayz/security`: 6.
- `npm run runtime:verify` exits 0; all nine builds exit 0.
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
- `node scripts/usage-smoke.mjs`: **119/119** against a real listener, seven real
  loopback origins, and a real `CONNECT` proxy — a full success/failure/failover/
  Combo/proxy/unknown-token/zero-token/malformed-usage/hostile-error sweep, then a
  six-sentinel leak drill across the database, WAL, SHM, stdout, stderr, structured
  logs, and every usage/management API response.
- `node scripts/dashboard-smoke.mjs`: 48/48 against the **built bundle** — no
  `localStorage`/`sessionStorage`/cookie/`indexedDB`/`window.name` write, no
  `dangerouslySetInnerHTML` prop, no `eval`/`new Function`/`document.write`, no
  credential getter, no 64-hex or `sk-`/`Bearer` literal, token input declared
  `type="password"` with `autoComplete="off"`, approved Flux Core mounted, no
  remote font/script/stylesheet or loadable remote origin, and the scalable
  constellation (`flux-field`, `provider-mark`, `PVD-`, `incident-row`) present
  with no `+N providers` aggregation.
- Live boot on `127.0.0.1:21001` with `BAYZ_DASHBOARD_ROOT` on the built dashboard:
  `schemaVersion:4`, `/api/health` unauthenticated and byte-identical,
  `/api/status` 401 unauthenticated, shell served, and the served bundle contains
  `data-bayz-flux-core-slot`, `relay-wrap`, `flux-field`, `provider-mark`, `PVD-`,
  `incident-row`, `incident-detail`, `route-`, `requestAnimationFrame`, and
  `Surge`. Served CSS contains `route-primary` and zero `@import`/`googleapis`.
  Root key absent from the log.
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
apps/dashboard/src/FluxCoreSlot.tsx      mount point, still data-bayz-flux-core-slot
apps/dashboard/src/flux/types.ts         display-safe view model (no secret fields)
apps/dashboard/src/flux/engine.ts        ported canvas engine, no DOM ownership
apps/dashboard/src/flux/FluxCore.tsx     React shell, controls, viewport, labels
apps/dashboard/src/flux/flux.css         ported styles, scoped, no remote font
apps/dashboard/src/flux/constellation.ts scalable layout + ingress trunk bundling
apps/dashboard/src/flux/lod.ts           semantic zoom + label priority/collision
apps/dashboard/src/flux/viewport.ts      clamped pan/zoom maths
apps/dashboard/src/flux/identity.ts      safe short id, initials, icon key resolve
apps/dashboard/src/flux/ProviderMark.tsx local monochrome SVG mark table
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

### Scalable provider constellation

The approved source demonstrates a fixed five providers. Production BAYZ needs
arbitrary counts, so the space *around* the core was extended while the core itself
was left alone.

- **1–5 providers use the approved layout verbatim** — original `.p1`–`.p5` CSS
  positions, full chip detail, one filament each, every label shown. A test pins the
  coordinates to six decimal places so the baseline cannot drift.
- **Past five**, providers are placed on concentric rings with a golden-angle offset
  per ring, so adjacent rings never align radially. Layout is pure and
  deterministic.
- **Traffic bundles, state does not.** Above five providers, filaments braid into 12
  sector trunks: 40 providers → 12 trunks, 120 providers → 12 trunks. `trunkFor()`
  maps any provider back to its trunk, so focusing one still identifies its own
  traffic. Bundling is a rendering decision only; `members` always holds every
  provider.
- **Semantic zoom** with three bands (far &lt; 1.15×, medium &lt; 2.1×, near) and a label
  budget of 4 / 10 / 24. Priority: selected &gt; failed &gt; degraded/recovering &gt; active
  &gt; standby &gt; off, with traffic share breaking ties inside a state and id breaking
  the rest, so ordering is stable frame to frame.
- **Overlap never deletes a node.** Exceptions that miss a label slot appear in a
  named Incidents list; clicking a row focuses the provider. There is no
  `+N providers` abstraction, and the build smoke asserts none was shipped.
- **Identity** is a local monochrome mark, a display name, and a stable non-secret
  `PVD-xxxx` (FNV-1a over the provider id alone). Duplicate display names become
  `CUSTOM — PVD-1A2F` automatically.
- **Icons are keys, not content.** Provider metadata selects one of eight local SVG
  marks; an unknown or hostile value (markup, URL, data URI, traversal) resolves to
  the generic mark plus initials. No provider-supplied markup, and no remote asset.
- **Zoom/pan** clamped to 0.45–4× and ±2000px, with every operation repairing a
  non-finite state, so the core cannot be lost off-screen. Wheel handling is scoped
  to the stage so page scrolling is unaffected. Pinch, drag, click-select,
  double-click-focus, and reset are all present, and all listeners are removed on
  unmount (asserted).
- **Performance:** the engine allocates filaments once and grows the pool on demand;
  anchors are supplied as data, so a 120-provider layout performs zero DOM
  measurements; braid strand count steps 3 → 2 → 1 as count rises; label/collision
  resolution runs on viewport or selection change, not per frame.

### The display-safe boundary is fully consumed

Every field the boundary declares reaches the screen — a declared-but-unused field
would be a hollow contract, so each is pinned by a test in
`test/flux-boundary.test.tsx`:

- `routeParticipation` → `data-route` attribute, a `route-*` prominence class, and
  the accessible name. Primary routes get the brightest border and an outward glow,
  combo members normal weight, reserves recede, `none` recedes furthest while
  staying inspectable. Selection always overrides participation.
- `latencyMs` → shown as `143 ms` on a labelled chip; a non-finite value is dropped
  rather than rendered as `NaN`.
- `incidentReason` → shown in the incident row beneath the provider name, as inert
  text. A provider carrying a reason appears in the incident list even when it holds
  a label slot.
- `period` → appended to the panel meta line.
- `loadPercent`, `routedRequests`, `routingMode` → core stat line, load meter, and
  mode word.

Disabled (`off`) nodes stay present, focusable, and clearly traffic-free.

### Dense-state verification

Measured in the integrated component by `test/flux-verify-states.test.tsx`, which
prints this table on each run:

```text
1 provider DIRECT      nodes=  1 labels= 1 budget= 1 trunks= 1 failed= 0 incidents= 0
5 provider COMBO       nodes=  5 labels= 5 budget= 5 trunks= 5 failed= 0 incidents= 0
12 provider COMBO      nodes= 12 labels= 4 budget= 4 trunks= 9 failed= 0 incidents= 0
40 provider COMBO      nodes= 40 labels= 4 budget= 4 trunks=12 failed= 0 incidents= 0
40 COMBO / 1 FAILED    nodes= 40 labels= 4 budget= 4 trunks=12 failed= 1 incidents= 0
40 COMBO / 14 FAILED   nodes= 40 labels= 4 budget= 4 trunks=12 failed=14 incidents=10
120 provider COMBO     nodes=120 labels= 4 budget= 4 trunks=12 failed= 0 incidents= 0
duplicate custom names nodes=  4 labels= 4 budget= 4 trunks= 4 failed= 1 incidents= 0
mixed states           nodes= 20 labels= 4 budget= 4 trunks=11 failed= 1 incidents= 0
```

Every state asserts: node count equals provider count, every node carries a mark,
labels stay within the collision budget, and every failed provider is accounted for
either as a label or as a named incident.

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
3. **When a live model is supplied, the routing HUD is disabled.** Provider toggles,
   the count buttons, and the failover drill are simulation affordances; driving them
   against real routing state would fake control the API does not expose. Zoom,
   reset, and tempo stay interactive because they are view controls.
4. **`onBeat` uses `Math.random()`**, exactly as approved, so packet timing is
   non-deterministic between runs — identical to the standalone behavior, but it
   means two side-by-side renders will never match frame for frame.
5. **jsdom has no Canvas 2D and performs no layout**, so tests assert engine
   lifecycle, bounds, label budgets, and safety rather than pixel output or measured
   text overlap. Visual confirmation needs a real browser.
6. **Beyond five providers the chip presentation necessarily changes.** The approved
   148px card would tile the stage at 40 nodes, so unlabelled nodes render as a
   compact mark and expand to a card only when they hold a label. This is an
   extension of the approved language rather than a preserved detail, and it is the
   one place the visual result at high density has no approved reference.
7. **`prov.p1`–`p5` classes are absent past five providers**, since positions then
   come from the constellation rather than the approved CSS. Pinned by a test so the
   switchover is explicit rather than incidental.

### Residual limitations

- Pinch zoom is implemented from raw pointer events rather than a gesture library
  (no new dependency); it is covered by unit tests but not by a real multi-touch
  device in this environment.
- Trunk count is fixed at 12 sectors. It is adequate from 6 to at least 120
  providers, but has not been tuned above that.
- Provider ring capacity tops out at six rings (138 slots) before positions begin to
  repeat radially at greater distance; beyond roughly 140 providers the layout would
  need another ring tier.
- The incident list orders by the label-priority ranking only; there is no separate
  severity model. Failure reasons are displayed when the model supplies
  `incidentReason`, but no Bayz API field populates it yet, so in practice it stays
  empty until routing telemetry exists.

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

## Phase 8 architecture as built

```text
Router  --emit(metadata)-->  normalizeUsageEvent  -->  UsageRepository
                             (closed field set)        (usage_requests,
                                                        usage_attempts,
                                                        count retention)
                                                              |
apps/server/src/routes/usage.ts  <-- authenticated Usage API --+
                                                              |
apps/dashboard/src/flux/adapter.ts  --> FluxCoreViewModel(source:"live")
```

Migration v5 adds the only new tables. Neither has a column able to hold content;
`failure_category` is enum-constrained in SQL as a backstop behind the boundary.

### Measured Phase 8 results

- Real end-to-end path proven by `scripts/usage-smoke.mjs`: authenticated API →
  router → real origin → telemetry → SQLite → Usage API → live Flux Core model.
- Sentinel leak drill, six sentinels (prompt, completion, provider credential, proxy
  password, Bayz API token, upstream error body): **zero** occurrences in `bayz.db`,
  `-wal`, `-shm`, stdout, stderr, structured logs, stored rows, and every
  usage/management API response. Metadata (`model-proxied`) *is* present in the byte
  scan, proving the scan reads real content.
- Retention: 500 events into a 10-row bound yields exactly 10 rows; a provider,
  proxy, route, and secret seeded alongside all survive. A malformed retention value
  cannot disable retention.
- Token honesty: unknown → `null`, genuine zero → `0`, malformed upstream usage
  (`prompt_tokens: -12`, `completion_tokens: "lots"`) → `null`. Verified end to end
  through three separate origins.
- Cost: `costAvailable: false`, `costReason: "no_pricing_data"`. No figure anywhere.
- CSP verified on a **real served response** at `127.0.0.1:21003`, not just as a
  constant.
- Flux Core live data verified for 1, 5, 12, 40, 40-with-failure, and 120 providers,
  plus duplicate custom names — no truncation, no fixed-five regression.

## Phase 8 deviations from the plan text

1. **Five event kinds, not eleven.** `request.started` and `route.selected` have no
   distinct observation point in the verified Phase 5 router, and
   `combo.member.started`/`combo.member.completed` are `provider.attempted`/
   `provider.failed` renamed. Emitting the others would have meant inventing
   observation points to serve telemetry rather than routing. Per-provider Combo
   membership and failover handoff are both fully observable with the five.
2. **`failover.started` is a marker, not a stored attempt.** My first implementation
   stored it in `usage_attempts`, which double-counted: a successful failover emits
   both it and `provider.attempted` for the promoted provider, inflating per-provider
   activity to 2 attempts for 1 network call. Found by a failing API test.
3. **No event queue.** The DoS risk of an unbounded queue was removed rather than
   bounded: a usage row is a dozen integers and slugs, and an async queue would add
   shutdown data loss for no measurable gain.
4. **`MIN_RETENTION` is 1, not 10.** My first value silently rejected a test's
   `requestRetention: 5` and fell back to the 5,000 default, so retention appeared
   not to prune at all. Three tests failed for what looked like a pruning bug but was
   config validation.
5. **Share totals drift above 100 at high provider counts.** 120 equal providers each
   round 0.83% to 1%, summing to 120. That is honest arithmetic — each share is the
   provider's real attempt fraction — so the assertion scales with count rather than
   normalizing shares and misreporting each one.
6. **The chat response legitimately contains the completion.** The smoke script's
   response scan is scoped to usage and management endpoints; scanning the chat
   response would have flagged the product working. Stated explicitly because a
   reader would otherwise expect the scan to cover every response.

## Phase 8 residual risks

- **`incidentReason` has no populating API field yet.** The boundary and the adapter
  both carry it, and a test proves it renders inertly, but no Bayz endpoint supplies
  a failure reason string today, so in practice it stays empty.
- **Retention is count-based only.** There is no age-based expiry, so a low-traffic
  install keeps old rows indefinitely (bounded in size, unbounded in age). An
  operator wanting time-based deletion has only the purge endpoint.
- **The `failure_category` enum is duplicated** in `@bayz/telemetry` and in
  `apps/dashboard/src/flux/failure-categories.ts`. Deliberate — the dashboard must
  not depend on a server package — but the two lists can drift. Drift surfaces as a
  category rendering `unknown_error`, not as a leak.
- **CSP is served but not enforced by a browser in this environment.** The header is
  verified on a real response and the built artifact is verified to need no
  exception; actual browser enforcement is unverified here.
- **Telemetry failure is silent by design.** A recorder throwing or storage failing
  drops the row rather than failing the chat. That is correct for routing
  correctness, but it means telemetry gaps are not surfaced to the operator.

## Phase 9 GOAT — execution state

Authoritative resume point. Everything below is measured, not asserted.

### Completed subprograms

| Subprogram | State | Evidence |
|---|---|---|
| Free-first amendment | COMMITTED | spec §25, `8069b65` |
| 9A Universal Client Gateway | COMPLETE | `@bayz/gateway` 74 tests |
| 9B Streaming + Tool Calling | COMPLETE | `@bayz/router` 245 tests, `stream-smoke` 63/63 |
| 9C Per-Client Security | COMPLETE | `@bayz/identity` 69 tests, `identity-smoke` 74/74 |
| 9D–9L | NOT STARTED | — |

### Measured totals after 9C

- `@bayz/contracts` 3 · `@bayz/security` 6 · `@bayz/storage` 166 · `@bayz/telemetry` 55
- `@bayz/identity` 69 · `@bayz/gateway` 74 · `@bayz/providers` 111 · `@bayz/proxy` 105
- `@bayz/router` 245 · `@bayz/server` 212 · `@bayz/dashboard` 269 across 18 files
- `npm run runtime:verify` exits 0; 11 build targets.
- Smokes: storage 42/42 · provider 36/36 · proxy 39/39 · router 46/46 · api **70/70**
  · usage 119/119 · dashboard 48/48 · **stream 63/63** · **identity 74/74**.
- Schema is **v6** (`client_identities`, `identity_audit`). Read from
  `TARGET_SCHEMA_VERSION` — no test hardcodes it any more.

### New packages

```text
packages/identity   scopes, registry, key custody, audit   deps: security, storage
packages/gateway    capabilities, profile, presets, normalize   deps: identity, security
```

`runtime:build` order is now: contracts → security → storage → telemetry →
identity → providers → proxy → gateway → router → dashboard → server.

### 9A as built

- `deriveProfile` builds a `ClientProfile` from **path, Accept, body shape, and
  granted scopes** — never a product name. `adversarial.test.ts` scans
  `packages/gateway/src` and `apps/server/src/routes` for `opencode`/`hermes`/
  `antigravity`/`cline` with comments stripped, and only `presets.ts` may contain them.
- Capability is the **intersection of request intent and granted scope**. A request
  asking for streaming and tools with a `models.read`-only key gets an empty set.
- Profiles use sealed sets: `add`/`delete`/`clear` are replaced with throwing stubs,
  because `Object.freeze` on a `Set` leaves the mutators working and a caller could
  otherwise grant itself a capability the scope check refused.
- `normalizeRequest` maps `max_tokens`→`maxTokens`, `top_p`→`topP`, and a bare-string
  `stop` to an array. **This fixed a real compatibility defect**: before 9A a
  compliant OpenAI client sending `max_tokens` got a 400.
- One declared quirk, `max-tokens-string`, converts a string `max_tokens` — strictly,
  so `"512abc"` and `"1e9"` are refused rather than coerced.
- `apps/server/src/principal.ts` holds `BayzPrincipal` and the bootstrap admin
  identity; `apps/server/src/scopes.ts` holds `requireScope`.

### 9B as built

- `packages/router/src/sse.ts`: `encodeSseEvent`, `encodeSseDone`, `SseLineReader`.
  Bounded at 64 KiB per line and 2 MiB per stream, 8 malformed frames tolerated then
  fatal, streaming UTF-8 decode so a multi-byte character split across chunks is not
  corrupted, and `done()` throws on a stream that never sent `[DONE]`.
- `sendChatRequestStreaming` in `transport.ts` with a `ChunkQueue` bridging Node's
  push-based `IncomingMessage` to a pull-based async generator. Idle timeout distinct
  from total timeout, abort destroys the socket, and cleanup runs in a `finally` so a
  consumer that breaks out of its loop still tears the upstream down.
- `router.chatStream` fails over **only before the first chunk**. After that the
  response is committed and `router-stream.test.ts` asserts the second origin
  observes zero requests.
- `apps/server` serves SSE with `content-type: text/event-stream`,
  `cache-control: no-cache, no-transform`, `x-accel-buffering: no`, and the strict
  CSP. Routing headers are written from the first chunk, before the body.
- A mid-stream failure emits a terminal error event and **no `[DONE]`**, so a client
  can distinguish a broken stream from a complete one.
- Tools: `parseToolDefinitions`, `parseToolChoice`, `parseToolCalls`,
  `parseToolMessage`. Arguments stay the opaque JSON string the OpenAI contract
  defines, validated as an object but never re-serialized. Caps: 64 tools, 8 calls,
  32 KiB per blob, 16 levels of `parameters` nesting.
- `role: "tool"` requires a `tool_call_id` declared by an **earlier** assistant
  message; the walk is forward-only, so an out-of-order or fabricated result fails.
- `ProviderConfig.supportsTools` is tri-state. `false` refuses with
  `tools_unsupported` (501) rather than silently stripping tools; **absent means
  unknown and forwards**, because a discovery endpoint cannot reveal tool support.

### 9C as built

- Migration **v6**: `client_identities` (9 columns, no key/hash/secret column) and
  `identity_audit` (7 columns, enum-constrained `action` and `outcome`, cascade on
  identity delete).
- Keys are 32 random bytes stored envelope-encrypted at `client:<id>:key` through the
  Phase 3 scoped-secret primitive, returned **exactly once**. No accessor returns a
  stored key; the adversarial suite scans for one.
- `verifyKey` shape-checks before hashing (a 1 MiB bearer costs nothing), compares
  with `timingSafeEqual` over SHA-256 digests, and iterates **ids not views** so one
  corrupt `scopes_json` row cannot lock every client out.
- Ten scopes, no implication except `admin`. `providers.write` does **not** grant
  `providers.read`.
- 34 `/api/*` routes each declare a scope, enumerated from Fastify's own route table.
  `scope-enforcement.test.ts` rebuilds the full URL from `printRoutes`' indentation,
  because a naive per-line parse reports `/:id` as a top-level route and
  under-reports the surface by more than half.
- Identity management is `admin`-only without exception: minting a credential is
  strictly more powerful than any write scope.
- `DELETE /api/usage/requests` moved to `admin` — purging an operator's audit trail
  is destruction, not a read.
- Dashboard `IdentitiesPanel` shows a key once, drops it from the DOM on
  acknowledgement, and uses no clipboard API (`navigator.clipboard` is unavailable
  over plain HTTP, so a copy button on a loopback dashboard would silently do nothing).

### Deviations from the plan text, with reasons

1. **9A ran before 9C's registry.** The plan has 9C first. 9A Task 1 needed only the
   scope *vocabulary*, so that one task was pulled forward and the rest of 9C ran
   after 9B. `apps/server/src/principal.ts` provided an injectable resolver seam in
   the meantime, which is also what let 9A's scope logic be tested against a
   genuinely limited principal rather than only the all-powerful bootstrap token.
2. **Phase 6 refused `stream: false`.** `rejectsStreaming` refused *any* request
   carrying a `stream` key. A compliant client explicitly asking for a buffered
   response got a 400. Corrected in 9A, then made moot by 9B.
3. **`api-smoke` grew 62 → 70 checks.** Section 9 changed from "streaming is refused"
   to "streaming works over real SSE", which needed eight new assertions.
4. **A lone surrogate is escaped, not refused.** The plan assumed `JSON.stringify`
   emits a raw unpaired surrogate. It does not — well-formed stringify escapes it as
   `\ud800`, so the frame is already valid UTF-8 and refusing would reject a
   readable completion. Verified rather than assumed.
5. **Client-disconnect abort listens on `reply.raw`, not `request.raw`.** Fastify
   fully consumes and destroys `request.raw` while parsing the JSON body, so a
   `close` listener there fires before the handler runs and cancelled every stream
   instantly. Found by a failing test, not by inspection.
6. **`x-bayz-*` headers ride on each chunk.** HTTP headers cannot be revised after
   the first byte, so `RoutedChatChunk` carries routing identity and the header comes
   from the same object the body does.
7. **`tools_unsupported` maps to 501**, alongside `unsupported_operation`: the request
   is well-formed and the remedy is to configure a capable provider.
8. **Tool names beginning `__` are refused.** Harmless inside BAYZ, where a name is
   only a value, but BAYZ hands these names to clients it does not control and a
   client building `handlers[toolName]` would resolve `__proto__`.
9. **Identity ids reject a trailing dash**, matching `assertProviderId`, because the
   id is concatenated into `client:<id>:key`.
10. **Expiry requires a full ISO-8601 timestamp.** `Date.parse("0")` returns a valid
    time in 1999, so a bare digit would have been accepted as an expiry.
11. **`counts` in `/api/status` gained `identities`.** Two tests pinned the old shape
    and were updated; both now read `TARGET_SCHEMA_VERSION` instead of a literal 5.

### Residual risks after 9C

- **No mid-stream failover.** Structural, documented, and tested. Once a byte reaches
  the client the response is committed.
- **`verifyKey` is O(identities).** Each authentication walks the identity list
  hashing one candidate per usable identity. Fine at the tens-of-clients scale BAYZ
  targets; a deployment with thousands would want an indexed lookup, which would need
  a stored key hash and therefore a different custody decision.
- **A database-write attacker can widen scopes.** `scopes_json` is revalidated on
  read, so a *malformed* or unknown scope fails closed, but a valid `["admin"]`
  written directly into the row is honoured. Preventing that needs signed rows, which
  9F's config HMAC addresses partially.
- **Streaming telemetry records one row at stream end.** A stream that never
  terminates records nothing until it fails, so an in-flight long stream is invisible
  to the usage API.
- **The dashboard shows a key as selectable text.** Correct given no clipboard API
  over HTTP, but it is in the DOM until acknowledged, so a screen recording captures it.

## Phase 9 GOAT — planning state

Planning only. **No source file was created or modified.** One spec, twelve
subprogram plans, 86 tasks, 608 checkbox steps, all under `docs/superpowers/`.

- Spec: `docs/superpowers/specs/2026-08-27-bayz-phase9-goat-release-design.md`
- Plans: `2026-08-27-phase9{a..l}-*.md`

### Recovery from the SIGKILL

A prior session wrote the spec and plans 9A–9H, then was killed by signal 9 before
committing. Those nine files were recovered **untracked and unmodified** — `git
status` showed a clean tree with exactly nine untracked files, so nothing was
half-written and nothing needed rebuilding. This session wrote 9I–9L, then
self-reviewed all thirteen documents against the actual repository rather than
against the plan text, which is where the corrections below came from.

### Subprogram map

```text
9A Universal Client Gateway ......... packages/gateway (new)
9B Streaming + Tool Calling ........ packages/router, apps/server
9C Client Identity / Scoped Keys ... packages/identity (new), apps/server
9D Custom Provider Completeness .... packages/providers
9E Multi-Proxy Easy UX ............. packages/proxy, packages/router, apps/*
9F Fortress Security Expansion ..... packages/storage, packages/security, apps/server
9G Agent / Tool Injection Security . packages/gateway, packages/capability (new)
9H Client Compatibility Matrix ..... scripts/, docs/
9I Fuzz / Chaos / Load / Soak ...... scripts/fuzz/, chaos/load/soak smokes
9J Cross-Platform / Packaging ...... scripts/, packaging/
9K Supply Chain / Release Integrity  scripts/, sbom/
9L Feature Completeness Gate ....... docs/, scripts/release-gate.mjs
```

### Corrections the self-review produced

Each of these was a defect in the plan text, found by measuring the repository:

1. **Migration numbering could collide.** 9C, 9D, and 9E each add a migration and
   9D/9E run in parallel, so v6/v7/v8 could not be assigned statically. The spec now
   carries a numbering ledger with a renumbering rule, and no test hardcodes a head
   version — every migration test reads the head from the migration table.
2. **`runtime:build` order was specified three times inconsistently.** The spec now
   fixes the full twelve-target topological order in one place; the three plans
   reference it instead of each inventing an insertion point.
3. **9F was labelled fully parallel and is not.** Its posture ladder, root-key
   rotation route, and request signing need 9C's scope vocabulary to express
   `admin`-gating. Its plan now splits: Tasks 1, 3, 4, 5, 8 are parallel; Tasks 2, 6,
   7 depend on 9C Task 1.
4. **9I was ordered after 9H only.** Load measurement must observe 9F's concurrency
   cap and chaos must exercise 9G's dispatch, so the graph now shows both.
5. **The Continue client is not installed.** The prior text recorded it as present
   and testable. `command -v continue` hits the **shell builtin**; there is no
   binary and no `~/.continue`. Corrected in the spec and in 9H. `opencode` is
   genuinely present at `/usr/local/bin/opencode`; `antigravity`, `hermes`, `cline`,
   and `aider` are absent.
6. **The packaging plan would have produced an artifact that cannot install.** A
   measured `npm pack --dry-run` on `@bayz/server` ships 33 files **including all 14
   `test/*.ts` files**, and every workspace package is `private: true` with no
   `license` and inter-package dependencies at `0.1.0` that resolve only through
   workspace links. 9J Task 4 now specifies a single self-contained artifact
   declaring only the five external dependencies, and its install smoke proves the
   install works with `@bayz/*` unresolvable from any registry.
7. **The dependency-closure guard had the wrong shape.** Measured: the runtime
   closure is **93 entries — 7 workspace links plus 86 external packages** — out of
   270 lockfile entries, with zero `.node` binaries, zero install scripts, and zero
   `os`/`cpu` restrictions. The 53 platform-restricted and 2 install-scripted
   packages are dev-only, via `vite`. "Five runtime dependencies" is the count of
   *directly declared* ones; both numbers are now stated, and the walker is required
   to follow npm's nested lookup rules or it would miss four nested entries.
8. **The anti-fabrication test would have failed against its own specs.** A naive
   ban on `zeroize`/`reproducible build` trips on the twelve existing lines that
   *refuse* those guarantees. The rule is now negation-aware and is validated against
   the real twelve-line corpus, not an invented example. The performance-figure rule
   also had to exempt configured bounds (`64 KiB`, `250 ms`) from measured results
   (`p95`, `throughput`), or every plan document would have failed it.
9. **The data-directory task would have caused data loss.** `config.ts:27` resolves
   `~/.bayz`. Switching to `%LOCALAPPDATA%`/XDG defaults would orphan every existing
   install's database. 9J Task 3 now keeps `~/.bayz` as the default on every
   platform and adds platform paths only as a fallback when it does not exist.
10. **Permissions were to be re-implemented rather than verified.**
    `packages/storage/src/paths.ts` already does `0o700`/`0o600` best-effort with a
    documented Android/FAT tolerance. A probe confirmed this filesystem honours
    `0o700`, so the task now asserts the *observed* mode.
11. **The evidence regex was specified four times.** 9H, 9I, 9J, and 9K each carried
    an identical inline copy. 9L Task 1 now builds `scripts/evidence.mjs` and
    explicitly refactors all four to import it.
12. **The aggregate gate would have taken hours.** Dynamic `scripts/*-smoke.mjs`
    discovery picks up soak (10 min default, 2 h long mode). 9L Task 3 now classifies
    every script `fast` or `long`, runs fast by default, and requires `--full` for
    the long set — printing plainly when load/soak were not re-measured.
13. **Scope enforcement cited "eight management routes".** Measured: 26
    authenticated routes (8 providers, 8 proxies, 5 routes, 4 usage, plus
    `/api/status`), with `/api/health` anonymous. Also, `GET
    /api/providers/:id/credential` does not exist — `PUT` and `DELETE` do — so the
    `404`-not-`403` assertion needed the method-mismatch reasoning made explicit.
14. **No licence exists.** No `LICENSE` file, no `license` field anywhere. Harmless
    while everything is `private: true`, fatal for a distributable tarball. 9K Task 3
    now blocks on a user decision rather than picking one.

### Open decisions requiring a user answer

1. **Licence identifier** for the `LICENSE` file and the nine `license` fields.
   Until answered, the supply-chain gate reports `UNKNOWN` and blocks release.
2. **Signing key custody** — whether releases are signed and with whose key. An
   unsigned local build is normal and reports `UNVERIFIED: unsigned build`.

### Locks carried into Phase 9

Flux Core V2 visually LOCKED (SHA-pinned by 9L Task 5) · no client product name in
any runtime path · no credential read path · no content persistence · GitHub push
prohibited, remote not added, asserted by a test.

### Honest boundaries the program will not cross

No mid-stream failover · no memory wiping in JavaScript · no secure disk overwrite
(erasure is cryptographic) · no rollback prevention without trusted monotonic
storage · no OS keystore on Termux/Android · no elimination of DNS rebinding · no
reproducible-build claim · no prompt-injection filtering as a boundary · no `PASS`
for a platform or client that cannot run here. Six of seven platforms and two of
three Core clients are `UNVERIFIED` on this device by measurement, not by choice.

## Next steps

1. **Answer the two open decisions** above — licence identifier and signing key
   custody. 9K Task 3 blocks on the first.
2. **Execute Phase 9 in dependency order**: 9C → 9A → 9B → 9G, with 9D, 9E, and
   9F's independent tasks in parallel, then 9H, then 9I, then 9J → 9K, then 9L last.
   9F Tasks 2, 6, and 7 wait on 9C Task 1.
3. **Verify Flux Core in a real browser.** Motion and typography equivalence with
   the approved standalone file is *unverified* — this environment has no browser.
   Compare side by side before treating the port as visually final.
4. **Do not push to GitHub.** A push requires implementation complete, the feature
   gate green, the security gate green, a clean tree, a verified release candidate,
   and an explicit user instruction.
