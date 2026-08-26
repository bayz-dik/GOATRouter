# Bayz Router — Local HTTP API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Phase 6 per `docs/superpowers/specs/2026-08-26-bayz-router-http-api-design.md`: token authentication, rate limiting, provider/proxy/route CRUD, and an OpenAI-compatible chat endpoint — strict RED→GREEN→REFACTOR, one commit per green task.

**Ground rules:** `/api/health` stays byte-identical and unauthenticated. No credential or password read endpoint. No CORS. Loopback default; `BAYZ_ALLOW_REMOTE` without a token is a startup failure. No streaming. No combos or usage. `apps/dashboard` and Flux Core untouched. No new dependencies beyond what `apps/server` already has. No push to GitHub.

---

### Task 1: Design and plan documents

- [x] Spec written.
- [ ] Plan written.
- [ ] Commit — `docs: add Phase 6 HTTP API design and plan`.

### Task 2: API token custody

- [ ] RED `apps/server/test/api-token.test.ts`: generated on first start, 32 bytes, stored at `api:token`, printed once and never again; `BAYZ_API_TOKEN` takes precedence; a stored token survives restart; comparison is digest-based and timing-safe; no accessor returns the token after generation; a corrupt stored token fails closed.
- [ ] GREEN `apps/server/src/api-token.ts`. Commit — `feat: add Bayz API token custody`.

### Task 3: Authentication and rate-limit hooks

- [ ] RED `apps/server/test/auth.test.ts`: `/api/health` reachable without a token and byte-identical to Phase 1; every `/api/*` and `/v1/*` route 401s without a token; malformed header 401s; wrong token 401s with an identical body; correct token passes; the error envelope keeps `{error:{code,message},requestId}`; failed-auth attempts are rate limited to 10/min and then 429; successful requests limited to 120/min; no CORS header on any response.
- [ ] GREEN `apps/server/src/auth.ts`. Commit — `feat: add Bayz API authentication and rate limiting`.

### Task 4: Runtime wiring for the managers

- [ ] RED `apps/server/test/runtime.test.ts`: a single `SecretStorage` is shared by all three managers; `close()` releases it exactly once; `/api/status` reports schema version, driver, journal mode, key provider, and counts without any key material; startup fails non-zero when `BAYZ_ALLOW_REMOTE` is set with no token available.
- [ ] GREEN `apps/server/src/runtime.ts`. Commit — `feat: wire Bayz managers into the runtime`.

### Task 5: Provider endpoints

- [ ] RED `apps/server/test/providers-api.test.ts`: full CRUD; `PUT credential` returns 204 and no body; `DELETE credential`; `POST discover` against a real loopback upstream; no response body ever contains the stored credential; `codex-oauth` credential set returns 501; unknown id 404; duplicate 409; invalid body 400; wrong content-type 415.
- [ ] GREEN `apps/server/src/routes/providers.ts`. Commit — `feat: add Bayz provider API endpoints`.

### Task 6: Proxy endpoints

- [ ] RED `apps/server/test/proxies-api.test.ts`: full CRUD; `PUT password` 204; `POST check` against a real loopback `CONNECT` proxy; password never in any response; password-without-username 400; unknown id 404; disabled proxy check 501.
- [ ] GREEN `apps/server/src/routes/proxies.ts`. Commit — `feat: add Bayz proxy API endpoints`.

### Task 7: Route endpoints and chat

- [ ] RED `apps/server/test/routes-api.test.ts` and `apps/server/test/chat-api.test.ts`: route CRUD; unknown provider 400; `POST /v1/chat/completions` completes against a real origin and returns the OpenAI response shape; `stream: true` → 400 with a message naming streaming as unimplemented; unbound model → 400 `no_route`; upstream 401 → 502; `GET /v1/models` lists models from enabled routes only; no prompt appears in any log.
- [ ] GREEN `apps/server/src/routes/routes.ts`, `apps/server/src/routes/chat.ts`. Commit — `feat: add Bayz route and chat API endpoints`.

### Task 8: Adversarial suite, non-mocked smoke, phase gate, docs

- [ ] RED `apps/server/test/api-adversarial.test.ts`: source scan finds no credential-returning handler; every response body across a full exercise is scanned for the stored credential, password, and root key; path traversal in `:id` 400s without touching storage; oversized body 413; prototype-pollution payload cannot poison the process; unauthenticated access to every route enumerated from the Fastify route table (so a newly added route cannot silently skip auth).
- [ ] `scripts/api-smoke.mjs`: real server on a free port, real HTTP, real origin; proves 401→200, byte-identical `/api/health`, a full provider→route→chat flow, no credential in any body, and `stream` rejection.
- [ ] Gate: `npm run runtime:test`, `npm run runtime:build`, `npm run runtime:verify`, `node --test tests/runtime-structure.test.mjs`, all five smoke scripts, secret scan, getter scan, `git diff --check`.
- [ ] Docs: README API section (token handling, loopback default, rate-limit honesty, no streaming); `WORK-HANDOFF.md` Phase 6 state and deviations.
- [ ] Commit — `feat: wire Bayz local HTTP API`.

## Completion checklist

- All suites green; every `tsc --noEmit` exits 0; `runtime:verify` exits 0.
- All five smoke scripts exit 0 against real artifacts.
- `/api/health` byte-identical and unauthenticated; every other route authenticated (enumerated, not assumed).
- No credential/password read endpoint; no response body contains a stored secret.
- No CORS headers; loopback default preserved; remote requires a token.
- Streaming rejected explicitly, not silently ignored.
- `apps/dashboard` and Flux Core untouched; `node:sqlite` single-import; no new dependencies.
