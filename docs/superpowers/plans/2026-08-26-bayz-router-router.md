# Bayz Router — Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Phase 5 per `docs/superpowers/specs/2026-08-26-bayz-router-router-design.md`: route registry (migration v4), deterministic route selection, strict chat request/response handling, a `node:http`-based transport that honors the Phase 4 proxy agent, and failover — strict RED→GREEN→REFACTOR, one commit per green task.

**Ground rules:** No prompt or completion is ever persisted or logged. No credential getter — `ProviderManager` gains `withCredential(id, fn)` scoped use, and the existing source scans must keep passing. `apps/dashboard` untouched. `/api/health` byte-stable. `node:sqlite` single-import. No new dependencies. No streaming, no combos, no usage. No push to GitHub.

---

### Task 1: Design and plan documents

- [x] Spec written.
- [ ] Plan written.
- [ ] Commit — `docs: add Phase 5 router design and plan`.

### Task 2: Model validation and pattern matching (`@bayz/router` scaffold)

- [ ] RED `test/model.test.ts`: `RouterError` fixed messages, no `cause`; model id matrix (slugs with `/`, `.`, `:` accepted; whitespace, CRLF, NUL, traversal, over-long rejected); pattern matching (exact, single trailing `*`, no mid-string `*`, no regex metacharacters honored as regex, `*` alone rejected); specificity ranking helper.
- [ ] Scaffold package + `src/{errors,model,index}.ts`; register in root `runtime:build`.
- [ ] GREEN + `tsc --noEmit`. Commit — `feat: add Bayz router model matching`.

### Task 3: Route registry migration v4 + repository CRUD

- [ ] RED: update `packages/storage/test/migrations.test.ts` (fresh tables include `routes`; keep bans on routing/combos/usage/requests/logs/clients; pin v4 columns; assert no prompt/body/content column); RED `test/repository.test.ts` including FK behaviour — provider delete cascades routes, proxy delete nulls `proxy_id`, unknown provider id refused, duplicate `(model, provider_id)` refused.
- [ ] GREEN: migration v4 (table + unique index) and `src/repository.ts`.
- [ ] Storage + router suites green. Commit — `feat: add Bayz route registry persistence`.

### Task 4: Deterministic selection

- [ ] RED `test/selection.test.ts`: exact beats wildcard; priority orders ties; id breaks remaining ties; disabled routes excluded; no match → `no_route`; candidate list order stable across repeated calls and independent of insertion order.
- [ ] GREEN `src/selection.ts`. Commit — `feat: add deterministic route selection`.

### Task 5: Strict request and response handling

- [ ] RED `test/request.test.ts` and `test/response.test.ts`: full accept/reject matrices; unknown keys refused (including `stream`); 1 MiB body cap; message and content limits; response requires `choices[0].message.content`; content cap; malformed `usage` degrades to `undefined` without failing; unexpected upstream fields discarded, never passed through.
- [ ] GREEN `src/request.ts`, `src/response.ts`. Commit — `feat: add strict chat request and response handling`.

### Task 6: Transport with proxy support

- [ ] RED `test/transport.test.ts` against a real loopback origin and a real `CONNECT` proxy: direct POST succeeds; proxied POST succeeds and the proxy really observes a `CONNECT`; bearer vs `x-goog-api-key` per kind; credential never in a URL; status mapping (401/403/429/other); transport failure → `unreachable`; timeout bounded; oversized response refused; invalid UTF-8 and bad JSON refused; no upstream body in any error message.
- [ ] GREEN `src/transport.ts`. Commit — `feat: add Bayz router transport`.

### Task 7: Router with failover, plus `withCredential`

- [ ] RED `test/router.test.ts`: end-to-end chat through a real origin; proxy-bound route traverses the proxy; failover advances on `unreachable`/`rate_limited`/`upstream_error` and stops on `auth_failed`/`credential_missing`; all-candidates-fail raises the last real code; logs carry route/provider/proxy/latency but no prompt, completion, or credential.
- [ ] RED `packages/providers/test/manager.test.ts` addition: `withCredential(id, fn)` passes the plaintext to the callback, returns the callback's value, throws `credential_missing` when unset, and **no** getter is introduced (existing adversarial source scan must still pass).
- [ ] GREEN `src/router.ts` + `withCredential`. Commit — `feat: add Bayz router with provider failover`.

### Task 8: Adversarial suite, non-mocked smoke, phase gate, docs

- [ ] RED `test/adversarial.test.ts`: source scan forbids any credential getter and any prompt persistence (`INSERT` of message content); prompts absent from database bytes after a full chat; hostile upstream (huge body, deep nesting, prototype-polluting keys, non-UTF-8) fails closed; model names with path traversal cannot reach the URL; a route row rewritten with a hostile config fails closed; response injection cannot add fields to the returned object.
- [ ] `scripts/router-smoke.mjs`: real database, real origin, real `CONNECT` proxy; proves a direct chat, a proxied chat, failover across two providers, prompt/completion absent from `bayz.db`/`-wal`/`-shm` and all logs, and a separate-process reopen of the route registry.
- [ ] Gate: `npm run runtime:test`, `npm run runtime:build`, `npm run runtime:verify`, `node --test tests/runtime-structure.test.mjs`, all four smoke scripts, secret scan, `git diff --check`.
- [ ] Docs: README router section (including that streaming is not implemented and that the proxy gap from Phase 4 is now closed for the router's own path only); `WORK-HANDOFF.md` Phase 5 state and deviations.
- [ ] Commit — `feat: wire Bayz router`.

## Completion checklist

- All suites green; every `tsc --noEmit` exits 0; `runtime:verify` exits 0.
- All four smoke scripts exit 0 against real artifacts.
- No credential getter exists; prompts and completions are never persisted or logged (executable proof).
- Route selection deterministic and pinned by tests.
- Proxied requests proven against a real `CONNECT` proxy.
- Failover semantics pinned: advances only on transport-class failures.
- `apps/dashboard` and `/api/health` untouched; `node:sqlite` single-import; zero new dependencies.
- Streaming, combos, and usage documented as not implemented, not faked.
