# Phase 9E — Multi-Provider + Multi-Proxy Easy UX

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Spec:** `docs/superpowers/specs/2026-08-27-bayz-phase9-goat-release-design.md` §9

**Depends on:** nothing (parallel with 9C and 9D)

**Goal:** Make multi-provider proxy management genuinely easy. This is a release requirement, not polish — backend support already exists and is insufficient.

**Locks:** No proxy password is ever displayed or returned. No config-file editing for any normal operation. Flux Core visuals untouched; it only receives proxy identity it already accepts.

**Repository constraint driving the design:** `proxy_id` currently lives only on `routes` (`packages/router/src/repository.ts`), and `packages/providers/src/repository.ts` has zero occurrences of `proxyId`. Assigning one proxy to forty providers today means editing forty routes. That is the gap.

**Migration numbering:** the spec's ledger (§4) labels this subprogram's migration v7, assuming 9C takes v6 from the v5 baseline. 9D and 9E run in **parallel**, so if 9D's kind migration lands first this one becomes v8 — whichever lands second renumbers and updates both plan texts in the same commit. No test hardcodes the head version.

---

### Task 1 — Provider-level proxy default (migration v7)

**Modify:** `packages/storage/src/migrations.ts`, `packages/storage/test/migrations.test.ts`, `packages/providers/src/repository.ts`, `packages/providers/src/manager.ts`
**Test:** `packages/providers/test/provider-proxy.test.ts`

**Schema:** migration v7 adds `providers.proxy_id TEXT REFERENCES proxies(id) ON DELETE SET NULL`

- [ ] RED `packages/storage/test/migrations.test.ts`: fresh `providers` gains `proxy_id` as a 9th column; the pinned column set updates; deleting a proxy sets dependent `providers.proxy_id` to NULL (degrade to direct, never break); existing rows survive the migration with `proxy_id` NULL.
- [ ] RED `packages/providers/test/provider-proxy.test.ts`: create with `proxyId` validates the proxy exists (pre-SQL, `invalid_provider_config` for unknown); `updateProvider` can set and clear it with `null`; the view exposes `proxyId` and never a password; a provider with no proxy reports `undefined`, not `""`.
- [ ] Verify RED: `node --import tsx --test packages/storage/test/migrations.test.ts` fails on the column-set assertion.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/storage` and `--workspace @bayz/providers` exit 0; `node scripts/storage-smoke.mjs` still 42/42; `node scripts/provider-smoke.mjs` still 36/36.
- [ ] Commit — `feat: add a provider-level proxy default`

### Task 2 — Proxy resolution order in the router

**Modify:** `packages/router/src/router.ts`
**Test:** `packages/router/test/proxy-resolution.test.ts`

**Resolution:** route override → provider default → direct

- [ ] RED `proxy-resolution.test.ts`: a route with `proxyId` uses it even when the provider has a different default (override wins); a route with no `proxyId` uses the provider default; neither set means direct; a route explicitly set to direct must be distinguishable from "unset" — introduce `proxyId: null` on the route meaning *force direct*, and pin that it beats the provider default; telemetry records the **effective** proxy id, not the route's raw value; the effective proxy is reported in the `x-bayz-proxy` header.
- [ ] Verify RED.
- [ ] GREEN. Note in code why `null` (force direct) and `undefined` (inherit) must differ, since collapsing them makes "opt this one route out" impossible.
- [ ] Verify: `npm run test --workspace @bayz/router` exits 0; `node scripts/router-smoke.mjs` still 46/46.
- [ ] Commit — `feat: resolve Bayz proxies by route override then provider default`

### Task 3 — Bulk assignment API

**Modify:** `apps/server/src/routes/proxies.ts`
**Test:** `apps/server/test/proxy-bulk-api.test.ts`

**Routes:**
```text
POST /api/proxies/:id/assign     { providerIds: string[] }
POST /api/proxies/:id/unassign   { providerIds: string[] }
GET  /api/proxies/:id/usage
```

- [ ] RED `proxy-bulk-api.test.ts`: assign accepts up to 200 ids and refuses more; every id is validated pre-SQL and one bad id fails the whole call **atomically** (assert no partial assignment); assigning to an unknown provider is `400`, not a silent skip; unassign sets those providers to direct; `usage` returns `{ providerCount, routeCount, providerIds }` with ids but no password and no credential; all three require `proxies.write` (or `proxies.read` for usage); assigning a disabled proxy is allowed but the response notes it (an operator may stage config before enabling); a duplicate id in the array is deduplicated rather than applied twice.
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/server` exits 0; `node scripts/api-smoke.mjs` still 62/62.
- [ ] Commit — `feat: add Bayz bulk proxy assignment API`

