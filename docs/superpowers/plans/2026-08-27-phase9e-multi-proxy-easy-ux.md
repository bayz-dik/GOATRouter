# Phase 9E — Multi-Provider + Multi-Proxy Easy UX

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Spec:** `docs/superpowers/specs/2026-08-27-bayz-phase9-goat-release-design.md` §9

**Depends on:** nothing (parallel with 9C and 9D)

**Goal:** Make multi-provider proxy management genuinely easy. This is a release requirement, not polish — backend support already exists and is insufficient.

**Locks:** No proxy password is ever displayed or returned. No config-file editing for any normal operation. Flux Core visuals untouched; it only receives proxy identity it already accepts.

**Repository constraint driving the design:** `proxy_id` currently lives only on `routes` (`packages/router/src/repository.ts`), and `packages/providers/src/repository.ts` has zero occurrences of `proxyId`. Assigning one proxy to forty providers today means editing forty routes. That is the gap.

**Migration numbering — SETTLED:** the spec's ledger (§4) provisionally labelled this subprogram's migration v7. **9D's `custom-openai` kind migration landed first and took v7**, so this subprogram's provider-proxy migration is **v8**, and 9D's plan text records the same settlement. No test hardcodes the head version; every migration test reads the head from the migration table.

---

### Task 1 — Provider-level proxy default (migration v8)

**Modify:** `packages/storage/src/migrations.ts`, `packages/storage/test/migrations.test.ts`, `packages/providers/src/repository.ts`, `packages/providers/src/manager.ts`
**Test:** `packages/providers/test/provider-proxy.test.ts`

**Schema:** migration v8 adds `providers.proxy_id TEXT REFERENCES proxies(id) ON DELETE SET NULL`

- [x] RED `packages/storage/test/migrations.test.ts`: fresh `providers` gains `proxy_id` as a 9th column; the pinned column set updates; deleting a proxy sets dependent `providers.proxy_id` to NULL (degrade to direct, never break); existing rows survive the migration with `proxy_id` NULL.
- [x] RED `packages/providers/test/provider-proxy.test.ts`: create with `proxyId` validates the proxy exists (pre-SQL, `invalid_provider_config` for unknown); `updateProvider` can set and clear it with `null`; the view exposes `proxyId` and never a password; a provider with no proxy reports `undefined`, not `""`.
- [x] Verify RED: `node --import tsx --test packages/storage/test/migrations.test.ts` fails on the column-set assertion.
- [x] GREEN.
- [x] Verify: `npm run test --workspace @bayz/storage` and `--workspace @bayz/providers` exit 0; `node scripts/storage-smoke.mjs` still 42/42; `node scripts/provider-smoke.mjs` still 36/36.
- [x] Commit — `feat: add a provider-level proxy default`

### Task 2 — Proxy resolution order in the router

**Modify:** `packages/router/src/router.ts`
**Test:** `packages/router/test/proxy-resolution.test.ts`

**Resolution:** route override → provider default → direct

- [x] RED `proxy-resolution.test.ts`: a route with `proxyId` uses it even when the provider has a different default (override wins); a route with no `proxyId` uses the provider default; neither set means direct; a route explicitly set to direct must be distinguishable from "unset" — introduce `proxyId: null` on the route meaning *force direct*, and pin that it beats the provider default; telemetry records the **effective** proxy id, not the route's raw value; the effective proxy is reported in the `x-bayz-proxy` header.
- [x] Verify RED.
- [x] GREEN. Note in code why `null` (force direct) and `undefined` (inherit) must differ, since collapsing them makes "opt this one route out" impossible.
- [x] Verify: `npm run test --workspace @bayz/router` exits 0; `node scripts/router-smoke.mjs` still 46/46.
- [x] Commit — `feat: resolve Bayz proxies by route override then provider default`

**As built — one deviation from the plan text.** The plan proposed expressing force-direct
as `proxyId: null` on the route. That does not work: `proxyId` is already `NULL` for an
inheriting route, so the two states would be the same row and indistinguishable after a
reload. Force-direct is therefore a separate column, `routes.force_direct` (migration
**v9**), defaulting to 0 = inherit so no existing route changes behaviour. The API-level
`proxyId: null` on an *update* keeps its existing meaning — return to inheriting — and
`forceDirect: true` is the new, distinct request. A sentinel `proxy_id` value was the
other option and was rejected: it would break the foreign key and put a magic string in a
reference column.

