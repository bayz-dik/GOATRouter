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
  - 9F Fortress Security: **COMPLETE**, Tasks 1–9 (`851dc68`, `d9340c7`, `83d169b`,
    `a850dd2`, `36c40bc`, `6f4782b`, `9541f6f`, `40b517b`, + Task 9), `runtime:verify`
    green.
    Migration numbering: 9F Task 2 took **v11** (`security_audit`).
  - 9G Agent / Tool Injection Security: **COMPLETE.** Tasks 1–5
    (`0539536`, `d243a3f`, `ab0fbc5`, `400aa8d`, + Task 5). Verified sequentially.
    New package `@bayz/capability`; `runtime:build` is now **twelve** targets, with
    `@bayz/capability` after `@bayz/identity` per the spec §4 order.
    Task 3 also fixed a **live 9B wire bug**: `wireBody` emitted the internal camelCase
    `toolCalls`/`toolCallId` instead of `tool_calls`/`tool_call_id`, so every tool
    roundtrip reached the upstream with the call and result unrecognisable.
    Task 4 is the only 9G task that changed **no `src` file**: 24 adversarial cases were
    written to break Tasks 1–3 and all refused on the first run, so seven mutations were
    applied and reverted to prove the suite can fail rather than asserting it.
    Task 5 found and fixed a **pre-existing breakage in `scripts/identity-smoke.mjs`**:
    it was last touched before free-only landed and created its route without
    `freeOnly: false`, so it had been failing 67/74 with `no_free_route`. Free-first was
    not weakened — the new smoke asserts a route created *without* the field still comes
    back `freeOnly: true`.
  - 9H Mandatory Client Compatibility Matrix: **COMPLETE.** Tasks 1–6 done, completion
    checklist green.
    `docs/superpowers/2026-08-27-bayz-client-compatibility-matrix.md` plus
    `tests/matrix-integrity.test.mjs` (9/9), `scripts/client-conformance.mjs` (**55/55**),
    `docs/clients/` (4 guides + index), `tests/client-docs.test.mjs` (6/6),
    `scripts/verify-opencode.mjs` (**16 VERIFIED / 1 UNVERIFIED, exit 0**),
    `scripts/verify-hermes.mjs` (**17 VERIFIED, exit 0**),
    `scripts/verify-antigravity.mjs` (client absent, exit 0), and
    `scripts/client-gate.mjs` with `tests/client-gate.test.mjs` (11/11), with transcripts
    in `docs/transcripts/opencode/` and `docs/transcripts/hermes/`.
    Matrix tally **46 VERIFIED / 2 PARTIAL / 0 BLOCKED / 54 UNVERIFIED**, 48 citations
    all resolving on disk.
    **`node scripts/client-gate.mjs --enforce` exits 1** with 18 blocking cells — 17 for
    the absent `antigravity` plus `opencode/models.list`. That is the gate working, not a
    defect: a release cannot be declared from a host that cannot run a mandatory client.
    Status vocabulary **deviates from the plan text deliberately**:
    `VERIFIED`/`PARTIAL`/`BLOCKED`/`UNVERIFIED`/`N/A`, with `PASS`/`FAIL` refused as
    placeholders. `BLOCKED` (tried, did not work) vs `UNVERIFIED` (not tried) is the split
    that matters, and the gate blocks on **both**.
    Device reality corrected at Task 1: **`hermes` is present** on this host
    (`/root/.local/bin/hermes`, v0.20.5) — the plan and spec §12 both said absent, so
    Task 5 verified it for real instead of only shipping a harness.
    Task 2 fixed a **live 400-vs-500 bug**: no `GatewayError` code was mapped in
    `apps/server/src/http-errors.ts`, so a malformed body returned `500 internal_error`
    and told a client to retry forever. Four codes now map to 400.
    **Tasks 4–5 found four defects protocol conformance could not see**: `stream_options`
    refused outright (no OpenCode session could reach a provider), streamed `tool_calls`
    silently dropped (18 identical retries), a 1 KiB tool-description cap no agent client
    could satisfy, and `name` refused on `role: "tool"` messages (the Hermes tool result
    rejected *after* the work was done). All four fixed with regression tests.
  - 9I Fuzz / Chaos / Load / Soak: **COMPLETE.** All seven tasks. Thirteen fuzz targets ×
    5,000 iterations (`fuzz-run` 39/39), eleven chaos scenarios (`chaos-smoke` 83/83), five
    concurrency levels (`load-smoke` 64/64, 3,288 requests, 0 failures), a 600 s soak
    (`soak-smoke` 14/14, 18,741 requests, 0 failures), and a resilience report of 71 rows
    behind `resilience-gate`. Fifteen mutations proved the checks bite; **zero BAYZ defects
    were found** — the four found in 9H remain the only ones. `--enforce` exits 1 because two
    chaos injections need mount privileges this device lacks, recorded UNVERIFIED with reasons.
    `scripts/fuzz/harness.mjs` + `tests/fuzz-harness.test.mjs` (**18/18**): xoshiro128\*\*
    over a SHA-256 seed expansion, zero dependencies, `node:crypto` for seeding only.
    Reproducible **across processes** — the load-bearing property, since a crash that
    cannot be replayed cannot be fixed. Seed *type* is part of the hash, so `createRng(1)`
    and `createRng("1")` are different streams.
    Harness defect fixed during the task: merely *adding* `unhandledRejection`/
    `uncaughtException` listeners left Node's default (kill the process) and
    `node --test`'s own handler firing alongside, so a floating rejection from a fuzzed
    boundary was reported as a harness failure. It now takes exclusive ownership of both
    events and restores the prior listeners afterwards.
    Credential scan reaches object **keys** and also **error text**, because Task 3 commits
    failing inputs and messages; a counter-test pins that 63/65-hex, bare `sk`,
    `__proto__`, SQL shapes, NUL and lone surrogates are *not* refused.
    Six mutations, each reverted byte-identical. One initially passed — disabling the
    per-iteration timer — because the test used a slow-but-finishing iteration; a
    never-settling-promise test was added, taking the suite 17 → 18.
    Task 2: `scripts/fuzz/generators.mjs` + `tests/fuzz-generators.test.mjs` (**21/21**),
    ten generators (JSON, UTF-8, invalid UTF-8, headers, URLs, identifiers, SSE, SOCKS5,
    CONNECT, SQLite-hostile), all pure given an rng and enumerable through a frozen
    `GENERATORS` registry. Corpus: **93 files, 111,914 bytes** (5.3% of the 2 MiB bound),
    written by the committed `scripts/fuzz/write-corpus.mjs`; `corpus/regression/` awaits
    Task 3's discoveries. Five generator mutations red and reverted, plus a planted
    `Bearer …` corpus file to prove the credential scan reads committed bytes.
    Task 3: thirteen targets under `scripts/fuzz/targets/` + `scripts/fuzz-run.mjs`,
    **39/39 checks**, 5,000 iterations each, three consecutive clean runs.
    **Host finding that governs every timing in this phase:**
    `scripts/fuzz/host-baseline.mjs` runs a bare socket loop with *no BAYZ code* and shows
    p50 63 ms with outliers at 8.2 s / 88 s / 184 s under swap pressure (load 0.12, 4 fds,
    3.9 GiB swap in use). Wall-clock budgets are valid for CPU-bound boundaries and **not**
    for socket-bound ones here; `socks5` therefore asserts BAYZ's own
    `ProxyError("timeout")` fired instead of trusting the clock.
    `sse` RSS was 147 MiB over a 64 MiB bound — measured as allocator retention, not a leak
    (decelerating growth, flat heap/arrayBuffers, 6.5 MiB for buffer-build vs 65.1 MiB for
    reader-push over 600 iterations). Bound left intact; the two byte-cap shapes moved to a
    deterministic sparse schedule, giving 41.5 MiB.
    **A mutation passed twice**: gutting `parseChatRequest`'s `isPlainObject` + unknown-key
    loop stayed green because the parser copies only known fields, so a leaked key is absent
    from the output. Fixed with a `mustReject(input)` oracle whose key sets are mirrored,
    not imported — importing them would agree with any regression by construction.
    Five target-side defects were mine, not BAYZ's (`grantedScopes` is a Set,
    `assertModelPattern` reports `invalid_route_config`, SOCKS5 0x07/0x08 →
    `unsupported_operation`, `createIdentity` not `create`, and a generator ordering bug),
    as was the `migration` target's first "half-applied schema" finding — nothing calls
    `runMigrations` without `verifyRecordedSchemaVersion` first.
  - 9J Cross-platform / Packaging / Upgrade: **IN PROGRESS.** Tasks 1–2 **COMPLETE**, Tasks 3–8
    **NOT STARTED**. Eight tasks total. `platform-matrix` **10/10**: 7 platforms × 11 columns =
    77 cells, all **UNVERIFIED**, primary device named. A `PASS` must cite a transcript from
    that platform; a `smoke:`/`test:` citation counts only for the primary platform.
    `dependency-closure` **12/12**: runtime closure **96 = 10 workspace links + 86 external**
    from 276 lockfile entries, 5 direct external deps, **native-free** — no install script, no
    gypfile, no `libc`, no `os`/`cpu` restriction. The 53 platform-restricted and 2
    install-scripted packages in the tree are all dev-only, reached through `vite`.
  - 9K–9L: **NOT STARTED.**
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
  - `docs/superpowers/plans/2026-08-27-phase9f-fortress-security.md` — DONE
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

Current as of 9G Task 5. Every figure below was measured on this device, not carried
forward from a plan. Tests and builds were run **one workspace per command**; smokes one
script per command.

### Tests — 1897 across twelve workspaces

- `@bayz/contracts`: 3, `@bayz/security`: 6.
- `@bayz/telemetry`: 55 tests pass.
- `@bayz/storage`: 246 tests pass (schema is **v11**).
- `@bayz/identity`: 69, `@bayz/gateway`: 74, `@bayz/capability`: **72** (18 registry +
  30 dispatch + 24 injection adversarial).
- `@bayz/providers`: 286 tests pass.
- `@bayz/proxy`: 121 tests pass.
- `@bayz/router`: 289 tests pass.
- `@bayz/server`: 336 tests pass (includes the `/api/health` Phase 1 contract guard).
- `@bayz/dashboard`: 340 tests pass across 23 files.

### Builds — all twelve `runtime:build` targets exit 0

Run one at a time: contracts, security, storage, telemetry, identity, capability,
providers, proxy, gateway, router, dashboard, server.

### Smokes — 998 checks across thirteen scripts, all PASS

```text
storage-smoke           42/42     provider-smoke          36/36
proxy-smoke             39/39     router-smoke            46/46
api-smoke               70/70     usage-smoke            119/119
dashboard-smoke         48/48     identity-smoke          74/74
custom-provider-smoke   73/73     proxy-ux-smoke         127/127
stream-smoke            63/63     security-smoke          82/82
injection-smoke        179/179
```

`injection-smoke.mjs` is 9G Task 5: a real listener on a real loopback port driven by
real `fetch`, a real SQLite database with real envelope crypto, and a real upstream
origin scripted per turn to emit hostile tool calls — through the real
gateway → router → `runToolLoop` → `@bayz/capability` path.

`identity-smoke` was **repaired** during Task 5. It had been failing 67/74 since
free-only landed (`6955443`) because its route fixture predated the field; see the 9G
Task 5 findings.

### Verification is run sequentially on this device

`npm run runtime:verify` fans out `npm run test --workspaces` and then twelve builds,
which on this ARM64 Termux host spawns enough concurrent Node processes to exhaust the
futex table: a run died with `The futex facility returned an unexpected error code`
followed by SIGKILL, with several GB of RAM still free. It is a process/thread-count
limit, not memory pressure.

So verification is done as bounded sequential steps — one `npm run test --workspace …`
per package, then one `npm run build --workspace …` per target, then one smoke script per
command — which produces the same coverage with a flat process count. Every total above
was measured that way. `runtime:verify` as a single command remains unusable on this
device and should not be treated as the gate; the per-workspace sequence is.

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
| 9F Fortress Security | COMPLETE | Tasks 1–9; migration v11; `security-smoke` 82/82 |
| 9G Agent / Tool Injection Security | **COMPLETE** | Tasks 1–5; `@bayz/capability` 72 tests; `injection-smoke` 179/179 |
| 9H Client Compatibility Matrix | **COMPLETE** | Tasks 1–6; `matrix-integrity` 9/9, `client-docs` 6/6, `client-gate` 11/11, `client-conformance` 55/55, `verify-opencode` 16V/1U exit 0, `verify-hermes` 17V exit 0, `verify-antigravity` absent exit 0; 46 VERIFIED / 2 PARTIAL / 0 BLOCKED / 54 UNVERIFIED; **`client-gate --enforce` exits 1 — correct, `antigravity` is absent** |
| 9I Fuzz / Chaos / Load / Soak | **COMPLETE** | Tasks 1–7; `fuzz-run` **39/39** (13 targets × 5,000 iterations), `chaos-smoke` **83/83** (11 scenarios), `load-smoke` **64/64** (1/8/32/128/256, 3,288 requests, 0 failures), `soak-smoke` **14/14** (600 s, 18,741 requests, 0 failures), `resilience-report` 24/24, plus `fuzz-harness` 18/18, `fuzz-generators` 21/21, `chaos-suite` 9/9, `load-harness` 11/11, `soak-harness` 13/13; report 71 rows = 68 PASS / 0 FAIL / 3 UNVERIFIED; **`resilience-gate --enforce` exits 1 — correct, two chaos injections need mount privileges this host lacks** |
| 9J Cross-platform / Packaging / Upgrade | **COMPLETE** | Tasks 1–8; `platform-matrix` 10/10, `dependency-closure` 12/12 (closure **96 = 10 links + 86 external**, native-free), `portability` 14/14 + scan 0 violations, `pack` 20/20 + `--self-test` 15/15, `install-smoke` **64/64**, `upgrade-ladder` 21/21 + `corrupt-row` 7/7 + `upgrade-smoke` **83/83** (every rung v1…v11), `ci-workflow` 8/8 (committed, inert, no remote exists), `platform-gate` 13/13 with `--report` 0 / `--enforce` **0**; Termux/Android ARM64 row **11/11 PASS** against the installed artifact, six other platforms honestly `UNVERIFIED`; six live production defects found and fixed |
| 9K–9L | NOT STARTED | — |

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

## Phase 9F Fortress Security — as built

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

### Task 6 — Security posture ladder (`6f4782b`)

`apps/server/src/posture.ts`. Exposure is **derived from the bind address**, never
configured — a flag would let an operator bind `0.0.0.0` and declare it `loopback`,
which is the exact silent downgrade the ladder exists to prevent.

| Posture | Bind | Mandatory | Limits (window / auth / in-flight) |
|---|---|---|---|
| `loopback` | any `127.x`, `::1`, `localhost` | token | 120 / 10 / 64 |
| `lan` | RFC 1918, link-local, CGNAT, `fc00::/7`, `fe80::/10` | + opt-in, explicit token, TLS | 60 / 5 / 32 |
| `remote` | anything else, **including `0.0.0.0` and `::`** | + mTLS **or** signing | 30 / 3 / 16 |

Three decisions worth keeping:

1. **A wildcard bind is `remote`, not `lan`.** It binds every interface the host has,
   including any public one, so treating it as merely local would be the single most
   dangerous misclassification available. An unresolvable name is `remote` too: the safe
   direction for an unknown is the strictest posture.
2. **`admin` over the wire keys off `request.ip`, not off the posture.** An admin key can
   rotate the root key and reach every provider credential, so a proxy in front or a
   spoofed posture value must not re-open it. A test refuses admin from a `10.x` peer
   *while in `loopback` posture* to prove the check is about the connection, not the flag.
3. **The declared concurrency cap is now enforced**, not merely reported. It was a hollow
   field when the SIGKILL interrupted the task. It lives in `installApiGuards` beside the
   window limiter, acquired **after** authentication so a slot represents real work rather
   than a stranger's ability to hold one, released on `onResponse` **and**
   `onRequestAbort`, tracked in a `WeakSet` so a double release cannot drift the count
   upward. An invalid cap leaves the listener **uncapped** — coercing to 0 would turn a
   typo into the outage the protection exists to prevent.

Nothing warns. A `lan` listener missing TLS is a startup failure, because a warning in a
log nobody reads is indistinguishable from no protection. Each absence raises a distinct
`PostureError` naming the requirement, and a test **enumerates** all seven mandatory
protections across the three postures and asserts each fails on its own — so "no silent
downgrade" is mechanical rather than sampled.

`loadRuntimeConfig` now shares `derivePosture`. Its old inline set knew only `127.0.0.1`,
`::1`, and `localhost`, so a bind to `127.0.0.53` — a real loopback address, the one
systemd-resolved uses — was refused as remote.

Verified: `@bayz/server` **286/286**, `tsc --noEmit` clean, `api-smoke` 70/70, and a live
boot on `127.0.0.1:21056` reporting `"posture":"loopback"` with `concurrency=64` in the
log and no root key or API token anywhere in it.

### Task 7 — TLS, mTLS, and request signing (`9541f6f`)

`apps/server/src/tls.ts` and `apps/server/src/signing.ts`. The two protections the
ladder demanded but could previously only ask for.

**TLS** holds file *contents*, never paths: a path on a live object eventually reaches a
log line or an error body, and the layout of an operator's key material is not a client's
business, so errors name the **variable** instead. Half a configuration is refused rather
than ignored — a client CA with no server certificate would leave an operator believing
mTLS was in force while the listener spoke plain HTTP. `requestCert` is paired with
`rejectUnauthorized`, and the suite proves a rogue certificate **and** no certificate both
fail the handshake against a real HTTPS listener over a real socket, using an
`openssl`-generated EC PKI (CA-signed server, CA-signed client, self-signed rogue). 1.2
floor, 1.3 ceiling, both pinned as constants.