### Task 4 — Proxy panel: full lifecycle and test connection

**Modify:** `apps/dashboard/src/panels/ProxiesPanel.tsx`, `apps/dashboard/src/api/client.ts`
**Test:** `apps/dashboard/test/proxies-panel-ux.test.tsx`

- [ ] RED `proxies-panel-ux.test.tsx`: create supports both `socks5` and `http` with a kind selector; edit changes host, port, username, enabled, and config; delete confirms; the password field is `type="password"`, `autocomplete="off"`, and clears on submit with the value absent from the DOM afterwards; Test Connection shows `ok` with measured latency, or the fixed failure code, or an explicit "not measured" — never a fabricated number; a disabled proxy renders distinctly; a degraded proxy renders distinctly; every row shows "used by N providers, M routes"; a `502 refused` shows the code and message from the envelope.
- [ ] RED same file: nothing in the panel renders a value from a field matching `/password|credential|secret/`.
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/dashboard` exits 0.
- [ ] Commit — `feat: complete the Bayz proxy panel lifecycle`

### Task 5 — Provider multi-select and one-action assignment

**Modify:** `apps/dashboard/src/panels/ProvidersPanel.tsx`
**Create:** `apps/dashboard/src/panels/ProxyAssignBar.tsx`
**Test:** `apps/dashboard/test/proxy-assign-ux.test.tsx`

- [ ] RED `proxy-assign-ux.test.tsx`: each provider row has a selection checkbox; select-all selects every visible provider; a filter box narrows the list and select-all then selects only the filtered set (assert with 40 providers, filter matching 12); the assign bar appears only with a selection and shows the count; choosing a proxy and confirming issues **one** `assign` call carrying all selected ids (assert the client was called once, not N times); "Set to Direct" issues one `unassign`; the bar clears after success; a failure shows the envelope code and leaves the selection intact so the operator can retry.
- [ ] RED same file: with 120 providers, select-all then assign still issues one call, and the rendered row count stays 120 (no truncation).
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/dashboard` exits 0.
- [ ] Commit — `feat: add Bayz bulk provider proxy assignment UX`

### Task 6 — Effective proxy visibility

**Modify:** `apps/dashboard/src/panels/ProvidersPanel.tsx`, `apps/dashboard/src/panels/RoutesPanel.tsx`
**Test:** `apps/dashboard/test/effective-proxy.test.tsx`

