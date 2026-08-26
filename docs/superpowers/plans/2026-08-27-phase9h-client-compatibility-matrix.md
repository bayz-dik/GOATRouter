# Phase 9H — Mandatory Client Compatibility Matrix

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Spec:** `docs/superpowers/specs/2026-08-27-bayz-phase9-goat-release-design.md` §12

**Depends on:** 9A, 9B, 9C, 9D, 9E (real clients need the gateway, streaming, tools, identities, and working UX)

**Goal:** A release-blocking compatibility matrix for OpenCode, Antigravity, Hermes Agent, and generic OpenAI-compatible clients — with `UNVERIFIED` never collapsed into `PASS`.

**Measured device reality:** `opencode` is present on this machine at `/usr/local/bin/opencode`. `antigravity`, `hermes`, `cline`, and `aider` are **absent** and cannot be executed here. A `command -v continue` hit resolves to the **shell builtin**, not the Continue client — Continue is not installed, and there is no `~/.continue`. Any cell that cannot be executed is `UNVERIFIED` with the reason recorded.

---

### Task 1 — Matrix document and status vocabulary

**Create:** `docs/superpowers/2026-08-27-bayz-client-compatibility-matrix.md`
**Test:** `tests/matrix-integrity.test.mjs`

**Rows:** `opencode`, `antigravity`, `hermes`, `generic-openai`, `continue` (opportunistic, not installed here), `cline` (opportunistic, not installed here)
**Columns:** configure, authenticate, models.list, chat, stream, tool call, tool result roundtrip, large request, cancel, error surface, custom provider, proxy-bound route, combo, failover, restart/reconnect, key revoke/rotate

- [ ] RED `tests/matrix-integrity.test.mjs`: the matrix file exists; every cell is exactly one of `PASS`, `FAIL`, `UNVERIFIED`, `N/A`; no cell is empty, `TODO`, `TBD`, `?`, or `-`; every `PASS` cell carries an evidence reference matching `^(smoke:[a-z-]+#\d+|test:[\w./-]+|transcript:[\w./-]+)$`; the Core 3 rows are present; a `PASS` without evidence fails the test.
- [ ] Note: 9I, 9J, and 9K each specify this same regex for their own matrices. 9L Task 1 builds `scripts/evidence.mjs` as the single source and refactors all four to import it. Write the regex inline here so this subprogram stands alone, and expect it to be replaced rather than copied further.
- [ ] Verify RED: `node --test tests/matrix-integrity.test.mjs` fails because the file does not exist.
- [ ] GREEN: write the matrix with every cell initialised to `UNVERIFIED` and a legend defining the four statuses and the evidence format.
- [ ] Verify: `node --test tests/matrix-integrity.test.mjs` exits 0.
- [ ] Commit — `docs: add the Bayz client compatibility matrix`

### Task 2 — Protocol conformance harness

**Create:** `scripts/client-conformance.mjs`
**Test:** covered by the script's own exit code

- [ ] Build a harness that drives BAYZ exactly as a generic OpenAI client would, over real HTTP with no in-process shortcuts: `GET /v1/models`, `POST /v1/chat/completions` non-streaming, the same streaming, a tool-call turn, a tool-result turn, a 200 KiB request, an aborted request, and an error case. Each check prints `ok`/`FAIL` with a number so the matrix can cite `smoke:client-conformance#N`.
- [ ] Assert the response shapes match the OpenAI contract field-for-field, since a client that parses strictly will otherwise break in the field rather than in the test.
- [ ] Verify: `node scripts/client-conformance.mjs` exits 0.
- [ ] Update the matrix `generic-openai` row from the check numbers.
- [ ] Commit — `test: add the Bayz generic client conformance harness`

### Task 3 — Per-client configuration presets and docs

**Create:** `docs/clients/opencode.md`, `docs/clients/antigravity.md`, `docs/clients/hermes.md`, `docs/clients/generic-openai.md`
**Modify:** `apps/dashboard/src/panels/IdentitiesPanel.tsx` (preset selector already added in 9C)

- [ ] Each document gives the exact configuration a user needs: base URL `http://127.0.0.1:20128/v1`, the API key field to paste a scoped client key into, the model name form, and any capability the client will not find. No product-name branching in code is introduced — these are user documents.
- [ ] Each document states explicitly which capabilities are `UNVERIFIED` for that client on this device and why.
- [ ] Verify: `node --test tests/matrix-integrity.test.mjs` still exits 0 (docs do not change cell status without evidence).
- [ ] Commit — `docs: add Bayz client configuration guides`

### Task 4 — OpenCode real-client verification

**Create:** `scripts/verify-opencode.mjs`, `docs/transcripts/opencode/` (populated at run time)

- [ ] Start a real BAYZ instance on a free port with a real loopback provider origin. Create a scoped client identity. Configure a real `opencode` invocation against it using the documented settings. Capture stdout, stderr, and the BAYZ usage rows.
- [ ] For each matrix column, record `PASS` with a transcript path, or `FAIL` with the observed error, or `UNVERIFIED` with the reason the check could not run in this environment.
- [ ] **The script must exit non-zero if any cell it claims to verify lacks a transcript.** A cell may not become `PASS` from a script's own opinion.
- [ ] Verify: `node scripts/verify-opencode.mjs` exits 0 and writes transcripts; update the matrix `opencode` row from them.
- [ ] Commit — `test: verify Bayz against the real OpenCode client`

### Task 5 — Antigravity and Hermes verification attempts

**Create:** `scripts/verify-antigravity.mjs`, `scripts/verify-hermes.mjs`

- [ ] Each script detects whether the client binary is available. If absent it prints a clear `UNVERIFIED: <client> not installed on this host` and exits **0** — absence is not a failure of BAYZ, but it must not be recorded as success either.
- [ ] If present, it runs the same matrix as 9H Task 4 and writes transcripts.
- [ ] The matrix rows for these two clients stay `UNVERIFIED` on this device, and `tests/matrix-integrity.test.mjs` enforces that they cannot be `PASS` without a transcript reference.
- [ ] Verify: both scripts exit 0; the matrix records `UNVERIFIED` with the reason.
- [ ] Commit — `test: add Bayz verification harnesses for Antigravity and Hermes`

### Task 6 — Release-blocking gate wiring

**Create:** `scripts/client-gate.mjs`

- [ ] The gate reads the matrix, and **fails** if any Core 3 client has a `FAIL` in any column, or if the release is being declared while any Core 3 mandatory column is `UNVERIFIED`. It prints a table of what is blocking.
- [ ] The gate distinguishes two modes: `--report` (always exits 0, prints status) and `--enforce` (exits non-zero on any Core 3 `FAIL` or `UNVERIFIED`). 9L runs it with `--enforce`.
- [ ] Verify: `node scripts/client-gate.mjs --report` exits 0 and lists the current `UNVERIFIED` cells; `node scripts/client-gate.mjs --enforce` exits **non-zero** today, which is the correct current state.
- [ ] Commit — `test: add the Bayz client compatibility gate`

## Completion checklist

- [ ] Matrix exists with every cell one of four statuses and no placeholder.
- [ ] Every `PASS` carries a machine-checkable evidence reference.
- [ ] Generic OpenAI conformance harness passes against real HTTP.
- [ ] OpenCode verified with transcripts, or explicitly `FAIL`/`UNVERIFIED`.
- [ ] Antigravity and Hermes recorded `UNVERIFIED` on this device with the reason; harnesses ready for a host that has them.
- [ ] `client-gate.mjs --enforce` correctly blocks release while Core 3 cells are `UNVERIFIED`.
- [ ] No client-name branching added to any runtime path.