**Signing** is HMAC-SHA256 over method, URL *including query*, timestamp, nonce, and a
hash of the body, keyed by the presented client key, compared with `timingSafeEqual` over
fixed-width digests so length cannot become an oracle.

Four things that were not obvious before building it:

1. **Raw-body custody is the whole difficulty.** Re-serialising the parsed object cannot
   reproduce the bytes the client signed — key order, whitespace, and number formatting
   all differ. A `parseAs: "string"` parser stashes `request.rawBody`, and it is
   registered **only when signing is enabled**, so every existing install keeps the
   default parser and the Phase 6 error map untouched. `FST_ERR_CTP_INVALID_JSON` is set
   explicitly so malformed JSON stays a clean 400 rather than becoming a 500.
2. **Verification runs at `preValidation`**, not `onRequest`, because the body must exist
   to be hashed. Authentication has already happened by then, which is why `stale` /
   `replayed` / `invalid` can be distinguishable for the operator — but a **missing**
   header is one generic `signature_required`, since naming which of the three is absent
   is a checklist for forging a request.
3. **The nonce is spent only after the signature verifies.** Consuming it first would let
   an unauthenticated flood of guesses evict every legitimate entry — replay protection
   turned into a replay enabler.
4. **The 4096-entry cache is a stated bound, not a claim.** Replay protection is the
   *conjunction* of the FIFO and the ±60s window, and a test asserts eviction really
   happens rather than pretending the cache is infinite. A replay only lands if it
   arrives late enough to be evicted yet early enough to be in-window, which needs
   thousands of signed requests inside a minute — which the rate limiter refuses.

`presentedBearer` and `isGuardedPath` are exported from `auth.ts` rather than
reimplemented: two independent path lists would eventually disagree, and the disagreement
would be an unsigned guarded route.

Verified: `@bayz/server` **319/319**, `tsc --noEmit` clean, `api-smoke` 70/70. The
absence of `tls.ts` was re-confirmed as a genuine RED by moving the module aside after
GREEN and watching the suite fail to load.

### Task 8 — Outbound concurrency cap and proxy pivot refusal

`packages/router/src/concurrency.ts` and `packages/proxy/src/self.ts`.

**The cap.** A rate limit bounds requests per window; it says nothing about how many are
being served at one instant. A hundred slow upstream calls stay inside a 120/minute
budget while holding a hundred sockets, file descriptors, and response buffers open.
Default 32, configurable 1–512, queue depth 256 — and **per-process, not per-provider**,
because twenty providers with a cap of 32 each would open 640 sockets while every
individual cap looked perfectly respected.

Four properties, each asserted:

- The permit is taken **after** the cheap refusals and immediately before the socket, so
  an unsupported provider or a denied egress target never occupies a slot.
- A **streaming** request holds its permit for the whole generator, released in the same
  `finally` that destroys the socket. Anything shorter would let N streams sit open while
  the limiter believed nothing was in flight — and a stream is the longest-lived outbound
  resource BAYZ holds.
- The release closure is **idempotent**. Without that, a `finally` racing an error path
  returns two permits and the cap drifts upward until it stops capping anything: the worst
  failure mode available, because the counter still looks plausible.
- An **abandoned waiter leaves the queue** and the pump skips its slot. Handing a freed
  permit to a departed waiter would lose it permanently, eroding the cap one aborted
  request at a time.

An out-of-range limit is **refused, not clamped** — serving 512 when the operator asked
for 5000 is a protection that lies about what it enforces — and a rejected reconfiguration
leaves the *previous* semaphore in force rather than leaving the process uncapped.

**The pivot refusal.** A proxy asked to tunnel back to BAYZ's own listener makes the
router a relay into itself: each hop consumes a socket and a permit until the process
exhausts one. The cap makes that bounded rather than unbounded, which is precisely why
the loop is refused outright instead of merely throttled — and refused **before any
socket is opened**, so a hostile configuration cannot buy one live connection per attempt.

- The check needed **its own loose-IPv4 parser**: `2130706433`, `127.1`, `0x7f000001`,
  and `0177.0.0.1` all reach 127.0.0.1. `@bayz/proxy` cannot import `@bayz/providers`'
  egress filter — the dependency runs the other way — so this is a deliberate second copy
  with the reason recorded in the source, not an inverted dependency.
- A **wildcard listener claims every local address on its port**; recording `0.0.0.0` as a
  literal address would leave every real interface open.
- The match is on **address and port, not address class**. A `lan` deployment binds one
  private address; a different private address is somebody else's machine and a legitimate
  target, so refusing everything private would break the feature instead of protecting it.
- With **no listener registered nothing is refused**, so the smoke scripts, the proxy
  health check, and a library embedder behave exactly as before. An *invalid* registration
  throws rather than being ignored: a silent failure would leave the check believing it
  protects a listener it knows nothing about.

`index.ts` registers the listener and applies the posture's cap to outbound requests
**before** `listen`, so there is no window in which a request is served unprotected.

Verified: `@bayz/router` **288/288**, `@bayz/proxy` **121/121**, three `tsc --noEmit`
clean, `router-smoke` 46/46, `proxy-smoke` 39/39, `api-smoke` 70/70, `usage-smoke`
119/119.

### Task 9 — Fortress adversarial suite and security smoke

`packages/storage/test/fortress-adversarial.test.ts` (13 tests) and
`scripts/security-smoke.mjs` (82 checks).

**Recovered from a SIGKILL, not rewritten.** The test file survived untracked and ran
11/13. Both failures were **fixture faults**, corrected rather than assertions
weakened, and a third fault was invisible to the runner entirely:

1. The forged-row insert named `schema_migrations.name`. That column does not exist —
   the table is `(version, applied_at)` — so the insert failed on the schema instead of
   on the integrity check, which would have passed the test for the wrong reason.
2. The independent chain recompute hashed `migration.name`, a field `Migration` does
   not have. It now hashes version plus statements, and additionally asserts the same
   property against the **shipped** `migrationChain`, so the test cannot pass while the
   real function hashed version numbers alone.
3. `blob.toString("latin1")` type-errors: `exportSecrets` returns `Uint8Array`, whose
   `toString` takes no arguments. It is a Buffer at runtime, so the suite went green
   while `runtime:build` failed. **`tsx` strips types — a recovered RED file has to be
   type-checked, not just run.**

**What the suite covers that the Phase 2 file does not.** Root-key custody (a swapped
`master.key` caught at open with nothing decrypted, a wrong-length file distinguished
as `master_key_invalid` because the operator's remedy differs, the fingerprint proven
one-way), all six envelope columns under bit-flip and truncation, the export blob
(wrong passphrase, five tampered offsets across header/salt/IV/tag/ciphertext, and no
secret **name** leaked — a backup announcing `provider:openai:api_key` would tell an
attacker what is worth targeting), the migration chain in both directions, and
`keystoreSupport()` asserted `UNVERIFIED` on this device rather than expected to
succeed. The last test re-asserts Phase 2's two load-bearing properties against 9F
storage, so a 9F change that weakened either is caught even if that file were edited.

**The smoke proves deployment claims, which nothing in-process can.**

- The `lan`-without-TLS and `remote`-without-client-auth refusals **spawn the real
  entry point** and assert a non-zero exit with no `Bayz Core ready` line. Calling
  `resolvePosture` would prove the function throws. The bind address is `10.0.0.1`,
  which this device does not hold — and does not need to, because the gate runs before
  `listen`; depending on a real interface would make the check environment-sensitive
  for nothing.
- A `lan` bind **with** TLS starts, reporting `posture=lan tls=true concurrency=32` on
  a real `https://` listener, with the token absent from the log.
- **TLS verification stays on.** An EC PKI with an IP SAN, client trusting the test CA.
  `rejectUnauthorized: false` would prove the listener speaks TLS and nothing about
  which certificate it serves. `servername` is deliberately unset — RFC 6066 forbids an
  IP in SNI.
- Signing: accepted, then the identical request replayed → `signature_replayed`; a
  ten-minute-old timestamp → `signature_stale`; a body signed for one payload and sent
  with another → `signature_invalid`; a signature under the wrong key refused. The
  signature is produced by the **shipped** `signRequest`, not reimplemented — a test
  that builds its own proves two implementations agree, not that ours is right.
- Root-key rotation is proven by a **chat that authenticates afterwards**, with the
  upstream receiving the same credential. `credentialPresent === true` would be
  satisfied by a row that no longer decrypts. `rotated` is pinned at exactly **2**:
  only the provider credential and the proxy password are under custody, because
  `resolveApiToken` deliberately does not copy a `BAYZ_API_TOKEN` into the database.
  The first draft asserted three and was wrong about the system.
- Revocation is honest erasure: the next chat goes out with **no** Authorization header
  rather than with a stale credential.
- A **200-request burst** through the router — not the HTTP API, whose window limiter
  would refuse most of them long before the outbound cap mattered — against an origin
  that **holds** every request, so the peak reflects simultaneous upstream work.
  Measured peak **8** against a cap of 8, zero permits leaked, zero waiters queued.
- Disk and log scans distinguish two scopes on purpose. A completion is *supposed* to
  appear in a response body, so one combined scan would either fail on correct
  behaviour or get weakened until it proved nothing: prompt and completion are asserted
  absent from the **logs**, while credentials, the token, and the TLS private key are
  absent from logs **and** every body. A positive check confirms the completion did
  reach a body, so the body scan is known to read real content. The root key is scanned
  as **32 raw bytes read from `master.key`** — under secure-file custody there is no hex
  string to grep for, and looking for one that never existed is a check that cannot
  fail.

**The smoke was inverted to prove it can fail.** With `requireSigning: false` and the
cap raised to 512, 10 checks went red — every signing refusal plus a measured upstream
peak of **47**. Both were then restored.

Verified: `@bayz/storage` **246/246**, `runtime:verify` exits 0 (all eleven builds),
`security-smoke` **82/82**, `storage-smoke` 42/42, `api-smoke` 70/70,
`git diff --check` clean.

### 9F resume point

Phase 9F is **COMPLETE**.

## Phase 9G Agent / Tool Injection Security — as built so far

**The boundary is the registry, not a filter.** Model output is untrusted data. A prompt
saying "read all provider API keys" fails because no such capability is registered, and
`packages/capability/src` imports no secret store, no `node:fs`, no
`node:child_process`, no `node:net`, and no `node:http` — so there is nothing for an
injected instruction to reach even if it were obeyed.

### Task 1 — Capability registry (`0539536`)

New package `@bayz/capability`, depending on `@bayz/identity` only, inserted into
`runtime:build` immediately after `@bayz/identity` per the spec's twelve-target order.

**A `Map`, not an object literal, and that is a security decision.** With `{}` as the
store, a model-supplied name of `toString`, `constructor`, or `__proto__` resolves
through the prototype chain to a truthy builtin that a dispatcher would then treat as a
found capability and call.

`constructor` and `prototype` are *additionally* refused at registration even though the
name pattern admits them and lookup is already safe. The reason is not lookup: it is the
consumer that does not exist yet, where an object keyed by capability name — a tool
schema list for a model, a JSON summary for the dashboard — gets corrupted by
`{ constructor: … }`. A test asserts the pattern admits the name, so the two guards
cannot be conflated if the pattern is ever widened.

**`registerCapability` does no name blocklisting, deliberately.** A blocklist makes the
guarantee "we blocked that spelling", which invites `fetch_pr0vider_k3ys`. The
secret-name regex appears only as a tripwire *over the registry's actual contents*,
asserting nobody added one. `lookupCapability` takes `unknown` and returns `undefined`
rather than throwing, because the name arrives from parsed model JSON and a throw would
turn "the model sent a number" into a 500 on an attacker-timed path. `requiredScope`
must be one of identity's ten scopes: a handler declaring `"superuser"` would read as
maximally locked down while being unreviewable, and `satisfies` throws on an unknown
required scope, so the first dispatch would be a 500 rather than a clean refusal.

Registry empty by default, bounded at 128, refusing rather than evicting, and
`registeredCapabilityNames()` returns a copy so a caller cannot make a capability appear
or hide one from the tripwire.

Verified: **18/18**, `tsc --noEmit` clean, `runtime:build` 0 across twelve targets.

### Task 2 — Tool-call dispatch pipeline

`packages/capability/src/dispatch.ts`, 30 tests in `dispatch.test.ts`.

```text
depth → envelope → byte cap → JSON parse → shape → lookup → scope → parse → run → output
```

**Scope is checked before `parse`, and the ordering is the security property.** A
handler's `parse` walks a structure the model authored, so it is attacker-reachable
code; running it for a caller with no right to the capability would put untrusted input
through the least-exercised path in the system on behalf of somebody who should already
have been turned away. Measured with a counter rather than asserted by reading the
source — the test fails if `parse` runs even once for an unauthorized caller.

Refusals are **per call**, not per batch: one hostile call from the model must not deny
service to the client's real work. Only batch-level violations throw, because there is
no per-call outcome to attach them to. An over-bound batch is refused **wholesale rather
than truncated** — running the first eight and dropping the rest is both a partial
execution nobody asked for and an unreportable outcome for what was dropped. A
10,000-call flood costs one length comparison.

Bounds match `@bayz/router`'s 9B tool parsing on purpose (8 calls, 32 KiB): two
different bounds on the same wire array would mean one layer accepted what the other
refused, and the disagreement would be the interesting case for an attacker. Depth is
bounded at 4 against a **genuinely recursive** handler that dispatches to itself, not a
faked counter.

Decisions worth carrying forward:

- **An invalid depth is treated as past the bound, not coerced to 1.** Coercing would
  let a buggy or hostile handler reset the recursion budget on every hop, turning the
  bound into decoration. `NaN`, `0`, `-1`, `1.5`, and `Infinity` all refuse.
- **The byte cap is `Buffer.byteLength`, not `.length`.** A cap on UTF-16 code units
  admits roughly three times the intended payload for CJK text; the test uses 12,000 `あ`
  to prove it.
- **`isPlainObject` compares the prototype, and a key-set check alone cannot replace
  it.** `Object.create({ id, type, function })` reads as a perfectly valid call while
  `Object.keys` returns `[]`. That test asserts the **stage**, not just the code:
  refusing it incidentally at `dispatch-call-type` would pass a code-only assertion
  while the real guard was gone.
- **Unknown envelope keys are refused, not ignored.** A call carrying
  `{ scopes: ["admin"] }` is a hard refusal. Ignoring it is safe today and a silent hole
  the moment any future field on that object is read.
- **A malformed granted-scope set authorizes nothing.** An array, a plain object, a
  string, or `undefined` are each things a permissive implementation could read as
  "scopes unknown, so allow" — the same class of bug as a missing `default:` in an
  authorization switch. Only a real `Set` is accepted.
- **Capability output is validated before it is returned.** A cycle or a >32 KiB blob
  would otherwise fail at HTTP serialization time in Task 3, past the point where a
  clean refusal is possible. `undefined` is refused too: it would become an empty tool
  result, which reads to the model as "the tool ran and found nothing".
- **No refusal echoes model text.** Not the arguments, not the handler's own error
  message. The only model-supplied value that crosses the boundary is the capability
  *name*, and only when it matched the bounded 64-character ASCII pattern; otherwise a
  fixed placeholder. A refusal reaches an operator's log and a client response, so
  quoting model text would let an upstream plant instructions where a human or a
  downstream agent later reads them.
- **Calls run sequentially.** Concurrency would multiply whatever resource the
  capabilities touch by the batch size at exactly the moment a hostile response is
  trying to, and 9F's outbound cap bounds sockets rather than handler work.

**Four mutations were applied to prove the suite can fail**, then reverted: running
`parse` before the scope gate turned 3 tests red; coercing a bad depth to 1 turned the
depth test red; measuring the cap with `.length` turned the UTF-8 test red; deleting the
prototype comparison turned the inherited-envelope test red. The first draft of that
last test passed under the mutation — it was refused incidentally at
`dispatch-call-type` — which is why it now pins the stage.

Verified: `@bayz/capability` **48/48** (18 registry + 30 dispatch), `@bayz/identity`
69/69 unaffected, `tsc --noEmit` clean, `runtime:build` exits 0 across all twelve
targets, no `node:fs` / `node:child_process` / `node:net` / `node:http` / secret-store
import anywhere in `packages/capability/src`.

### Task 3 — Gateway and router wiring

`apps/server/src/tool-loop.ts`, wired into `apps/server/src/routes/chat.ts`.
17 tests in `apps/server/test/tool-dispatch.test.ts`, all against a real runtime, a
real SQLite database, and a real loopback origin scripted to emit hostile tool calls.

**One distinction carries the design.** A tool call BAYZ has a registered capability
for is BAYZ's to run; everything else belongs to the client. The registry is empty
unless an operator registers something, so with the shipped configuration `runToolLoop`
makes exactly one router call and returns exactly what Phase 9B returned — which is why
adding it changes no existing deployment's behaviour, asserted by a test.

An unregistered call is **forwarded, not refused**. BAYZ has nothing to run, and
inventing a refusal would break every client that declares its own tools. That is also
why a model naming `read_provider_credentials` gets a forwarded tool call rather than an
error: the guarantee is that no capability reads a secret, not that a name was blocked.

Authority is re-established from the authenticated principal on **every** turn, never
from the previous turn's output. `dispatchToolCalls` checks the scope before calling a
handler's `parse`, and the HTTP test measures that with a counter — a chat-only identity
naming a `routes.write` capability gets 403 with `parsed() === 0`.

