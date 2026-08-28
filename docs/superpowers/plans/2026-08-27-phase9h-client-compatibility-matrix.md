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

- [x] Each document gives the exact configuration a user needs: base URL `http://127.0.0.1:20128/v1`, the API key field to paste a scoped client key into, the model name form, and any capability the client will not find. No product-name branching in code is introduced — these are user documents. — **five files**: the four guides plus `docs/clients/README.md` as an index and shared-preamble.
- [x] Each document states explicitly which capabilities are `UNVERIFIED` for that client on this device and why.
- [x] Verify: `node --test tests/matrix-integrity.test.mjs` still exits 0 (docs do not change cell status without evidence). **9/9**, and no matrix cell moved — the tally is unchanged at 13/2/0/87/0.
- [x] Commit — `docs: add Bayz client configuration guides`

**`apps/dashboard/src/panels/IdentitiesPanel.tsx` was NOT modified**, contrary to the plan's
Modify list. The preset selector 9C added is already correct: it renders
`CLIENT_PRESET_NAMES`, seeds `PRESET_SCOPES[preset]` on change, and leaves the scope
checkboxes editable. Task 3 needs no UI change, and editing a working panel to satisfy a
checklist entry would be change without a reason. **Zero runtime source files were touched**
in this task.

**A new guard was added, because the guides are reachable by no existing test.**
`tests/client-docs.test.mjs` (6 tests). The matrix's cells are machine-checked; its *prose
documentation* was not, so a guide asserting "streaming works" for a client whose `stream`
cell is `UNVERIFIED` would have been a fake compatibility claim that
`tests/matrix-integrity.test.mjs` cannot see — it reads the matrix, not `docs/`. The new test
holds the documentation to the matrix:

1. All four guides plus the index exist.
2. Every guide states `http://127.0.0.1:20128/v1`, and **no guide may name any other
   `127.0.0.1` port** — a wrong port is a wrong instruction a user would paste.
3. A guide may write a bare `VERIFIED` only if that client's matrix row genuinely has one.
   For `opencode`, `hermes`, and `antigravity` — every cell `UNVERIFIED` — the word may
   appear only in a negation.
4. Where a guide restates a status table, **every row must match the matrix cell for cell**
   and every citation must be one the matrix carries. `generic-openai` is asserted to compare
   exactly 17 cells, so the test cannot pass by comparing nothing.
5. Every repository path referenced must exist, except three explicitly-enumerated future
   artefacts (`scripts/verify-{opencode,hermes,antigravity}.mjs`, which Tasks 4–5 create).
6. `antigravity.md` may contain **no copyable client-config assignment**, since the client is
   absent and any field name would be invented.

**Findings worth carrying forward:**
- **Client config forms disagree on nearly every field, which is why nothing was
  generalised.** Read from the live files on this host: OpenCode uses
  `~/.config/opencode/opencode.json` with **camelCase** `options.baseURL` / `options.apiKey`,
  `npm: "@ai-sdk/openai-compatible"`, an explicit `models` map, and a **`<provider>/<model>`
  prefixed** top-level `model`. Hermes uses `~/.hermes/config.yaml` with **snake_case**
  `model.base_url`, `api_mode: chat_completions`, **bare** model ids, and reads the key from
  `~/.hermes/.env` under a **host-and-port-derived** variable —
  `HERMES_CUSTOM_127_0_0_1_20128_API_KEY`. No safe default exists between those two, so
  `antigravity.md` documents no config block at all rather than guessing.
- **The model-name form differs per client and is the likeliest user error.** OpenCode needs
  the bare id as the `models` key *and* the prefixed form in `model`; BAYZ ids may themselves
  contain `/` (`^[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,126}[A-Za-z0-9])?$`), so
  `bayz/openai/gpt-4o` is one provider label plus a two-segment id. Both guides say so
  explicitly.
- **Every documented behaviour was measured against a live listener, not read off the
  source.** Confirmed this way: `freeOnly` defaults to `true` on a route created without the
  field; the first chat against an unclassified provider is **409 `no_free_route`**;
  `GET /v1/models` excludes wildcard patterns; `response_format` / `user` / `n` are **400**
  rather than ignored; `stop` as a bare string and `max_tokens` as a string are accepted; 257
  messages, 65 tools, 5 stop sequences, a 129,000-character message and a `__proto__` tool
  name are each **400**; `usage` is **absent** when the upstream omits it and per-field
  `null` when partial; `x-bayz-route` / `x-bayz-provider` / `x-request-id` are present and
  `x-bayz-proxy` is absent on a direct route.
