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
  - 9D Custom Provider Completeness: **COMPLETE**, Tasks 1–7 plus amendment 5a/5b.
    Migration numbering **settled**: 9D took v7, so 9E takes v8. Spec ledger and both
    plan texts record it.
  - 9E Multi-Proxy Easy UX: **COMPLETE**, Tasks 1–8 plus the free-first amendment.
  - 9F Fortress Security: **IN PROGRESS.** Tasks 1-7 **COMPLETE** (`851dc68`,
    `d9340c7`, `83d169b`, `a850dd2`, `36c40bc`, `6f4782b`, + Task 7). Task 8 is next
    and **NOT STARTED**.
    Migration numbering: 9F Task 2 took **v11** (`security_audit`).
  - 9G–9L: **NOT STARTED.**
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
- Phase 9 plans (approved; 9A–9D **executed**, checkboxes ticked in the plan files):
  - `docs/superpowers/plans/2026-08-27-phase9a-universal-client-gateway.md` — DONE
  - `docs/superpowers/plans/2026-08-27-phase9b-streaming-and-tools.md` — DONE
  - `docs/superpowers/plans/2026-08-27-phase9c-client-identity-scoped-keys.md` — DONE
  - `docs/superpowers/plans/2026-08-27-phase9d-custom-provider-completeness.md` — DONE
  - `docs/superpowers/plans/2026-08-27-phase9e-multi-proxy-easy-ux.md` — DONE
  - `docs/superpowers/plans/2026-08-27-phase9f-fortress-security.md` — **IN PROGRESS,
    Tasks 1–7 done, Task 8 next**
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

Current as of 9F Task 7. Every figure below was measured on this device, not carried
forward from a plan.

- `@bayz/telemetry`: 55 tests pass.
- `@bayz/storage`: 233 tests pass (schema is **v11**).
- `@bayz/providers`: 286 tests pass.
- `@bayz/proxy`: 112 tests pass.
- `@bayz/router`: 276 tests pass.
- `@bayz/server`: 319 tests pass (includes the `/api/health` Phase 1 contract guard).
- `@bayz/identity`: 69, `@bayz/gateway`: 74.
- `@bayz/dashboard`: 253 tests pass across 17 files.
- `@bayz/contracts`: 3, `@bayz/security`: 6.
- `node scripts/api-smoke.mjs`: 70/70 against a **real listener** driven by real `fetch`.

### Known pre-existing flakes

Two timing-bound tests fail roughly 1 run in 3 on this device, **measured on
`851dc68` with all 9F Task 2 work stashed** — they are not regressions and were not
"fixed" by weakening them:

- `@bayz/providers` — `a slow-loris body is bounded by the timeout, not held open`
- `@bayz/proxy` — `a proxy that never answers is bounded by the timeout` /
  `a header block that never terminates is refused at the byte cap`

Both assert an upper bound on elapsed time against a deliberately stalled loopback
peer. On a loaded ARM64 device the scheduler occasionally misses the bound. 9I owns
load/timing work and is the right place to make them deterministic.

## Historical totals (pre-9F)

- `@bayz/storage`: 160 tests pass (schema was v5).
- `@bayz/providers`: 111, `@bayz/proxy`: 105, `@bayz/router`: 140, `@bayz/server`: 142.
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
| 9D Custom Provider Completeness | COMPLETE | `@bayz/providers` 256 tests, `custom-provider-smoke` 73/73 |
| 9E Multi-Proxy Easy UX + free-first | **COMPLETE** | `@bayz/router` 276, `@bayz/server` 252, `@bayz/dashboard` 340, `@bayz/storage` 185, `@bayz/providers` 276, `@bayz/identity` 69; migrations v8–v10; `proxy-ux-smoke` 127/127 |
| 9F–9L | NOT STARTED | — |

## Phase 9E resume point

**This is the authoritative next-step section. Read it before anything else.**

### State

- **Last completed task:** 9E is **finished** — Tasks 1–7 plus the free-only amendment
  (6a, 6b, 6c) and the Amended Task 7 additions. Last commit `032cc16`.