#### A live bug this task found and fixed

`wireBody` serialized `request.messages` directly. `ChatMessage` is BAYZ's internal
shape and uses camelCase (`toolCalls`, `toolCallId`); the OpenAI wire contract is
snake_case. So **every tool roundtrip since 9B** reached the upstream with `toolCalls`
and `toolCallId` — names no provider recognises — handing the model a conversation with
the tool call and its result effectively missing. It would answer without the data it
asked for, or ask again.

The 9B suite could not see it. Its only assertion on the outbound body was that the
result *string* appeared somewhere in it, which held either way because `content` needs
no renaming. `wireMessages()` now translates the three fields explicitly, assembling
them one at a time so a field added to `ChatMessage` later cannot reach the wire without
a decision, and `packages/router/test/tools-response.test.ts` pins the key names.

#### Decisions worth carrying forward

- **`packages/gateway/src/normalize.ts` was not modified**, contrary to the plan's
  Modify list. The gateway maps *client request* fields; nothing about server-side
  dispatch belongs there, and the `role:"tool"` messages the loop synthesises never pass
  through it. Editing it to match a checklist would have been change without a reason.
- **The first turn passes the request through untouched.** Seeding the loop with
  `[...request.messages]` turned a `{}` payload's clean 400 `invalid_request` into a 500
  on a spread of `undefined`. `router.chat` owns request validation, so the conversation
  is only reconstructed *after* a turn comes back with tool calls — at which point the
  body is known to have validated. Caught by `chat-api.test.ts`, which pins that refusal.
- **A split batch is refused, not half-run.** Running the registered calls and handing
  the client-side ones back would perform a side effect and then return a conversation
  neither party can reconcile: the client cannot know which calls already ran, and the
  model's next turn would be missing a result it expects. `tool_dispatch_split`, and
  nothing ran.
- **The loop is bounded in turns, not wall-clock** — `MAX_DISPATCH_TURNS = 4`. A turn is
  a real upstream request that costs money and holds a socket, so the count is what an
  operator can reason about and what a hostile model inflates. Reaching the last turn
  with another call pending is `tool_dispatch_exhausted` rather than a conversation whose
  final turn is an unanswered call.
- **Streaming does not dispatch, stated rather than left ambiguous.** A stream's 200 and
  headers are committed with the first byte, so a dispatch failure could only be a
  terminal event inside an already-successful response, while the non-streaming path can
  still answer 403 or 400. Forwarding tool calls to a streaming client is the correct
  fallback — exactly the 9B behaviour — and a test asserts the handler does not run.
- **The reachable capability namespace is the intersection of two patterns.**
  `CAPABILITY_NAME_PATTERN` admits `.`; the router's 9B `TOOL_NAME_RE` does not. A
  capability named `echo.text` is registrable and permanently unreachable, because a
  model naming it has its whole response refused by `parseToolCalls` before the registry
  is consulted. Safe, but silent, so a test pins it.
- **Nine 9G codes were added to the HTTP error map.** 400 for a malformed argument or an
  exhausted loop (the remedy is a different request, not a retry), 403 for a scope
  refusal, 502 for a capability that threw — the client did nothing wrong. Every message
  behind them is fixed vocabulary, because all of them are produced in response to model
  output.
- **The leak scan covers the accepted path too**, not just the rejected one. A successful
  dispatch is where an argument could most plausibly be persisted: it travelled to a
  handler, came back, and went out to the model again. Telemetry rows, captured log
  lines, and the raw `bayz.db` / `-wal` / `-shm` bytes are all scanned, with a positive
  check that the scan is reading real content.

**Three mutations proved the suite can fail**, then were reverted: half-running a split
batch (1 red), letting a tool result widen the effective scope (1 red), and removing the
turn budget (1 red).

Verified: `@bayz/server` **336/336** (up from 319), `@bayz/router` **289/289** (up from
288), `tsc --noEmit` clean for both, `api-smoke` 70/70, `stream-smoke` 63/63,
`router-smoke` 46/46. `apps/server/src/tool-loop.ts` touches no secret surface — no
`SecretStorage`, no `withCredential`, no `node:fs`, no `node:child_process`.

### Task 4 — Injection adversarial suite

`packages/capability/test/injection-adversarial.test.ts`, 24 tests. **No `src` file
changed** — the only 9G task where that is true, and it is the result rather than an
omission: the suite was written to break Tasks 1–3 and every case refused on the first
run.

Each case asserts a **structural** refusal. Something fails because the capability does
not exist, or because the caller's scope does not include it, or because a bound was
exceeded — never because a string matched a denylist. `secrets.read` and a deliberately
misspelled `s3cr3ts_r34d` fail identically, for the same reason: neither is in the `Map`.
A control capability is registered in nearly every test and *does* run, so no refusal can
be passing because dispatch is broken.

What the suite proves, grouped as an auditor would read it:

- **Injection cannot escalate.** The hostile prompt is *text*; there is no eval, no name
  resolution from prose, no intent mapping. Every phrasing of "read all provider API
  keys" — and every individual word of it — resolves to `undefined`, and the registry
  still contains exactly what was registered.
- **Unknown and unauthorized calls fail closed.** `unknown_capability` at
  `dispatch-lookup` even for an `admin` principal, because the refusal is about
  existence and the widest available authority must not change it.
  `capability_forbidden` at `dispatch-scope` for a real capability the caller lacks,
  with the handler's `parse` counter still at zero.
- **Forged arguments and forged authority are rejected.** 19 hostile `city` values
  (traversal, `file://`, `169.254.169.254`, `metadata.google.internal`, gopher/Redis,
  command substitution, a NUL, a header-injection newline) all refuse at
  `dispatch-parse`; a call carrying `scopes`, `requiredScope`, `principal`, `authorized`,
  or an own `__proto__` key refuses as `invalid_tool_call`. Wildcards — `*`, `all`,
  `routes.*`, `ROUTES.WRITE`, whitespace- and zero-width-padded variants — authorize
  nothing, because the vocabulary has ten words and none is a wildcard.
- **Unknown argument keys are rejected, not trimmed.** Silently trimming would leave a
  caller believing a field took effect and would hide the fact that the model sent
  something unexpected.
- **Output stays untrusted.** A handler returning `scopes`, `grantedScopes`,
  `principal`, `authorized`, plus embedded `tool_calls`/`toolCalls`/`next`/`then` naming
  a privileged capability drives nothing. That test grants the caller `routes.write`
  **on purpose**: if those fields were ever read, scope would not be what stopped them.
- **Nothing leaks through a refusal.** Sentinel scans plus a pinned field set —
  `Object.keys(outcome)` is exactly `code`/`id`/`name`/`stage`/`status`, every value a
  string under 128 characters — so there is nowhere for an unanticipated leak to sit. The
  `CapabilityError` class is checked directly too, including its stack.
- **Rejected data reaches no privileged execution.** A `routes.write` capability records
  every `parse` and `run`; four hostile calls aimed at it in one batch refuse with
  `parsed() === 0` and `seen()` empty, while a legitimate call in the same batch
  completes. The complement matters: a dispatcher that refused the whole batch would pass
  a refusal-only test while handing any hostile call a denial-of-service lever.
- **The boundary is structural.** The source scan allowlists module specifiers to
  relative paths plus `@bayz/identity`, additionally names `node:fs`,
  `node:child_process`, `node:net`, `node:tls`, `node:http(s)`, `node:vm`,
  `node:worker_threads`, `node:sqlite` and the sibling `@bayz` packages, bans the
  secret-store identifiers and `eval` / `new Function` / `require(` / `import(`, and
  asserts positively that it read the real registry source. The manifest is pinned so a
  new dependency cannot arrive via a file the glob misses, and both `@bayz/capability`
  and `@bayz/identity` **export** lists are checked against
  `/credential|password|secret|reveal|decrypt|plaintext|unsafe/i` — the imports say what
  the package can reach, the exports say what a handler can be handed.

Decisions worth carrying forward:

- **"The client never declared it" is not a refusal this layer can make, and the test
  says so instead of pretending otherwise.** A client's `tools` array is a declaration to
  the *model*; the registry is what this process will run. Separate namespaces on
  purpose, so an undeclared name refuses for the same structural reason an invented one
  does — nothing registered it. The guarantee actually pinned here is the narrower,
  load-bearing one: **BAYZ executes nothing it was not given**, including when a tool
  *definition* is passed to `registerCapability`. Task 3's `tool-dispatch.test.ts` owns
  the forward-to-client half.
- **The source scan runs on comment-stripped source, and that is not a loosening.** A raw
  text scan fails on `dispatch.ts`, which explains in prose why its bounds match
  `@bayz/router`'s — a legitimate cross-reference with no import behind it. Banning the
  *words* would push authors toward vaguer comments, so what is banned is the code, with
  module specifiers additionally checked on their own so an import cannot hide inside
  something the stripper mangles.
- **The homoglyph case asserts both halves.** The lookalike does not resolve to the real
  capability *and* cannot be registered, because the name pattern is ASCII-only — nine
  variants including Cyrillic е/р, fullwidth `ｗ` and `＿`, and zero-width and
  non-breaking padding.
- **The recursion case is genuinely recursive.** The handler dispatches to *itself* and
  asks for ten levels; the recorded depth sequence is exactly `[1, 2, 3, 4]`, and the
  fifth level's refusal appears as `dispatch_depth_exceeded` at `dispatch-depth-bound`
  inside the returned outcome.
- **The flood case asserts the bound is a bound.** 10,000 calls throw
  `too_many_tool_calls` with `parsed() === 0`, and then the first eight of the same array
  run successfully — otherwise a blanket refusal would pass.

**Seven mutations proved the suite can fail**, then were reverted, each time verified by
`git status` returning to a single untracked test file:

1. `parse` moved before the scope gate → 2 red.
2. `CAPABILITY_NAME_PATTERN` widened to `\p{L}` → 1 red (homoglyph).
3. A `detail` field added to a refusal carrying the handler's own message → 2 red.
4. The envelope unknown-key check deleted → 1 red (forged `scopes` accepted).
5. `node:fs` imported by `registry.ts` → 1 red (source scan).
6. The registry `Map` swapped for an object literal → 1 red (`toString` resolved to a
   builtin the dispatcher would have called).
7. An over-bound batch truncated to eight instead of refused, plus an invalid depth
   coerced to 1 → 1 red.

Verified: `@bayz/capability` **72/72** (18 registry + 30 dispatch + 24 injection),
`@bayz/identity` 69/69, `@bayz/gateway` 74/74, `@bayz/router` 289/289, `@bayz/server`
336/336, all twelve `runtime:build` targets exit 0 run one at a time, `api-smoke` 70/70,
`security-smoke` 82/82.

### Task 5 — Injection smoke

`scripts/injection-smoke.mjs`, **179 checks**, non-mocked end to end: a real listener on
a real loopback port driven by real `fetch` (not `app.inject`), a real SQLite database
under a temp `dataDir` with the real envelope crypto, a real provider credential and
proxy password under custody, and a real upstream origin on its own port scripted per
turn to emit hostile tool calls — reaching the real gateway → router → `runToolLoop` →
`@bayz/capability` path. The registry is process-wide, so a capability registered by the
script is the capability the HTTP path finds, not a double.

Eleven sections, in the order an auditor would want them:

1. **Real listener, real database, real hostile origin** — including the free-first
   assertion below.
2. **The registry is empty by default**, the bounds are 8 and 4, and thirteen
   secret-reaching names resolve to `undefined`.
3. **`read_provider_credentials` and four siblings refuse** with `unknown_capability` at
   `dispatch-lookup` under an **`admin`** principal — the refusal is about existence, so
   the widest authority in the system must not change it. Then over HTTP, where an
   unregistered name is forwarded to the client with nothing executed and no credential
   attached.
4. **Ten traversal-style arguments** (`../../etc/passwd`, `file://`, `169.254.169.254`,
   `metadata.google.internal`, command substitution, `; rm -rf /`, a header-injection
   newline) each refuse as `invalid_tool_arguments`, reach `parse` exactly once, reach
   `run` never, echo nothing, and produce no second upstream turn.
5. **A chat-scope identity cannot dispatch a `providers.write` capability** — 403
   `capability_forbidden` with `parsed() === 0`, `ran() === 0`, and `seen()` empty; then
   the complement, an admin caller dispatching the same capability successfully, so the
   gate cannot be passing by refusing everything.
6. **The credential is unreachable through every hostile path exercised** — nine
   management routes 403 to the chat client, no credential read endpoint exists for
   anyone including admin, and the provider row reports custody without the value.
7. **Unknown capabilities and malformed arguments fail closed** — six malformed blobs, a
   nine-call batch, a 40 KiB argument, and a split batch, each with nothing executed.
8. **A recursive chain stops at depth four**, driven through HTTP against a handler that
   dispatches to itself and asks for ten levels.
9. **The credential reached the upstream**, asserted positively.
10. **Zero occurrences** across every response body, every log line, and the raw
    `bayz.db` / `-wal` / `-shm` bytes, with positive checks that each scan read real
    content.
11. **No boundary was weakened** — bounds re-asserted, the secret-reaching names still
    unregistered at the end of the run, and no registered name matching
    `/credential|password|secret|token|key|export/i`.

Decisions worth carrying forward:

- **Two layers refuse a malformed argument, and the smoke records which.** The router's
  9B `parseToolCalls` runs before dispatch and already requires `arguments` to parse to a
  JSON object, so an unparseable blob, a bare array, and a bare scalar never become tool
  calls: the response is refused as **`invalid_response` (502)** — the upstream's fault,
  not the client's. What survives reaches dispatch and refuses as
  **`invalid_tool_arguments` (400)**. The first draft asserted 400 for all six and failed
  three; pinning the expected code per case is the honest fix and makes a future move
  between layers a decision rather than drift.
- **The credential is asserted to reach the upstream, positively.** A zero-occurrence
  scan passes trivially if credentials are simply broken, so the origin's captured
  `Authorization` headers are held apart from the scan and checked to contain
  `Bearer <sentinel>`. The upstream request *bodies* are separately asserted
  credential-free.
- **The accepted path is exercised on purpose**, because it is where a value could most
  plausibly be persisted — it travels to a handler, returns as a `role:"tool"` message,
  and goes out again. The Task 3 wire fix is re-checked there: the replayed result must
  carry `tool_call_id`, never the internal `toolCallId`.
- **The depth refusal is found in the upstream request body**, not merely in a return
  value, which proves it was serialized into the conversation the model saw.
- **FREE-FIRST is preserved and asserted, not assumed.** A route created with no
  `freeOnly` field must still come back `freeOnly: true` (§25 rule 6), and the smoke
  checks exactly that before opting its own scenario route out explicitly.

#### A pre-existing breakage this task found and fixed

`scripts/identity-smoke.mjs` was failing **67/74** before this task touched anything. It
was last edited at `e1e2a71`, *before* free-only landed at `6955443`, and it created its
route without `freeOnly: false`. Free-only defaults ON, the fixture origin publishes no
pricing metadata so its model classifies as undiscovered, and undiscovered is not free —
so all three client chats and the admin-credential check refused with 409
`no_free_route`. Every other smoke received the `freeOnly: false` fixture note in
`6955443`; this one was missed. Fixed with the same one-line opt-out and the same
explanatory comment: **74/74**. No free-first behaviour was changed.

**Mutations.** Two were applied and reverted, each verified byte-identical to its backup
and to `HEAD` afterwards: `parse` moved before the scope gate in `dispatch.ts` → 2 red;
the split-batch guard deleted from `tool-loop.ts` → 2 red. A third — the loop escalating
its own principal to `admin` — was **prepared but not run**, because the command was
blocked awaiting approval and retrying a source mutation without consent was the wrong
move. That property is already covered by `tool-dispatch.test.ts`'s elevated-scope test
and by this smoke's own chat-scope refusal, so the shortfall is in the mutation count
rather than in the coverage, and it is recorded here rather than glossed.

### 9G completion checklist — all seven items GREEN

Registry is a bounded `Map`, empty by default, with no secret-reading name. Dispatch
validates in stages and checks scope before `parse`, measured with a counter in three
places. Depth 4 / calls 8 / arguments 32 KiB all bounded and exercised. A model cannot
name a capability into existence, and the refusal is structural rather than a blocklist
hit. Tool results cannot elevate scope. `packages/capability` imports no secret store, no
`node:fs`, no `node:child_process` — enforced by an allowlist plus a named forbidden
list, the manifest, and both packages' export lists. No tool argument or result reaches
telemetry, logs, or the database, on both the rejected and the accepted path.

### 9G resume point

**Phase 9G is COMPLETE.** Tasks 1–5, five commits: `0539536`, `d243a3f`, `ab0fbc5`,
`400aa8d`, `de02328`.

## Phase 9H Client Compatibility Matrix — as built so far

### Task 1 — Matrix document and status vocabulary

`docs/superpowers/2026-08-27-bayz-client-compatibility-matrix.md` and
`tests/matrix-integrity.test.mjs` (9 tests). **102 cells — 6 clients × 17 capabilities —
and every single one is `UNVERIFIED`.** No client has been driven against BAYZ yet, and the
document leads with that rather than burying it.

**The document's first job is to separate two things that look alike.** BAYZ *implements*
an OpenAI-compatible gateway with streaming, tool calling, scoped identities, custom
providers, proxy-bound routes, combos, failover, and free-only routing, all covered by 1897
tests and 998 smoke checks. **None of that is a compatibility claim.** A capability can be
correct at the protocol level and still fail a specific client that sends an unexpected
header, parses a field strictly, or reconnects unusually. Implemented capability lives in
the plans and suites; verified client behaviour lives in the matrix, and nothing enters it
without evidence that resolves on disk.

