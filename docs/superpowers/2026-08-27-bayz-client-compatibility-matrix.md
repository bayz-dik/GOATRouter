# BAYZ Router — Client Compatibility Matrix

**Phase:** 9H Tasks 1–5 · **Spec:** `docs/superpowers/specs/2026-08-27-bayz-phase9-goat-release-design.md` §12, amended by §25
**Status of this document:** the matrix exists and the vocabulary is enforced by
`tests/matrix-integrity.test.mjs`. **Three rows carry evidence:** `generic-openai` from the
protocol conformance harness, and `opencode` and `hermes` from real-client runs against the
installed binaries. Antigravity, Cline, and Continue are absent from this host and every one
of their cells is `UNVERIFIED`.

## What this document is, and what it is not

This records **what has actually been observed**, client by client, capability by
capability. It is deliberately separate from what BAYZ *implements*.

That separation is the whole point. BAYZ has an OpenAI-compatible gateway with streaming,
tool calling, scoped client identities, custom providers, proxy-bound routes, combos,
failover, and free-only routing — all of it covered by 1897 tests and 998 smoke checks
against real listeners, real databases, and real loopback origins. **None of that is a
compatibility claim.** A capability can be correct at the protocol level and still fail a
particular client, because that client sends a header nobody anticipated, parses a field
strictly, or reconnects in a way the server did not expect. Only running the real client
answers that, and until a real client has been run the honest value is `UNVERIFIED`.

So:

- **Implemented capability** lives in the phase plans, the test suites, and the smoke
  scripts. It is proven, and it is not in this table.
- **Verified client behaviour** lives here. Nothing enters it without evidence that
  resolves on disk.

Nothing in this document is a screenshot, a transcript, a test, or a check that does not
exist. Where a client is absent from this host, that is stated as absence — not as an
untested pass, and not as a failure of BAYZ.

## Status vocabulary

Exactly one of these per cell. The vocabulary is closed and enforced; a blank, `-`, `?`,
`TODO`, or `TBD` fails `tests/matrix-integrity.test.mjs`.

- **`VERIFIED`** — the capability was exercised against the real client and observed to
  work. **Requires evidence.** A cell may not read `VERIFIED` on anybody's judgement,
  including the author's.
- **`PARTIAL`** — exercised against the real client and it works within a stated limit
  (a subset of inputs, a degraded mode, a workaround the user must apply). **Requires
  evidence**, and the limit must be named in the same cell.
- **`BLOCKED`** — an attempt was made and the capability does **not** work, or cannot work
  in this environment for a stated reason. Something was learned. Requires a reason.
- **`UNVERIFIED`** — nothing has been attempted. Nothing is known. Requires a reason
  stating why not, so an untried cell cannot be mistaken for a tried one.
- **`N/A`** — the client has no such surface, so there is nothing to verify. A chat client
  with no tool support is not "unverified" at tool calling; demanding evidence for a
  capability that cannot exist would make the gate unsatisfiable. Requires a reason.

### The distinction that matters: `BLOCKED` vs `UNVERIFIED`

`BLOCKED` means *tried and it did not work*. `UNVERIFIED` means *not tried*. Collapsing
them is the specific failure this phase exists to prevent — an untried cell that reads
like a tried one is how a matrix ends up asserting compatibility nobody ever observed.
`UNVERIFIED` is never rolled up into a pass, a percentage, or a summary that implies
readiness.

## Evidence format

A `VERIFIED` or `PARTIAL` cell cites evidence in one of exactly three forms. Multiple
citations may be comma-separated, and **every** one must parse — one good citation beside
one hand-waved sentence fails the test.

| form | meaning | example |
| --- | --- | --- |
| `smoke:<script>#<n>` | numbered check in a smoke script | `smoke:client-conformance#7` |
| `test:<path>` | a test file in this repository | `test:apps/server/test/tools-api.test.ts` |
| `transcript:<path>` | a captured real-client session | `transcript:docs/transcripts/opencode/chat-stream.md` |

Grammar, as enforced:

```text
^(smoke:[a-z-]+#\d+|test:[\w./-]+|transcript:[\w./-]+)$
```

`tests/matrix-integrity.test.mjs` does not merely pattern-match these — it **resolves
them**:

- `test:` and `transcript:` paths must exist on disk. A cited file that is not there fails
  the test, which is what stops the easiest route to a green matrix: inventing a plausible
  path.
