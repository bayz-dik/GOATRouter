# Bayz Router — Operator Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Phase 7 per `docs/superpowers/specs/2026-08-26-bayz-router-dashboard-design.md`: a typed API client and operator panels inside the existing dashboard shell — strict RED→GREEN→REFACTOR, one commit per green task.

**Ground rules:** Flux Core stays LOCKED; no Flux file is created or modified. No new dependency. The token lives in memory only — never `localStorage`, `sessionStorage`, a cookie, or a URL. No credential or password is ever rendered, masked or otherwise. No prompt or completion is persisted. No streaming UI. `/api/health` and every Phase 1–6 contract stays green.

---

### Task 1: Design and plan documents

- [x] Spec written.
- [ ] Plan written.
- [ ] Commit — `docs: add Phase 7 dashboard design and plan`.

### Task 2: Typed API client

- [ ] RED `apps/dashboard/test/client.test.ts` against a stubbed `fetch`: bearer header injected; `credentials: "omit"` on every call; JSON content type only for bodies; error envelope parsed into `ApiError` with `status`/`code`/`message`/`requestId`; a non-envelope body still yields a usable error; ids `encodeURIComponent`-escaped; `AbortSignal.timeout` present; no method name matches `/get(Credential|Password)/`.
- [ ] GREEN `apps/dashboard/src/api/{client.ts,types.ts}`.
- [ ] Commit — `feat: add Bayz dashboard API client`.

### Task 3: Token entry held in memory only

- [ ] RED `apps/dashboard/test/token.test.ts`: entering a token enables requests; the token is absent from `localStorage`, `sessionStorage`, and `document.cookie` after entry; a `401` clears it and returns to the entry form; the input is `type="password"` with `autocomplete="off"`; nothing renders the token back to the DOM.
- [ ] GREEN `apps/dashboard/src/api/token.ts` + `TokenGate` component.
- [ ] Commit — `feat: add in-memory dashboard token gate`.

### Task 4: Status panel

- [ ] RED: renders schema version, driver, journal mode, key provider, counts; shows the envelope `code`/`message` on failure; never renders a field named like a secret even if the API returned one.
- [ ] GREEN `apps/dashboard/src/panels/StatusPanel.tsx`.
- [ ] Commit — `feat: add dashboard status panel`.

### Task 5: Providers panel

- [ ] RED: list/create/toggle/delete; credential field is write-only, clears on submit, and its value never appears in the DOM afterwards; `credentialPresent` shown as a boolean indicator only; discover renders the returned models; a `501` from `codex-oauth` shows the message rather than a crash.
- [ ] GREEN `apps/dashboard/src/panels/ProvidersPanel.tsx`.
- [ ] Commit — `feat: add dashboard providers panel`.

### Task 6: Proxies panel

- [ ] RED: list/create/toggle/delete; password field write-only and cleared; `passwordPresent` boolean only; check shows `ok` and latency; a `502` refusal shows the code.
- [ ] GREEN `apps/dashboard/src/panels/ProxiesPanel.tsx`.
- [ ] Commit — `feat: add dashboard proxies panel`.

### Task 7: Routes panel and test chat

- [ ] RED: route list/create/toggle/delete/priority/proxy binding; unknown provider surfaces `invalid_route_config`; chat panel loads models from `/v1/models`, sends one message, renders the reply and the routing headers; no transcript survives a remount; the panel offers no streaming control.
- [ ] GREEN `apps/dashboard/src/panels/{RoutesPanel,ChatPanel}.tsx` and shell wiring.
- [ ] Commit — `feat: add dashboard routes panel and test chat`.

### Task 8: Adversarial suite, build smoke, phase gate, docs

- [ ] RED `apps/dashboard/test/adversarial.test.ts`: source scan over `apps/dashboard/src` finds no `localStorage`/`sessionStorage`/`document.cookie` write and no credential accessor; no panel renders a value from a `credential`/`password`/`token` field; an API response containing an unexpected secret-shaped field is not rendered.
- [ ] `scripts/dashboard-smoke.mjs`: build the dashboard, then scan the emitted bundle for `localStorage.setItem`, `sessionStorage.setItem`, `document.cookie =`, and any 64-hex literal. Non-zero exit on any hit.
- [ ] Gate: `npm run runtime:test`, `npm run runtime:build`, `npm run runtime:verify`, `node --test tests/runtime-structure.test.mjs`, all six smoke scripts, secret scan, getter scan, `git diff --check`, and `git log -- apps/dashboard` reviewed to confirm Phase 7 is the only change since Phase 1.
- [ ] Docs: README dashboard section (token re-entry on reload and why; write-only fields; no streaming); `WORK-HANDOFF.md` Phase 7 state and deviations.
- [ ] Commit — `feat: wire Bayz operator dashboard`.

## Completion checklist

- All suites green; every `tsc --noEmit` exits 0; `runtime:verify` exits 0.
- All six smoke scripts exit 0.
- Token never persisted anywhere (proven by source scan *and* built-bundle scan).
- No credential, password, or token is ever rendered.
- No prompt or completion persisted.
- Flux Core untouched and still untracked; no visual redesign.
- Zero new dependencies.