#### The status vocabulary, and why it is not the plan's

The plan said `PASS` / `FAIL` / `UNVERIFIED` / `N/A`. Implemented:
**`VERIFIED` / `PARTIAL` / `BLOCKED` / `UNVERIFIED` / `N/A`**, with `PASS` and `FAIL`
refused as *placeholders* so the old words cannot creep back in.

- **`PASS` overstates what a cell can mean.** A cell asserts "observed to work against the
  real client" — that is `VERIFIED`. `PASS` reads like a test result, and inviting that
  reading is inviting a green suite to be mistaken for a verified integration.
- **`PARTIAL` had no representation at all.** A client that streams but truncates on
  reconnect is neither a pass nor a failure; forcing it into `PASS` is how a real
  limitation vanishes. It requires evidence *and* a named limit in the same cell.
- **`BLOCKED` vs `UNVERIFIED` is the load-bearing distinction, and `FAIL` conflated it.**
  `BLOCKED` = attempted, did not work, something was learned. `UNVERIFIED` = not attempted,
  nothing is known. An untried cell that reads like a tried one is precisely the failure
  9H exists to prevent.
- **`N/A`** is retained for a capability the client genuinely has no surface for — demanding
  evidence for something that cannot exist would make the gate unsatisfiable.

**Consequence for 9H Task 6:** `client-gate.mjs --enforce` must block on `BLOCKED` **and**
`UNVERIFIED` for any Core 3 mandatory column. A gate written against a single `FAIL` word
would pass a matrix full of untried cells.

#### What the integrity test enforces

Nine tests, and the third property is the one that matters:

1. **Shape** — all six client sections, all seventeen capabilities each, one status per
   cell from the closed vocabulary. Placeholders (`` `` / `-` / `?` / `TODO` / `TBD`, plus
   `PASS`/`FAIL`) are refused, and an *unrecognised* capability row is refused too, because
   a typo'd name would otherwise sit there looking covered while the real column went
   missing.
2. **Evidence required** — `VERIFIED`/`PARTIAL` must cite
   `smoke:<script>#<n>` / `test:<path>` / `transcript:<path>`, comma-separated citations all
   of which must parse. `BLOCKED`/`UNVERIFIED`/`N/A` must instead give a reason of ≥12
   characters — the shortest bound that excludes `n/a`, `todo`, and `see above` — and are
   refused if they cite evidence, since a cell with evidence should not claim ignorance.
3. **Evidence must resolve on disk.** The plan asked only for a regex. A regex accepts
   `transcript:docs/transcripts/opencode/chat.log` in a repository where no such file
   exists, which makes the easiest path to a green matrix inventing a plausible filename.
   Every citation is `existsSync`-checked; `smoke:<name>#<n>` resolves the script (the check
   *number* is Task 2/4's to validate by running it).

Plus a raw-text scan: any `VERIFIED` on a line that is not a table row fails, with a
carve-out only for the legend defining the word. A `VERIFIED` in prose or a heading is
invisible to a table parser, and would let the document read as a verified integration
while every cell said otherwise.

#### Device reality, measured — and a correction

| client | measured | plan/spec said |
| --- | --- | --- |
| `opencode` | **present**, `/usr/local/bin/opencode`, `1.18.23` | present ✓ |
| `hermes` | **present**, `/root/.local/bin/hermes`, `Hermes Agent v0.20.5` | **absent ✗ — corrected** |
| `antigravity` | absent | absent ✓ |
| `cline`, `aider` | absent | absent ✓ |
| `continue` | absent — the `command -v` hit is the **shell builtin**; `type continue` → `continue is a shell builtin`, no `~/.continue` | absent ✓ |

Both the 9H plan and spec §12 recorded Hermes as absent. It is present. The row stays
`UNVERIFIED` — **presence is not verification** — but Task 5 can now attempt it for real
rather than only shipping a harness for a host that has it.

#### Decisions worth carrying forward

- **Row ids are the real preset identifiers** the runtime already validates
  (`packages/identity/src/repository.ts`: `opencode`, `hermes`, `antigravity`,
  `generic-openai`), not display names invented for a document — so a row cannot drift into
  a marketing label. **No client-name branching exists in any runtime path and none was
  added**; BAYZ still derives behaviour from the protocol, Accept header, body shape, and
  scopes.
- **The `free-only routing` column was applied at Task 1, not retro-fitted.** The §25
  amendment adds a seventeenth column; putting it in the required list from the start means
  it cannot be omitted and then patched in. A client that silently spends money would be a
  compatibility failure even with every other cell green.
- **A one-shot generator wrote the 102 cells and was then deleted.** Hand-typing 102 rows
  is 102 chances to typo a capability name. It was verified to reproduce the committed file
  byte-for-byte, then removed rather than committed: the matrix is now edited by hand, cell
  by cell, with evidence, and a generator that could rewrite statuses would be a second
  source of truth.
- **Five conditions move a cell to `VERIFIED`**, documented in the matrix itself: a real
  client process (not `fetch`, not `app.inject`), a real BAYZ listener with a real database
  and a scoped identity, an observed result, captured evidence on disk, and a harness that
  exits non-zero if it claims a cell it has no transcript for. A cell may not become
  `VERIFIED` from a script's own opinion.

**Six mutations proved the test can fail**, then were reverted: a `VERIFIED` with a
hand-waved reason (2 red), a `VERIFIED` citing a well-formed but non-existent transcript
(1 red), a `TODO`/`-` placeholder (1 red), a Core 3 row renamed away (2 red), the
`free-only routing` column dropped from one client (1 red), and a prose "all Core 3 clients
are VERIFIED and release-ready" line outside any table (1 red).

Verified: `node --test tests/matrix-integrity.test.mjs` **9/9**;
`tests/runtime-structure.test.mjs` **1/1** unaffected; 10/10 together. `git diff --check`
clean. **No tracked source file was touched** — Task 1 adds two new files and edits two
documents, so the gateway, routing, security, provider, and proxy behaviour are byte-identical
to `de02328`.

### Task 2 — Protocol conformance harness

`scripts/client-conformance.mjs`, **55 checks across 13 sections**, driving BAYZ exactly as
a third-party OpenAI-compatible client would: real `fetch` over a real TCP port against a
real listener, a real SQLite database with real envelope crypto, and real scripted loopback
origins. No `app.inject`, no imported handler, no in-process shortcut — because the failures
this exists to catch only appear on the wire. A client that parses strictly breaks on a
missing `object` field or an `index` that is absent rather than `0`, and an in-process
assertion on a JavaScript object would never see it.

Sections A–N: configure, authenticate, `GET /v1/models`, non-streaming chat, streaming SSE,
tool call, tool result roundtrip, large request, cancel, error surface, custom provider,
combo + failover, key revoke/rotate, and the §25 free-only amendment.

Shape assertions run through a `shapeProblems()` walker that **names the offending field**
in the failure message, so a regression says `object has the wrong shape: "chatCompletion"`
rather than just failing. `chat.completion`, `chat.completion.chunk`, the model-list
envelope, `tool_calls`, and `usage` are each pinned key by key. Extra keys are tolerated —
the OpenAI contract is additive and a strict client ignores unknowns — but every declared
key must be present with the right type.

#### A live 400-vs-500 bug this task found and fixed

`apps/server/src/http-errors.ts` mapped **no `GatewayError` code at all**, and an unmapped
code falls through to a generic **500 `internal_error`**. So a generic OpenAI client posting
a JSON scalar instead of an object was told "the server is broken, retry" when the truth was
"your request is malformed, fix it" — and a client obeying that would retry forever.
`invalid_capability`, `invalid_quirk`, `invalid_profile`, and `capability_unsupported` now
map to **400**, since all four are produced from a caller-supplied body or headers.

This is the **only runtime source change** in Task 2. `capability_unsupported` has two other
theoretical stages — a missing scope and the unimplemented Anthropic `/v1/messages`
protocol — but neither is reachable over HTTP today: `requireScope` answers 403 before the
chat route normalizes anything, and `/v1/messages` is not registered. If that route is ever
added, its refusal needs 501 and the map has to become stage-aware rather than code-only;
that is recorded in the source comment.

#### The matrix's `smoke:` citations were decoration until this task

Task 1's integrity test resolved the cited *script* but never the *number*. So
`smoke:client-conformance#99` sitting in a cell for a capability the harness never exercises
passed cleanly — found by mutating the matrix to claim `proxy-bound route` exactly that way.
That is a fake compatibility claim with a green test behind it, which is the failure mode
9H exists to prevent.

Fixed structurally rather than by inspection: the harness writes
`docs/evidence/client-conformance.json` on a **fully passing run only** (a manifest from a
failing run would let a matrix cite a check that did not pass), mapping each capability to
the check number covering it. `tests/matrix-integrity.test.mjs` resolves every `smoke:`
citation against that manifest, so a cell can no longer cite a number the script never
assigned, a capability it never covers, or another capability's number. A script without a
manifest still gets the existence check only — Task 4/5's harnesses cite `transcript:`
paths instead.

`PARTIAL` also needed enforcement it did not have: Task 1's legend said such a cell carries
evidence *and* a named limit, but the test only checked the evidence half, so a bare
`PARTIAL` would have passed. Task 2 produced the first real `PARTIAL` cells and exposed it.
The limit after ` — ` is now required at ≥12 characters, and a `VERIFIED` cell is refused if
it carries trailing prose — a caveat inside a full pass is precisely what `PARTIAL` is for.

#### Two PARTIAL cells, recorded honestly rather than rounded up

- **`large request`** — a 120 KiB message is served in full with nothing truncated; the
  plan's 200 KiB payload exceeds `MAX_CONTENT_CHARS` (128,000 in
  `packages/router/src/request.ts`) and is cleanly refused 400, never truncated and never
  5xx. Two payloads are sent deliberately: the oversized one alone could not distinguish a
  working bound from a broken large-body path.
- **`error surface`** — every malformed request returns the stable
  `{error:{code,message,requestId}}` envelope with the right status, but a JSON scalar body
  reports `capability_unsupported` ("the client is not granted that capability") when the
  real cause is body shape. `deriveProfile` never derives the `chat` intent from a
  non-object, so the refusal comes from the capability gate rather than a shape check. The
  status and envelope are conformant so no client breaks; the message misdirects. Fixing it
  means changing `intentOf`/`deriveProfile` in `@bayz/gateway` — outside Task 2's remit and
  pinned by several of the 74 gateway tests — so the wording is *asserted* to keep it a
  known pinned fact rather than a surprise.

#### Decisions worth carrying forward

- **Two columns are deliberately not claimed.** `proxy-bound route` needs a real CONNECT
  proxy fixture and `restart/reconnect` needs a client surviving a listener restart; both
  stay `UNVERIFIED` with the reason in the cell, and the harness prints what it does not
  verify. 9H Tasks 4–5 own them.
- **The §25 free-only checks bind a non-loopback address on purpose.** `allowLoopback`
  short-circuits classification to `LOCAL`, which is free, so a loopback origin cannot
  exercise the PAID path at all. #50 proves the 409 `no_free_route`, **#51 proves the paid
  origin was never called** — a 409 alone would not prove nothing was spent — #48 proves a
  route created without `freeOnly` still defaults to free-only (§25 rule 6), and #53 proves
  an explicit opt-out still routes, so the guard is a bound rather than a wall. On a host
  with no private IPv4 the check reports `SKIP` instead of asserting against loopback.
- **The cancel check waits 400 ms before aborting**, so the request is genuinely in flight
  upstream, and asserts the **origin** observed the socket close rather than merely that
  `fetch` rejected. A held-open origin gives the abort a window to land. It then re-checks
  that the listener still serves normally, because an abort must not poison the server.
- **Streaming is measured incrementally.** The origin emits two content frames, so "content
  arrives across multiple deltas" is observed rather than assumed, and the reassembled
  deltas are compared to the upstream completion exactly. `[DONE]`,
  `x-accel-buffering: no`, `no-cache`, a stable chunk `id`, and a terminal `finish_reason`
  are pinned separately.
- **The 9G wire fix is re-checked from the client's side.** The tool-result roundtrip
  asserts the forwarded body carries `tool_call_id`/`tool_calls` and **never** the internal
  `toolCallId`/`toolCalls` — the exact bug 9G Task 3 found. Mutating it back turns this red.
- **Check numbers are contractual.** The matrix cites them by number, so a check must be
  *appended*, never inserted mid-sequence; if a number has to move, the matrix citation and
  the manifest move with it in the same commit. Stated at the top of the script.

**Four mutations proved the harness can fail**, then were reverted: `object` renamed to
`chatCompletion` in `denormalizeResponse` (1 red, and the message named the field);
`isFreeCandidate` forced true so PAID reads as free (4 red); the `freeOnly` default flipped
to `false` (5 red, including the rule-6 default check); and `tool_call_id` regressed to
camelCase on the wire (1 red). Two further mutations proved the matrix-integrity additions
can fail: a `PARTIAL` with no stated limitation, and a caveat hidden inside a `VERIFIED`
cell. Plus the two that motivated the manifest: a fictional check number, and a real number
belonging to a different capability.

Verified: `client-conformance` **55/55** (twice), `matrix-integrity` **9/9**,
`runtime-structure` **1/1**, `@bayz/server` **336/336**, `@bayz/gateway` **74/74**,
`@bayz/router` **289/289**, `@bayz/server` build exit 0, and `api-smoke` 70/70 +
`stream-smoke` 63/63 + `security-smoke` 82/82 + `injection-smoke` 179/179 +
`usage-smoke` 119/119 + `proxy-ux-smoke` 127/127 confirming the one-line error-map change
moved nothing. `git diff --check` clean.

### Task 3 — Per-client configuration presets and docs

Five files under `docs/clients/`: `README.md` (index and shared preamble), plus
`generic-openai.md`, `opencode.md`, `hermes.md`, `antigravity.md`. Guarded by
`tests/client-docs.test.mjs` (6 tests). **Zero runtime source files were touched.**

These are **configuration** guides, not compatibility claims, and each says so at the top.
Only `generic-openai.md` carries evidence — it restates the matrix row cell for cell with
`smoke:client-conformance#N` citations. The other three describe how to point a client at
BAYZ while stating plainly that **no capability has been verified for that client**.

#### Real config forms, read from this machine

Nothing was composed from documentation. The two installed clients disagree on nearly every
field, which is the finding that shaped the whole task:

| | OpenCode | Hermes |
| --- | --- | --- |
| file | `~/.config/opencode/opencode.json` | `~/.hermes/config.yaml` |
| format | JSON | YAML |
| base URL key | `options.baseURL` (**camelCase**) | `model.base_url` (**snake_case**) |
| key location | `options.apiKey` in the config | `~/.hermes/.env`, variable **derived from host+port**: `HERMES_CUSTOM_127_0_0_1_20128_API_KEY` |
| adapter | `npm: "@ai-sdk/openai-compatible"` | `api_mode: chat_completions` |
| model form | bare id as the `models` key, **`<provider>/<model>`** in `model` | **bare id** everywhere |

There is no safe default between those two. So `antigravity.md` — the client absent from this
host — documents **no config block at all**, and says why: inventing a field name would be
indistinguishable from a correct guide until someone tried it.

**The model-name form is the likeliest user error.** BAYZ ids may themselves contain `/`
(`^[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,126}[A-Za-z0-9])?$`), so OpenCode's
`bayz/openai/gpt-4o` is one provider label plus a two-segment id — not a three-part path.
Both guides state it explicitly.

#### Every documented behaviour was measured, not read off the source

A probe against a live listener confirmed each claim before it was written: `freeOnly`
defaults to `true` on a route created without the field; a first chat against an unclassified
provider is **409 `no_free_route`**; `GET /v1/models` excludes wildcard patterns;
`response_format` / `user` / `n` are **400** rather than ignored; `stop` as a bare string and
`max_tokens` as a string are accepted; 257 messages, 65 tools, 5 stop sequences, a
129,000-character message, and a `__proto__` tool name are each **400**; `usage` is **absent**
when the upstream omits it entirely and per-field `null` when partial; `x-bayz-route`,
`x-bayz-provider`, and `x-request-id` are present while `x-bayz-proxy` is absent on a direct
route.

#### The guides needed a guard of their own

`tests/matrix-integrity.test.mjs` reads the matrix, not `docs/`. So a guide asserting
"streaming works" for a client whose `stream` cell is `UNVERIFIED` would have been a fake
compatibility claim no existing test could see — prose is the one place such a claim can
hide. `tests/client-docs.test.mjs` holds the documentation to the matrix: all four guides plus
the index exist; every guide states the base URL and **no other `127.0.0.1` port**; a bare
`VERIFIED` is permitted only where that client's row genuinely has one; a restated status
table must match the matrix **cell for cell** with citations the matrix carries (17 compared
for `generic-openai`, asserted, so it cannot pass by comparing nothing); every referenced
repository path must exist bar three enumerated future artefacts; and `antigravity.md` may
contain no copyable config assignment.

#### Decisions worth carrying forward

- **`IdentitiesPanel.tsx` was not modified**, contrary to the plan's Modify list. The 9C
  preset selector is already correct — it renders `CLIENT_PRESET_NAMES` and seeds
  `PRESET_SCOPES[preset]` while leaving the checkboxes editable. Editing a working panel to
  satisfy a checklist entry would be change without a reason.
- **Presets are re-stated as inert in every guide.** A preset seeds the default scope set and
  labels the key; `packages/gateway/src/presets.ts` is the only file where these names may
  appear, and `packages/gateway/test/adversarial.test.ts` scans every other gateway source to
  keep it so. Naming a key `opencode` does not change how a request is served.