- `smoke:<script>#<n>` must exist **and the number must be right**. A harness writes
  `docs/evidence/<script>.json` on a fully passing run, mapping each capability to the
  check number that covers it, and the test resolves the citation against that manifest.
  So a cell cannot cite a check number the script never assigned, cite a capability the
  script never exercises, or cite the wrong capability's number. Without the manifest the
  number was decoration — `smoke:client-conformance#99` for an unexercised capability
  passed, which is precisely a fake compatibility claim.

A `PARTIAL` cell carries its citations **and** a limitation after an em dash
(` — `), and the test requires both. Evidence alone would say "it works, sort of" and
leave a reader guessing; a limitation alone would be an unevidenced claim. A `VERIFIED`
cell must carry citations and *no* trailing prose — a caveat inside a full pass is exactly
what `PARTIAL` exists for.

> The grammar is written literally here and in the integrity test. 9I, 9J, and 9K each
> specify the same shape for their own matrices; 9L Task 1 builds `scripts/evidence.mjs`
> as the single source and refactors all four to import it. It is duplicated once so this
> subprogram stands alone, and is expected to be **replaced** rather than copied again.

## Clients

Row identifiers are the **real protocol/preset identifiers** the runtime already accepts —
`opencode`, `antigravity`, `hermes`, `generic-openai` are the preset names validated in
`packages/identity/src/repository.ts`. The matrix and the runtime name clients in the same
words on purpose, so a row cannot drift into a marketing label.

**No client-name branching exists in any runtime path**, and none is introduced here. BAYZ
derives behaviour from the protocol, the Accept header, the body shape, and the caller's
scopes — never from a product identifier. The presets exist to label an operator's key and
to select a documentation page, not to change how a request is served.

### Device reality, measured on this host

Measured directly, not assumed:

| client | measurement | consequence |
| --- | --- | --- |
| `opencode` | **present** — `/usr/local/bin/opencode` → `opencode-ai/bin/opencode.exe`, `--version` reports `1.18.23` | **driven for real; 9H Task 4 filled the row** |
| `hermes` | **present** — `/root/.local/bin/hermes` → `hermes-agent/venv/bin/hermes`, `--version` reports `Hermes Agent v0.20.5` | **driven for real; 9H Task 5 filled the row** |
| `antigravity` | **absent** — no executable file named `antigravity` on PATH | not executable here; `scripts/verify-antigravity.mjs` records the absence and exits 0 |
| `cline` | **absent** — `command -v cline` finds nothing | not executable here |
| `continue` | **absent** — the `command -v continue` hit resolves to the **shell builtin**; `type continue` reports `continue is a shell builtin`, and there is no `~/.continue` | not executable here; treating that hit as a client would have been a measurement error |

The `hermes` measurement corrects the plan and spec text, which recorded Hermes as absent.
It is present on this host now. The row stays `UNVERIFIED` — presence is not verification —
but 9H Task 5 can attempt it for real rather than only shipping a harness.

### The Core 3

`opencode`, `antigravity`, and `hermes` are release-blocking. 9H Task 6's
`scripts/client-gate.mjs --enforce` must exit non-zero while any Core 3 mandatory cell is
`UNVERIFIED` or `BLOCKED`. `opencode` is verified 16 of 17 (`models.list` `UNVERIFIED`
because the client does not use that surface) and `hermes` is verified 17 of 17;
`antigravity` is absent from this host and entirely `UNVERIFIED`, so the gate is still
expected to block — that is the correct current state, not a defect.

## How a cell moves to `VERIFIED`

All five, or the cell does not move:

1. **A real client process.** The actual client binary, invoked as a user would invoke it.
   Not `fetch`, not `app.inject`, not a script imitating the client's requests.
2. **A real BAYZ listener.** A real port, a real SQLite database, a real provider origin,
   a scoped client identity created through the management API.
3. **An observed result.** The capability demonstrably did its job — a completion arrived,
   a stream yielded frames, a tool result completed a roundtrip.
4. **Captured evidence on disk.** A transcript under `docs/transcripts/<client>/`, or a
   numbered smoke check, or a test file. `tests/matrix-integrity.test.mjs` resolves the
   path; an unresolvable citation fails.
5. **A harness that refuses to self-certify.** Per 9H Task 4, a verification script must
   exit non-zero if it claims a cell it has no transcript for. A cell may not become
   `VERIFIED` from a script's own opinion.

`PARTIAL` needs all five plus the limitation named in the cell. `BLOCKED` needs steps 1–3
attempted and the observed error or environmental blocker recorded. `UNVERIFIED` needs
only an honest reason for not having tried.

