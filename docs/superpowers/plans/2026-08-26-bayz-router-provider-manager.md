# Bayz Router — Provider Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Phase 3 per `docs/superpowers/specs/2026-08-26-bayz-router-provider-manager-design.md`: scoped secret views, provider registry (migration v2), strict validation, capped upstream gateway, untrusted discovery (OpenAI-compatible, Gemini, OpenRouter), and a `ProviderManager` with **no** credential read path — strict RED→GREEN→REFACTOR per task, one commit per green task.

**Ground rules:** Do not repeat Phase 1/2 work. `apps/dashboard` untouched. `/api/health` byte-stable. `node:sqlite` still imported in exactly one file. No new dependencies (validation is hand-rolled, not zod — documented deviation). No SQL outside `@bayz/storage` except parameterized statements inside `packages/providers/src/repository.ts`. Never log or return a credential. Default host/port/data-dir unchanged. No push to GitHub.

---

### Task 1: Design and plan documents

- [x] Write spec `docs/superpowers/specs/2026-08-26-bayz-router-provider-manager-design.md`.
- [ ] Write this plan.
- [ ] Commit — `docs: add Phase 3 provider manager design and plan`.

### Task 2: Scoped secret views (`@bayz/storage`)

- [ ] RED `test/scoped.test.ts`: round-trip incl. UTF-8; physical name `provider:<id>:api_key` proven via `inspect`; two-way isolation between scopes sharing a field; `list()` filters + strips prefix; segments/fields rejecting uppercase, empty, >63, leading `-`/`.`, `".."`, `":"`; `invalid_argument` code; corrupted record under a scoped name throws `secret_corrupt` from both `find` and `get` (never `undefined`).
- [ ] Verify RED.
- [ ] GREEN: add `invalid_argument` to `errors.ts`, create `src/scoped.ts`, export from `index.ts`.
- [ ] Full `@bayz/storage` suite + `tsc --noEmit`.
- [ ] Commit — `feat: add scoped Bayz secret storage views`.

### Task 3: Provider validation boundary (`@bayz/providers` scaffold)

- [ ] RED `test/validation.test.ts`: id regex accept/reject matrix; URL normalization (scheme/host lowercase, userinfo rejected, query/fragment stripped, trailing slash trimmed, 2048 cap, non-http(s) rejected, garbage rejected) — messages contain no raw input; strict config parsing (defaults, ranges, integer-only, unknown keys rejected incl. header-smuggling shapes, path-only `discoveryPath`, `".."` refused); `ProviderError` fixed messages, `cause` never set.
- [ ] Scaffold `package.json` (dep `@bayz/storage` only), `tsconfig.json` mirroring storage, `src/{errors,url,config,index}.ts`; register workspace build in root `package.json`.
- [ ] GREEN + `tsc --noEmit`.
- [ ] Commit — `feat: add Bayz provider validation boundary`.

### Task 4: Registry migration v2 + repository CRUD

- [ ] RED: update `packages/storage/test/migrations.test.ts` pins (fresh-tables list includes `providers`; speculative-schema ban drops `providers`, keeps proxies/routes/routing/combos/usage/requests/logs/clients; v2 column set pinned, no credential-like columns); RED `test/repository.test.ts`.
- [ ] GREEN: append migration v2 to `src/migrations.ts`; `src/repository.ts` with client-side validation + `SELECT`-before-INSERT (driver folds all throws into `storage_unavailable`, so constraints are backstops only); corrupt `config_json` → `invalid_provider_config` (`load-config`).
- [ ] Both suites green; storage + providers builds pass.
- [ ] Commit — `feat: add Bayz provider registry persistence`.

### Task 5: Upstream HTTP gateway