- **The invented-config guard was wrong twice before it worked**, and both holes are recorded
  in the test rather than quietly fixed. It first exempted any line containing
  `127.0.0.1:20128`, so an invented block passed *because* it cited the real URL. Then
  `baseURL\s*[:=]` failed to match JSON, where the text is `"baseURL":` with a quote between
  key and colon — a YAML-shaped pattern silently ignored the shape most likely to be
  fabricated. Only the third version caught the mutation. A guard never shown to fail is not
  a guard.

**Five mutations proved the doc guard can fail**, then were reverted: a `VERIFIED` claim in
the OpenCode guide (1 red), a cell promoted past the matrix in `generic-openai.md` (1 red), a
wrong port in the Hermes YAML (1 red), an invented JSON config block in `antigravity.md`
(1 red), and a non-existent source path in the README (1 red).

Verified: `client-docs` **6/6**, `matrix-integrity` **9/9** with **no cell moved** (tally
still 13/2/0/87/0), `runtime-structure` **1/1** — 16/16 together — `client-conformance`
**55/55**, `api-smoke` **70/70**. `git diff --check` clean, and `git diff --name-only` empty:
Task 3 adds files only.

### Task 4 — OpenCode real-client verification

`scripts/verify-opencode.mjs` (entry + relaunch guard), `scripts/verify-opencode-lib.mjs`
(fixtures), `scripts/verify-opencode-scenarios.mjs` (nine scenarios), and
`docs/transcripts/opencode/` (README + 8 transcripts). **Exit 0**, tally
**16 VERIFIED / 0 PARTIAL / 0 BLOCKED / 1 UNVERIFIED**, confirmed on two consecutive full
runs.

This drives the **real `opencode` binary** (v1.18.23) as a child process: a real config file
in an isolated HOME with every XDG dir redirected, real stdout and stderr, a real BAYZ
listener on a real port, real SQLite with real envelope crypto, real loopback provider
origins, a real HTTP CONNECT proxy requiring Basic auth, and scoped identities created
through the management API. No `fetch` standing in for the client, no `app.inject`.

**The script refuses to self-certify.** An end-of-run pass `existsSync`-checks every
transcript a claimed cell cites, and separately asserts that all 17 capabilities recorded a
verdict — so a scenario that silently failed to run cannot leave a cell quietly absent.

#### Three defects that protocol conformance could not see

None is a protocol violation, which is precisely why 55 generic checks missed all three.
Each is a mismatch between what BAYZ accepted and what a real agent client sends.

1. **`stream_options` refused outright.** OpenCode sends
   `{"include_usage": true}` on every request; the strict allow-list had no entry, so the
   whole body failed `invalid_request (unknown-key)`. The first capture shows
   `origin chat hits: 0` — **no real OpenCode session could reach a provider at all.** Fixed
   as `assertStreamOptions` in `packages/gateway/src/normalize.ts`: validated, not dropped,
   because `include_usage: false` asks BAYZ to suppress usage and it cannot (usage feeds the
   accounting rows), so accepting it would claim a setting took effect that never did.
2. **Streamed `tool_calls` silently dropped.** `packages/router/src/chunk.ts` always parsed
   `toolCallDeltas`, and the non-streaming path always rendered them, but `chunkBody` in
   `apps/server/src/routes/chat.ts` built a `content`-only delta. The client received
   `finish_reason: "tool_calls"` with no calls attached, treated it as an empty turn, and
   re-sent the identical request **18 times** before the run was killed. A client cannot
   recover from this — nothing in the response says a call was lost. Fixed with the OpenAI
   streaming fragment shape: `index` on every fragment, `id`/`type` and `function.name` only
   where the router observed them.
3. **The 1 KiB tool-description cap refused the client's payload.** Measured on the wire:
   `bash` 4,628 chars, `task` 3,019, `todowrite` 2,012. Agent clients put their whole usage
   contract in the description, so 1 KiB was an incompatibility rather than a boundary — it
   had been set against hand-written examples. Raised to 16 KiB per tool; the aggregate 1 MiB
   `MAX_REQUEST_BYTES` check, applied last to the *validated* request, is what actually
   bounds input.

Regression tests pin the measured numbers so a future tightening fails with the client that
would break: +6 in `packages/gateway/test/normalize.test.ts`, +2 in
`packages/router/test/tools.test.ts`, +2 in `apps/server/test/chat-stream.test.ts` — one
reassembling fragments to the exact arguments the provider sent, one asserting a text-only
stream carries **no** `tool_calls` key so a strict client never sees a call that did not happen.

#### What the transcripts show

`configure-authenticate.md` the documented JSON config accepted, a corrupted key refused,
**zero** `GET /v1/models`. `chat-stream.md` `stream:true` by default, SSE rendered, usage in
the final chunk. `tool-roundtrip.md` a streamed call reassembled by `index`, `bash` executed,
`role:"tool"` result answered. `large-request.md` 67,447 bytes served intact.
`cancel.md` SIGINT mid-flight destroyed the upstream socket before the response completed.
`error-surface-and-keys.md` a legible one-line error not a stack trace; rotation kills the old
key; deletion locks the client out. `routing.md` a custom provider, a CONNECT proxy logging
the origin authority, `routingMode:"combo"`, failover after the primary was killed.
`free-only.md` `freeOnly` defaults true, a PAID-classified non-loopback provider refused with
**0 upstream requests**, an explicit opt-out then routes.

#### Decisions worth carrying forward

- **`models.list` stays `UNVERIFIED` by measurement.** OpenCode offers the models in its own
  config `models` map and never calls `GET /v1/models`. `opencode models bayz` prints the
  right model with zero gateway requests, so promoting the cell would have been easy and
  wrong. Practical consequence for users: adding a route in BAYZ does not make it appear in
  OpenCode.
- **A harness bug was found and fixed rather than blamed on BAYZ.** Run 1 reported
  `key revoke/rotate` BLOCKED. The cause was mine: `content-type: application/json` on
  bodyless `DELETE`/`POST` calls, which Fastify correctly refuses `400 invalid_json`, so
  nothing was ever revoked. The scenario was also restructured to rotate the *same* identity
  — deleting and recreating answered `409 identity_already_exists` and returned no key, so
  the rotation half would have tested nothing. Rotation now runs before revocation, because
  revocation is destructive.
- **Free-only needs a non-loopback origin.** `allowLoopback` short-circuits classification to
  LOCAL, and LOCAL is free, so a loopback origin cannot exercise the PAID path at all. The
  scenario uses the host's private IPv4 and skips honestly when there is none.
- **Redaction is by name, not by shape.** Admin token, provider credential, proxy password,
  master key, and every per-scenario client key are replaced by literal, so a credential
  cannot survive because it happened not to look like one. Ports, temp paths, UUIDs,
  timestamps, and latencies are normalised so a re-run reproduces the same bytes. Sections
  over 4,000 chars are truncated **with the real total stated** — the client's own body is
  ~30 KiB of system prompt and tool schemas. A grep for every secret literal and for any
  64-hex run across the transcripts returns nothing.

Verified sequentially, one command per step: `@bayz/server` **338/338**, `@bayz/gateway`
**80/80**, `@bayz/router` **291/291**, `matrix-integrity` **9/9**, `client-docs` **6/6**,
`runtime-structure` **1/1**, `client-conformance` **55/55**, `api-smoke` **70/70**,
`stream-smoke` **63/63**, `security-smoke` **82/82**, `injection-smoke` **179/179**,
`usage-smoke` **119/119**, `proxy-ux-smoke` **127/127**, `@bayz/server` build exit 0.
`git diff --check` clean.

### Task 5 — Antigravity and Hermes verification attempts

`scripts/verify-antigravity.mjs` (client absent, exit 0), `scripts/verify-hermes.mjs` +
`-config` + `-scenarios` + `-part1` + `-part2` + `-run` (**17 VERIFIED, exit 0**),
`docs/transcripts/hermes/` (README + 9 transcripts), and `scripts/verify-client-lib.mjs`
holding the BAYZ-side fixtures both harnesses share.

**Hermes is installed here, so it was verified for real** — nine scenarios against the actual
`hermes` binary (v0.20.5) as a child process. Every scenario uses a throwaway `HERMES_HOME`
**and** `HOME`: this agent is itself Hermes, and redirecting `HERMES_HOME` alone leaves some
paths under the real `$HOME`, so a stray write could destroy the session doing the
verification.

**Antigravity is absent.** `scripts/verify-antigravity.mjs` prints
`UNVERIFIED: antigravity not installed on this host`, writes no transcript, and exits 0 — so
`tests/matrix-integrity.test.mjs` cannot let any of its 17 cells read `VERIFIED`, because
there is nothing on disk to cite. Presence is checked as an **executable file on PATH**, not
`command -v`, because Task 1 caught exactly that error when `command -v continue` "found" the
shell builtin. If a host *does* have the client, the script exits **non-zero** rather than
guessing its configuration form: a harness that invents field names produces a transcript that
looks like evidence and is not.

#### The fourth defect, and it was worse in kind

Task 4's three broke requests before they reached a provider. This one broke the roundtrip
*after* the work was already done. The message allow-list in `packages/router/src/request.ts`
permitted `role`, `content`, `tool_calls`, `tool_call_id` — and Hermes sends
`{role, tool_call_id, name, content}`, where `name` is part of the OpenAI chat contract. BAYZ
delivered the tool call, Hermes executed it, and the result was rejected on the way back with
`invalid_request (message-unknown-key)`.

`name` is now validated and bounded at 64 characters (matching the tool-name bound) and
deliberately **not forwarded**: `tool_call_id` already identifies the call unambiguously, so
echoing a client-supplied string into the provider request would add untrusted data for no
gain. It is validated anyway — "we drop it" is not a reason to skip bounding a value that is
still parsed and held. Three tests pin it, and the allow-list assertion that previously used
`name` to prove the list closed was **retargeted at `metadata` and `function_call`** rather
than deleted, so the list is still proven closed rather than merely widened.

#### Two harness bugs, each costing a full run

- **`api_key: ${VAR}` in `config.yaml` is load-bearing.** The first probe wrote the key only
  into `.env`; Hermes answered `HTTP 401: A valid API token is required` with **zero** requests
  reaching BAYZ. The YAML must reference the variable, which is what the live file does.
- **`-t` takes toolset names, not tool names.** `-t execute_code` made Hermes exit 2 before
  sending anything, which would have recorded both tool cells `BLOCKED` against BAYZ for a
  mistake in the harness. `terminal` is a real toolset, read from
  `/usr/local/lib/hermes-agent/toolsets.py`.

Both are recorded in the harness comments, because the next person to touch it will otherwise
make the same two mistakes.

#### Where the two verified rows disagree, on measured grounds

`hermes/models.list` is `VERIFIED` (10 `GET /v1/models` calls in one one-shot run, all 200)
where `opencode/models.list` is `UNVERIFIED` (the client reads its own config map and never
touches the endpoint). Neither is a defect. Two verified rows differing because the clients
genuinely differ is the matrix working as intended.

Also worth carrying: Hermes reports transport failures as `HTTP <status>: <message>` on stdout
and **exits 0**, so exit code alone cannot distinguish success from refusal for this client.
Every authentication and key assertion therefore checks for the *absence of the completion*
plus the error text, not the exit status.

Verified sequentially, one command per step: `@bayz/router` **294/294**, `@bayz/server`
**338/338**, `@bayz/capability` **72/72**, `matrix-integrity` **9/9**, `client-docs` **6/6**,
`runtime-structure` **1/1**, `client-conformance` **55/55**, `injection-smoke` **179/179**,
`verify-hermes` **17 VERIFIED exit 0**, `verify-antigravity` **exit 0**. Secret scan across
`docs/transcripts/hermes/` returns nothing. `git diff --check` clean.

### Task 6 — Release-blocking gate wiring

`scripts/client-gate.mjs` (entry), `scripts/client-gate-lib.mjs` (policy, parsing,
assessment), `scripts/client-gate-run.mjs` (reporting), guarded by
`tests/client-gate.test.mjs` (**11 tests**).

`--report` exits 0 and prints the Core 3 tally plus every blocking cell. `--enforce` exits
non-zero when anything blocks. No flag, both flags, or a misspelled flag exits **2** — a CI
step with a typo must not be read as "release permitted".

**`--enforce` exits 1 today, with 18 blocking cells**: 17 for the absent `antigravity` and one
for `opencode/models.list`. That is the gate working. `tests/client-gate.test.mjs` asserts the
non-zero exit as a *requirement*, not as a known failure to be fixed later.

#### Policy decisions, each with a reason

- **All seventeen capabilities are mandatory.** The plan says "mandatory column" without
  narrowing the list, and §25 made `free-only routing` explicitly not optional. Inventing a
  subset would be a quiet decision that some capability does not matter; `N/A` is how a client
  says it has no such surface.
- **`BLOCKED` and `UNVERIFIED` both block.** The plan's word is `FAIL`; this vocabulary has no
  `FAIL`, and the equivalent is `BLOCKED`. `UNVERIFIED` blocks too, because "we never tried" is
  not a smaller release risk than "we tried and it broke" — it is an unknown. That is the split
  Task 1 refused to collapse, honoured here.
- **`PARTIAL` and `N/A` pass.** A `PARTIAL` cell carries evidence *and* a limitation that
  `tests/matrix-integrity.test.mjs` forces it to name, so it is a documented bound rather than
  an unknown.
- **A `MISSING` cell or an absent Core 3 row blocks.** Deleting a line is the easiest way to
  make a claim disappear, so silence is a blocker in its own right.
- **The gate re-derives nothing.** It reads what the matrix says; the matrix's own integrity is
  `tests/matrix-integrity.test.mjs`'s job. Two tools, one question each — and Mutation E below
  shows them covering each other.

#### The test suite is written against synthetic matrices

Driving only the real document would let a gate **hardcoded to fail** pass every check, because
today's state is blocked. So `assess()` is exercised directly: a fully `VERIFIED` matrix
permits release; a single blocking cell at the first, middle, and last capability of *each*
Core 3 client blocks; a missing cell blocks; a missing row blocks; and `generic-openai` can
neither block (it is not Core 3) nor rescue a Core 3 failure.

**Five mutations, each red, each reverted:** dropping `UNVERIFIED` from the blocking set
(**4 red**), adding `PARTIAL` to it (**1 red**), ignoring a missing cell (**1 red**), checking
only the first Core 3 client (**5 red**), and promoting `antigravity/configure` to `VERIFIED`
citing a transcript that does not exist — invisible to the gate, caught by
`matrix-integrity` by name.

#### One structural constraint worth knowing

The entry script cannot both export the policy and `await import` the runner that consumes it:
that is a circular top-level await, and Node exits **13** with "unsettled top-level await"
rather than failing visibly. The first version did exactly that and produced three blank lines
and exit 13. Hence three files.

Verified: `client-gate` **11/11**, `matrix-integrity` **9/9**, `client-docs` **6/6**,
`runtime-structure` **1/1** (27/27 together), `--report` exit 0, `--enforce` exit 1,
`git diff --check` clean.

### 9H resume point

**Phase 9H is COMPLETE.** All six tasks are done and the plan's completion checklist is green.
Final matrix: **46 VERIFIED / 2 PARTIAL / 0 BLOCKED / 54 UNVERIFIED** across 102 cells, 48
citations resolving on disk.

The release gate blocks (`--enforce` exits 1), which is correct: `antigravity` cannot be run on
this host. On a machine that has it, `node scripts/verify-antigravity.mjs` will exit non-zero
until someone reads the client's real configuration file and implements
`configureAntigravity()` from it — deliberately, so nobody produces a transcript from a guessed
config shape.

Next: **Phase 9I**, in progress. Nothing in 9H is left open.

## Phase 9I Fuzz / Chaos / Load / Soak — as built so far

Seven tasks. **Task 1 COMPLETE; Tasks 2–7 not started.**

### Task 1 — Deterministic fuzz harness

`scripts/fuzz/harness.mjs` with `tests/fuzz-harness.test.mjs` (**18 tests**). Zero
dependencies, per the phase lock: `node:crypto` is used to expand the seed once, never for a
per-draw value.

`createRng(seed)` is xoshiro128\*\* over a SHA-256 seed expansion and exposes `nextUint32`,
`next`, `int`, `bool`, `bytes`, `pick`, `fork`. `fuzz({name, seed, iterations, generate, run})`
returns `{name, seed, iterations, completed, truncated, durationMs, failures}`.

**Reproducibility across *processes* is the load-bearing property**, not reproducibility within
one. A crash at iteration 3,812 of 5,000 is worthless if the input cannot be regenerated
tomorrow from the seed alone, so the test spawns a child process and compares 24 draws
byte-for-byte. That rules out `Math.random()`, the clock, the pid, and `randomBytes` at draw
time.

**Seed type is part of the hash.** `createRng(1)` and `createRng("1")` are different streams;
`String(seed)` would collapse them and let a numeric seed recorded in a transcript replay as a
different sequence.

`iterations` is what was *requested* and `completed` is what actually ran. Reporting the
requested count as though it had run is the specific dishonesty that shape prevents, and
`truncated` says so out loud when the time budget stops a run early.