- [ ] RED `effective-proxy.test.tsx`: a provider row shows its proxy id or `Direct`; a route row shows the **effective** proxy plus whether it is `inherited` or `overridden`; a route forcing direct against a proxied provider shows `Direct (override)`; the proxy id renders as inert text even when hostile; a proxy that was deleted leaves the provider showing `Direct` with no dangling id.
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/dashboard` exits 0; `node scripts/dashboard-smoke.mjs` exits 0.
- [ ] Commit — `feat: show effective Bayz proxy assignment in the dashboard`

### Task 7 — Multi-proxy UX smoke

**Create:** `scripts/proxy-ux-smoke.mjs`

- [ ] Non-mocked: real listener, two real CONNECT proxies, one real SOCKS5 proxy, twelve real loopback provider origins. Prove: create all three proxies through the API; bulk-assign proxy A to twelve providers in one call; a chat through each provider traverses proxy A (assert each proxy's connect log); bulk-reassign six providers to proxy B in one call and prove the split; set three to Direct and prove no tunnel; a route override beats the provider default; `usage` reports the correct counts; deleting proxy B degrades its providers to Direct without breaking them; scan db/wal/shm/logs/responses for both proxy passwords — zero occurrences.
- [ ] Verify: `node scripts/proxy-ux-smoke.mjs` exits 0.
- [ ] Verify full gate: `npm run runtime:verify`; every smoke script; `git diff --check`.
- [ ] Commit — `test: add Bayz multi-proxy UX smoke`

## Completion checklist

- [ ] Migration v7 adds `providers.proxy_id`; proxy deletion degrades to direct.
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

- [ ] RED `packages/storage/test/migrations.test.ts`: `routes` gains `free_only`; the pinned column set updates; **every pre-existing route migrates to `free_only = 1`** — the safe value, asserted explicitly, because migrating to 0 would silently enable paid routing on an existing install; the CHECK rejects 2.
- [ ] RED `free-only.test.ts`: a route with `freeOnly: true` selects only candidates whose economics `isFreeEconomics`; a `PAID` candidate is excluded; **an `UNKNOWN` candidate is excluded** (asserted separately and first); `LOCAL`, `FREE_VERIFIED`, `FREE_TIER`, and `FREE_PREVIEW` are all eligible; with `freeOnly: false` every candidate is eligible; the flag is per route, so two routes for the same model can differ.
- [ ] RED same file, **the no-fallback rule**: a free-only route whose only free candidate fails does **not** try a paid candidate that exists and is healthy — assert the paid provider's origin observed **zero** requests, which is the only assertion that actually proves money was not spent; the request fails `no_free_route`; the same holds when the free candidate is rate-limited, when it times out, and when it returns 500, since each is a plausible excuse for a fallback and none is acceptable.
- [ ] RED same file: a free-only route with no free candidate at all fails `no_free_route` **before** any upstream request; the error is a fixed message naming no model and no provider; telemetry records `request.failed` with the fixed code and no candidate list.
- [ ] RED same file: a free-only route whose free candidate list becomes empty mid-failover (the second attempt's provider was reclassified `PAID` by a fresh discovery) fails `no_free_route` rather than continuing.
- [ ] Verify RED.
- [ ] GREEN. Economics come from a cached catalogue read, not a live discovery call per request — note in code why: a per-request discovery would add an upstream round trip to every chat and would let a discovery outage silently empty the free set, turning an availability problem into a `no_free_route` storm.
- [ ] Verify: `npm run test --workspace @bayz/router` and `--workspace @bayz/storage` exit 0; `node scripts/router-smoke.mjs` still 46/46; `node scripts/storage-smoke.mjs` still 42/42.
- [ ] Commit — `feat: add Bayz free-only routing with no paid fallback`

### Task 6b — Model catalogue persistence and API surface

**Modify:** `packages/storage/src/migrations.ts` (same migration as 6a), `packages/providers/src/repository.ts`, `apps/server/src/routes/providers.ts`, `apps/server/src/routes/routes.ts`, `apps/server/src/errors.ts`
**Test:** `apps/server/test/economics-api.test.ts`

**Schema:** `model_catalogue (provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE, model TEXT NOT NULL, economics TEXT NOT NULL, discovered_at TEXT NOT NULL, PRIMARY KEY (provider_id, model))`

The table stores an id and a classification. It is **not** content-bearing: no prompt, no completion, no pricing value, no description. A schema-pinning test asserts the four-column set so a later phase cannot add a `description` column.

- [ ] RED `economics-api.test.ts`: `POST /api/providers/:id/discover` persists the catalogue and returns `{ models: [{ id, economics }] }`; the legacy `{ models: string[] }` shape is **also** still available under the existing contract so the Phase 3 smoke does not break — assert both, since silently changing a response shape is how a client breaks in the field; `GET /api/models/free` returns the aggregated free set across every enabled provider with no duplicate model id and no `UNKNOWN` or `PAID` entry; the aggregate requires `models.read`; a provider with no catalogue contributes nothing rather than erroring; deleting a provider cascades its catalogue rows away.
- [ ] RED same file: a free-only route that cannot be satisfied returns HTTP **409** with the stable envelope and code `no_free_route`, distinct from a 503 `unreachable`, because the operator action differs — one means "add a free provider", the other means "the network is down". The message names no model and no price.
- [ ] RED same file: `POST /api/routes` accepts `freeOnly` and defaults it to `true` when absent; `PATCH` can set it false; setting it false requires `routes.write` and is recorded in the audit as a metadata-only event, since enabling paid spending is exactly the kind of change an operator will later want to explain.
- [ ] Verify RED.
- [ ] GREEN.
- [ ] Verify: `npm run test --workspace @bayz/server` exits 0; `node scripts/api-smoke.mjs` still 62/62.
- [ ] Commit — `feat: expose Bayz free model aggregation and free-only routes`

### Task 6c — Free-first model selection UX

**Modify:** `apps/dashboard/src/panels/ProvidersPanel.tsx`, `apps/dashboard/src/panels/RoutesPanel.tsx`, `apps/dashboard/src/api/client.ts`, `apps/dashboard/src/api/types.ts`
**Test:** `apps/dashboard/test/free-first-ux.test.tsx`

- [ ] RED `free-first-ux.test.tsx`: a discovered model list shows each model with its economics as inert text; **free models are listed first and paid models are collapsed behind an explicit "show paid models" control that is closed by default** — asserted by checking that a `PAID` model is absent from the DOM until the control is activated, since "de-emphasised" must mean actually not offered by accident; `FREE_TIER` renders with its limited-quota qualification and `FREE_PREVIEW` with its temporary qualification, so neither reads as permanently free; `UNKNOWN` renders as `Unknown` and is grouped with paid, not with free.
- [ ] RED same file: the route form's free-only toggle defaults to on; turning it off shows a plain-language warning that paid models may be charged; the toggle state round-trips through the API; a route that is free-only shows a `FREE ONLY` marker on its row.
- [ ] RED same file: a `no_free_route` failure in the test chat panel renders the envelope's code and a plain-language explanation that no free model was available and **nothing was charged** — the second half matters, because an operator seeing only an error will assume a bug rather than a deliberate refusal.
- [ ] RED same file: no economics value is rendered as markup; a hostile economics string from a tampered response falls back to `Unknown` rather than rendering; Flux Core files are untouched — asserted by the 9L SHA pin, and this test additionally asserts no import of anything under `src/flux/` was added.
- [ ] Verify RED.
- [ ] GREEN, monochrome only, no new visual language beyond the existing panel vocabulary.
- [ ] Verify: `npm run test --workspace @bayz/dashboard` exits 0; `node scripts/dashboard-smoke.mjs` exits 0.
- [ ] Commit — `feat: make Bayz model selection free-first`

### Amended Task 7 additions

- [ ] `scripts/proxy-ux-smoke.mjs` additionally proves, against real origins: a provider whose catalogue reports zero pricing yields `FREE_VERIFIED` and is routable on a free-only route; a provider whose catalogue reports a non-zero price yields `PAID` and a free-only route to it fails `no_free_route` with **zero requests observed at that origin**; a provider whose catalogue omits pricing yields `UNKNOWN` and is likewise refused; a loopback provider yields `LOCAL` and is routable; disabling free-only on one route lets the paid provider through while a second free-only route to the same model still refuses.
- [ ] Commit — `test: prove Bayz free-only routing spends nothing`

### Amended completion checklist additions

- [ ] `routes.free_only` defaults to 1; existing rows migrate to 1.
- [ ] `UNKNOWN` and `PAID` are both excluded from a free-only route.
- [ ] No paid fallback on failure, rate limit, timeout, or 5xx — proven by zero requests at the paid origin.
- [ ] `no_free_route` is a distinct 409 naming no model and no price.
- [ ] `model_catalogue` holds only id and classification; no content column.
- [ ] Paid models are not in the DOM until explicitly requested.
- [ ] `FREE_TIER` and `FREE_PREVIEW` carry their qualifications in the UI.
- [ ] Flux Core untouched.