## Capabilities

Seventeen per client: the sixteen from spec §12 plus `free-only routing` from the §25
amendment. `free-only routing` is not optional — free-first is a load-bearing economic
guarantee (a route created without `freeOnly` defaults to free-only), so a client that
silently spends money would be a compatibility failure even if every other cell passed.

| capability | what a `VERIFIED` here would mean |
| --- | --- |
| configure | the client accepts the documented base URL and key and reaches BAYZ |
| authenticate | a scoped client key authenticates; a wrong key is refused |
| models.list | `GET /v1/models` returns routes the client can select from |
| chat | a non-streaming completion arrives intact |
| stream | SSE frames arrive incrementally and terminate correctly |
| tool call | the client receives a tool call and can act on it |
| tool result roundtrip | a tool result returns and the model answers using it |
| large request | a large payload is accepted or bounded cleanly, not truncated silently |
| cancel | client-side abort tears the upstream request down |
| error surface | BAYZ errors reach the user legibly rather than as a crash |
| custom provider | a custom `openai-compatible` provider serves the client |
| proxy-bound route | a route pinned to a proxy genuinely tunnels |
| combo | multi-provider combo routing serves the client |
| failover | a dead primary fails over without the client noticing |
| restart/reconnect | the client recovers across a BAYZ restart |
| key revoke/rotate | revocation takes effect immediately; rotation keeps the client working |
| free-only routing | a free-only route refuses to spend, and the client surfaces that |

---

## Matrix

Every cell below is `UNVERIFIED`. The reason column records what was measured about the
client's availability on this host and which task owns filling the row in.

### opencode

Filled by 9H Task 4 from `scripts/verify-opencode.mjs`, which drives the **real `opencode`
binary** (v1.18.23) as a child process against a real BAYZ listener — a real config file in
an isolated HOME, real stdout and stderr, real loopback provider origins, a real HTTP
CONNECT proxy, and a scoped identity created through the management API. The script exits
non-zero if it claims a cell whose transcript is not on disk.

Driving the real client found **three defects the 55 generic protocol checks could not
see**, all fixed with regression tests before any cell was filled:

1. `stream_options` — sent by this client on every request — hit the strict allow-list and
   the whole request was refused `invalid_request (unknown-key)`. No real OpenCode session
   could reach a provider.
2. Streamed `tool_calls` were **silently dropped**: the streaming renderer built a
   `content`-only delta, so the client saw `finish_reason: "tool_calls"` with no calls
   attached and re-sent the identical request 18 times before the run was killed.
3. The 1 KiB tool-description cap refused this client's payload outright — its `bash`
   description alone is 4,628 characters.

What each transcript demonstrates:

| transcript | what it captures |
| --- | --- |
| `configure-authenticate.md` | the documented JSON config accepted; a corrupted key refused; zero `GET /v1/models` |
| `chat-stream.md` | `stream:true` by default, SSE frames rendered, usage in the final chunk |
| `tool-roundtrip.md` | a streamed call reassembled by `index`, `bash` executed, `role:"tool"` result answered |
| `large-request.md` | a 67,447-byte request served intact, not truncated |
| `cancel.md` | SIGINT mid-flight destroyed the upstream socket before the response completed |
| `error-surface-and-keys.md` | a legible one-line error, not a stack trace; rotation kills the old key, deletion locks the client out |
| `routing.md` | a custom provider; a CONNECT proxy logging the origin authority; `routingMode:"combo"`; failover after the primary was killed |
| `free-only.md` | `freeOnly` defaults true; a PAID-classified provider refused with **0 upstream requests**; an explicit opt-out then routes |

