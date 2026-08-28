# Phase 9H — Mandatory Client Compatibility Matrix

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Spec:** `docs/superpowers/specs/2026-08-27-bayz-phase9-goat-release-design.md` §12

**Depends on:** 9A, 9B, 9C, 9D, 9E (real clients need the gateway, streaming, tools, identities, and working UX)

**Goal:** A release-blocking compatibility matrix for OpenCode, Antigravity, Hermes Agent, and generic OpenAI-compatible clients — with `UNVERIFIED` never collapsed into `PASS`.

**Measured device reality:** `opencode` is present on this machine at `/usr/local/bin/opencode` (`--version` → `1.18.23`). **CORRECTED at Task 1:** `hermes` is also **present**, at `/root/.local/bin/hermes` (`--version` → `Hermes Agent v0.20.5`); this plan and spec §12 both recorded it as absent, which was wrong. `antigravity`, `cline`, and `aider` are **absent** and cannot be executed here. A `command -v continue` hit resolves to the **shell builtin**, not the Continue client — Continue is not installed, and there is no `~/.continue`. Any cell that cannot be executed is `UNVERIFIED` with the reason recorded. **Presence is not verification:** every present client's row is still `UNVERIFIED` until a real run produces a transcript.

---

### Task 1 — Matrix document and status vocabulary

**Create:** `docs/superpowers/2026-08-27-bayz-client-compatibility-matrix.md`
**Test:** `tests/matrix-integrity.test.mjs`

**Rows:** `opencode`, `antigravity`, `hermes`, `generic-openai`, `continue` (opportunistic, not installed here), `cline` (opportunistic, not installed here)
**Columns:** configure, authenticate, models.list, chat, stream, tool call, tool result roundtrip, large request, cancel, error surface, custom provider, proxy-bound route, combo, failover, restart/reconnect, key revoke/rotate, **free-only routing** (the §25 amendment column, applied at Task 1 rather than retro-fitted)

- [x] RED `tests/matrix-integrity.test.mjs`: the matrix file exists; every cell is exactly one status from a closed vocabulary (implemented as `VERIFIED` / `PARTIAL` / `BLOCKED` / `UNVERIFIED` / `N/A` — see the deviation note below, which supersedes the `PASS`/`FAIL` wording); no cell is empty, `TODO`, `TBD`, `?`, or `-`; every `PASS` cell carries an evidence reference matching `^(smoke:[a-z-]+#\d+|test:[\w./-]+|transcript:[\w./-]+)$`; the Core 3 rows are present; a `PASS` without evidence fails the test.
- [x] Note: 9I, 9J, and 9K each specify this same regex for their own matrices. 9L Task 1 builds `scripts/evidence.mjs` as the single source and refactors all four to import it. Write the regex inline here so this subprogram stands alone, and expect it to be replaced rather than copied further. — **done, and stated in both the test and the matrix legend.**
- [x] Verify RED: `node --test tests/matrix-integrity.test.mjs` fails because the file does not exist. Measured: **9/9 fail**, all `ENOENT` on the matrix path — the file-level failure a missing document produces.
- [x] GREEN: write the matrix with every cell initialised to `UNVERIFIED` and a legend defining the statuses and the evidence format. **102 cells** (6 clients × 17 capabilities), every one `UNVERIFIED` with a measured reason.
- [x] Verify: `node --test tests/matrix-integrity.test.mjs` exits 0 (**9/9**). `tests/runtime-structure.test.mjs` unaffected (**1/1**); 10/10 together.
- [x] Commit — `docs: add the Bayz client compatibility matrix`

**Amendment applied at Task 1 rather than deferred.** The §25 `free-only routing` column is
in the required-capability list from the start, so the seventeenth column cannot be omitted
and then retro-fitted. The plan's separate amendment step for Task 1 is therefore already
satisfied; Tasks 2 and 4 still owe their own amendment work.