- **Five mutations proved the doc guard can fail**, then were reverted: a `VERIFIED` claim in
  the OpenCode guide (1 red), a cell promoted past the matrix in `generic-openai.md` (1 red),
  a wrong port in the Hermes YAML (1 red), an invented JSON config block in
  `antigravity.md` (1 red), and a non-existent source path in the README (1 red).
- **The invented-config guard was wrong twice before it worked**, and both holes are recorded
  in the test. First it exempted any line containing `127.0.0.1:20128`, so the invented block
  passed because it cited the real URL. Then `baseURL\s*[:=]` failed to match JSON, where the
  text is `"baseURL":` with a quote between key and colon — a YAML-shaped pattern silently
  ignored the shape most likely to be fabricated. Only the third version caught the mutation.
  A guard that has never been shown to fail is not a guard.

### Task 4 — OpenCode real-client verification

**Create:** `scripts/verify-opencode.mjs`, `docs/transcripts/opencode/` (populated at run time)

- [x] Start a real BAYZ instance on a free port with a real loopback provider origin. Create a scoped client identity. Configure a real `opencode` invocation against it using the documented settings. Capture stdout, stderr, and the BAYZ usage rows. — `scripts/verify-opencode.mjs` plus `scripts/verify-opencode-lib.mjs` and `scripts/verify-opencode-scenarios.mjs`, nine scenarios, **transcripts in `docs/transcripts/opencode/`**.
- [x] For each matrix column, record `PASS` with a transcript path, or `FAIL` with the observed error, or `UNVERIFIED` with the reason the check could not run in this environment. — recorded in the project's `VERIFIED`/`BLOCKED`/`UNVERIFIED` vocabulary rather than the plan's `PASS`/`FAIL`, consistent with Task 1's deliberate deviation.
- [x] **The script must exit non-zero if any cell it claims to verify lacks a transcript.** A cell may not become `PASS` from a script's own opinion. — implemented as an explicit end-of-run evidence pass that `existsSync`-checks every claimed transcript, plus a check that all 17 capabilities recorded a verdict at all.
- [x] Verify: `node scripts/verify-opencode.mjs` exits 0 and writes transcripts; update the matrix `opencode` row from them. — **exit 0**, tally `{VERIFIED: 16, PARTIAL: 0, BLOCKED: 0, UNVERIFIED: 1}`, confirmed on two consecutive full runs.
- [x] Commit — `test: verify Bayz against the real OpenCode client`

**Driving the real client found three defects that the 55 generic protocol checks could not
see.** None is a protocol violation; each is a mismatch between what BAYZ accepted and what
a real agent client actually sends. This is the argument for real-client verification,
stated as a measured result rather than a principle:

1. **`stream_options` was refused outright.** OpenCode sends
   `stream_options: {"include_usage": true}` on every request. The gateway's strict
   allow-list had no entry, so the whole body failed `invalid_request (unknown-key)` and
   **no real OpenCode session could reach a provider at all** — the first capture shows
   `origin chat hits: 0`. Fixed in `packages/gateway/src/normalize.ts` as
   `assertStreamOptions`: validated rather than dropped, because `include_usage: false` asks
   BAYZ to suppress usage and it cannot (usage feeds the accounting rows), so accepting it
   would claim a setting took effect that never did.
2. **Streamed `tool_calls` were silently dropped.** `packages/router/src/chunk.ts` had always
   parsed `toolCallDeltas` and `denormalizeResponse` had always rendered the non-streaming
   form, but `chunkBody` in `apps/server/src/routes/chat.ts` built a `content`-only delta. A
   streaming client received `finish_reason: "tool_calls"` with no calls attached, treated it
   as an empty turn, and re-sent the identical request **18 times** before the run was killed.
   Fixed with the OpenAI streaming fragment shape: `index` on every fragment, `id`/`type` and
   `function.name` only where the router observed them.
