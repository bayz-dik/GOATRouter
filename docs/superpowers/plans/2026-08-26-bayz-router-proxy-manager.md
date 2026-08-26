# Bayz Router — Proxy Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Phase 4 per `docs/superpowers/specs/2026-08-26-bayz-router-proxy-manager-design.md`: proxy registry (migration v3), encrypted per-proxy password custody, a hand-rolled SOCKS5 client, an HTTP `CONNECT` client, a dial/agent seam, and a `ProxyManager` with no password read path — strict RED→GREEN→REFACTOR, one commit per green task.

**Ground rules:** Reuse Phase 3 primitives (`scopedSecretStorage`, error-boundary pattern, source-scan enforcement). `apps/dashboard` untouched. `/api/health` byte-stable. `node:sqlite` still single-import. No new dependencies, no shell, no `spawn`. Never log or return a password. No push to GitHub.

---

### Task 1: Design and plan documents

- [x] Spec written.
- [ ] Plan written.
- [ ] Commit — `docs: add Phase 4 proxy manager design and plan`.

### Task 2: Proxy validation boundary (`@bayz/proxy` scaffold)

- [ ] RED `test/validation.test.ts`: `ProxyError` fixed messages and no `cause`; id matrix; endpoint validation (bare host only — reject `socks5://h`, `h/p`, `u@h`, whitespace, NUL, CRLF, over-long labels, label edge dashes; accept IPv4, `[::1]`, lowercased hostnames); port range; strict config (defaults, ranges, unknown keys refused, prototype refused).
- [ ] Scaffold package + `src/{errors,endpoint,config,index}.ts`; register in root `runtime:build`.
- [ ] GREEN + `tsc --noEmit`. Commit — `feat: add Bayz proxy validation boundary`.

### Task 3: Registry migration v3 + repository CRUD

- [ ] RED: update `packages/storage/test/migrations.test.ts` (fresh tables include `proxies`; keep bans on routes/routing/combos/usage/requests/logs/clients; pin v3 columns; assert no `password`/`secret`/`token` column); RED `test/repository.test.ts`.
- [ ] GREEN: migration v3 + `src/repository.ts` (validate pre-SQL, `SELECT` before insert, re-validate `config_json` on read).
- [ ] Storage + proxy suites green. Commit — `feat: add Bayz proxy registry persistence`.

### Task 4: SOCKS5 client

- [ ] RED `test/socks5.test.ts` against hand-written loopback servers: no-auth success; username/password success; `FF` no acceptable method → `auth_failed`; wrong RFC 1929 status → `auth_failed`; each `REP` code mapped; wrong version byte → `protocol_error`; truncated reply → `protocol_error`; oversized domain refused; stall → `timeout`; payload passes through byte-exact after the handshake; the password never appears in a captured server-side transcript beyond the single RFC 1929 field.
- [ ] GREEN `src/socks5.ts` with bounded reads.
- [ ] Commit — `feat: add hand-rolled SOCKS5 client`.

### Task 5: HTTP CONNECT client

- [ ] RED `test/http-connect.test.ts` against loopback servers: `200` success; `407` → `auth_failed`; `403` → `forbidden`; `502`/`504` → `unreachable`; other → `proxy_error`; `Proxy-Authorization` present only with credentials and correctly base64-encoded; header block over 16 KiB refused; malformed status line → `protocol_error`; CRLF in a target host impossible (validated earlier, asserted here); byte-exact passthrough after the blank line.
- [ ] GREEN `src/http-connect.ts`. Commit — `feat: add HTTP CONNECT tunnel client`.

### Task 6: Dial and agent seam

- [ ] RED `test/dial.test.ts`: kind dispatch; injected `connect` honored; socket destroyed on every failure path (asserted via a socket spy, not inferred); real end-to-end request through a real loopback CONNECT proxy using `createProxyAgent` + `node:http`; timeout bounds a proxy that never replies.
- [ ] GREEN `src/dial.ts`. Commit — `feat: add proxy dial and agent seam`.

### Task 7: ProxyManager

- [ ] RED `test/manager.test.ts`: CRUD; `passwordPresent` view field; password set/replace/delete; blank password refused; unknown id → `proxy_not_found`; `deleteProxy` removes the password; `checkProxy` success reports latency; disabled proxy refuses; logs carry ids and kinds but no password.
- [ ] GREEN `src/manager.ts`. Commit — `feat: add Bayz proxy manager`.

### Task 8: Adversarial suite, non-mocked smoke, phase gate, docs

- [ ] RED `test/adversarial.test.ts`: source-scan forbids a password accessor; manager surface excludes it; password lives at exactly `proxy:<id>:password` and is the only new secret row; tampered password → `secret_corrupt`, never `false`; hostile handshake bytes (length-0 fields, 255-byte fields, garbage floods, immediate FIN) all fail closed without unbounded allocation; injection-shaped ids rejected with the schema intact; cross-proxy isolation survives `deleteProxy`.
- [ ] `scripts/proxy-smoke.mjs`: real SOCKS5 and CONNECT servers on loopback, real sockets, real database; proves tunneled request/response, physical-name custody, no password bytes in `bayz.db`/`-wal`/`-shm`/logs, separate-process reopen. Non-zero exit on any failure.
- [ ] Gate: `npm run runtime:test`, `npm run runtime:build`, `npm run runtime:verify`, `node --test tests/runtime-structure.test.mjs`, all three smoke scripts, `git diff --check`.
- [ ] Docs: README proxy section stating the `fetch` limitation and that Basic proxy auth is observable on a plaintext proxy; `WORK-HANDOFF.md` Phase 4 state and deviations.
- [ ] Commit — `feat: wire Bayz proxy support`.

## Completion checklist

- All suites green; every `tsc --noEmit` exits 0; `runtime:verify` exits 0.
- All three smoke scripts exit 0 against real artifacts.
- No password read path (executable proof); no password column (schema pin); password absent from disk bytes and logs.
- SOCKS5 and CONNECT proven against real servers, not mocks.
- Every handshake failure path bounded and fail-closed.
- `apps/dashboard` and `/api/health` untouched; `node:sqlite` single-import; zero new dependencies.
- The `fetch`-cannot-be-proxied limitation documented, not papered over.