**Status vocabulary — a deliberate deviation from the plan text.** The plan specified
`PASS` / `FAIL` / `UNVERIFIED` / `N/A`. The implemented vocabulary is
**`VERIFIED` / `PARTIAL` / `BLOCKED` / `UNVERIFIED` / `N/A`**, and `PASS`/`FAIL` are
refused as placeholders so the old words cannot creep back:

- `PASS` overstates what a matrix cell can mean. A cell says "this was observed to work
  against the real client", which is `VERIFIED`; `PASS` reads like a test result and
  invites collapsing a green test suite into a compatibility claim.
- **`PARTIAL` had no representation at all.** A client that streams but truncates on
  reconnect is neither a pass nor a failure, and forcing that into `PASS` is how a real
  limitation disappears. It now requires evidence *and* a named limit.
- **`BLOCKED` vs `UNVERIFIED` is the load-bearing split**, and `FAIL` conflated it.
  `BLOCKED` = tried, did not work, something was learned. `UNVERIFIED` = not tried,
  nothing is known. An untried cell that reads like a tried one is exactly the failure 9H
  exists to prevent.
- `N/A` is retained unchanged, for a capability the client genuinely has no surface for.

Downstream consequence recorded for 9H Task 6: `client-gate.mjs --enforce` must block on
`BLOCKED` **and** `UNVERIFIED` for a Core 3 mandatory column, not on a single `FAIL` word.