3. **The 1 KiB tool-description cap refused the client's payload.** Measured from the wire:
   `bash` 4,628 characters, `task` 3,019, `todowrite` 2,012. Agent clients put their entire
   usage contract in the description, so the cap was an incompatibility rather than a
   boundary — it was set against hand-written examples. Raised to 16 KiB per tool in
   `packages/router/src/tools.ts`; the aggregate 1 MiB `MAX_REQUEST_BYTES` check, applied last
   to the *validated* request, is what actually bounds input.

Each fix carries a regression test pinning the real measured numbers, so a future tightening
fails with the client that would break rather than passing review: `+6` tests in
`packages/gateway/test/normalize.test.ts`, `+2` in `packages/router/test/tools.test.ts`, `+2`
in `apps/server/test/chat-stream.test.ts` (one asserting fragments reassemble to the exact
arguments the provider sent, one asserting a text-only stream carries **no** `tool_calls` key
so a strict client never sees a call that did not happen).

**`models.list` stays `UNVERIFIED` by measurement, not omission.** OpenCode offers the models
listed in its own config `models` map and never calls `GET /v1/models`; a full
`opencode models bayz` run recorded zero requests to that endpoint. The command prints the
right model, so promoting the cell would have been easy and wrong — BAYZ's discovery endpoint
was never exercised by this client.

**A harness bug was found and fixed rather than blamed on BAYZ.** Run 1 reported
`key revoke/rotate` as `BLOCKED`. The cause was in the verification script: it sent
`content-type: application/json` on bodyless `DELETE`/`POST` calls, so Fastify correctly
answered `400 invalid_json` and nothing was ever revoked. BAYZ was right throughout. The
scenario was also restructured to rotate the *same* identity instead of deleting and
recreating one — the recreate answered `409 identity_already_exists` and returned no key, so
the rotation half of the cell would have tested nothing.

Rotation is now exercised before revocation, because revocation is destructive: rotate, prove
the superseded key dies and the new key works, then delete and prove the client is locked out.

**Transcripts are committed, so redaction is deterministic.** Secrets are replaced **by
name** — admin token, provider credential, proxy password, master key, and every
per-scenario client key — rather than by pattern-matching a shape, so a credential cannot
survive because it happened not to look like one. Ports, temp paths, UUIDs, timestamps, and
latencies are normalised so a re-run reproduces the same bytes. Sections over 4,000
characters are truncated **with the real total stated**, since the client's own request body
is ~30 KiB of system prompt and tool schemas. A grep for every secret literal and for any
64-hex-character run across `docs/transcripts/opencode/` returns nothing.

### Task 5 — Antigravity and Hermes verification attempts

**Create:** `scripts/verify-antigravity.mjs`, `scripts/verify-hermes.mjs`

- [x] Each script detects whether the client binary is available. If absent it prints a clear `UNVERIFIED: <client> not installed on this host` and exits **0** — absence is not a failure of BAYZ, but it must not be recorded as success either. — Detection is an **executable file on PATH**, not `command -v`: Task 1 caught exactly that measurement error when `command -v continue` "found" the shell builtin. A name that resolves but cannot run is absence.
- [x] If present, it runs the same matrix as 9H Task 4 and writes transcripts. — **Hermes is present**, so this ran for real: nine scenarios, nine transcripts in `docs/transcripts/hermes/`, **17 VERIFIED / 0 PARTIAL / 0 BLOCKED / 0 UNVERIFIED**, exit 0.
- [x] The matrix rows for these two clients stay `UNVERIFIED` on this device, and `tests/matrix-integrity.test.mjs` enforces that they cannot be `PASS` without a transcript reference. — **Deviation, stated rather than hidden: the `hermes` row is now `VERIFIED`, not `UNVERIFIED`.** The plan assumed Hermes was absent; it is installed (v0.20.5), Task 1 corrected that measurement, and refusing to verify a client that is genuinely runnable in order to match the plan's text would be the fake-status failure inverted. `antigravity` **is** absent and every one of its 17 cells stays `UNVERIFIED` with no transcript written, so the integrity test's enforcement is exactly what the plan asked for.
- [x] Verify: both scripts exit 0; the matrix records `UNVERIFIED` with the reason. — `verify-antigravity.mjs` exits 0 with the absence recorded; `verify-hermes.mjs` exits 0 with 17 verified cells.
- [x] Commit — `test: add Bayz verification harnesses for Antigravity and Hermes`