- **Exact current task:** none in progress. The tree is **clean and fully GREEN**.
- **RED/GREEN/DIRTY:** **GREEN, committed, nothing dirty.**
- **Last command result:** all five workspaces pass (185 / 276 / 276 / 252 / 69) and all
  nine smokes PASS: api 70/70, stream 63/63, usage 119/119, router 46/46, storage 42/42,
  provider 36/36, proxy 39/39, **proxy-ux 127/127**, dashboard 48/48.
- **Exact next step:** start **9F**, per the Phase 9 spec. 9E requires nothing further.

### Commit chain for 9E

`f9c5253` handoff → `f4c2ce8` Task 3 API → `6c3feaa` Task 4 panel → `4a9b303` Task 5 UX →
`8591948` docs → `506b6f8` Task 6 effective proxy → `0870aa8` Task 7 proxy smoke →
`6955443` 6a free-only routing → `7ad37f3` 6b catalogue persistence →
`17eaad3` 6c free-first UX → `032cc16` Task 7 economics additions.

### The free-only amendment as built (6a–6c), and what it costs a future task

**Migration v10** adds `routes.free_only INTEGER NOT NULL DEFAULT 1` and the
`model_catalogue` table (`provider_id`, `model_id`, `economics`, `discovered_at` — no
content column, pinned by an exact column-set assertion). Existing routes migrate to
`free_only = 1`, the safe value: migrating to 0 would silently opt every route into
spending.

**The default being ON broke 55 router tests, 33 server tests, and four smokes** — all
`no_free_route`. That was correct behaviour, not a regression: those fixtures route to
origins publishing no pricing metadata, which classifies `UNKNOWN`, and `UNKNOWN` is not
free (§25 rule 5). **The fixtures were fixed, not the policy.** Every one now passes
`freeOnly: false` explicitly with a comment stating why. Any new test that routes to a
fixture origin must do the same or serve four-dimension zero pricing.

**`classifyModelEconomics` requires a proven zero on all four priced dimensions**
(`prompt`, `completion`, `request`, `image`). `{prompt: "0", completion: "0"}` classifies
`UNKNOWN`, not `FREE_VERIFIED` — a missing dimension is not a zero. This cost one RED
cycle; the fixture helper now documents it.

**Loopback origins cannot test `PAID` or `UNKNOWN` at all.** `allowLoopback`
short-circuits classification to `LOCAL` before the catalogue is consulted, so economics
tests bind a private LAN address with `allowPrivate: true`. `proxy-ux-smoke` skips its
economics sections with an explicit message when the host has no non-loopback IPv4,
rather than asserting something weaker.

**`routes_model_provider_idx` is UNIQUE on `(model, provider_id)`.** Two routes to one
model that disagree about free-only therefore need **two providers**. The first version of
that smoke scenario used one and reported a false FAIL.

Economics are read from the **persisted catalogue**, never a per-request discovery call: a
discovery outage must not become a `no_free_route` storm. `no_free_route` is **409**, kept
distinct from the 502 an unreachable provider gives — one means "add a free provider", the
other means "the network is down". Turning free-only **off** writes a metadata-only audit
row via `recordDecision`; turning it back on is deliberately not audited, since only the
money-spending direction is interesting.

The scope-surface count moved **40 → 41** for `GET /api/models/free` (`models.read`).

### Tasks 6–7 as built

**Task 6** gave `RoutesPanel.tsx` an `effectiveProxy()` that mirrors the router's
precedence exactly — `forceDirect` → route override → provider default. A panel
disagreeing with the router would tell an operator traffic goes direct while it tunnels. A
route whose provider is missing renders `Effective proxy unknown (provider missing)`, not
a fabricated `Direct`; `Direct (override)` appears only when something is actually
overridden.

