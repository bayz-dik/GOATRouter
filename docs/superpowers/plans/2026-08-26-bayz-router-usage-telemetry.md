# Bayz Router — Usage Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Phase 8 per `docs/superpowers/specs/2026-08-26-bayz-router-usage-telemetry-design.md`: a metadata-only telemetry boundary, usage storage with retention, a usage API, real Flux Core data, and a strict CSP — strict RED→GREEN→REFACTOR, one commit per green task.

**Ground rules:** Telemetry is metadata only — no prompt, completion, body, header, credential, or arbitrary error text, proven by byte scans and source scans. Flux Core visuals are LOCKED: wire state, change no geometry or motion. No new dependency. No `node:sqlite` outside the driver. No per-frame React updates. Retention touches only usage tables. CSP is not relaxed to accommodate implementation. No push to GitHub.

---

### Task 1: Design and plan documents

- [x] Spec written.
- [ ] Plan written.
- [ ] Commit — `docs: add Phase 8 usage telemetry design and plan`.

### Task 2: Telemetry event boundary and validation

- [ ] RED `packages/telemetry/test/events.test.ts`: the recorder copies only the closed field set onto a fresh row; an event carrying `prompt`/`messages`/`completion`/`body`/`authorization`/`apiKey` yields a row containing none of them; `failureCategory` outside the enum becomes `unknown_error`; arbitrary upstream error text cannot survive; every integer bound enforced (negative, non-integer, overflow, NaN); timestamps outside ±24 h replaced; over-long ids rejected; malformed events dropped without partial state.
- [ ] Scaffold `packages/telemetry` (deps `@bayz/storage`, `@bayz/security`), `src/{errors,events,normalize,index}.ts`; register in root `runtime:build`.
- [ ] GREEN + `tsc --noEmit`. Commit — `feat: add Bayz telemetry event boundary`.

### Task 3: Usage storage, migration v5, retention

- [ ] RED: update `packages/storage/test/migrations.test.ts` (fresh tables include `usage_requests` and `usage_attempts`; keep bans on combos/logs/clients; pin v5 columns; assert **no** content-like column exists on either table); RED `packages/telemetry/test/repository.test.ts` covering insert, read-back, ordering, retention pruning bounds, and that pruning deletes only usage rows (providers/proxies/routes/secrets untouched).
- [ ] GREEN: migration v5 + `src/repository.ts`.
- [ ] Both suites green; storage smoke green. Commit — `feat: add Bayz usage telemetry persistence`.

### Task 4: Router emits telemetry

- [ ] RED `packages/router/test/telemetry.test.ts`: a successful chat emits one `request.completed` plus one `provider.attempted`; a failover emits attempt-failed then attempt-ok then `failover.started`; a total failure emits `request.failed` with a normalized category; a 40-provider Combo emits per-provider attempts; the prompt sentinel appears in **no** emitted event; token counts absent from the upstream stay `undefined` rather than becoming 0; a throwing recorder never breaks a chat request.
- [ ] GREEN: optional `recorder` on `createRouter`.
- [ ] Router suite + router smoke green. Commit — `feat: emit routing telemetry from the Bayz router`.

### Task 5: Usage API endpoints

- [ ] RED `apps/server/test/usage-api.test.ts`: all three endpoints require the token; summary reports counts, outcome split, token totals where known, and `costAvailable: false` with a stated reason; unknown tokens stay `null`; requests list is metadata-only and bounded by `limit`; providers list reports derived state; no response body contains a prompt, completion, or credential sentinel; invalid `period`/`limit` → 400.
- [ ] GREEN `apps/server/src/routes/usage.ts` + runtime wiring.
- [ ] Server suite + api smoke green. Commit — `feat: add Bayz usage API endpoints`.

### Task 6: Strict Content-Security-Policy

- [ ] RED `apps/server/test/csp.test.ts`: the dashboard document carries the policy from the spec; no `unsafe-inline`, no `unsafe-eval`, no remote origin; `default-src 'none'`; API responses carry it too; the policy is not weakened by any option.
- [ ] GREEN `apps/server/src/security-headers.ts`; extend `scripts/dashboard-smoke.mjs` to assert the built dashboard needs no inline script or style.
- [ ] Commit — `feat: serve a strict Content-Security-Policy`.

### Task 7: Flux Core real data

- [ ] RED `apps/dashboard/test/flux-adapter.test.ts`: the adapter maps usage + provider data to a `source: "live"` view model; derives active/degraded/failed/standby/off from attempt outcomes; preserves 1/5/12/40/120 provider counts without truncation; keeps duplicate custom names distinguishable; renders a failed provider as identifiable; malformed API data degrades safely rather than throwing; the adapter introduces no per-frame update.
- [ ] GREEN `apps/dashboard/src/flux/adapter.ts` + polling wiring in `App.tsx`.
- [ ] Dashboard suite + dashboard smoke green. Commit — `feat: drive Flux Core from real usage telemetry`.

### Task 8: Adversarial suite, non-mocked smoke, phase gate, docs

- [ ] RED `packages/telemetry/test/adversarial.test.ts`: source scan proves no telemetry `INSERT`/`UPDATE` names a content column; a hostile event object with 30 extra keys yields a clean row; prototype pollution cannot reach a row; retention cannot be disabled by a malformed config; recorded rows survive a byte scan for sentinels.
- [ ] `scripts/usage-smoke.mjs`: real listener, real ok origin, real failing origin, real `CONNECT` proxy, real chats through the real router; then scan `bayz.db`/`-wal`/`-shm`, every usage API response, and captured logs for prompt/completion/credential sentinels; verify summary/requests/providers reflect the real traffic; verify CSP header present.
- [ ] Gate: `npm run runtime:test`, `runtime:build`, `runtime:verify`, `node --test tests/runtime-structure.test.mjs`, all seven smoke scripts, secret/persistence/remote scans, `git diff --check`.
- [ ] Docs: README usage/telemetry/CSP sections; `WORK-HANDOFF.md` Phase 8 state, retention policy, and residual risks.
- [ ] Commit — `feat: wire Bayz usage telemetry`.

## Completion checklist

- All suites green; every `tsc --noEmit` exits 0; `runtime:verify` exits 0.
- All seven smoke scripts exit 0 against real artifacts.
- Prompt, completion, credential, and Authorization bytes absent from database, WAL, SHM, logs, and every telemetry response — proven by scan.
- Unknown token counts stay unknown; cost reported unavailable, never invented.
- Retention bounded and scoped to usage tables only.
- Strict CSP served and verified against the built dashboard.
- Flux Core receives real state with no per-frame React update and no visual regression.
- Many-provider behaviour (1/5/12/40/120, duplicates, failures) intact.