**Driving Hermes found a fourth defect, and it was worse in kind than Task 4's three:** it
broke the tool roundtrip *after* the work was already done. The message allow-list in
`packages/router/src/request.ts` refused `name`, which Hermes sends on every `role: "tool"`
message (`{role, tool_call_id, name, content}`) and which is part of the OpenAI chat contract.
BAYZ delivered the call, Hermes executed it, and the result was rejected on the way back with
`invalid_request (message-unknown-key)`. `name` is now validated and bounded at 64 characters
and deliberately **not forwarded** — `tool_call_id` already identifies the call, so echoing a
client-supplied string upstream would add untrusted data for no gain. Validated anyway,
because "we drop it" is not a reason to skip bounding a value that is still parsed and held.
Three regression tests pin it: the roundtrip works, `name` never reaches the router request,
and the bound plus type check still refuse `""`, 65 characters, and non-strings.

**The message allow-list assertion was retargeted, not deleted.** `request.test.ts` previously
proved the list closed by rejecting `name`. That case now points at `metadata` and
`function_call` — keys genuinely outside the OpenAI message contract — so the list is still
proven closed rather than merely widened.

**Two configuration facts cost a full run each, and both are recorded in the harness:**
`api_key: ${VAR}` in `config.yaml` is load-bearing (writing the key only into `.env` yields
`HTTP 401` with **zero** requests reaching BAYZ), and `-t` takes **toolset** names rather than
tool names (`-t execute_code` made Hermes exit 2 before sending anything, which would have
recorded both tool cells `BLOCKED` against BAYZ for a harness mistake).

**`hermes/models.list` is `VERIFIED` where `opencode/models.list` is `UNVERIFIED`.** Hermes
makes 10 `GET /v1/models` calls in a single one-shot run; OpenCode reads its own config map and
never touches the endpoint. Two verified rows disagreeing on measured grounds is the matrix
working, not a contradiction.

**The BAYZ-side fixtures are now shared** in `scripts/verify-client-lib.mjs` — the scripted SSE
origin, the CONNECT proxy, the listener, the redactor, the transcript writer, and the
refuse-to-self-certify auditor. Two harnesses with private copies would drift, and drifting
copies would make their matrix rows incomparable.

Matrix tally moves 29/2/0/71 → **46 VERIFIED / 2 PARTIAL / 0 BLOCKED / 54 UNVERIFIED**.
`antigravity` remains wholly `UNVERIFIED`, so the Core 3 gate must still block.

### Task 6 — Release-blocking gate wiring

**Create:** `scripts/client-gate.mjs`

- [x] The gate reads the matrix, and **fails** if any Core 3 client has a `FAIL` in any column, or if the release is being declared while any Core 3 mandatory column is `UNVERIFIED`. It prints a table of what is blocking. — `scripts/client-gate.mjs` (entry), `scripts/client-gate-lib.mjs` (policy + parsing + assessment), `scripts/client-gate-run.mjs` (reporting). Blocks on **`BLOCKED`** — this project's vocabulary has no `FAIL` — **and `UNVERIFIED`**, and on a **`MISSING`** cell or an absent Core 3 row, because silence must never read as success.
- [x] The gate distinguishes two modes: `--report` (always exits 0, prints status) and `--enforce` (exits non-zero on any Core 3 `FAIL` or `UNVERIFIED`). 9L runs it with `--enforce`. — Both implemented. No flag, both flags, or a misspelled flag exits **2**, so a CI step with a typo cannot be read as "release permitted".
- [x] Verify: `node scripts/client-gate.mjs --report` exits 0 and lists the current `UNVERIFIED` cells; `node scripts/client-gate.mjs --enforce` exits **non-zero** today, which is the correct current state. — `--report` exits 0 and lists **18** blocking cells; `--enforce` exits **1**. `tests/client-gate.test.mjs` (11 tests) asserts that non-zero exit as a requirement rather than noting it as a known failure.
- [x] Commit — `test: add the Bayz client compatibility gate`