- [ ] RED `test/http-gateway.test.ts` against a real `node:http` loopback server and against fake fetchers: success JSON; timeout → `unreachable`; connection refused → `unreachable`; 401/403 → `auth_failed`; 429 → `rate_limited`; 500 → `upstream_error`; oversized body aborted mid-stream → caller-chosen code; invalid UTF-8/bad JSON → `discovery_failed` path; no error message ever contains upstream bytes; custom `fetcher` honored.
- [ ] GREEN `src/http.ts`: `FetchError` mapping, `AbortSignal.timeout`, streamed byte cap, strict UTF-8 + single `JSON.parse`.
- [ ] Commit — `feat: add Bayz upstream HTTP gateway`.

### Task 6: OpenAI-compatible discovery

- [ ] RED `test/discovery-openai.test.ts`: `{data}` and bare-array shapes; slug validation skips malformed entries; dedupe + `min(modelLimit,500)` cap; Bearer header only when credential present; unauthenticated allowed for `openai-compatible`; `credential_missing` for requiring kinds before any network call; structural violations → `discovery_failed`; fixed messages leak nothing.
- [ ] GREEN `src/discovery-openai.ts` + shared `src/model-list.ts`.
- [ ] Commit — `feat: add OpenAI-compatible model discovery`.

### Task 7: Gemini and OpenRouter discovery

- [ ] RED `test/discovery-gemini.test.ts`: `models/` prefix stripping; `x-goog-api-key` header asserted, **never** an `apikey=` query param; credential required; caps apply. OpenRouter exercises the OpenAI path with default base `https://openrouter.ai/api` and required credential.
- [ ] GREEN `src/discovery-gemini.ts`.
- [ ] Commit — `feat: add Gemini and OpenRouter discovery`.

### Task 8: ProviderManager, adversarial suite, non-mocked smoke, phase gate

- [ ] RED `test/manager.test.ts`: full CRUD + update paths; per-kind defaults; `codex-oauth` accepted at creation, `unsupported_operation` for `setCredential`/`discoverModels`; credential ops honest; discovery dispatch happy path via injected fetcher; `close()` closes storage.
- [ ] RED `test/adversarial.test.ts`: source-scan forbids `getCredential` anywhere in `src/`; object surface excludes it; envelope lives at exactly `provider:<id>:api_key` and is the **only** secret row; tampered credential ⇒ `hasCredential` throws `secret_corrupt` (not `false`); oversized/malicious payloads capped with fixed messages; 700-entry feed capped at 500; SQL-injection ids rejected pre-SQL with tables intact; header-smuggling config rejected; Gemini query-param leak impossible; cross-provider isolation survives `deleteProvider`.
- [ ] GREEN `src/manager.ts`.
- [ ] `scripts/provider-smoke.mjs`: real temp data dir + real env KEK, real `node:http` loopback upstream, real fetch; proves discovery end-to-end, physical-name custody, no plaintext/credential bytes in `bayz.db`/`-wal`/`-shm`/logs, no `getCredential` on the surface. Exits non-zero on any failed check.
- [ ] Gate: `npm run runtime:test`, `npm run runtime:build`, `npm run runtime:verify`, `node --test tests/runtime-structure.test.mjs`, `node scripts/storage-smoke.mjs`, `node scripts/provider-smoke.mjs`, `git diff --check`.
- [ ] Honest docs: README Phase 3 section + `WORK-HANDOFF.md` state/deviations (hand-rolled validators instead of zod; `codex-oauth` behavior deferred).
- [ ] Commit — `feat: add Bayz provider manager`.

## Completion checklist

- All suites green; every `tsc --noEmit` exits 0; `runtime:verify` exit 0.
- Both smoke scripts exit 0 against real artifacts.
- No credential read path exists (executable proof), no credential column exists (schema pin), plaintext absent from disk bytes and logs.
- Discovery inputs treated as untrusted: capped, slug-filtered, fixed-message failures.
- `apps/dashboard` and `/api/health` untouched; `node:sqlite` still single-import; zero new dependencies.
- Working tree clean after commits; nothing pushed.