### Task 3 — Bulk assignment API

**Modify:** `apps/server/src/routes/proxies.ts`
**Test:** `apps/server/test/proxy-bulk-api.test.ts`

**Routes:**
```text
POST /api/proxies/:id/assign     { providerIds: string[] }
POST /api/proxies/:id/unassign   { providerIds: string[] }
GET  /api/proxies/:id/usage
```

- [x] RED `proxy-bulk-api.test.ts`: assign accepts up to 200 ids and refuses more; every id is validated pre-SQL and one bad id fails the whole call **atomically** (assert no partial assignment); assigning to an unknown provider is `400`, not a silent skip; unassign sets those providers to direct; `usage` returns `{ providerCount, routeCount, providerIds }` with ids but no password and no credential; all three require `proxies.write` (or `proxies.read` for usage); assigning a disabled proxy is allowed but the response notes it (an operator may stage config before enabling); a duplicate id in the array is deduplicated rather than applied twice.
- [x] Verify RED.
- [x] GREEN.
- [x] Verify: `npm run test --workspace @bayz/server` exits 0; `node scripts/api-smoke.mjs` still 62/62.
- [x] Commit — `feat: add Bayz bulk proxy assignment API`

**As built — two decisions the plan did not settle.**

1. **An unknown provider in the batch is `invalid_request` (400), not `provider_not_found`
   (404).** The plan asked for 400 without saying how. `assignProxy` raises
   `provider_not_found`, which maps to 404 — but on `/api/proxies/:id/assign` a 404
   already means *the proxy* is missing, so passing it through would point the operator
   at the wrong resource. The route translates that one code and leaves every other
   domain error alone.
2. **`usage.routeCount` counts only routes *pinned* to the proxy** (`routes.proxy_id`),
   not routes that reach it by inheriting from their provider. An inheriting route
   follows whatever its provider is assigned, so counting it would double-count the
   provider already reported in `providerCount` and would change without the route
   changing. `unassign` also reports `detachedFromProxy` — how many of the submitted
   ids were actually on this proxy — because after the write nothing distinguishes
   "was on this proxy" from "was already direct".

### Task 4 — Proxy panel: full lifecycle and test connection

**Modify:** `apps/dashboard/src/panels/ProxiesPanel.tsx`, `apps/dashboard/src/api/client.ts`
**Test:** `apps/dashboard/test/proxies-panel-ux.test.tsx`

- [x] RED `proxies-panel-ux.test.tsx`: create supports both `socks5` and `http` with a kind selector; edit changes host, port, username, enabled, and config; delete confirms; the password field is `type="password"`, `autocomplete="off"`, and clears on submit with the value absent from the DOM afterwards; Test Connection shows `ok` with measured latency, or the fixed failure code, or an explicit "not measured" — never a fabricated number; a disabled proxy renders distinctly; a degraded proxy renders distinctly; every row shows "used by N providers, M routes"; a `502 refused` shows the code and message from the envelope.
- [x] RED same file: nothing in the panel renders a value from a field matching `/password|credential|secret/`.
- [x] Verify RED.
- [x] GREEN.
- [x] Verify: `npm run test --workspace @bayz/dashboard` exits 0.
- [x] Commit — `feat: complete the Bayz proxy panel lifecycle`

**As built.** Four decisions the plan text left open:

1. **An edit sends only what changed.** A full-object PATCH would rewrite fields the
   operator never touched and make an accidental save indistinguishable from a
   deliberate one. Saving an unchanged form is refused with a message rather than
   issuing a no-op write.
2. **Clearing a username sends `null`, not `""`.** The API models absence as `null`;
   an empty string would be a second way to say the same thing.
3. **"Connection not measured" is the initial state**, and a *failed* check renders the
   envelope's code and message with **no latency at all** — a failed dial has no
   meaningful measurement, and printing `0 ms` would be a fabricated one.
4. **`disabled` outranks `degraded`** on a row's `data-state`. An operator who turned a
   proxy off already knows why traffic is not flowing.

Usage per row comes from `GET /api/proxies/:id/usage` (Task 3) and renders
`Usage unavailable` when the call fails — a `proxies.read`-less credential or an older
Core must not be shown a fabricated `0 providers`.