**All seventeen capabilities are mandatory.** The plan says "mandatory column" without
narrowing the list, and §25 made `free-only routing` explicitly not optional. Inventing a
subset would have been a quiet decision that some capability does not matter, so every column
is required and `N/A` carries "this client has no such surface".

**`PARTIAL` and `N/A` do not block; `BLOCKED` and `UNVERIFIED` do.** A `PARTIAL` cell carries
evidence *and* a limitation that `tests/matrix-integrity.test.mjs` forces it to name, so it is
a documented bound. `UNVERIFIED` is an unknown, which is not a smaller release risk than a
known failure — that is why Task 1 refused to collapse it into `BLOCKED`, and the gate honours
the same split.

**The gate is tested against synthetic matrices, not just today's.** Driving only the real
document would let a gate hardcoded to fail pass every check, since the current state *is*
blocked. `assess()` is exercised directly: a fully `VERIFIED` matrix permits release, a single
blocking cell at the first, middle, and last capability of each Core 3 client blocks, a missing
cell blocks, a missing row blocks, and a non-Core-3 client can neither block nor rescue.

**Five mutations each turned the suite red and were reverted:** dropping `UNVERIFIED` from the
blocking set (4 red), adding `PARTIAL` to it (1 red), ignoring a missing cell (1 red), checking
only the first Core 3 client (5 red), and promoting an `antigravity` cell to `VERIFIED` with a
citation to a transcript that does not exist — which the gate cannot see but
`tests/matrix-integrity.test.mjs` catches by name, the two tools covering each other.

**Structural note:** the entry script cannot both export the policy and `await import` the
runner that needs it — that is a circular top-level await, and Node exits **13** with
"unsettled top-level await" rather than failing visibly. Hence three files: entry dispatches,
lib holds policy, run renders.

## Completion checklist

- [x] Matrix exists with every cell one of four statuses and no placeholder. — Five statuses, actually: `VERIFIED`/`PARTIAL`/`BLOCKED`/`UNVERIFIED`/`N/A`, enforced as a closed vocabulary by `tests/matrix-integrity.test.mjs`. 102 cells, no blanks, no `TODO`.
- [x] Every `PASS` carries a machine-checkable evidence reference. — 48 citations, every one resolved on disk: `smoke:<script>#N` validated against `docs/evidence/client-conformance.json`, and `transcript:<path>` against the file itself.
- [x] Generic OpenAI conformance harness passes against real HTTP. — `scripts/client-conformance.mjs`, **55/55**, real `fetch` over a real port.
- [x] OpenCode verified with transcripts, or explicitly `FAIL`/`UNVERIFIED`. — **16 VERIFIED / 1 UNVERIFIED**, nine transcripts. `models.list` is `UNVERIFIED` by measurement: the client never calls the endpoint.
- [x] Antigravity and Hermes recorded `UNVERIFIED` on this device with the reason; harnesses ready for a host that has them. — **Half of this is a deliberate deviation.** `antigravity` is absent and wholly `UNVERIFIED` with the reason recorded. `hermes` is **present** on this host — the plan and spec §12 were wrong about that, Task 1 corrected the measurement — so it was verified for real: **17 VERIFIED**, nine transcripts. Leaving a runnable client `UNVERIFIED` to match the plan's text would have been the fake-status failure inverted.
- [x] `client-gate.mjs --enforce` correctly blocks release while Core 3 cells are `UNVERIFIED`. — Exits **1** with 18 blocking cells listed; asserted by `tests/client-gate.test.mjs`.
- [x] No client-name branching added to any runtime path. — Still true, and still enforced: `packages/gateway/test/adversarial.test.ts` scans every gateway source outside `presets.ts` for the preset names. The four Task 4/5 fixes are all client-agnostic — `stream_options`, streamed `tool_calls`, the tool-description bound, and the message `name` key are OpenAI-contract features, not per-client special cases.

---

## AMENDMENT — FREE ONLY routing column (spec §25)

The matrix gains a seventeenth column, `free-only routing`, and Task 1's integrity
test gains it as a required column so it cannot be omitted.

