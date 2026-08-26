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