`proxies-panel.test.tsx` needed two updates: its stub gained `proxyUsage`, and the
delete assertion became two-step now that delete confirms.

### Task 5 — Provider multi-select and one-action assignment

**Modify:** `apps/dashboard/src/panels/ProvidersPanel.tsx`
**Create:** `apps/dashboard/src/panels/ProxyAssignBar.tsx`
**Test:** `apps/dashboard/test/proxy-assign-ux.test.tsx`

- [x] RED `proxy-assign-ux.test.tsx`: each provider row has a selection checkbox; select-all selects every visible provider; a filter box narrows the list and select-all then selects only the filtered set (assert with 40 providers, filter matching 12); the assign bar appears only with a selection and shows the count; choosing a proxy and confirming issues **one** `assign` call carrying all selected ids (assert the client was called once, not N times); "Set to Direct" issues one `unassign`; the b
- [x] RED same file: with 120 providers, select-all then assign still issues one call, and the rendered row count stays 120 (no truncation).
- [x] Verify RED.
- [x] GREEN.
- [x] Verify: `npm run test --workspace @bayz/dashboard` exits 0 — 21 files, 317 tests.
- [x] Commit — `feat: add Bayz bulk provider proxy assignment UX`

**As built.** Three decisions, one of them a deviation from the plan text:

1. **No `ProxyAssignBar.tsx`.** The bar is ~30 lines of JSX over four pieces of state
   (`selected`, `filter`, `assignProxyId`, `assignNote`) that all belong to the provider
   list. Extracting it would mean threading every one of them plus two callbacks through
   props for no reuse — there is exactly one call site. It stays inline in
   `ProvidersPanel.tsx`.
2. **A filter never deselects.** Filtering is a view operation; select-all acts on the
   visible rows only, and rows hidden by the filter keep whatever state they had.
   Silently dropping a selection an operator built would lose work.
3. **A batch over `MAX_BULK_PROVIDER_IDS` (200) is refused, not split.** Two calls would
   forfeit the server's single transaction, and a half-applied assignment is worse than a
   refused one. The panel says how many are selected and suggests narrowing the filter.

A failed assignment **keeps the selection** — the server applied nothing, and rebuilding
a 40-provider selection by hand after a transient 502 would be punishing.

**Test-performance note (worth knowing before touching these tests).** With 120 rows,
`getByLabelText` costs ~26 s per call under jsdom: it walks every label in the document
and normalises text. `getByTestId` is a single attribute selector and costs ~7 ms. The
40-row RED run took 122 s and the 120-row case timed out at 5 s per test purely from
label queries. Every bulk control therefore carries a `data-testid` alongside its real
`<label htmlFor>` — the label is what an operator and a screen reader use, the testid is
what the suite queries. Same accessibility, ~3000× cheaper assertions; the whole file now
runs in 11 s.

Both existing provider-panel suites needed `listProxies`/`assignProxy`/`unassignProxy`
added to their stubs, since `ProvidersApi` grew.

### Task 6 — Effective proxy visibility

**Modify:** `apps/dashboard/src/panels/ProvidersPanel.tsx`, `apps/dashboard/src/panels/RoutesPanel.tsx`
**Test:** `apps/dashboard/test/effective-proxy.test.tsx`

- [x] RED `effective-proxy.test.tsx`: a provider row shows its proxy id or `Direct`; a route row shows the **effective** proxy plus whether it is `inherited` or `overridden`; a route forcing direct against a proxied provider shows `Direct (override)`; the proxy id renders as inert text even when hostile; a proxy that was deleted leaves the provider showing `Direct` with no dangling id.
- [x] Verify RED — 7 of 10 failed for the right reason (no `route-proxy-*` cell existed).
- [x] GREEN.
- [x] Verify: `npm run test --workspace @bayz/dashboard` exits 0 — 22 files, 327 tests; `tsc --noEmit -p apps/dashboard` clean.
- [x] Commit — `feat: show the effective Bayz proxy per provider and route`

**As built.** `effectiveProxy()` in `RoutesPanel.tsx` mirrors `effectiveProxyId()` in
`packages/router/src/router.ts` exactly, including the order — `forceDirect` first, then
the route override, then the provider default. A test pins that precedence (`proxyId` set
*and* `forceDirect` true renders Direct), because a panel that disagreed with the router
would tell the operator traffic goes direct while it tunnels.