- [x] Amend Task 1's column list to include `free-only routing` and re-run `node --test tests/matrix-integrity.test.mjs`. — **done at Task 1**: the column is in the integrity test's required list from the start, so all six clients carry it and it cannot be omitted. 9/9 green.
- [x] Amend Task 2's conformance harness with a check that a free-only route to a paid-classified provider fails `no_free_route` over real HTTP, so the `generic-openai` row's cell has a citable check number. — **`smoke:client-conformance#50`**, plus #48 (default is free-only), #51 (the paid origin was never called), #52 (stable envelope), and #53 (explicit opt-out still routes).
- [x] Amend Task 4's OpenCode verification to configure a free-only route and record the cell from the transcript. — **done**: `scripts/verify-opencode-scenarios.mjs` scenario 9 creates a route with **no** `freeOnly` field against a genuinely PAID-classified non-loopback provider, drives the real client, and records `transcript:docs/transcripts/opencode/free-only.md`. The transcript captures the route as created (`freeOnly: true` by default), the client's refusal, **0 upstream requests to the paid origin**, and an explicit opt-out then routing. Repeated for Hermes at Task 5.
- [x] Statuses for this column follow the same rule as every other: `UNVERIFIED` where the client cannot run here. — `antigravity/free-only routing` is `UNVERIFIED` (client absent). `opencode` and `hermes` are both `VERIFIED` from transcripts, and `generic-openai` cites `smoke:client-conformance#50`.

---

## Phase 9H — COMPLETE

Six tasks, six commits, and the completion checklist above is green. Final state:

**Matrix: 46 VERIFIED / 2 PARTIAL / 0 BLOCKED / 54 UNVERIFIED / 0 N/A** across 102 cells,
48 citations all resolving on disk.

| client | result |
| --- | --- |
| `generic-openai` | 13 VERIFIED, 2 PARTIAL — protocol conformance over real HTTP, 55/55 |
| `opencode` | **16 VERIFIED, 1 UNVERIFIED** — real client v1.18.23, 9 transcripts |
| `hermes` | **17 VERIFIED** — real client v0.20.5, 9 transcripts |
| `antigravity` | 17 UNVERIFIED — client absent from this host, absence recorded |
| `cline`, `continue` | 17 UNVERIFIED each — clients absent |

**The gate blocks, and that is the correct outcome.** `scripts/client-gate.mjs --enforce`
exits 1 with 18 blocking cells: 17 for the absent `antigravity` and one for
`opencode/models.list`. A release cannot be declared from this host, which is what a
mandatory-client gate is for.

**Real-client verification earned its place.** Driving two actual clients found **four
defects that 55 generic protocol checks could not see**, because none is a protocol
violation — each is a gap between what BAYZ accepted and what a real agent client sends:

1. `stream_options` refused outright (Task 4) — **no real OpenCode session could reach a
   provider at all**.
2. Streamed `tool_calls` silently dropped (Task 4) — the client re-sent the same request 18
   times, unable to tell that a call had been lost.
3. A 1 KiB tool-description cap (Task 4) — no real coding agent could call a tool, since
   OpenCode's `bash` description alone is 4,628 characters.
4. `name` refused on `role: "tool"` messages (Task 5) — the worst of the four, because it
   broke the roundtrip *after* the work was done: BAYZ delivered the call, Hermes executed
   it, and the result was rejected on the way back.

All four are fixed with regression tests pinning the measured values, so a future tightening
fails with the client that would break rather than passing review.

**Three defects were found in the harnesses themselves and fixed there, not blamed on BAYZ:**
a bodyless-`DELETE` content-type that silently made revocation a no-op, `api_key: ${VAR}`
missing from the Hermes YAML (401 with zero requests reaching BAYZ), and `-t execute_code`
naming a tool where a toolset was required. Each would have recorded a false `BLOCKED`.

**What is deliberately not claimed:** `opencode/models.list` stays `UNVERIFIED` because that
client never calls the endpoint; `hermes/models.list` is `VERIFIED` because it makes 10 such
calls per run. Two verified rows disagreeing on measured grounds is the matrix working.
Antigravity's harness exits **non-zero** on a host that has the client but whose config form
is unmeasured, rather than guessing field names and producing a transcript that looks like
evidence.

Next phase: **9I**. Not started, and out of 9H's scope.