| capability | status | evidence / reason |
| --- | --- | --- |
| configure | VERIFIED | transcript:docs/transcripts/opencode/configure-authenticate.md |
| authenticate | VERIFIED | transcript:docs/transcripts/opencode/configure-authenticate.md |
| models.list | UNVERIFIED | The client never calls `GET /v1/models`: it offers the models listed in its own config `models` map, so BAYZ's discovery endpoint is not exercised by this client at all. A full `opencode models bayz` run recorded zero such requests. Not a BAYZ defect and not a client defect — the surface simply is not used, and promoting the cell because the command printed the right thing would be a fake claim. |
| chat | VERIFIED | transcript:docs/transcripts/opencode/chat-stream.md |
| stream | VERIFIED | transcript:docs/transcripts/opencode/chat-stream.md |
| tool call | VERIFIED | transcript:docs/transcripts/opencode/tool-roundtrip.md |
| tool result roundtrip | VERIFIED | transcript:docs/transcripts/opencode/tool-roundtrip.md |
| large request | VERIFIED | transcript:docs/transcripts/opencode/large-request.md |
| cancel | VERIFIED | transcript:docs/transcripts/opencode/cancel.md |
| error surface | VERIFIED | transcript:docs/transcripts/opencode/error-surface-and-keys.md |
| custom provider | VERIFIED | transcript:docs/transcripts/opencode/routing.md |
| proxy-bound route | VERIFIED | transcript:docs/transcripts/opencode/routing.md |
| combo | VERIFIED | transcript:docs/transcripts/opencode/routing.md |
| failover | VERIFIED | transcript:docs/transcripts/opencode/routing.md |
| restart/reconnect | VERIFIED | transcript:docs/transcripts/opencode/restart-reconnect.md |
| key revoke/rotate | VERIFIED | transcript:docs/transcripts/opencode/error-surface-and-keys.md |
| free-only routing | VERIFIED | transcript:docs/transcripts/opencode/free-only.md |

### antigravity

| capability | status | evidence / reason |
| --- | --- | --- |
| configure | UNVERIFIED | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, and exits 0. Nothing was attempted, so nothing is known — UNVERIFIED, not BLOCKED. |
| authenticate | UNVERIFIED | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, and exits 0. Nothing was attempted, so nothing is known — UNVERIFIED, not BLOCKED. |
| models.list | UNVERIFIED | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, and exits 0. Nothing was attempted, so nothing is known — UNVERIFIED, not BLOCKED. |
| chat | UNVERIFIED | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, and exits 0. Nothing was attempted, so nothing is known — UNVERIFIED, not BLOCKED. |
| stream | UNVERIFIED | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, and exits 0. Nothing was attempted, so nothing is known — UNVERIFIED, not BLOCKED. |
| tool call | UNVERIFIED | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, and exits 0. Nothing was attempted, so nothing is known — UNVERIFIED, not BLOCKED. |
| tool result roundtrip | UNVERIFIED | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, and exits 0. Nothing was attempted, so nothing is known — UNVERIFIED, not BLOCKED. |
| large request | UNVERIFIED | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, and exits 0. Nothing was attempted, so nothing is known — UNVERIFIED, not BLOCKED. |
| cancel | UNVERIFIED | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, and exits 0. Nothing was attempted, so nothing is known — UNVERIFIED, not BLOCKED. |
| error surface | UNVERIFIED | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, and exits 0. Nothing was attempted, so nothing is known — UNVERIFIED, not BLOCKED. |
| custom provider | UNVERIFIED | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, and exits 0. Nothing was attempted, so nothing is known — UNVERIFIED, not BLOCKED. |
| proxy-bound route | UNVERIFIED | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, and exits 0. Nothing was attempted, so nothing is known — UNVERIFIED, not BLOCKED. |
| combo | UNVERIFIED | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, and exits 0. Nothing was attempted, so nothing is known — UNVERIFIED, not BLOCKED. |
| failover | UNVERIFIED | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, and exits 0. Nothing was attempted, so nothing is known — UNVERIFIED, not BLOCKED. |
| restart/reconnect | UNVERIFIED | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, and exits 0. Nothing was attempted, so nothing is known — UNVERIFIED, not BLOCKED. |
| key revoke/rotate | UNVERIFIED | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, and exits 0. Nothing was attempted, so nothing is known — UNVERIFIED, not BLOCKED. |
| free-only routing | UNVERIFIED | Client absent: no executable file named `antigravity` exists on PATH. `scripts/verify-antigravity.mjs` checks for a real file rather than using `command -v`, which a shell builtin would satisfy, records the absence, writes no transcript, and exits 0. Nothing was attempted, so nothing is known — UNVERIFIED, not BLOCKED. |

### hermes

Filled by 9H Task 5 from `scripts/verify-hermes.mjs`, which drives the **real `hermes`
binary** (v0.20.5) as a child process against a real BAYZ listener. Every scenario runs in a
throwaway `HERMES_HOME` *and* `HOME`, so the operator's live `~/.hermes` is never read or
written — this agent is itself Hermes, and clobbering that directory would destroy the
session performing the verification.