**Task 6c** withholds paid and `UNKNOWN` models from the DOM entirely — `queryByTestId`
asserts absence, not CSS hiding — behind a "Show paid models" action that discloses the
hidden count, so a withheld model is never mistaken for a missing one. `UNKNOWN` groups
with paid: absence of a price is not evidence of zero. `asEconomics` narrows at the type
boundary so a tampered response reads `Unknown` and lands in the withheld group rather
than becoming silently spendable. A fresh discovery re-hides paid models. `FREE_TIER` and
`FREE_PREVIEW` render their qualifications ("free within a quota", "free while in
preview"). The `no_free_route` help lives in `RoutesPanel` rather than a test chat panel —
recorded as a deviation, because no such panel exists here.

**Task 7** (`scripts/proxy-ux-smoke.mjs`, 127/127) is non-mocked: a real listener, two
real CONNECT proxies with Basic auth, one real SOCKS5 with RFC 1929 auth, twelve loopback
origins, plus four economics origins. Every "where did traffic go" claim reads the
proxies' own CONNECT logs keyed by origin port, never a router return value. Refusals are
proven by **zero requests observed at the paid origin**, not just by the status code. The
leak scan covers db/`-wal`/`-shm`, logs, and every response body for three proxy
passwords, the provider credential, API token, root key, prompt, and completion — with
`fleet-1` asserted **present** as a positive control, so a scan reading an empty buffer
cannot pass.

One fixture bug worth remembering: a provider credential containing `«»` fails with
`ERR_INVALID_CHAR` before reaching the socket, because Node rejects non-latin1
`Authorization` values. Sixteen checks failed as `500 internal_error` until the smoke
started dumping the router's attempt log on failure.


### Tasks 4–5 as built

**Task 4** rewrote `ProxiesPanel.tsx` for the full lifecycle. An edit sends **only what
changed** — a full-object PATCH would rewrite untouched fields and make an accidental save
indistinguishable from a deliberate one; saving an unchanged form is refused rather than
issuing a no-op write. Clearing a username sends `null`, not `""`, because the API models
absence as `null`. A **failed** connection check renders the envelope's code and message
with **no latency at all**: a failed dial has no measurement, and `0 ms` would be a
fabricated one. `disabled` outranks `degraded` on a row's `data-state`. Per-row usage comes
from `GET /api/proxies/:id/usage` and renders `Usage unavailable` on failure — a caller
without `proxies.read`, or an older Core, must not be shown a fabricated `0 providers`.
Delete became two-step, since it silently detaches every provider using the proxy.

**Task 5** added selection checkboxes, a filter, and an assign bar to `ProvidersPanel.tsx`.
Two deviations from the plan text, both recorded in the plan file:

- **No `ProxyAssignBar.tsx`.** The bar is ~30 lines of JSX over four pieces of state that
  all belong to the provider list, with exactly one call site. Extracting it would thread
  six props for no reuse.
- **A batch over `MAX_BULK_PROVIDER_IDS` (200) is refused, not split.** Two calls would
  forfeit the server's single transaction, and a half-applied assignment is worse than a
  refused one.

A filter never deselects — filtering is a view operation, and select-all acts on visible
rows only. A failed assignment **keeps the selection**: the server applied nothing, and
rebuilding a 40-provider selection by hand after a transient 502 would be punishing.

### Read this before touching the dashboard tests

Under jsdom with 120 rows, `getByLabelText` costs **~26 s per call** — it walks every label
in the document and normalises text. `getByTestId` is a single attribute selector at ~7 ms.
That, not the panel, is why the first 40-provider run took 122 s and the 120-provider case
timed out at the 5 s default. Every bulk control therefore carries a `data-testid`
**alongside** its real `<label htmlFor>`: the label is what an operator and a screen reader
use, the testid is what the suite queries. Same accessibility, ~3000× cheaper assertions,
and the file runs in 11 s.

Both pre-existing provider-panel suites needed `listProxies`/`assignProxy`/`unassignProxy`
added to their stubs when `ProvidersApi` grew, and `proxies-panel.test.tsx` needed
`proxyUsage` plus a two-step delete assertion.

### Task 3 as built

Three routes on `apps/server/src/routes/proxies.ts`: `POST /api/proxies/:id/assign`,
`POST /api/proxies/:id/unassign`, `GET /api/proxies/:id/usage`. The domain work was
already done in Task 1 (`assignProxy`, `providersUsingProxy`, `MAX_PROXY_ASSIGN_BATCH`
= 200), so this task is the HTTP boundary and its two undecided questions:

- An unknown provider **inside the batch** answers `invalid_request` (400). Letting the
  domain's `provider_not_found` through would answer 404, and on this URL 404 already
  means *the proxy* is missing — the operator would check the wrong resource. Exactly
  one code is translated; every other domain error passes through untouched.
- `usage.routeCount` counts routes **pinned** to the proxy (`routes.proxy_id`), not
  routes inheriting it via their provider. An inheriting route follows its provider, so
  counting it would double-count what `providerCount` already reports.
- `assign` echoes `proxyEnabled` and `notes: ["proxy_disabled"]` when the proxy is off —
  staging config before enabling is legitimate, but a route through a disabled proxy
  **fails** rather than going direct, so the operator is told.
- `unassign` reports `detachedFromProxy`: after the write nothing distinguishes "was on
  this proxy" from "was already direct".
- Body shape is exactly `{ providerIds: string[] }`, extra keys refused. Id alphabet
  validation stays in `@bayz/providers` — duplicating it at the route would give two
  places to keep in step.

`scope-enforcement.test.ts` gained the three routes and its exact `/api/` route count
moved **37 → 40**. That count is deliberately exact: a route added without a scope
decision must fail there.

### What Tasks 1–2 built, and the decisions behind it

**Migration v8** — `providers.proxy_id TEXT REFERENCES proxies(id) ON DELETE SET NULL`,
plus `providers_proxy_idx`. Added with `ALTER TABLE ... ADD COLUMN`, which SQLite permits
for a REFERENCES column when the default is NULL, so no rebuild and no foreign-key
suspension were needed (unlike v7, which had to rebuild to widen a CHECK). `SET NULL` not
`CASCADE`: cascading would delete the operator's providers, and orphan their credentials,
because they happened to share a proxy.

**Migration v9** — `routes.force_direct INTEGER NOT NULL DEFAULT 0 CHECK (force_direct IN
(0,1))`.

> **Plan deviation, already recorded in the 9E plan text.** The plan proposed expressing
> force-direct as `proxyId: null` on the route. That does not work: an inheriting route
> already stores `proxy_id IS NULL`, so the two states would be the same row and
> indistinguishable after a reload. Hence a separate column. A sentinel `proxy_id` value
> was the other option and was rejected — it would break the foreign key and put a magic
> string in a reference column. On the API, `proxyId: null` in an update keeps its old
> meaning (return to inheriting) and `forceDirect: true` is the new, distinct request.

**Provider repository** (`packages/providers/src/repository.ts`):

- `proxyId?: string` on the record; `undefined` means direct. No `""` alternative — a
  second way to say "direct" would compare truthily somewhere.
- On update, `null` = set direct, `undefined` = leave alone. Collapsing them would make
  renaming a provider silently drop its proxy.
- Proxy existence is checked with a query, not left to the foreign key, so an unknown
  proxy is a domain `invalid_provider_config` (→ 400) rather than a driver error (→ 500).
- `providersUsingProxy(id)` and `assignProxy(id | null, ids)`. Assign validates and
  deduplicates everything before writing, then writes in a transaction: one bad id fails
  the whole call. Bounded at `MAX_PROXY_ASSIGN_BATCH = 200`; an empty batch is refused
  rather than reported as "0 changed".
- The proxy id alphabet is **duplicated** from `@bayz/proxy` rather than imported.
  `@bayz/providers` does not depend on `@bayz/proxy`, and adding the dependency to reach
  one regex would invert the layering — the router composes the two. The foreign key is
  the backstop.
- A stored proxy id that no longer matches the alphabet loads as direct rather than
  failing the row: the reference is not security-bearing, and refusing to load would take
  the provider's credential offline over a cosmetic problem.

**Router** (`packages/router/src/router.ts`): one pure
`effectiveProxyId(route, provider)` — `forceDirect ? undefined : route.proxyId ??
provider.proxyId`. Every consumer reads it: the agent, all telemetry fields, the
`x-bayz-proxy` header, and the streamed chunk metadata. The provider is read **per
attempt**, not cached, so a bulk reassignment is live on the next request.

**Behavioural rule worth not re-litigating:** deleting a proxy degrades its providers to
direct, but *disabling* one **fails the attempt**. An operator who disabled a proxy has
not consented to their traffic leaving directly — that would be an unannounced
deanonymisation. This matches what a route-level proxy already did.

### Two test-expectation corrections made during Task 2

Recorded so the next executor does not repeat them:

- Telemetry events are keyed `kind`, not `event`.
- `proxied` is a **log** field, not a telemetry field. The telemetry boundary
  (`packages/telemetry/src/events.ts`) carries `proxyId` and derives the boolean, so
  `proxied` must be asserted on the logger output.

### Files touched by Tasks 1–2 (all committed)

`packages/storage/src/migrations.ts` · `packages/storage/test/migrations.test.ts` ·
`packages/providers/src/repository.ts` · `packages/providers/src/manager.ts` ·
`packages/providers/src/index.ts` · `packages/providers/test/provider-proxy.test.ts`
(new) · `packages/providers/test/repository.test.ts` ·
`packages/router/src/repository.ts` · `packages/router/src/router.ts` ·
`packages/router/test/proxy-resolution.test.ts` (new) ·
`packages/router/test/repository.test.ts` · `packages/router/test/selection.test.ts` ·
`docs/superpowers/plans/2026-08-27-phase9e-multi-proxy-easy-ux.md`

### Pinned counts a later change will trip

Both are deliberately **exact**, so a content-bearing or credential-bearing column
cannot be added silently:

- `providers` row key count = **9** (`packages/providers/test/repository.test.ts`).
- `routes` row key count = **10** (`packages/router/test/repository.test.ts`).
- Plus the sorted column-set assertions in `packages/storage/test/migrations.test.ts`.

### Not yet done in 9E

Tasks 4–7 and the free-only amendment (6a/6b/6c) are untouched. Note that 6a/6b add a
further migration — it takes the **next free version, v10** — and depend on 9D Tasks 5a
and 5b, which are complete.

### Measured totals after 9E Task 2

- `@bayz/router` **261** · `@bayz/storage` **178** · `@bayz/server` 227 ·
  `@bayz/providers` 276 · `@bayz/dashboard` 286
- Schema head is **v9**. Read from `TARGET_SCHEMA_VERSION`; no test hardcodes it.
- Smokes re-run after Task 2: router 46/46 · api 70/70 · stream 63/63 · usage 119/119 ·
  storage 42/42 · provider 36/36.

---

### Measured totals after 9D

- `@bayz/contracts` 3 · `@bayz/security` 6 · `@bayz/storage` 170 · `@bayz/telemetry` 55
- `@bayz/identity` 69 · `@bayz/gateway` 74 · `@bayz/providers` **256** · `@bayz/proxy` 105
- `@bayz/router` 245 · `@bayz/server` **227** · `@bayz/dashboard` **286** across 19 files
- `npm run runtime:verify` exits 0; 11 build targets.
- Smokes: storage 42/42 · provider 36/36 · proxy 39/39 · router 46/46 · api 70/70
  · usage 119/119 · dashboard 48/48 · stream 63/63 · identity 74/74 ·
  **custom-provider 73/73**.
- Schema is **v7** (`providers.kind` CHECK gains `custom-openai`). Read from
  `TARGET_SCHEMA_VERSION` — no test hardcodes it.

### 9D as built

- `packages/providers/src/egress.ts` — the SSRF classifier. Parses every numeric IPv4
  form a resolver accepts (decimal, octal, hex, short), IPv4-mapped IPv6, and the
  metadata names. Loopback and private are **opt-in per provider**; link-local,
  metadata, multicast, and reserved are refused with no flag able to permit them.
- `assertRequestEgressAllowed` is the pre-connect check: classify the name, then resolve
  and classify **every** returned address. Documented as *narrowing* the DNS-rebinding
  window, not closing it — Node offers no hook between a socket's own resolution and its
  connect, so the honest guarantee is "an address BAYZ has seen is checked".
- Enforced at storage write time (create *and* update, against the resulting URL/config
  pair) and at request time on both discovery paths and the chat transport. Loading a row
  is deliberately **not** checked, so a pre-9D install with a loopback URL still starts.
- Custom headers: allowlist by charset, then denylist on the lowercased name. A denied
  header is a 400 that **names** the header — `ProviderError.detail`, re-validated
  against a narrow charset rather than trusted. `safeCustomHeaders` filters again at send
  time, and custom headers are spread *first* so credential and framing headers always
  win.
- `custom-openai` kind via migration v7, which rebuilds `providers` because SQLite cannot
  alter a CHECK. The rebuild needs foreign keys suspended: `DROP TABLE providers` with
  enforcement on cascades every dependent route away. Found by a failing test. The runner
  gained `suspendForeignKeys` and verifies the end state with `PRAGMA foreign_key_check`
  before committing.
- `capabilities.ts` — `detectCapabilities` and `testConnection`. `unknown` is a real
  value: `tools` is `yes`/`no` only from the operator's declaration, `streaming` is
  always `unknown`, and `capped` is reported separately from `modelCount`.
- `economics.ts` — six values, four free. Free requires *proof*; `UNKNOWN` and `PAID` are
  not free. A missing priced dimension is `UNKNOWN`, prices are matched strictly rather
  than `parseFloat`-ed, a negative price is `UNKNOWN`, and a `:free` id suffix alone
  never yields free. A source-scan test forbids any price literal or model-name table.
- `discoverModelCatalogue` is additive; `discoverModels` keeps `string[]`. Both share one
  fetch, validator, filter, and collector, so they cannot disagree about which models
  exist.
- `ProviderView.config` carries `headerNames`, not `headers`. `ProviderManager.
  requestConfig(id)` is the one explicit, greppable way to reach header values, used only
  by the router.
- Three new routes, all `providers.write` because each dials an upstream: `/test`,
  `/capabilities`, `/catalogue`. A failed test is `200 { ok: false, failureCode }`.


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

## Phase 9F Fortress Security — as built so far

### Task 1 — OS-backed key providers (`851dc68`)

Three real adapters (DPAPI, Keychain, Secret Service) plus four supporting modules.
`keystore/exec.ts` is the single `node:child_process` choke point, asserted by a
source scan, so no adapter can grow a shell string later. On this Termux/Android
ARM64 device all three probe `available: false` and `keystoreSupport()` reports
`UNVERIFIED` — measured, never faked.

### Task 2 — Root-key rotation surface and audit

```text
POST /api/security/rotate-root-key   admin   → { rotated, keyId, previousKeyId, rotatedAt }
GET  /api/security/audit             admin   → { audit: [...] }
```

Three things the plan did not anticipate, each forced by making the recovered RED
test pass honestly:

1. **Rotation is a custody capability, not an attempt.** `rotateRootKey(next)` takes a
   caller-supplied provider, which is wrong for an HTTP surface twice over — an admin
   must not choose the key, and environment/passphrase custody cannot persist a
   replacement at all. `SecretStorage` gained `canRotateRootKey` and
   `rotateManagedRootKey()`: the route refuses with `409 rotation_unsupported`
   **before reading a single row**, so a refusal is a genuine no-op. A test opens the
   database afterwards and proves every secret still reads under the original key.
2. **Two-phase key promotion, because rotation spans two stores.** The replacement is
   written to `master.key.next` before the rewrap and promoted by `rename(2)` after
   the commit. `openSecretStorage` now recovers the window between them: a staged key
   is promoted **only** when its fingerprint matches the recorded `active_key_id`, and
   a staged key that does not match is discarded as the residue of a failed attempt.
   Without this, a crash between commit and promotion left every secret permanently
   unreadable — the one failure mode worse than refusing to rotate.
3. **`storage.keyId` had to become a getter.** It was captured at open, so after a
   rotation `/api/status` would have reported the superseded fingerprint and told an
   operator the rotation had not happened.

Migration **v11** adds `security_audit`. Kept separate from `identity_audit` because
the subject differs: one records what a client credential did, the other what happened
to the deployment's own custody — and folding them together would have put an
`identity_id` foreign key on a row that refers to no identity. `key_id` and
`previous_key_id` are validated against `/^kek_[0-9a-f]{32}$/` on write, so a caller
that passes a raw 64-hex key by mistake fails instead of persisting it. `subject_count`
is a count, not a list: naming which secrets were rewrapped would turn the audit trail
into a secret-name index.

Verified: `@bayz/server` 260/260, `@bayz/storage` 202/202, both `tsc --noEmit` clean,
`storage-smoke` 42/42, `api-smoke` 70/70.

### Task 3 — Credential rotation, revocation, cryptographic erasure

Provider credentials and proxy passwords now have pinned lifecycle semantics, and
measuring the erasure claim found a **real defect** rather than confirming the plan.

The plan expected to *document* a WAL caveat. Measured on this device, with SQLite's
default `secure_delete = 0`, the situation was worse than the caveat described:
deleting a secret left its superseded page in the WAL, and the next checkpoint copied
that page **into `bayz.db`**, where it persisted indefinitely. Permanent recoverable
ciphertext in the main database file, not a transient window.

`openDatabase` now sets `PRAGMA secure_delete = ON`. Measured after the fix: the
ciphertext is in the WAL after the write, still in the WAL immediately after the
delete (asserted, not hidden), and absent from both files after a checkpoint.

Two claims deliberately **not** made:

- **Not secure overwrite.** The physical NAND page is not rewritten in place by this
  or by anything reachable from Node; the FTL may retain the old page until wear
  levelling reclaims it. Said plainly in both the code and the test.
- **Not a replacement for cryptographic erasure.** That remains the guarantee — the
  wrapped DEK is gone, so surviving bytes cannot be decrypted. `secure_delete` closes
  a needless forensic exposure that one pragma was already able to close.

No manager code changed. Per-write DEK/IV freshness, pre-transaction validation, and
secret-deletion-before-row-deletion were already correct; the tests pin them now
instead of leaving them incidental. A 25-round rotation sweep asserts 25 distinct
wrapped DEKs and 25 distinct IVs, which is what would catch a counter-style IV — the
one bug here that would be catastrophic and invisible.

On the proxy side a revoked password fails `agentFor` **before a socket is opened**.
A SOCKS5 greeting that offers username/password and then cannot supply one would hang
or, worse, downgrade to no-auth.

Verified: `@bayz/providers` 286/286, `@bayz/proxy` 112/112, `@bayz/storage` 202/202,
`@bayz/router` 276/276, `@bayz/server` 260/260, three `tsc --noEmit` clean,
`storage-smoke` 42/42, `proxy-smoke` 39/39, `provider-smoke` 36/36.

### Task 4 — Encrypted export and import

`exportSecrets(storage, passphrase)` / `importSecrets(storage, blob, passphrase,
{ replace? })` in `packages/storage/src/portable.ts`.

Blob layout: `BAYZEXP1` ‖ version byte ‖ 16-byte salt ‖ 12-byte IV ‖ 16-byte GCM tag ‖
ciphertext. The header is the AAD, so the version byte cannot be edited to steer a
future reader down a different parse without failing the tag.

Two guarantees stronger than the plan asked for, both deliberate:

- **Secret names are sealed too, not just their values.** A backup whose header leaked
  `provider:openai:api_key` would tell an attacker what the deployment holds and which
  credentials are worth targeting.
- **Two exports of identical content must differ byte-for-byte.** Identical output
  would mean a fixed salt or a reused IV, and a reused IV under one derived key leaks
  the XOR of both payloads. A round-trip test would never catch it.

Import decrypts, parses, **and conflict-checks before writing a single row**. Without
that ordering, an attacker grinding passphrases would accumulate rows on the way, and
one name collision would leave a half-restored database.

The blob is deliberately **not** root-key-bound — it re-seals plaintext, so it restores
into a database with a different root key. That is the point of a backup, and it is why
the passphrase carries the full Phase 2 scrypt cost: offline ciphertext an attacker can
grind at leisure needs at least the hardness the live root key gets.

Error-code split: a wrong passphrase and a tampered blob are indistinguishable at the
GCM tag, so both raise `master_key_invalid` — nothing *stored* is corrupt, the supplied
key is wrong. A file that is not an export at all is refused on its magic with a
distinct stage, because that is a different operator problem with a different remedy.

Verified: `@bayz/storage` **216/216**, `tsc --noEmit` clean, `storage-smoke` 42/42.

### Task 5 — Tamper evidence and rollback detection

`packages/storage/src/integrity.ts`. Four independent mechanisms, each with its own
distinct error stage:

| Mechanism | Catches | Where | Fatal? |
|---|---|---|---|
| `verifyRecordedSchemaVersion` | edited `user_version`, forged/deleted audit row | before migrations | yes |
| `migrationChain` | altered migration SQL, reordered migrations | after migrations | yes |
| `checkRollback` | restored older `bayz.db` alone | at open | warning |
| `configHmac` | out-of-band registry row edit | at open | warning |

**The plan's ordering was wrong and measuring it proved why.** It grouped the
`user_version` check with the chain digest. But `runMigrations` decides what to apply
*from* `user_version`, so any post-migration check speaks too late: a version edited
down re-runs migrations over an existing schema (opaque `exec` failure on a duplicate
table), and one edited up silently skips migrations that never ran. The check now runs
inside `openDatabase` **before** the runner, using `schema_migrations` as the
independent witness of what actually executed.

The chain hashes each migration's version **and its statements**, so a tampered build
that altered a migration's SQL while keeping its number is caught. Version-only hashing
would have missed that entirely. Order-sensitivity is pinned too.

The config HMAC is keyed by HKDF from the KEK with its own info string — keyed rather
than a plain digest, because an attacker who can edit rows can also edit a stored
digest. The derived key is not the KEK and cannot unwrap a DEK. This closes 9C's
residual risk: a valid `["admin"]` written straight into `client_identities.scopes_json`
is honoured by scope validation *because it is valid*, and the HMAC is what surfaces it.

Verified at open, resealed at close, so the property is precise — **rows that changed
while BAYZ was not running** are what gets reported.

#### Honest boundaries, asserted in tests rather than claimed away

- **A whole-directory rollback is NOT detected.** Restoring `bayz.db` *and*
  `integrity.json` together defeats `checkRollback`, and a test proves it. Prevention
  needs a monotonic counter in storage an attacker cannot rewrite — TPM, secure element,
  or trusted remote service — none present on this target or reachable from Node.
- **Rollback and config mismatch warn, they do not refuse.** Failing closed would turn a
  crash into an unbootable install, and the registries hold no secret whose exposure
  justifies that. Structural schema damage *does* refuse: running domain SQL against an
  unknown shape is a different class of risk.
- **An unclean shutdown after a config change leaves a stale HMAC**, reported as
  `mismatch` indistinguishably from a genuine edit. That is why it is a warning surface.

Verified: `@bayz/storage` **233/233**, `tsc --noEmit` clean, `storage-smoke` 42/42,
`api-smoke` 70/70, `router-smoke` 46/46, `usage-smoke` 119/119, and providers 286 /
proxy 112 / router 276 / server 260 / identity 69 / telemetry 55 unaffected.

### 9F resume point

Task 6 — security posture ladder. **NOT STARTED.** Next concrete step: write RED
`apps/server/test/posture.test.ts` — posture derived from the bind address rather than a
flag; `lan` without TLS a **startup failure** not a warning; `remote` without mTLS or
signing a startup failure; `remote` without `BAYZ_ALLOW_REMOTE` a startup failure
(existing behaviour, pinned); a generated token refused for `lan`/`remote`; tightened
rate limits plus a concurrency cap for both; `admin` scope rejected over a non-loopback
connection even with a valid admin key; posture reported in `/api/status`; and binding
loopback keeping today's behaviour exactly as a regression guard.

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