**Findings worth carrying forward:**
- **The integrity test resolves evidence on disk, which the plan did not ask for and is
  the check that actually matters.** A regex-only gate accepts
  `transcript:docs/transcripts/opencode/chat.log` from a document where no such file
  exists — so the easiest route to a green matrix would be inventing a plausible path.
  Every citation is now `existsSync`-checked (`smoke:<name>#<n>` resolves the *script*;
  the check number is Task 2/4's to validate by running it).
- **A prose scan backs up the structured parse.** A `VERIFIED` written in a summary line
  or heading is invisible to a table parser, and the document would read as a verified
  integration while every cell said otherwise. Any `VERIFIED` outside a table row fails,
  with a carve-out only for the legend defining the word.
- **Unknown capability rows are refused, not ignored.** A typo'd capability name would
  otherwise sit in the document looking covered while the real column silently went
  missing.
- **`BLOCKED`/`UNVERIFIED`/`N/A` need ≥12 characters of reason.** Not a style rule: it is
  the shortest bound that excludes `n/a`, `todo`, and `see above`, which are the three
  ways this column goes empty while looking filled. Such a cell is also refused if it
  cites evidence, since a cell with evidence should not be claiming ignorance.
- **A one-shot generator wrote the 102 cells and was then deleted.** Hand-typing 102 rows
  is 102 chances to typo a capability name. The generator was verified to reproduce the
  committed matrix byte-for-byte, then removed rather than committed — a build step for a
  document that is now edited by hand, cell by cell, with evidence, would be a second
  source of truth for statuses and the wrong thing to keep.
- **Hermes is present on this host, correcting the plan and spec text.** Both recorded
  `hermes` as absent; `/root/.local/bin/hermes` exists and reports
  `Hermes Agent v0.20.5`. `opencode` is present at `1.18.23` as recorded. `antigravity`,
  `cline`, and `aider` are genuinely absent, and the `continue` hit is still the **shell
  builtin** (`type continue` → `continue is a shell builtin`, no `~/.continue`). The
  hermes row stays `UNVERIFIED` — presence is not verification — but Task 5 can now
  attempt it for real instead of only shipping a harness.
- **Six mutations proved the test can fail**, then were reverted: a `VERIFIED` with a
  hand-waved reason (2 red), a `VERIFIED` citing a well-formed but non-existent transcript
  (1 red), a `TODO`/`-` placeholder cell (1 red), a Core 3 row renamed away (2 red), the
  `free-only routing` column dropped from a client (1 red), and a prose "all Core 3 are
  VERIFIED" line outside any table (1 red).

### Task 2 — Protocol conformance harness

**Create:** `scripts/client-conformance.mjs`
**Test:** covered by the script's own exit code

- [x] Build a harness that drives BAYZ exactly as a generic OpenAI client would, over real HTTP with no in-process shortcuts: `GET /v1/models`, `POST /v1/chat/completions` non-streaming, the same streaming, a tool-call turn, a tool-result turn, a 200 KiB request, an aborted request, and an error case. Each check prints `ok`/`FAIL` with a number so the matrix can cite `smoke:client-conformance#N`. — **55 checks across 13 sections**, real `fetch` on a real port, real SQLite with real envelope crypto, real scripted origins. No `app.inject`, no imported handler.
- [x] Assert the response shapes match the OpenAI contract field-for-field, since a client that parses strictly will otherwise break in the field rather than in the test. — a `shapeProblems()` walker names the offending field in the failure message; `chat.completion`, `chat.completion.chunk`, the model list envelope, `tool_calls`, and `usage` are all pinned key by key.
- [x] Verify: `node scripts/client-conformance.mjs` exits 0. **55/55**, twice in a row.
- [x] Update the matrix `generic-openai` row from the check numbers. — 13 `VERIFIED`, 2 `PARTIAL`, 2 `UNVERIFIED`; matrix tally now 13/2/0/87/0.
- [x] Commit — `test: add the Bayz generic client conformance harness`

**Beyond the plan's list**, because a generic client exercises them and the matrix has
columns for them: custom provider, combo, failover, key revoke/rotate, and the §25
free-only amendment. Two columns are deliberately **not** claimed — `proxy-bound route`
needs a real CONNECT fixture and `restart/reconnect` needs a client surviving a listener
restart. Both stay `UNVERIFIED` with the reason recorded; claiming them from this harness
would be the fake compatibility claim 9H exists to prevent.

**§25 amendment satisfied here.** Check #50 proves a free-only route to a genuinely
PAID-classified provider is refused `409 no_free_route`, #51 proves the paid origin was
never called (a 409 alone would not prove nothing was spent), #48 proves a route created
*without* `freeOnly` still defaults to free-only, and #53 proves an explicit
`freeOnly: false` opt-out then routes — so the guard is a bound, not a wall. The paid
origin binds a **non-loopback** address on purpose: `allowLoopback` short-circuits
classification to `LOCAL`, which is free, so a loopback origin cannot exercise the PAID
path at all. On a host with no private IPv4 the check reports `SKIP` rather than asserting
against loopback.

**A live 400-vs-500 bug this task found and fixed.** `apps/server/src/http-errors.ts`
mapped no `GatewayError` code, and an unmapped code becomes a generic **500
`internal_error`**. So a generic OpenAI client posting a JSON scalar instead of an object
was told "the server is broken, retry" when the truth was "your request is malformed, fix
it" — a client would retry forever. `invalid_capability`, `invalid_quirk`,
`invalid_profile`, and `capability_unsupported` are now mapped to **400**. This is the
only runtime source change in Task 2; the 336 server tests, 74 gateway tests, and 289
router tests are unchanged and green, and `api-smoke` 70/70 confirms the gateway contract
did not move.

**Findings worth carrying forward:**
- **The matrix's `smoke:` citations were decoration until this task.** Task 1's integrity
  test resolved the *script* but never the *number*, so `smoke:client-conformance#99` in a
  cell for a capability the harness never exercises passed — found by mutating the matrix
  to claim `proxy-bound route` that way. Fixed structurally: the harness writes
  `docs/evidence/client-conformance.json` on a fully passing run (never on a failing one),
  mapping capability → check number, and the integrity test resolves each citation against
  it. A cell can no longer cite a number the script never assigned, a capability it never
  covers, or another capability's number.
- **`PARTIAL` needed enforcement it did not have.** Task 1's legend said a `PARTIAL` cell
  carries evidence *and* a named limit, but the test only checked the evidence half — so a
  bare `PARTIAL` would have passed. Task 2 produced the first real `PARTIAL` cells and
  exposed it. Now the limit after ` — ` is required at ≥12 characters, and a `VERIFIED`
  cell is refused if it carries trailing prose, because a caveat inside a full pass is what
  `PARTIAL` is for.
- **Two `PARTIAL` cells, honestly recorded rather than rounded up.** `large request`: a
  120 KiB message is served in full, and the plan's 200 KiB payload exceeds
  `MAX_CONTENT_CHARS` (128,000) and is cleanly refused 400 — bounded, never truncated or
  5xx. Two payloads are sent deliberately, because the oversized one alone could not
  distinguish a working bound from a broken large-body path. `error surface`: every
  malformed request returns the stable envelope with the right status, but a JSON scalar
  body reports `capability_unsupported` ("the client is not granted that capability") when
  the real cause is body shape — `deriveProfile` never derives the `chat` intent from a
  non-object, so the refusal comes from the capability gate. The status and envelope are
  conformant so no client breaks, but the message misdirects. Fixing it means changing
  `intentOf`/`deriveProfile` in `@bayz/gateway`, which is outside Task 2's remit and pinned
  by several of the 74 gateway tests; the wording is asserted so it is a known pinned fact
  rather than a surprise.
- **The cancel check waits 400 ms before aborting**, so the request is genuinely in flight
  upstream, and asserts the *origin* observed the socket close — not merely that `fetch`
  rejected. A held-open origin (`holdMs`) is what gives the abort a window to land. It then
  re-checks that the listener still serves normally, because an abort must not poison the
  server.
- **Streaming is asserted incrementally.** The origin emits two content frames, so
  "content arrives across multiple deltas" is measured rather than assumed, and the
  reassembled deltas are compared to the upstream completion exactly. `[DONE]`,
  `x-accel-buffering: no`, `no-cache`, a stable chunk `id`, and a terminal `finish_reason`
  are each pinned separately.
- **Four mutations proved the harness can fail**, then were reverted: `object` renamed to
  `chatCompletion` in `denormalizeResponse` (1 red, and the failure message named the
  field); `isFreeCandidate` forced true so PAID reads as free (4 red); the `freeOnly`
  default flipped to `false` (5 red, including the §25 rule-6 default check); and
  `tool_call_id` regressed to camelCase on the wire — the exact 9G Task 3 bug — (1 red).
  Two further mutations proved the matrix integrity additions can fail: a `PARTIAL` with no
  limitation, and a caveat hidden inside a `VERIFIED` cell.
- **Check numbers are contractual.** The matrix cites them, so a check must be *appended*
  rather than inserted; if a number ever has to move, the matrix citation and the manifest
  move with it in the same commit. Stated at the top of the script.

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

---

## AMENDMENT — FREE ONLY routing column (spec §25)

The matrix gains a seventeenth column, `free-only routing`, and Task 1's integrity
test gains it as a required column so it cannot be omitted.

- [x] Amend Task 1's column list to include `free-only routing` and re-run `node --test tests/matrix-integrity.test.mjs`. — **done at Task 1**: the column is in the integrity test's required list from the start, so all six clients carry it and it cannot be omitted. 9/9 green.
- [x] Amend Task 2's conformance harness with a check that a free-only route to a paid-classified provider fails `no_free_route` over real HTTP, so the `generic-openai` row's cell has a citable check number. — **`smoke:client-conformance#50`**, plus #48 (default is free-only), #51 (the paid origin was never called), #52 (stable envelope), and #53 (explicit opt-out still routes).
- [ ] Amend Task 4's OpenCode verification to configure a free-only route and record the cell from the transcript.
- [ ] Statuses for this column follow the same rule as every other: `UNVERIFIED` where the client cannot run here.