**Driving this client found a fourth real defect**, on top of Task 4's three: the message
allow-list in `packages/router/src/request.ts` refused `name`, which Hermes sends on every
`role: "tool"` message (`{role, tool_call_id, name, content}`). BAYZ delivered the tool call,
Hermes executed it, and the **result was refused on the way back** with
`invalid_request (message-unknown-key)` — a tool roundtrip was impossible for this client.
`name` is part of the OpenAI chat contract; it is now validated and bounded, and deliberately
**not** forwarded, because `tool_call_id` already identifies the call.

Unlike OpenCode, Hermes genuinely calls `GET /v1/models` — 10 discovery calls in a single
one-shot run — so its `models.list` cell is `VERIFIED` where OpenCode's is `UNVERIFIED`. Two
rows differing on measured grounds is the matrix working as intended.

| transcript | what it captures |
| --- | --- |
| `configure-authenticate.md` | the YAML config accepted; a corrupted key refused 401; 10 `GET /v1/models` calls served 200 |
| `chat-stream.md` | `stream:true` by default, SSE consumed, usage in the final chunk |
| `tool-roundtrip.md` | 2 tool definitions advertised, the streamed call delivered, `role:"tool"` result answered |
| `large-request.md` | a 95,047-byte request served intact |
| `cancel.md` | SIGINT mid-flight destroyed the upstream socket before the response completed |
| `error-surface-and-keys.md` | `HTTP <status>: <message>` reaches the user, not a traceback; rotation and revocation both bite |
| `routing.md` | a custom provider; a CONNECT proxy logging the origin authority; `routingMode:"combo"`; failover |
| `free-only.md` | `freeOnly` defaults true; a PAID provider refused with **0 upstream requests**; opt-out then routes |

| capability | status | evidence / reason |
| --- | --- | --- |
| configure | VERIFIED | transcript:docs/transcripts/hermes/configure-authenticate.md |
| authenticate | VERIFIED | transcript:docs/transcripts/hermes/configure-authenticate.md |
| models.list | VERIFIED | transcript:docs/transcripts/hermes/configure-authenticate.md |
| chat | VERIFIED | transcript:docs/transcripts/hermes/chat-stream.md |
| stream | VERIFIED | transcript:docs/transcripts/hermes/chat-stream.md |
| tool call | VERIFIED | transcript:docs/transcripts/hermes/tool-roundtrip.md |
| tool result roundtrip | VERIFIED | transcript:docs/transcripts/hermes/tool-roundtrip.md |
| large request | VERIFIED | transcript:docs/transcripts/hermes/large-request.md |
| cancel | VERIFIED | transcript:docs/transcripts/hermes/cancel.md |
| error surface | VERIFIED | transcript:docs/transcripts/hermes/error-surface-and-keys.md |
| custom provider | VERIFIED | transcript:docs/transcripts/hermes/routing.md |
| proxy-bound route | VERIFIED | transcript:docs/transcripts/hermes/routing.md |
| combo | VERIFIED | transcript:docs/transcripts/hermes/routing.md |
| failover | VERIFIED | transcript:docs/transcripts/hermes/routing.md |
| restart/reconnect | VERIFIED | transcript:docs/transcripts/hermes/restart-reconnect.md |
| key revoke/rotate | VERIFIED | transcript:docs/transcripts/hermes/error-surface-and-keys.md |
| free-only routing | VERIFIED | transcript:docs/transcripts/hermes/free-only.md |

### generic-openai

Filled by 9H Task 2 from `scripts/client-conformance.mjs` (**55/55**), which drives BAYZ
over real HTTP with real `fetch` — no `app.inject`, no in-process shortcut. Two cells stay
`UNVERIFIED` because that harness deliberately does not exercise them.

| capability | status | evidence / reason |
| --- | --- | --- |
| configure | VERIFIED | smoke:client-conformance#1 |
| authenticate | VERIFIED | smoke:client-conformance#3 |
| models.list | VERIFIED | smoke:client-conformance#5 |
| chat | VERIFIED | smoke:client-conformance#9 |
| stream | VERIFIED | smoke:client-conformance#14 |
| tool call | VERIFIED | smoke:client-conformance#22 |
| tool result roundtrip | VERIFIED | smoke:client-conformance#27 |
| large request | PARTIAL | smoke:client-conformance#31 — a 120 KiB message is served in full; the plan's 200 KiB payload exceeds MAX_CONTENT_CHARS (128,000) and is cleanly refused 400, never truncated or 5xx |
| cancel | VERIFIED | smoke:client-conformance#35 |
| error surface | PARTIAL | smoke:client-conformance#37 — every malformed request returns the stable envelope with the right status, but a JSON scalar body reports `capability_unsupported` when the real cause is body shape |
| custom provider | VERIFIED | smoke:client-conformance#42 |
| proxy-bound route | UNVERIFIED | Not exercised by the conformance harness; needs a real CONNECT proxy fixture, which 9H Task 4 owns. |
| combo | VERIFIED | smoke:client-conformance#46 |
| failover | VERIFIED | smoke:client-conformance#44 |
| restart/reconnect | UNVERIFIED | Not exercised by the conformance harness; needs a client surviving a real listener restart — 9H Task 4/5. |
| key revoke/rotate | VERIFIED | smoke:client-conformance#49 |
| free-only routing | VERIFIED | smoke:client-conformance#52 |