**A slow iteration is a failure, not a performance note** — unbounded time on a hostile input is
a denial of service — so the per-iteration budget (250 ms default, Task 3's contract) records
the input exactly like a thrown error does.

#### Defect found and fixed inside the task

Adding `unhandledRejection`/`uncaughtException` listeners is **not** enough. Node's default for
an escaped rejection is to kill the process, and `node --test` installs its own handler that
fails the enclosing test; both fired alongside the harness, so a floating rejection from a
fuzzed boundary was reported as a harness failure rather than the boundary defect it is. The
harness now removes and restores the prior listeners around a run. Restoration is not
housekeeping: leaving the process without its original handlers would silently disarm crash
reporting for everything that runs after a fuzz target.

#### The credential scan is wider than the plan's line

It reaches object **keys** as well as values (a key is just as committed as a value once a
failing input is saved), and it also scans **what a target reports** — Task 3 writes failing
inputs *and* error text to `scripts/fuzz/corpus/regression/`, so a boundary echoing a provider
key inside an error message would otherwise put that key in git history.

Equally deliberate is what it does *not* refuse: a counter-test pins that 63- and 65-hex
strings, bare `sk`, `Bearer` alone, `__proto__`, `'; DROP TABLE identities; --`, NUL bytes and
lone surrogates all pass. A scan eager enough to block the corpus this phase needs would get
switched off, which is worse than no scan.

#### Mutation proof

Six mutations, each reverted and confirmed byte-identical with `diff -q`: stopping at the first
failure (**2 red**), mixing `Date.now()` into rng state (**3 red**), reporting `iterations` as
`completed` (**1 red**), skipping object keys in the scan (**1 red**), raising the 1 MiB input
cap (**1 red**), and disabling the per-iteration budget timer.

**The last one initially passed — a real gap in my own test.** The budget test used a
*slow but finishing* iteration, which the post-hoc elapsed check catches without the timer. A
boundary that hangs **forever** is the actual DoS case and only the timer race catches it. A
never-settling-promise test was added; the same mutation then took 60 s and failed, and the
suite went 17 → 18.

Verified: `fuzz-harness` **18/18**, the four pre-existing root suites still **27/27**,
`git diff --check` clean.

### Task 2 — Input-shape generators and the corpus

`scripts/fuzz/generators.mjs` with `tests/fuzz-generators.test.mjs` (**21 tests**). Ten
generators: `generateJsonValue`, `generateUtf8String`, `generateInvalidUtf8Bytes`,
`generateHeaderPair`, `generateUrl`, `generateIdentifier`, `generateSseStream`,
`generateSocks5Handshake`, `generateConnectHandshake`, `generateSqliteHostileString`. A CONNECT
tunnel and a SOCKS5 greeting share no bytes, so they are two generators rather than one with a
branch. All ten are also exposed through a frozen `GENERATORS` registry with a `family` label,
so Task 3 can enumerate rather than hardcode a list that would drift.

**Every generator is pure given an rng**, and the test proves it by drawing 200 values from two
independently seeded rngs and comparing. That property is what makes a Task 3 crash replayable
from its seed alone.

Corpus: **93 files, 111,914 bytes** — 5.3% of the 2 MiB budget, largest file 64,008 bytes.
Written by the committed `scripts/fuzz/write-corpus.mjs`, which refuses to emit a file over
64 KiB or a total over 2 MiB, so the bounds are enforced at write time as well as at test time.
Every case is a minimised hand-written input tied to a documented rule.
`scripts/fuzz/corpus/regression/` exists with a README for Task 3's discoveries.

The corpus credential scan calls Task 1's exported `findCredentialShape`. Not a copy — two
scanners that can drift apart is how a secret gets committed.

#### Three assertions the plan does not list, each closing a way to test nothing

A generator returning a constant would pass a purity check while fuzzing nothing, so every
generator must additionally **vary with the seed** and produce more than one shape across 200
draws. The invalid-UTF-8 generator is decoded with `TextDecoder("utf-8", { fatal: true })` and
at least 80% of its output must genuinely fail to decode. And no generator may exceed the 1 MiB
harness cap, since one that did would abort a Task 3 run with `input_too_large` instead of
fuzzing.

#### Coverage is wider than the plan's three loopback encodings

The plan names `2130706433`, `0177.0.0.1`, `0x7f.0.0.1`. Also carried: `127.1`, `0x7f000001`,
`[::ffff:127.0.0.1]`, `127.0.0.1.nip.io`, `169.254.169.254`, `metadata.google.internal`,
`[fe80::1]`, `[fd00::1]`, `10.`/`172.16.`/`192.168.` and `100.64.0.1`. 9F's egress protection
covers link-local, cloud metadata and CGNAT as well as loopback, and a corpus probing only
loopback would leave most of that boundary unexercised.

#### Guaranteed rather than hoped-for coverage

`generateUtf8String` appends a combining mark, a bidi override and an astral character on coin
flips instead of trusting the random walk to reach all three; `generateSseStream` likewise
trails a UTF-8 lead byte so the split-mid-sequence shape appears often. Without that, coverage
of a required shape would depend on the draw count, and lowering iterations later would quietly
stop testing it.

#### Mutation proof

Five mutations, each red, each reverted byte-identical: dropping `__proto__` from the pollution
keys (**1 red**), shrinking the 10,000-element array to 100 (**1 red**), removing the octal and
hex loopback encodings (**1 red**), making the invalid-UTF-8 generator return valid bytes
(**1 red**), and giving a generator module-level state so it drifts every 7th call (**1 red**,
the purity test). A sixth check ran the other way: planting `Bearer abcdefghijklmnop` in a
corpus file turned the scan red, confirming it reads committed bytes rather than trusting the
writer.

Verified: `fuzz-generators` **21/21**, with Task 1 **39/39**, `git diff --check` clean.

### Task 3 — Boundary fuzz targets

Thirteen targets under `scripts/fuzz/targets/` plus `scripts/fuzz-run.mjs`, 5,000 iterations
each at pinned seeds, **39/39 checks**, three consecutive clean runs. `scripts/fuzz/targets/shared.mjs`
carries the contract: `expectBayzError` (engine error named separately from a stray custom
error — different diagnosis, different report line) and `globalStateSnapshot` /
`assertGlobalStateUnchanged`, which watch `Object.prototype` because a target that fuzzes
prototype-pollution shapes and never checks it would miss the exact defect it aims at.

Real boundaries throughout: `authorization` uses real `openSecretStorage` with real envelope
crypto and a real identity manager; `socks5` drives real TCP against a real listener;
`migration` runs real SQLite DDL in real transactions; `storage-envelope` uses real AES-GCM.

Measured RSS growth per target on this device: `sse` 41.5 MiB, `socks5` 22.3, `tool-args` 18.7,
`authorization` 10.8, `api-schema` 5.4, everything else under 1 MiB. Slowest target `socks5` at
143 s (socket-bound), then `migration` 10 s, `authorization` 6 s; the rest 1–3 s each.

#### The host finding that governs every timing in this phase

`socks5` reported iterations at 8.5 s and 72 s against the 250 ms budget. Before calling that a
hang I wrote `scripts/fuzz/host-baseline.mjs` — a bare `connect` + `setTimeout(60)` + `destroy`
loop with **no BAYZ code in it**. It reproduced the same shape: p50 63 ms with individual
iterations at 8.2 s, 88 s and 184 s, while load average was 0.12, four descriptors were open, and
3,905 MiB of swap was in use. Diagnosis **D — Termux/proot host stall**, not a BAYZ defect, and
intermittent (a later run showed max 68 ms). `timer.unref()` was ruled out separately: ref'd and
unref'd 60 ms timers both delivered 60–63 ms.

Consequence: a wall-clock budget is a valid DoS signal for CPU-bound boundaries and **not** for
socket-bound ones here. `socks5` asserts BAYZ's own deadline fired — the returned
`ProxyError("timeout")` — and carries a widened budget citing that file. Tasks 5 and 6 must read
their own latency numbers the same way.

#### `sse` RSS: 147 MiB over a 64 MiB bound, and the bound stayed

Growth *decelerated* across 1,250 → 10,000 iterations (67.6, 34.6, 50.1, 5.8 MiB, plateauing near
220 MiB) with heap growth 0.4/−1.1/0.0/0.0 MiB and `arrayBuffers` growth 0.0 MiB throughout;
first half +65.1 MiB against second half +40.9 MiB — the opposite of a leak's signature.
Isolated: building a 64 KiB buffer and discarding it costs 6.5 MiB over 600 iterations, pushing
it through a real `SseLineReader` costs 65.1 MiB, and a shared `TextDecoder`, a fresh one, and
`Buffer.toString("utf8")` each cost ~0 MiB. Allocator retention of large short-lived strings.

Raising the bound would blind the target to a future real leak, which is the only thing the bound
is for. Instead the two expensive shapes stopped being re-proved hundreds of times — `overflow`
had been drawn 481 times and `long-line` 612 — since a byte cap is proved at, below and above the
boundary. Both now run on a deterministic sparse schedule (ten each per 5,000) and growth
measures 41.5 MiB with the bound intact.

#### A mutation that passed twice

Replacing `parseChatRequest`'s `isPlainObject` check and unknown-key loop with a bare
`typeof === "object"` test left `api-schema` green through two rounds of added assertions. The
reason is worth keeping: the parser builds a fresh `ChatRequest` copying only known fields, so an
undocumented key that slips past validation is simply *absent* from the output and invisible to
any output-shape check.

The target now carries `mustReject(body)`, which reads the **input** and decides independently
whether acceptance is permitted. Its key sets are mirrored deliberately rather than imported —
importing `ALLOWED_KEYS` would make the assertion agree with any regression by construction, and
the friction of updating both in one commit is the point. The same mutation then failed at
iteration 31 on `{"prototype":1}` and was reverted byte-identical.

#### Findings that were mine, not BAYZ's

Six, each fixed in the target rather than reported as a product defect: `deriveProfile` takes
`grantedScopes` as a `ReadonlySet` (400/400 false failures); `assertModelPattern` reports
`invalid_route_config`, not `invalid_model` (62 false failures); SOCKS5 reply codes 0x07/0x08
legitimately map to `unsupported_operation`; `IdentityManager` exposes `createIdentity`, not
`create`; a generator reached into `choices[0]` *after* replacing `choices`, throwing inside
`generate` and aborting the run; and `generateJsonValue` recursed without a depth guard, producing
a 1,072,923-byte input at iteration 155 (fixed, and the Task 2 cap test's draw count went
120 → 4,000 so it would now catch it).

The `migration` target's first finding was the same category: it reported a half-applied schema at
iteration 48, but nothing in BAYZ calls `runMigrations` on an unverified database —
`openDatabase` calls `verifyRecordedSchemaVersion` first, which refuses that exact state with
`storage_unavailable/verify-user-version`. The target now models the real open sequence, which
turns the finding into proof the guard is load-bearing.

#### Two constraints that collided, resolved without weakening either

The plan wants a 3 MiB SSE stream; the harness caps a generated input at 1 MiB so a runaway
generator cannot exhaust memory. Both are right, so `generate` emits a descriptor and `run`
materialises the bytes — the boundary sees a genuine 3 MiB stream while the recorded input stays a
few hundred bytes. The same shape solved `authorization`, where putting real 64-hex keys in
generated inputs made the harness refuse the run at iteration 2 with `credential_shape`: correct
behaviour, since failing inputs are committed, so the key is now materialised only inside `run`.

On-disk migration cost was measured rather than assumed: 60–213 ms per file-backed open against
~2.5 ms in memory, essentially all fsync, which produced budget failures at iterations 0 and 250.
Rather than raising the budget (blinding the target) or dropping the case (leaving WAL unproven),
the on-disk path runs as a bounded timed pre-check at `user_version` 0, 3, 11, 12 and 255 with its
cost printed in the run output.

Verified: `fuzz-run` **39/39** ×3, `fuzz-harness` 18/18, `fuzz-generators` 21/21, root suites
27/27, `@bayz/router` 294/294, `@bayz/storage` 246/246, `@bayz/providers` 286/286,
`@bayz/proxy` 121/121, `@bayz/identity` 69/69, `@bayz/telemetry` 55/55, `@bayz/gateway` 80/80,
`@bayz/server` 338/338, `git diff --check` clean.

### Task 4 — Chaos scenarios

`scripts/chaos-smoke.mjs` (77, runner) + `chaos-lib.mjs` (426, fixtures) + `chaos-part1.mjs`
(scenarios 1–5) + `chaos-part2.mjs` (6–8) + `chaos-part3.mjs` (9–11), with
`tests/chaos-suite.test.mjs` (**9/9**) guarding the harness itself. **83/83 checks,
`chaos: PASS`**, two consecutive clean runs. `PRAGMA integrity_check` clean after all ten
storage-owning scenarios.

Real components throughout: a real Fastify listener on a real port, real loopback origins, a real
HTTP CONNECT proxy that can fail at chosen points, real SQLite with real envelope crypto, a real
process restart on the same port. No `app.inject`, no stubbed transport.

Numbered ranges, citable as `smoke:chaos#N` (append-only):

| # | scenario |
|---|---|
| 1–5 | provider dies mid-request |
| 6–10 | provider dies mid-**stream** after the first byte |
| 11–15 | provider malformed responses |
| 16–22 | RST at pre-request, post-headers, mid-body, mid-SSE |
| 23–30 | upstream total vs idle timeout |
| 31–44 | proxy dies mid-handshake and mid-tunnel |
| 45–53 | DNS failure and DNS rebinding |
| 54–63 | credential and identity revocation mid-operation |
| 64–73 | BAYZ restarted mid-stream |
| 74–82 | SQLite reopen under a held WAL, read-only injection |
| 83 | disk exhaustion |

**Four mutations, each reverted byte-identical.** Allowing the post-first-chunk path in
`router.ts` to `continue` the failover loop turned #7/#8/#10 red — that is the 9B
no-failover-after-first-byte guarantee under test. Disabling the resolved-address egress re-check
turned #49/#50 red. Two revocation mutations were needed for #61/#62: disabling `isUsable`'s
`revoked` check alone left them **green**, because `manager.revoke` also erases the stored key, so
`verifyKey` has nothing to compare — revocation is genuinely double-guarded (auditable flag +
cryptographic erasure), and only disabling both turns the checks red.

**Three of my own assertions were wrong, and the code was right.** Recorded because each would
have shipped a false green:

1. `requestTimeoutMs` passed at the top level of a route returns **201** and is silently the
   60 s default — it belongs inside `config`. Both timeout paths were taking 60 s while the
   checks passed, testing nothing. Now the total path returns at ~1,040 ms with a 1 s deadline.
2. I asserted the idle timer should outlast the request deadline on a stalled stream. Measured:
   both at ~1,040 ms. `transport.ts:483` arms the total timer once for the whole stream while
   `bumpIdle()` at :466 re-arms a separate 60 s timer per chunk, so with a 1 s total the total
   correctly wins. The two mechanisms are distinguished by **stage code**
   (`stream-total-timeout` vs `stream-idle-timeout`), not by wall-clock ordering.
3. One check demanded the provider credential never reach a socket across *all* proxy failures,
   including mid-tunnel. A granted tunnel carrying the credential is the tunnel working. Split:
   four handshake-failure modes assert zero credential bytes; the mid-tunnel case asserts the
   opposite — the request *did* traverse the tunnel and did not go direct.

**Two plan expectations corrected against measurement.** `credential_missing` after
`DELETE …/credential` does not occur: `router.ts:234` branches on `provider.credentialPresent`, so
with no stored credential the request goes out **unauthenticated** (200 against an origin that
accepts anything) rather than raising. `credential_missing` fires at `manager.ts:322` when a
credential is *expected* but unreadable — a corrupt envelope or rotated KEK. The asserted property
is the one that matters: the deleted secret is never sent again, proven by the origin observing no
`Authorization` header. Whether a credential-free upstream request should be refused outright is a
product decision, recorded as a note rather than invented as a defect.

**Two scenarios UNVERIFIED on this host, with reasons, per the plan's rule:**

- Read-only-database injection: `chmod 0444` does not prevent writes for this process (root under
  Termux/proot; `paths.ts:56` documents that Android and FAT-derived mounts may not honour POSIX
  modes). The `storage_unavailable` path is covered by `@bayz/storage` unit tests.
- Disk exhaustion: `mount -t tmpfs` exits **0** under proot while mounting nothing, leaving the
  mount point inaccessible. An earlier version of this scenario **passed for the wrong reason** —
  `startBayz` threw `storage_unavailable` from a directory that had ceased to exist, not from a
  full disk. The mount is now probed (write, read back, confirm `ENOSPC` past the size limit)
  before it is trusted, and `tests/chaos-suite.test.mjs` pins that probe so the regression cannot
  return. Filling the real filesystem is refused deliberately: `/tmp` is shared Android device
  storage with 211 GiB free.

One harness accommodation, narrow and explained in-file: restarting on the **same port** makes
undici hand out a pooled socket belonging to the dead process (`UND_ERR_SOCKET`). A single retry on
socket-level errors only — which is what "reconnect" means for a real client — with any other
error and any reached-the-server status passing straight through.

Verified: `chaos-smoke` 83/83 ×2, `chaos-suite` 9/9, `fuzz-run` 39/39, `fuzz-harness` 18/18,
`fuzz-generators` 21/21, `git diff --check` clean.

### Task 5 — Load measurement

`scripts/load-smoke.mjs` (runner) + `load-lib.mjs` (fixtures, origin, driver, transcript) +
`load-cap.mjs` (cap proofs), with `tests/load-harness.test.mjs` (**11/11**) guarding the harness.
**64/64 checks, `load: PASS`**, three consecutive full runs. Evidence:
`docs/transcripts/load/load.md`.

Real listener, real `fetch`, real loopback origins, real SQLite. 3,288 requests per run across both
series. **Zero failures at every level, both streaming and not.**

Non-streaming (run 3, the committed transcript is run 3's):

| c | requested | ok | p50 | p95 | p99 | max | req/s |
|---|---|---|---|---|---|---|---|
| 1 | 100 | 100 | 26.5 | 38.7 | 43.9 | 45.5 | 36.8 |
| 8 | 200 | 200 | 188.5 | 231.6 | 339.0 | 372.7 | 42.1 |
| 32 | 320 | 320 | 702.9 | 1319.1 | 2773.0 | 3330.0 | 43.0 |
| 128 | 512 | 512 | ~1234 | ~11474 | ~11945 | ~12058 | 41.2 |
| 256 | 512 | 512 | ~3025 | ~10497 | ~11014 | ~11128 | 43.0 |

Streaming reports TTFB separately, and at these levels TTFB ≈ total because the origin's first
frame is its whole answer: c=1 25.0 ms, c=8 192.2 ms, c=32 765.5 ms, c=128 3,082.5 ms,
c=256 4,455.4 ms (p50). Throughput stays ~40 req/s across every level — the device saturates, and
latency grows linearly with concurrency rather than anything collapsing.

Resource observation after 3,288 requests: RSS 353.2 MiB, heap 29.5/206.2 MiB, external 6.4 MiB,
40 open fds, host free 2,650 MiB, load average 0.12. **No latency threshold is asserted** — the plan
forbids it, and `scripts/fuzz/host-baseline.mjs` measured 184 s stalls on an idle loop containing no
BAYZ code, which is why no figure here is a gate. The absence of a threshold is itself pinned by a
test that greps for one.

**Two concurrency mechanisms, proved separately because they behave differently.** Conflating them
would misdescribe the system:

- **Outbound** (`packages/router/src/concurrency.ts`, default 32, queue 256) **queues** past the
  limit, then refuses `rate_limited/concurrency-queue-full`. Proved at the semaphore for exactness
  (limit 4, queue 2 → the 7th caller is refused) *and* against real work observed **at the origin**:
  32 clients issuing 64 requests, and the origin — a real HTTP server counting its own concurrent
  connections — never saw more than 4. That is what "waits rather than opening a socket" means,
  measured where the socket would be opened.
- **Inbound** (`apps/server/src/auth.ts:190`) has **no queue at all**: it refuses `429 rate_limited`
  with `retry-after` the instant `inFlight >= concurrency`. 16 simultaneous requests against a gate
  of 4 → 5 served, 11 refused, every refusal carrying `retry-after`, and the gate releases its slots
  afterwards.

**Three mutations, each reverted byte-identical.** Removing the queue-full rejection → `FAIL 35`
(the 7th acquire never settles) plus `FAIL 37`. Making `release` non-idempotent → `FAIL 36`/`FAIL 37`
with `inFlight` drifting to −1, the "looks fine while the cap stops capping" failure the
implementation comment warns about. Skipping the semaphore on the non-streaming transport path →
`FAIL 38`, origin saw 6 concurrent against a limit of 4.

**Three faults of mine, fixed:**

1. `startBayz({ concurrency: 32 })` — **that option does not exist**
   (`verify-client-lib.mjs:314` takes `{ dataDir, port, adminToken, kekHex }`). Silently ignored, so
   the series measured an ungated listener while the code claimed a cap. Now ungated deliberately and
   for a stated reason: the inbound gate *refuses* rather than queues, so a c=128 series behind it
   would measure rejection, not latency.
2. Telemetry counted through `/api/usage/requests`, which caps `limit` at 200
   (`routes/usage.ts:24`). At 512 requests it returned `undefined` and the check asserted
   `rowCount >= 0` — true of every number. Now counted in SQL: 1,644 `usage_requests` rows =
   1,644 completed requests, per series, with `usage_attempts >= usage_requests`.
3. A harness test whose slice anchor (`"] : ["`) never matched, so it validated an empty string and
   would have passed for any concurrency levels at all.

The queue-full check is raced against a 200 ms timer rather than awaited, because the unbounded-queue
mutation made a bare `await` hang the process — Node exited 13 with "unsettled top-level await",
which is red but reports that the *harness* broke rather than naming the missing bound.

Verified: `load-smoke` 64/64 ×3, `load-harness` 11/11, `chaos-smoke` 83/83, `fuzz-run` 39/39,
`git diff --check` clean.

### Task 6 — Soak measurement

`scripts/soak-smoke.mjs` + `soak-lib.mjs` + `soak-traffic.mjs`, with `tests/soak-harness.test.mjs`
(**13/13**). **14/14 checks, `soak: PASS`**, two clean 600 s runs after the measurement fix below.
Evidence: `docs/transcripts/soak/soak.md`.

600 s, sampled every 15 s (41 samples), mixed traffic: 5,206 non-streaming chat, 2,603 streaming,
2,603 two-leg tool roundtrips, 2,603 model listings, 2,603 usage reads, 520 management writes —
**18,741 requests, 0 failures**. All thirteen metrics the plan lists are in the series table.

Results: heap second-half slope **+2.1 KiB/sample** (run 3) and **+8.4** (run 4) against a 256 KiB
tolerance; RSS +0.084 and +0.086 MiB/sample against 1 MiB; handles 6 → 5, timers 1 → 0, fds 28 → 30
after a quiet period; WAL peak 3.97 MiB against a 16 MiB ceiling; **200 telemetry rows retained from
18,741 requests**; `PRAGMA integrity_check` ok.

**The finding worth carrying forward: raw `heapUsed` is unusable as a leak signal here.** Two
identical 600 s runs gave second-half slopes of **−338** and **+295 KiB/sample** — same code,
opposite verdicts, one either side of the tolerance — because `heapUsed` is a sawtooth swinging
between 29.7 and 137.7 MiB and a fixed cadence samples whichever tooth it lands on. The fix was not a
wider tolerance, which would have kept the noise and blinded the check, but to measure the
**post-collection floor**: a double `globalThis.gc()` before each sample, so what is recorded is
retention rather than allocation rate. Heap then reads a flat 24 MiB throughout. `--expose-gc` is
consequently load-bearing, and a run without it records the trend **UNVERIFIED with the series**
rather than asserting on a number known to be unstable.

Two related refusals, both recorded rather than papered over: a run whose second half holds fewer
than six samples reports the trend UNVERIFIED (at `--duration=45` two points made a "slope" of
1,144 KiB/sample out of ordinary warm-up), and `--duration` below 30 s is **refused with exit 2**
rather than clamped — a soak that can be set to one second is a soak that can be passed by not
running.

Telemetry retention is set to **200 rows** through the documented `BAYZ_USAGE_RETENTION`, not to make
the test easier but to make it real: the 5,000-row default is never reached in ten minutes, so the
pruning assertion would have passed without the pruning code ever executing. A separate check proves
the run crossed the bound.

**Two mutations, reverted byte-identical.** Disabling `prune("usage_requests", …)` → `#11` red with
2,960 rows against a bound of 200. Leaking one `setInterval` per request in the chat route → `#6`/`#7`
red with 2,665 handles and 2,660 timers against a baseline of 6 and 1 — the leak detector detecting a
planted leak.

`--long` (7200 s) is implemented and documented but **UNVERIFIED on this host**: a two-hour
unattended run cannot be supervised here, and documented host stalls up to 184 s would make the
result unreadable.

### Task 7 — Resilience report and gate wiring

`docs/superpowers/2026-08-27-bayz-resilience-report.md` (**71 rows: 68 PASS, 0 FAIL, 3 UNVERIFIED,
0 N/A**) plus `scripts/resilience-gate.mjs` + `-lib.mjs` + `-run.mjs`, with
`tests/resilience-report.test.mjs` (**24/24**). RED confirmed first: 7 failures before the report
existed.

Report sections: fuzz (17 rows), chaos (15), load (18), soak (12), mutation proofs (9). Every `PASS`
carries an evidence reference; every cited `test:`/`transcript:` path resolves on disk.

**Gate exit contract** — deliberately the same shape as 9H's client gate so an operator learns one
convention: `--report` → 0 · `--enforce` → 1 on any `FAIL`, any fuzz/chaos `UNVERIFIED`, or a
malformed/missing/empty/device-less report · no flag, both flags, or an unknown flag → **2**.

**The explicit policy decision the plan required:** fuzz and chaos `UNVERIFIED` **blocks**; load and
soak `UNVERIFIED` **does not**. Fuzz and chaos are correctness and failure-handling properties where
"not checked" is indistinguishable from "broken"; load and soak are capacity measurements whose
feasibility depends on the host, and a gate that refused every release from this device would be
routed around within a week. Non-blocking `UNVERIFIED` rows are **printed explicitly** under
`--enforce` so they cannot quietly disappear.

Current state: `--report` exit 0; `--enforce` **exit 1**, blocked by the two chaos rows needing mount
privileges. Correct behaviour, the same shape as 9H's gate blocking on absent `antigravity`.

Two report-integrity rules were tightened by their own tests failing first. A comma-list evidence
reference (`smoke:load#4,9,14,19,24`) is **rejected** — a row citing five scattered check numbers
cannot be confirmed or refuted by looking up any one of them — while a contiguous range
(`smoke:chaos#31-44`) is accepted. And "capacity figure" is a *measured* quantity (a unit, a
percentile, a thousands-separated count), not any digit: the first version flagged `limit 4, queue 2`,
which is configuration verifiable by reading the code, not a measurement needing provenance.

The gate is tested against **synthetic reports** in a temp directory, not only today's file — a gate
checked only against the current report would pass even if hardcoded to succeed, the same trap 9H
Task 6 avoided.

### Phase 9I verification totals

Sequential, one command at a time (`runtime:test` fans out `--workspaces` and exhausts the futex
table on this host, so it was run as eleven separate workspace commands):

- `@bayz/contracts` 3/3 · `@bayz/security` 6/6 · `@bayz/storage` 246/246 · `@bayz/telemetry` 55/55
- `@bayz/identity` 69/69 · `@bayz/capability` 72/72 · `@bayz/providers` 286/286 · `@bayz/proxy` 121/121
- `@bayz/gateway` 80/80 · `@bayz/router` 294/294 · `@bayz/server` 338/338
- root `tests/*.test.mjs` **123/123** (12 files)
- `fuzz-run` 39/39 · `chaos-smoke` 83/83 · `load-smoke` 64/64 · `soak-smoke` 14/14
- `api-smoke` PASS · `stream-smoke` PASS · `security-smoke` PASS · `injection-smoke` PASS ·
  `usage-smoke` PASS · `proxy-ux-smoke` PASS · `client-conformance` PASS
- `npm run runtime:build` **exit 0** · `client-gate --report` 0 / `--enforce` 1 (expected) ·
  `resilience-gate --report` 0 / `--enforce` 1 (expected) · `git diff --check` clean

### 9I resume point

**Phase 9I is COMPLETE. Next: Phase 9J — COMPLETE as of this session; see the 9J section below.**

Carry forward into 9J:

- **Host timing is not evidence.** `scripts/fuzz/host-baseline.mjs` measures a bare
  connect/timeout/destroy loop with no BAYZ code in it and has recorded individual iterations at
  8.2 s, 88 s and 184 s at load average 0.12 with GBs free. Assert on BAYZ's own error codes and
  observable state, never the clock.
- **Product load is allowed; build fan-out is not.** `npm run runtime:test` exhausts the futex table
  here. Run one workspace test command at a time; `runtime:build` alone is fine (~3 min).
- **Long runs go to the background with a log.** `fuzz-run` ~3 min, `chaos-smoke` ~2 min,
  `load-smoke` ~4 min, `soak-smoke` 10 min — all exceed or approach the 600 s foreground cap.
- **`--expose-gc` matters for any memory claim** (see Task 6). Raw `heapUsed` flips a leak verdict
  between identical runs.
- **Two host limitations are permanent here**, both recorded UNVERIFIED with reasons rather than
  skipped: `chmod 0444` does not stop writes for root under proot, and `mount -t tmpfs` exits 0 while
  mounting nothing. Any future scenario needing either must probe for effect before trusting it.

## Phase 9J Cross-platform / Packaging / Upgrade — as built

Eight tasks. **Phase 9J is COMPLETE — all eight tasks committed.** Six commits, nothing pushed
(there is no remote configured; `git remote -v` is empty).

```text
efac3b4  feat: single-source the Bayz data directory with portable permissions   (Task 3)
44f2ca8  feat: add the Bayz release packaging script                             (Task 4)
fa4e28d  test: add the Bayz install and first-boot smoke                         (Task 5)
ad7a839  test: prove the Bayz upgrade ladder from every prior schema             (Task 6)
1c6f02f  ci: add the Bayz platform matrix workflow, unpushed                     (Task 7)
b9453d0  test: add the Bayz platform gate                                        (Task 8)
```

Tasks 1–2 were committed earlier (`6a6174d`, `54acf84`).

### Task 1 — Platform matrix document

`docs/superpowers/2026-08-27-bayz-platform-matrix.md` with `tests/platform-matrix.test.mjs`
(**10/10**). Seven rows (Linux x64/ARM64, Termux/Android ARM64, Windows x64/ARM64, macOS
x64/ARM64) × eleven columns (install, first boot, schema create, chat, stream, proxy, dashboard
serve, restart, upgrade from v1, data dir permissions, uninstall). Every cell starts `UNVERIFIED`.

The parser is table-driven off the document's own header row, so a column inserted without
updating the test shows up as a mismatch rather than silently shifting every value one place left.

Two tests carry the phase's real constraint. `a PASS on a platform with no transcript for that
platform fails` requires a cited transcript path to contain that platform's slug, and permits a
`smoke:`/`test:` citation **only** for the primary platform — a suite proves the machine it ran
on, and nothing else. `no non-primary platform claims PASS` is the stronger form, true while this
repository has one device; when CI or a real machine produces a transcript, that test is the one
that must be deliberately relaxed, which puts the decision somewhere visible.

The matrix also states plainly which platforms **must not be described** as supported, and why
Windows ARM64 and Termux/Android will stay `UNVERIFIED` even after CI exists: neither has a hosted
runner.

Three mutations, each reverted byte-identical: a Windows x64 `PASS` citing `smoke:install#1` → 2
red; a `TODO` placeholder cell → 2 red; a removed column → 1 red.

### Task 2 — Runtime dependency closure guard

`scripts/dependency-closure.mjs` with `tests/dependency-closure.test.mjs` (**12/12**). Script exit
0, prints the closure and the native-free verdict.

Measured, from the lockfile alone: lockfileVersion 3, **276** entries in the tree, runtime closure
**96 = 10 workspace links + 86 external**, **5** direct external dependencies (`@fastify/static`,
`fastify`, `react`, `react-dom`, `zod`). Verdict: no install script, no gypfile, no `libc`
constraint, no `os`/`cpu` restriction anywhere in the runtime closure.

Two plan figures were estimates and are corrected here rather than matched: the tree has **276**
entries, not 270, and **10** workspace links are reached, not 7 — `@bayz/server` and
`@bayz/dashboard` are leaves that nothing depends on, so a dependency walk never reaches them.

The tree genuinely contains **53** `os`/`cpu`-restricted and **2** install-scripted packages
(`esbuild`, `fsevents`). Saying so is more useful than implying the tree is pristine: all 55 are
reachable only through `vite`, a dev dependency of `@bayz/dashboard` that never runs in production,
and each is asserted absent from the runtime closure. The tree-wide counts are pinned too, so a new
install-scripted package gets looked at even when it lands in devDependencies.

The walker follows npm's nested `node_modules` rules — walk up from the requiring directory, exactly
as Node resolves. A companion test runs a deliberately flat resolver to prove the nested assertion is
not decoration, and that measurement corrected my own arithmetic: flat finds **83**, not 82, because
it misses the four nested entries *and gains* the hoisted `lru-cache` it resolved to instead. The
test now asserts the **set difference** rather than `86 − 4`.

`libc` is checked alongside `hasInstallScript` and `gypfile`, because a package shipping a prebuilt
binary declares which C library it was built against without needing an install script.

One structural fix: the CLI is behind an `import.meta.url === process.argv[1]` guard. Without it,
importing the module from the test ran the whole report, and a real violation would have called
`process.exit(1)` *inside the test runner* — killing the suite instead of failing an assertion.

`--self-test` injects five synthetic violations into the real closure (install script, gypfile,
`libc`, `os`, `cpu`) and confirms each is caught, plus that a dev-only native package is **not**
flagged. Three mutations reverted byte-identical: a genuinely flat walk → 4 red; `devDependencies`
included in the walk → 8 red; install-script detection disabled → 1 red.

### Task 3 — Cross-platform path, permission, and shell hygiene

`apps/server/src/data-dir.ts` (new) with `apps/server/test/data-dir.test.ts` (**13/13**), and
`scripts/portability-scan.mjs` with `tests/portability.test.mjs` (**14/14**, scan exit 0, 0
violations).

`resolveDataDir({ platform, home, env, cwd })` takes everything injected and never reads the real
platform, home, or env, so every branch is testable. Order: `BAYZ_DATA_DIR` (relative resolved
against cwd, empty or whitespace refused) → an existing `~/.bayz` → `%LOCALAPPDATA%/bayz` on Windows
→ `~/Library/Application Support/bayz` on macOS → `$XDG_DATA_HOME/bayz` or `~/.local/share/bayz`
elsewhere. It returns `{ path, reason }`, and `reason` is logged at startup so an operator can see
*why* a directory was chosen. **An existing `~/.bayz` wins on every platform**, which is the
backward-compatibility guarantee: abandoning it would leave existing installs with an unreadable
database.

`config.ts` now calls `resolveRuntimeDataDir(env)` and the scanner asserts `data-dir.ts` is the only
file in the repository that asks the OS where home is.

**The plan's "existing config tests unmodified" could not be honoured, and that is recorded rather
than papered over.** `apps/server/test/config.test.ts:9` asserted `/\.bayz$/`, which pinned the old
inlined default; this device has no `~/.bayz`, so the resolver correctly returns
`~/.local/share/bayz`. The assertion was rewritten to assert the **chain** — branching on
`existsSync(~/.bayz)` — rather than weakened to a substring match or forced green by creating the
directory.

Permissions were **verified, not re-implemented**: `packages/storage/src/paths.ts` already does
`0o700`/`0o600` and already tolerates chmod failure. A child process probed the real filesystem and
observed dir `0700`, `bayz.db`/`-wal`/`-shm` `0600`. Both Windows permission cells stay `UNVERIFIED`
and a test asserts they do: NTFS has no `chmod`-settable equivalent for `0700`, so parity is not
claimed.

Two scanner defects were found and fixed **before** the commit, both false-positive floods totalling
42 violations with none real. A character-walking comment stripper mistook quote characters inside
regex literals for string delimiters, swallowed the rest of each file, stopped recognising block
comments, and rewrote `\\` as spaces — destroying the very signal the Windows drive-letter rule needs.
And `\b(exec|…)` matched `db.exec("PRAGMA …")` and `pattern.exec(line)`, reporting 22 SQL statements
as shells. Rules also cannot spell live call forms in their *labels*, because the scanner scans
itself; excluding it from its own scan would have been a hole rather than a fix.

Five mutations, one of which **survived and forced a real test fix**: disabling the home-directory
*call* rule stayed green, because the vacuity fixture fed an import line and a call line together and
the import rule alone satisfied it. The fixtures were split into call-only forms (suite 13 → 14) and a
third pattern was added for `const { homedir } = await import("node:os")`. The mutation was then
caught.

### Task 4 — Packaging artifact

`scripts/pack.mjs` with `tests/pack.test.mjs` (**20/20**) and `packaging/README.md`. Output
`packaging/out/bayz-router-0.1.0.tgz` — 7 files, 188 KB — with `packaging/out/` gitignored.

Measured baseline defect: `npm pack --workspace @bayz/server` shipped **57 files including all 29
`test/*.ts`**. A `files` field narrows that accident, but the real fix is that the release is a single
bundled artifact rather than a workspace pack, because a workspace tarball's ten `@bayz/*`
dependencies are unresolvable anywhere.

**The artifact declares two dependencies, not the plan's five**, and this is a correction from
measurement. `fastify` and `@fastify/static` stay external; `react`/`react-dom` belong to the
dashboard bundle, and the server reaches `@bayz/contracts` only through `import type`, which erases at
compile time — so `zod` is never loaded. Declaring all five would install four packages nothing can
require. The test asserts declared **equals** imported in both directions, so a genuinely missing
sixth dependency still fails.

It installs for real: `npm install <tarball>` into a clean prefix added 83 packages, `.bin/bayz`
booted, created the data directory at `0700` with the database and `master.key` at `0600`, reached
schema v11, and served `/api/health` 200 plus the packaged dashboard.

Licence is `UNLICENSED` — true today, and 9K Task 3 owns that decision. The test asserts a
*consistency* rule rather than a value, so it survives 9K landing.

Six mutations. Five were caught immediately: over-declaring the three unused dependencies, a
hardcoded unused `zod`, shipping a test file (reproducing the 57-file defect), and a tar `mtime` from
the clock. **One survived and exposed an unfalsifiable assertion**: removing `mtime: 0` from
`gzipSync` stayed green, because zlib on this Node emits a zero gzip timestamp regardless of the
option — so *no* assertion on the produced bytes could ever have caught a non-deterministic writer.
The fix gives `writeTarGz` a test-only `mtime` injection point: the test packs once with a real clock
injected and proves the bytes diverge, then proves production is byte-identical across two packs. Two
positive controls confirm it now fails — production stamped with the clock, and the injection point
neutered.

### Task 5 — Install, first boot, restart, and uninstall

`scripts/install-smoke.mjs` (**64/64**) and `docs/install.md`.

Every check runs against the **installed artifact**, never the workspace: the tarball is installed
into a clean temporary prefix with a temporary npm cache, and the checks drive the binary npm linked
at `node_modules/.bin/bayz`. A workspace run would prove nothing about what an operator installs,
because the workspace has ten `@bayz/*` symlinks a user will never have.

Covered: install, first boot creating the data directory at `0700` with `bayz.db` and `master.key` at
`0600`, the API token generated once and **reused** across a restart rather than regenerated, a real
chat through a real loopback origin, streaming, proxying, dashboard serving, a generated token refused
for a non-loopback bind, and uninstall leaving operator data untouched — with `docs/install.md`
documenting that deleting the data directory is the operator's explicit choice.

**Two real defects in the smoke itself, both found by running it rather than reading it.**
`--@bayz:registry` passed as two argv entries is not recognised by npm, which treated the URL as a
*second install target* and hung for over nine minutes retrying it as a package; it must be one
`--flag=value` entry. And the fixture imports needed the `tsx` loader, without which the run died at
check 20 with `ERR_MODULE_NOT_FOUND`. Everything under test is still the artifact's own compiled
bundle in a separate process.

### Task 6 — Upgrade from every prior schema version

`packages/storage/test/upgrade-ladder.test.ts` (**21/21**),
`packages/providers/test/corrupt-row.test.ts` (**7/7**), and `scripts/upgrade-smoke.mjs` (**83/83**).

Every rung v1 through head v11, each fixture built by **truncating the real `MIGRATIONS` list**.
Writing the head schema and editing `user_version` down would produce a shape no BAYZ build ever
created — and the ahead-of-head refusal added here would reject it anyway.

Two layers, answering different questions. The storage test proves the ladder: every rung reaches
head, every secret still decrypts, every provider, proxy, route, identity and usage row survives with
its values, and the 9F hash chain validates after each step. The smoke proves it where an operator
meets it: each rung opened by the installed artifact's own bundle, a real chat completing through the
pre-upgrade route and credential, and `PRAGMA integrity_check` `ok` after each. The artifact is a
*bundle*, so migrations could in principle be reordered or dropped by bundling and the storage test
would never notice.

**Three live production defects, all fixed here:**

1. **An ahead-of-head database opened cleanly.** A forged `user_version` 14 with a consistent ledger
   passed every existing check: `verifyRecordedSchemaVersion` (its head matched), zero migrations
   applied (every version this build knows was already `<= current`), and `verifyMigrationChain` —
   because the chain folds only the migrations this build *has*, so `chain(…, 14)` and
   `chain(…, 11)` are byte-identical. Measured: it opened and reported `schemaVersion: 14`. There is
   no safe way to remove a column that already holds data, so `verifySchemaNotAheadOfHead` now
   refuses it at a distinct stage, called from `openDatabase` **before** the runner.
2. **A ledger gap was skipped.** `verifyMigrationChain` returns early when no chain is recorded —
   the normal state for exactly the databases 9J upgrades — so a v11 database with ledger row 3
   deleted opened fine. The count check moved into `verifyRecordedSchemaVersion`, before the runner,
   where no early return can reach it.
3. **One corrupt provider row killed the whole install.** `runtime.describe()` counts providers
   through `listProviders()`, which mapped every row through `rowToRecord` and rethrew, so a single
   unparseable `config_json` made the daemon **exit before listening** — every healthy provider and
   every stored credential offline over one field. `ProviderRepository.list` now skips undecodable
   rows and `listUnreadable()` reports their ids; tolerating without reporting would trade a dead
   install for an invisible one, so `GET /api/providers` returns `unreadable` when non-empty. A
   second defect in the same area: `deleteProvider` checked existence with `get`, which decodes, so
   the documented repair failed with HTTP 400 on exactly the rows needing it — it now uses a
   non-decoding `exists`.

**The free-first default is asserted as a guarantee, not worked around.** Migration v10 adds
`routes.free_only NOT NULL DEFAULT 1`, so an upgraded route arrives free-only and the first chat is
*expected* to be refused with `no_free_route`; the completion is asserted after an explicit opt-in. An
upgrade that silently cleared `free_only` would let a migrated route start spending money without
anyone asking. My first reading of those 409s as a fixture bug was wrong and is recorded as such.

v1–v3 predate the `routes` table, so those rungs assert the API answering rather than a chat —
recorded rather than skipped silently, since inventing a route would test v11's schema, not v1's.

Five mutations, all caught: `list` intolerant again, `listUnreadable` returning `[]`, ahead-of-head
refused only 100+ versions out, a ledger gap accepted when rows are *fewer* than `user_version`, and
corrupt rows undeletable again.

### Task 7 — CI workflow for the untestable platforms

`.github/workflows/platform-matrix.yml` and `docs/superpowers/2026-08-27-bayz-ci-notes.md`, with
`tests/ci-workflow.test.mjs` (**8/8**).

Five hosted runners (`ubuntu-latest`, `ubuntu-24.04-arm`, `windows-latest`, `macos-latest`,
`macos-13`), each running `npm ci`, the closure and portability gates, every workspace suite,
`runtime:build`, `node --test tests/`, pack plus its self-test, then `install-smoke` and
`upgrade-smoke` against the packed artifact, then `platform-gate --report`.

**One deviation from the plan text, recorded rather than made silently:** `npm run runtime:verify` is
replaced by the bounded sequential equivalent, one workspace per step. The parallel fan-out exhausts
the futex table and cannot run on the primary device at all, so using it in CI would make a CI failure
incomparable to a local one.

The file is **committed and inert**. Trigger is `workflow_dispatch` only — no `push`,
`pull_request`, or `schedule` — with `permissions: contents: read`, no `secrets.` reference, no
token, and no publish step. If a remote is ever added, this must not start acting before someone
re-reads it.

The load-bearing test is the anti-cheat: the five CI-only platform rows must contain **no `PASS`** and
no matrix cell may cite the workflow file. A workflow that has never executed is not a measurement,
and that test is what stops a future edit from treating it as one.

The notes record that Windows ARM64 and Termux/Android have **no hosted runner at all**, plus two ways
a green CI run would still not equal the Termux row: Windows has no `chmod`-settable equivalent for
`0700`, and `node:sqlite` binds its SQLite from the Node build rather than the OS.

Three mutations, all caught: a `push` trigger on master, `NODE_AUTH_TOKEN` from `secrets.NPM_TOKEN`
smuggled into a step, and the Linux x64 row upgraded to `PASS` on the strength of a workflow that has
never run.

### Task 8 — Platform gate

`scripts/platform-gate.mjs` with `tests/platform-gate.test.mjs` (**13/13**). `--report` exit 0,
`--enforce` exit 0.

The asymmetry is the design. A `FAIL` anywhere blocks **unconditionally** — someone looked, it did not
work, and shipping would be shipping a known defect. An `UNVERIFIED` mandatory cell on the **primary**
platform blocks, because that is the device this release is qualified on. An `UNVERIFIED` anywhere else
does **not** block: this repository has, by design, no access to five of its seven platforms, and a
gate that can never pass is one that gets bypassed or ignored, which is strictly worse than one that
reports honestly. What it does instead is print the exact list of platforms that must not be described
as supported.

`README.md` now carries that list in a `## Platform support` section, and a test asserts the two agree
in both directions. A README claiming a platform nobody has ever run is the most consequential lie this
project could tell, because a user would install on it.

Three guards beyond the plan text, each because the obvious implementation would have been vacuous: a
**missing primary row** blocks (every other rule is about that row, so losing it would satisfy them
all by having nothing to check); a **dropped mandatory column** blocks (`MANDATORY_COLUMNS` lives in
the gate, not the matrix header, so deleting a column cannot shrink "complete" into a pass); and a
`PASS` with no evidence reference blocks, while an unparseable matrix throws rather than reading as
empty.

Five mutations, all caught: a `FAIL` on a non-primary platform no longer blocking, a missing primary
row treated as nothing to check, `uninstall` dropped from the mandatory set, an `UNVERIFIED` primary
cell downgraded to a notice, and the README quietly dropping Linux x64/ARM64 and Windows x64 from its
do-not-claim list.

### Phase 9J verification totals

Run sequentially, one heavy worker at a time — `npm run runtime:verify` as a single command remains
unusable on this host, exhausting the futex table and taking SIGKILL with gigabytes free.

```text
@bayz/contracts      3/3        @bayz/proxy        121/121
@bayz/security       6/6        @bayz/gateway       80/80
@bayz/storage      267/267      @bayz/router       294/294
@bayz/telemetry     55/55       @bayz/providers    293/293
@bayz/identity      69/69       @bayz/server       351/351
@bayz/capability    72/72

pack               20/20        portability         14/14
platform-gate      13/13        platform-matrix     10/10
matrix-integrity    9/9         ci-workflow          8/8
dependency-closure 12/12

api-smoke          70/70        install-smoke       64/64
upgrade-smoke      83/83        pack --self-test    15/15
root suite `node --test "tests/*.test.mjs"`  200/200, exit 0, four consecutive runs
portability-scan   0 violations, exit 0
platform-gate --report exit 0, --enforce exit 0
builds: storage, providers, server, dashboard — all exit 0
git diff --check  clean
```

Storage schema head remains **v11**. The runtime closure is unchanged at **96 = 10 workspace links +
86 external** from 276 lockfile entries; `esbuild` was promoted to an explicit pinned root
devDependency so the release path does not rely on npm hoisting from `tsx`, and a test asserts it never
reaches the runtime closure.

**25 mutations were run across Tasks 3–8. Two survived on first attempt and both forced real fixes** —
the vacuity fixture that let the home-directory call rule be disabled, and the unfalsifiable gzip
timestamp assertion. Both are described above.

**One pre-existing flake was found and fixed while running the whole root suite together, and it was a
real defect rather than a flaky assertion.** `node --test "tests/*.test.mjs"` failed roughly one run in
three on `the scanner runs as a script and exits 0 on the clean tree`, with two different symptoms:
sometimes a genuine `hardcoded-path` violation at `scripts/resilience-gate-probe.mjs:2`, sometimes
`ENOENT` reading that same path from inside the scanner.

Cause: `tests/resilience-report.test.mjs` wrote a temporary probe **into the tracked `scripts/`
directory**, with an absolute `/tmp/...` report path interpolated into its source, then deleted it.
Because `node --test` runs files concurrently, the portability scanner would either read the probe
while it existed — correctly reporting a hardcoded path — or list the directory and then find the file
gone mid-scan. The scanner was right both times. The probe now lives in the temp directory alongside
its fixture, takes its arguments through `argv` instead of interpolation, and imports the gate through
an absolute `file:` URL. Four consecutive root-suite runs: **200/200**, exit 0.

That flake predates 9J; it was invisible until this phase added a scanner that reads `scripts/`.

### Phase 9J honest limitations

- **Six of seven platforms are `UNVERIFIED`**, and nothing has been run on any of them. Linux x64,
  Linux ARM64, Windows x64, Windows ARM64, macOS x64, macOS ARM64. The runtime is *plausibly*
  portable — zero native runtime dependencies, no install scripts in the closure, no POSIX shell on
  any user path, a per-platform data-directory resolver — but plausible is not observed.
- **Windows file-permission parity is not claimed** and cannot be until a Windows machine exists.
  `0700` has no `chmod`-settable NTFS equivalent, so both Windows permission cells stay `UNVERIFIED`
  by design, with a test asserting it.
- **Termux/Android and Windows ARM64 have no hosted runner**, so CI can never fill those rows. Termux
  is filled by real local runs; Windows ARM64 cannot be filled by anyone here.
- **The upgrade ladder starts from databases this repository constructs.** No v1-era BAYZ binary
  exists to have written one, so what is proven is that the migration sequence is correct and
  complete, not that a database from a historical release has been recovered.
- **The CI workflow has never executed.** It is committed and inert, cited by nothing.
- **The artifact's licence is `UNLICENSED`.** True today; 9K Task 3 owns that decision.

### Post-9J follow-up: operator session UX (NOT in the 9J plan)

Recorded here rather than built, because it is outside this phase's plan and silently changing the
auth architecture would be scope creep on a security surface.

The requirement: an operator should not have to re-enter the bootstrap token after every browser
refresh. `README.md:379` currently documents "The token is not remembered" as deliberate behaviour, so
this is a **change of decision**, not a bug fix.

If a later phase takes it, the shape is constrained: the bootstrap token is entered once to establish
trust and is **never** persisted in `localStorage`, `sessionStorage`, IndexedDB, a URL, or a
browser-readable cookie; trust is carried by a revocable **server-side session** behind an
`HttpOnly`, `SameSite` cookie; Lock/Logout revokes the session server-side and clears the cookie;
refresh and reopen stay authenticated until explicit lock or revocation; CSRF and origin protections
are retained; and a test proves the raw bootstrap token is not browser-persisted.

No Fortress protection was weakened in 9J. Token enforcement, encrypted secret storage, master-key
permissions, loopback/remote rules, SSRF defences, scoped identities, admin locality, credential
redaction, request limits, and TLS/mTLS/signing behaviour are all untouched — the install smoke
asserts several of them against the installed artifact.

### 9J resume point

**Phase 9J is COMPLETE. Next: Phase 9K — Supply chain / release integrity — not started.** Read its
plan at `docs/superpowers/plans/2026-08-27-phase9k-supply-chain-release-integrity.md`.

One decision is **already blocking 9K Task 3 and must come from the user**: the licence identifier.
There is no `LICENSE` file, root `package.json` has no `license` field, and all nine `@bayz/*`
packages declare none (masked by `private: true`). The task deliberately does not pick one; until it
is chosen the inventory records the repository's own licence as `UNKNOWN`, and an `UNKNOWN` in the
runtime closure blocks the 9K release gate. The packaged artifact currently declares `UNLICENSED`,
which is accurate and will need updating when the decision is made.

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