Two states the plan text did not name:

1. **A route whose provider is missing renders `Effective proxy unknown (provider
   missing)`,** not `Direct`. The effective proxy genuinely cannot be computed without the
   provider, and `Direct` would be a fabricated claim about where traffic goes.
2. **`Direct (override)` only when it actually overrides something.** A forced-direct route
   under an already-direct provider reads plain `Direct` — nothing was overridden, and
   labelling it a decision invites the operator to go looking for a proxy that isn't there.

A route pinning its own proxy reads `(overridden)` whether or not the provider had a
default, because the route no longer follows whatever the provider does next.

`RouteView` gained the `forceDirect: boolean` the repository has carried since Task 1; the
route row now renders the effective proxy in place of the raw `proxyId` column, and
`routes-panel.test.tsx` needed `forceDirect` in its fixture.

Also verified for this task: `node scripts/dashboard-smoke.mjs` — 48/48 PASS.

### Task 7 — Multi-proxy UX smoke

**Create:** `scripts/proxy-ux-smoke.mjs`

- [x] Non-mocked: real listener, two real CONNECT proxies, one real SOCKS5 proxy, twelve real loopback provider origins. Prove: create all three proxies through the API; bulk-assign proxy A to twelve providers in one call; a chat through each provider traverses proxy A (assert each proxy's connect log); bulk-reassign six providers to proxy B in one call and prove the split; set three to Direct and prove no tunnel; a route override beats the provider default; `usage` reports the correct counts; deleting proxy B degrades its providers to Direct without breaking them; scan db/wal/shm/logs/responses for both proxy passwords — zero occurrences.
- [x] Verify: `node scripts/proxy-ux-smoke.mjs` exits 0 — **87/87 checks PASS**.
- [ ] Verify full gate: `npm run runtime:verify`; every smoke script; `git diff --check`.
- [x] Commit — `test: add Bayz multi-proxy UX smoke`

**Ordering deviation, recorded deliberately.** The amendment below says 6a–6c run
*before* Task 7 so the UX smoke can cover them. The proxy half of Task 7 was written
first because it depends only on 9E Tasks 1–6, which were complete, and leaving it
unwritten would have meant no non-mocked proof for work already committed. The
**Amended Task 7 additions** (free-only economics against real origins) remain open and
are the correct place for that coverage; they are still gated on 6a–6c.

**What the script proves, mechanically.** Every "where did traffic go" claim reads the
proxies' own CONNECT logs, keyed by origin port, rather than a router return value: an
in-process assertion can show a function returned `"assigned"`, but only a real tunnel
shows twelve providers egressing through A and then six of them actually moving to B.
The leak scan carries a positive control — `fleet-1` **is** asserted present in the
database bytes — so a scan that silently read an empty buffer cannot pass.

Two additions beyond the plan text: cross-contamination is asserted absent (proxy A's
CONNECT preambles never contain proxy B's password, and neither carries the provider
credential), and `forceDirect` on a route is proven to beat a proxied provider with no
CONNECT logged anywhere.

One real defect the smoke caught, which no in-process test had: a non-ASCII provider
credential (`«…»`) makes Node reject the upstream `Authorization` header with
`ERR_INVALID_CHAR`, surfacing as a 500 `internal_error` with the cause visible only in
the attempt log. That was a fault in the smoke's own fixture, not in the router, but it
is exactly the class of failure a mocked test cannot see — the header never reaches a
socket there.

## Completion checklist

- [ ] Migration v8 adds `providers.proxy_id`; proxy deletion degrades to direct.
- [ ] Resolution order route-override → provider-default → direct, with `null` meaning force-direct.
- [ ] Bulk assign/unassign is atomic, bounded at 200, and issues one call.
- [ ] Proxy panel covers both kinds, full lifecycle, write-only password, real test result.
- [ ] Multi-select with select-all-filtered works at 120 providers with no truncation.
- [ ] Effective proxy and inherited/overridden state visible on every row.
- [ ] No password rendered, returned, or logged anywhere.
- [ ] No config-file editing required for any of the above.

---

## AMENDMENT — Free-only routing (spec §25)

Added after this plan was committed. Three extra tasks, executed after Task 6 and
before Task 7, so the UX smoke in Task 7 can cover them.

**Depends on:** 9D Tasks 5a and 5b (the classifier and catalogue must exist).

**Locks:** BAYZ never falls back from a free route to a paid route. `UNKNOWN` is not
free. No hardcoded model name. Flux Core untouched — this is routing metadata.

### Task 6a — Free-only route flag and candidate filtering

**Modify:** `packages/storage/src/migrations.ts` (next free version), `packages/router/src/repository.ts`, `packages/router/src/selection.ts`, `packages/router/src/errors.ts`
**Test:** `packages/router/test/free-only.test.ts`, `packages/storage/test/migrations.test.ts`

**Schema:** `routes.free_only INTEGER NOT NULL DEFAULT 1 CHECK (free_only IN (0,1))`

**Default is 1 — free-only ON.** Paid routing is off by default per §25 rule 6, and a default of 0 would make the safe posture opt-in, which inverts the requirement.

**New error code:** `no_free_route`.

- [x] RED `packages/storage/test/migrations.test.ts`: `routes` gains `free_only`; the pinned column set updates; **every pre-existing route migrates to `free_only = 1`** — the safe value, asserted explicitly, because migrating to 0 would silently enable paid routing on an existing install; the CHECK rejects 2.
- [x] RED `free-only.test.ts`: a route with `freeOnly: true` selects only candidates whose economics `isFreeEconomics`; a `PAID` candidate is excluded; **an `UNKNOWN` candidate is excluded** (asserted separately and first); `LOCAL`, `FREE_VERIFIED`, `FREE_TIER`, and `FREE_PREVIEW` are all eligible; with `freeOnly: false` every candidate is eligible; the flag is per route, so two routes for the same model can differ.
- [x] RED same file, **the no-fallback rule**: a free-only route whose only free candidate fails does **not** try a paid candidate that exists and is healthy — assert the paid provider's origin observed **zero** requests, which is the only assertion that actually proves money was not spent; the request fails `no_free_route`; the same holds when the free candidate is rate-limited, when it times out, and when it returns 500, since each is a plausible excuse for a fallback and none is acceptable.
- [x] RED same file: a free-only route with no free candidate at all fails `no_free_route` **before** any upstream request; the error is a fixed message naming no model and no provider; telemetry records `request.failed` with the fixed code and no candidate list.
- [x] RED same file: a free-only route whose free candidate list becomes empty mid-failover (the second attempt's provider was reclassified `PAID` by a fresh discovery) fails `no_free_route` rather than continuing.

  **Deviation, recorded:** the mid-failover test asserts the reclassified candidate is
  **never attempted** (`chatHits === 0`) and that the request rejects, rather than
  asserting the error code is `no_free_route`. When a free candidate really was tried and
  really did fail, the honest surfaced error is that upstream failure; reporting
  `no_free_route` there would misattribute a provider outage to economics policy. The
  original intent — no paid request is issued — is what the assertion proves.
- [x] Verify RED. First run: 14/15 pass, the mid-failover test red for the wrong reason (it reclassified before the request, so the up-front filter caught it and the per-attempt recheck was never exercised); reshaped to reclassify from inside the first candidate's chat handler via an `onChat` hook, which makes the recheck load-bearing.
- [x] GREEN. Economics come from a cached catalogue read, not a live discovery call per request — noted in `filterFreeCandidates`: a per-request discovery would add an upstream round trip to every chat and would let a discovery outage silently empty the free set, turning an availability problem into a `no_free_route` storm.
- [x] Verify: `@bayz/router` 276/276 pass; `@bayz/storage` 185/185 pass; `@bayz/providers` 276/276 pass; `node scripts/router-smoke.mjs` 46/46 PASS; `node scripts/storage-smoke.mjs` 42/42 PASS; `node scripts/provider-smoke.mjs` 36/36 PASS.

  **Fixture migration, recorded:** enabling the safe default turned 55 pre-existing router
  tests and the router smoke red with `no_free_route`. Those tests assert proxying,
  telemetry, failover, and adversarial behaviour against fixture origins that publish no
  pricing metadata, so their models classify as undiscovered — and undiscovered is not
  free (§25 rule 5). They now pass `freeOnly: false` explicitly, with a comment in each
  file explaining why. The default itself was **not** weakened. The same applied to server
  HTTP fixtures. `packages/router/test/repository.test.ts` also pins the `routes` column
  count, now 11, and additionally asserts `free_only = 1` so the safe default is proven at
  the storage layer rather than only at the API layer.
- [x] Commit — `feat: add Bayz free-only routing with no paid fallback`

### Task 6b — Model catalogue persistence and API surface

**Modify:** `packages/storage/src/migrations.ts` (same migration as 6a), `packages/providers/src/repository.ts`, `apps/server/src/routes/providers.ts`, `apps/server/src/routes/routes.ts`, `apps/server/src/errors.ts`
**Test:** `apps/server/test/economics-api.test.ts`

**Schema:** `model_catalogue (provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE, model TEXT NOT NULL, economics TEXT NOT NULL, discovered_at TEXT NOT NULL, PRIMARY KEY (provider_id, model))`

The table stores an id and a classification. It is **not** content-bearing: no prompt, no completion, no pricing value, no description. A schema-pinning test asserts the four-column set so a later phase cannot add a `description` column.

- [x] RED `economics-api.test.ts`: catalogue discovery persists economics and still returns the legacy `{ models: string[] }`; `GET /api/models/free` aggregates across providers with no duplicates and no `UNKNOWN`/`PAID`; a re-discovery prunes a model the upstream stopped listing; a reclassified model leaves the free set.
- [x] RED same file: a free-only route with no free candidate returns HTTP **409** `no_free_route`, distinct from **502** on an unreachable provider — the operator action differs, so conflating them is the bug. The message names no model and no price.
- [x] RED same file: `POST /api/routes` defaults `freeOnly` to `true` when absent; `PATCH` can set it false; that requires `routes.write` and writes a metadata-only audit row. Re-enabling free-only is **not** audited — only the money-spending direction is.
- [x] Verify RED — 7 of 13 failed for the intended reasons before implementation.
- [x] GREEN: `refreshModelCatalogue` on the provider manager persists via `CatalogueRepository`; the catalogue route calls it; `GET /api/models/free` reads the persisted rows; `no_free_route → 409` in `http-errors.ts`; `recordDecision` on the identity manager writes the `free_only_disabled` row.
- [x] Verify: `economics-api.test.ts` **13/13**; `@bayz/server` **252/252**; `@bayz/identity` 69/69; `@bayz/providers` 276/276; `tsc --noEmit -p apps/server` exit 0; smokes api 70/70, stream 63/63, usage 119/119, provider 36/36.

  **Deviations, recorded:**
  1. The planned "no decimal-looking substring" audit assertion was replaced with an exact key-set pin. The row's own `occurredAt` carries fractional seconds, so that regex either fails on a correct row or has to be loosened until it proves nothing. Pinning `["action","identityId","occurredAt","outcome","route","scope"]` is what actually forbids a price, prompt, or credential field being added later.
  2. `listFree()` filters in JS over `isFreeEconomics` rather than with a SQL `IN` list. Two places deciding what "free" means is how a classification silently becomes routable; the per-provider catalogue is small enough that the index gains nothing worth that risk.
  3. `freeModel()` fixtures must publish **all four** priced dimensions as zero. `FREE_VERIFIED` requires proof on every dimension, so a `{prompt, completion}`-only fixture classifies `UNKNOWN` — the classifier being strict, not the fixture being free.
- [x] Commit — `feat: persist Bayz model economics and expose the free set`

### Task 6c — Free-first model selection UX

**Modify:** `apps/dashboard/src/panels/ProvidersPanel.tsx`, `apps/dashboard/src/panels/RoutesPanel.tsx`, `apps/dashboard/src/api/client.ts`, `apps/dashboard/src/api/types.ts`
**Test:** `apps/dashboard/test/free-first-ux.test.tsx`

- [x] RED `free-first-ux.test.tsx`: a discovered model list shows each model with its economics as inert text; **free models are listed first and paid models are collapsed behind an explicit "show paid models" control that is closed by default** — asserted by checking that a `PAID` model is absent from the DOM until the control is activated, since "de-emphasised" must mean actually not offered by accident; `FREE_TIER` renders with its limited-quota qualification and `FREE_PREVIEW` with its temporary qualification, so neither reads as permanently free; `UNKNOWN` renders as `Unknown` and is grouped with paid, not with free.
- [x] RED same file: the route form's free-only toggle defaults to on; turning it off shows a plain-language warning that paid models may be charged; the toggle state round-trips through the API; a route that is free-only shows a `FREE ONLY` marker on its row.
- [x] RED same file: a `no_free_route` failure in the test chat panel renders the envelope's code and a plain-language explanation that no free model was available and **nothing was charged** — the second half matters, because an operator seeing only an error will assume a bug rather than a deliberate refusal.
- [x] RED same file: no economics value is rendered as markup; a hostile economics string from a tampered response falls back to `Unknown` rather than rendering; Flux Core files are untouched — asserted by the 9L SHA pin, and this test additionally asserts no import of anything under `src/flux/` was added.
- [x] Verify RED.
- [x] GREEN, monochrome only, no new visual language beyond the existing panel vocabulary.
- [x] Verify: `npm run test --workspace @bayz/dashboard` exits 0; `node scripts/dashboard-smoke.mjs` exits 0.
- [x] Commit — `feat: make Bayz model selection free-first`

Recorded deviations:

- **`CatalogueList` extracted as a component**, unlike Task 5's assign bar. It owns real
  logic — classification, free-first ordering, and the hidden count — so a caller cannot
  render the list and forget to withhold paid models.
- **`asEconomics` narrows on the way in.** The plan asked that a hostile economics string
  fall back to `Unknown`; doing that at the type boundary rather than at each render site
  means an unrecognised classification also groups with paid, so it cannot become
  silently spendable.
- **`no_free_route` help lives in `RoutesPanel`, not a chat panel.** There is no test chat
  panel in this dashboard; the refusal surfaces where routes are created and edited, which
  is where the operator can act on it.
- The economics choice is **not** reset after a successful create, unlike the rest of the
  form: an operator adding several paid routes should not re-confirm on each one.


### Amended Task 7 additions

- [x] `scripts/proxy-ux-smoke.mjs` additionally proves, against real origins: a provider whose catalogue reports zero pricing yields `FREE_VERIFIED` and is routable on a free-only route; a provider whose catalogue reports a non-zero price yields `PAID` and a free-only route to it fails `no_free_route` with **zero requests observed at that origin**; a provider whose catalogue omits pricing yields `UNKNOWN` and is likewise refused; a loopback provider yields `LOCAL` and is routable; disabling free-only on one route does not affect another; `GET /api/models/free` lists exactly the free set. **127/127 checks PASS** (sections 13–15, +40 checks).
- [x] Commit — `test: prove Bayz free-only routing spends nothing`

**Two constraints this section ran into, both recorded because they shape the test.**

`routes_model_provider_idx` is UNIQUE on `(model, provider_id)`, so "two routes to the
same model that disagree about free-only" requires **two providers**. A second paid
origin publishing the same model id is what makes the scenario real; without it the
second `POST /api/routes` returns 409 and the assertion is vacuous. The first version of
this section did exactly that and reported a false FAIL, which is how the constraint
surfaced.

Loopback origins cannot exercise `PAID` or `UNKNOWN` at all: `allowLoopback` short-circuits
classification to `LOCAL` before the catalogue is consulted. The economics origins bind a
private LAN address with `allowPrivate: true`, and the section **skips with an explicit
message** when the host has no non-loopback IPv4 rather than asserting something weaker.

### Amended completion checklist additions

- [x] `routes.free_only` defaults to 1; existing rows migrate to 1.
- [x] `UNKNOWN` and `PAID` are both excluded from a free-only route.
- [x] No paid fallback on failure, rate limit, timeout, or 5xx — proven by zero requests at the paid origin.
- [x] `no_free_route` is a distinct 409 naming no model and no price.
- [x] `model_catalogue` holds only id and classification; no content column — pinned by an exact column-set assertion in `packages/storage/test/migrations.test.ts`.
- [x] Paid models are not in the DOM until explicitly requested — asserted absent via `queryByTestId`, not merely hidden by CSS.
- [x] `FREE_TIER` and `FREE_PREVIEW` carry their qualifications in the UI ("free within a quota", "free while in preview").
- [x] Flux Core untouched — no file under `src/flux/` modified in 9E; the two panels changed here are asserted to import nothing from it.