### continue

| capability | status | evidence / reason |
| --- | --- | --- |
| configure | UNVERIFIED | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| authenticate | UNVERIFIED | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| models.list | UNVERIFIED | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| chat | UNVERIFIED | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| stream | UNVERIFIED | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| tool call | UNVERIFIED | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| tool result roundtrip | UNVERIFIED | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| large request | UNVERIFIED | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| cancel | UNVERIFIED | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| error surface | UNVERIFIED | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| custom provider | UNVERIFIED | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| proxy-bound route | UNVERIFIED | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| combo | UNVERIFIED | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| failover | UNVERIFIED | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| restart/reconnect | UNVERIFIED | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| key revoke/rotate | UNVERIFIED | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |
| free-only routing | UNVERIFIED | Client absent on this host; the `command -v continue` hit resolves to the shell builtin, and there is no ~/.continue. |

### cline

| capability | status | evidence / reason |
| --- | --- | --- |
| configure | UNVERIFIED | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| authenticate | UNVERIFIED | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| models.list | UNVERIFIED | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| chat | UNVERIFIED | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| stream | UNVERIFIED | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| tool call | UNVERIFIED | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| tool result roundtrip | UNVERIFIED | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| large request | UNVERIFIED | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| cancel | UNVERIFIED | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| error surface | UNVERIFIED | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| custom provider | UNVERIFIED | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| proxy-bound route | UNVERIFIED | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| combo | UNVERIFIED | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| failover | UNVERIFIED | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| restart/reconnect | UNVERIFIED | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| key revoke/rotate | UNVERIFIED | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |
| free-only routing | UNVERIFIED | Client absent on this host; `command -v cline` finds nothing, and no cell can be exercised here. |

---

## Current tally

| status | cells |
| --- | --- |
| `VERIFIED` | 46 |
| `PARTIAL` | 2 |
| `BLOCKED` | 0 |
| `UNVERIFIED` | 54 |
| `N/A` | 0 |

102 = 6 clients × 17 capabilities. Three rows carry evidence: **`generic-openai`** (13
`VERIFIED`, 2 `PARTIAL`, `smoke:` citations into `scripts/client-conformance.mjs`),
**`opencode`** (16 `VERIFIED`, `transcript:` citations) and **`hermes`** (17 `VERIFIED`,
`transcript:` citations). `tests/matrix-integrity.test.mjs` resolves all 48 citations on disk.

**Two of the Core 3 are now verified against the real client.** Between them, Tasks 4 and 5
found **four defects that the 55 generic protocol checks could not see**, because none is a
protocol violation:

1. `stream_options` refused outright — no real OpenCode session could reach a provider.
2. Streamed `tool_calls` silently dropped — the client re-sent the same request 18 times.
3. A 1 KiB tool-description cap that no real agent client could satisfy.
4. `name` refused on `role: "tool"` messages — the Hermes tool result was refused *on the
   way back*, after BAYZ had delivered the call and the client had executed it.

All four are fixed with regression tests pinning the measured values. That is the argument
for real-client verification over protocol conformance, stated as a result rather than a
principle.

Two cells differ **between** verified rows on measured grounds, which is the matrix doing its
job: `opencode/models.list` is `UNVERIFIED` because that client reads its own config `models`
map and never calls `GET /v1/models`, while `hermes/models.list` is `VERIFIED` because Hermes
makes 10 such calls in a single run.

**`antigravity` remains entirely `UNVERIFIED`** — the client is not installed on this host,
`scripts/verify-antigravity.mjs` records the absence and writes no transcript, so no cell can
be promoted. The Core 3 gate must therefore still block a release, which is the correct
current state.
