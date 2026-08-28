# BAYZ Router — Client Compatibility Matrix

**Phase:** 9H Task 1 · **Spec:** `docs/superpowers/specs/2026-08-27-bayz-phase9-goat-release-design.md` §12, amended by §25
**Status of this document:** the matrix skeleton exists and the vocabulary is enforced by
`tests/matrix-integrity.test.mjs`. **Every cell is `UNVERIFIED`.** No client has been
driven against BAYZ yet.

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
| `transcript:<path>` | a captured real-client session | `transcript:docs/transcripts/opencode/chat.log` |

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
| `opencode` | **present** — `/usr/local/bin/opencode` → `opencode-ai/bin/opencode.exe`, `--version` reports `1.18.23` | can be driven here; 9H Task 4 |
| `hermes` | **present** — `/root/.local/bin/hermes` → `hermes-agent/venv/bin/hermes`, `--version` reports `Hermes Agent v0.20.5` | can be driven here; 9H Task 5 |
| `antigravity` | **absent** — `command -v antigravity` finds nothing | not executable here; harness ships ready |
| `cline` | **absent** — `command -v cline` finds nothing | not executable here |
| `continue` | **absent** — the `command -v continue` hit resolves to the **shell builtin**; `type continue` reports `continue is a shell builtin`, and there is no `~/.continue` | not executable here; treating that hit as a client would have been a measurement error |

The `hermes` measurement corrects the plan and spec text, which recorded Hermes as absent.
It is present on this host now. The row stays `UNVERIFIED` — presence is not verification —
but 9H Task 5 can attempt it for real rather than only shipping a harness.

### The Core 3

`opencode`, `antigravity`, and `hermes` are release-blocking. 9H Task 6's
`scripts/client-gate.mjs --enforce` must exit non-zero while any Core 3 mandatory cell is
`UNVERIFIED` or `BLOCKED`. Today every Core 3 cell is `UNVERIFIED`, so the gate is
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

| capability | status | evidence / reason |
| --- | --- | --- |
| configure | UNVERIFIED | Binary present at /usr/local/bin/opencode (v1.18.23); not yet driven against BAYZ — 9H Task 4 owns this row. |
| authenticate | UNVERIFIED | Binary present at /usr/local/bin/opencode (v1.18.23); not yet driven against BAYZ — 9H Task 4 owns this row. |
| models.list | UNVERIFIED | Binary present at /usr/local/bin/opencode (v1.18.23); not yet driven against BAYZ — 9H Task 4 owns this row. |
| chat | UNVERIFIED | Binary present at /usr/local/bin/opencode (v1.18.23); not yet driven against BAYZ — 9H Task 4 owns this row. |
| stream | UNVERIFIED | Binary present at /usr/local/bin/opencode (v1.18.23); not yet driven against BAYZ — 9H Task 4 owns this row. |
| tool call | UNVERIFIED | Binary present at /usr/local/bin/opencode (v1.18.23); not yet driven against BAYZ — 9H Task 4 owns this row. |
| tool result roundtrip | UNVERIFIED | Binary present at /usr/local/bin/opencode (v1.18.23); not yet driven against BAYZ — 9H Task 4 owns this row. |
| large request | UNVERIFIED | Binary present at /usr/local/bin/opencode (v1.18.23); not yet driven against BAYZ — 9H Task 4 owns this row. |
| cancel | UNVERIFIED | Binary present at /usr/local/bin/opencode (v1.18.23); not yet driven against BAYZ — 9H Task 4 owns this row. |
| error surface | UNVERIFIED | Binary present at /usr/local/bin/opencode (v1.18.23); not yet driven against BAYZ — 9H Task 4 owns this row. |
| custom provider | UNVERIFIED | Binary present at /usr/local/bin/opencode (v1.18.23); not yet driven against BAYZ — 9H Task 4 owns this row. |
| proxy-bound route | UNVERIFIED | Binary present at /usr/local/bin/opencode (v1.18.23); not yet driven against BAYZ — 9H Task 4 owns this row. |
| combo | UNVERIFIED | Binary present at /usr/local/bin/opencode (v1.18.23); not yet driven against BAYZ — 9H Task 4 owns this row. |
| failover | UNVERIFIED | Binary present at /usr/local/bin/opencode (v1.18.23); not yet driven against BAYZ — 9H Task 4 owns this row. |
| restart/reconnect | UNVERIFIED | Binary present at /usr/local/bin/opencode (v1.18.23); not yet driven against BAYZ — 9H Task 4 owns this row. |
| key revoke/rotate | UNVERIFIED | Binary present at /usr/local/bin/opencode (v1.18.23); not yet driven against BAYZ — 9H Task 4 owns this row. |
| free-only routing | UNVERIFIED | Binary present at /usr/local/bin/opencode (v1.18.23); not yet driven against BAYZ — 9H Task 4 owns this row. |

### antigravity

| capability | status | evidence / reason |
| --- | --- | --- |
| configure | UNVERIFIED | Client absent on this host; `command -v antigravity` finds nothing, so no cell can be exercised here — 9H Task 5 harness. |
| authenticate | UNVERIFIED | Client absent on this host; `command -v antigravity` finds nothing, so no cell can be exercised here — 9H Task 5 harness. |
| models.list | UNVERIFIED | Client absent on this host; `command -v antigravity` finds nothing, so no cell can be exercised here — 9H Task 5 harness. |
| chat | UNVERIFIED | Client absent on this host; `command -v antigravity` finds nothing, so no cell can be exercised here — 9H Task 5 harness. |
| stream | UNVERIFIED | Client absent on this host; `command -v antigravity` finds nothing, so no cell can be exercised here — 9H Task 5 harness. |
| tool call | UNVERIFIED | Client absent on this host; `command -v antigravity` finds nothing, so no cell can be exercised here — 9H Task 5 harness. |
| tool result roundtrip | UNVERIFIED | Client absent on this host; `command -v antigravity` finds nothing, so no cell can be exercised here — 9H Task 5 harness. |
| large request | UNVERIFIED | Client absent on this host; `command -v antigravity` finds nothing, so no cell can be exercised here — 9H Task 5 harness. |
| cancel | UNVERIFIED | Client absent on this host; `command -v antigravity` finds nothing, so no cell can be exercised here — 9H Task 5 harness. |
| error surface | UNVERIFIED | Client absent on this host; `command -v antigravity` finds nothing, so no cell can be exercised here — 9H Task 5 harness. |
| custom provider | UNVERIFIED | Client absent on this host; `command -v antigravity` finds nothing, so no cell can be exercised here — 9H Task 5 harness. |
| proxy-bound route | UNVERIFIED | Client absent on this host; `command -v antigravity` finds nothing, so no cell can be exercised here — 9H Task 5 harness. |
| combo | UNVERIFIED | Client absent on this host; `command -v antigravity` finds nothing, so no cell can be exercised here — 9H Task 5 harness. |
| failover | UNVERIFIED | Client absent on this host; `command -v antigravity` finds nothing, so no cell can be exercised here — 9H Task 5 harness. |
| restart/reconnect | UNVERIFIED | Client absent on this host; `command -v antigravity` finds nothing, so no cell can be exercised here — 9H Task 5 harness. |
| key revoke/rotate | UNVERIFIED | Client absent on this host; `command -v antigravity` finds nothing, so no cell can be exercised here — 9H Task 5 harness. |
| free-only routing | UNVERIFIED | Client absent on this host; `command -v antigravity` finds nothing, so no cell can be exercised here — 9H Task 5 harness. |

### hermes

| capability | status | evidence / reason |
| --- | --- | --- |
| configure | UNVERIFIED | Binary present at /root/.local/bin/hermes (Hermes Agent v0.20.5); not yet driven against BAYZ — 9H Task 5 owns this row. |
| authenticate | UNVERIFIED | Binary present at /root/.local/bin/hermes (Hermes Agent v0.20.5); not yet driven against BAYZ — 9H Task 5 owns this row. |
| models.list | UNVERIFIED | Binary present at /root/.local/bin/hermes (Hermes Agent v0.20.5); not yet driven against BAYZ — 9H Task 5 owns this row. |
| chat | UNVERIFIED | Binary present at /root/.local/bin/hermes (Hermes Agent v0.20.5); not yet driven against BAYZ — 9H Task 5 owns this row. |
| stream | UNVERIFIED | Binary present at /root/.local/bin/hermes (Hermes Agent v0.20.5); not yet driven against BAYZ — 9H Task 5 owns this row. |
| tool call | UNVERIFIED | Binary present at /root/.local/bin/hermes (Hermes Agent v0.20.5); not yet driven against BAYZ — 9H Task 5 owns this row. |
| tool result roundtrip | UNVERIFIED | Binary present at /root/.local/bin/hermes (Hermes Agent v0.20.5); not yet driven against BAYZ — 9H Task 5 owns this row. |
| large request | UNVERIFIED | Binary present at /root/.local/bin/hermes (Hermes Agent v0.20.5); not yet driven against BAYZ — 9H Task 5 owns this row. |
| cancel | UNVERIFIED | Binary present at /root/.local/bin/hermes (Hermes Agent v0.20.5); not yet driven against BAYZ — 9H Task 5 owns this row. |
| error surface | UNVERIFIED | Binary present at /root/.local/bin/hermes (Hermes Agent v0.20.5); not yet driven against BAYZ — 9H Task 5 owns this row. |
| custom provider | UNVERIFIED | Binary present at /root/.local/bin/hermes (Hermes Agent v0.20.5); not yet driven against BAYZ — 9H Task 5 owns this row. |
| proxy-bound route | UNVERIFIED | Binary present at /root/.local/bin/hermes (Hermes Agent v0.20.5); not yet driven against BAYZ — 9H Task 5 owns this row. |
| combo | UNVERIFIED | Binary present at /root/.local/bin/hermes (Hermes Agent v0.20.5); not yet driven against BAYZ — 9H Task 5 owns this row. |
| failover | UNVERIFIED | Binary present at /root/.local/bin/hermes (Hermes Agent v0.20.5); not yet driven against BAYZ — 9H Task 5 owns this row. |
| restart/reconnect | UNVERIFIED | Binary present at /root/.local/bin/hermes (Hermes Agent v0.20.5); not yet driven against BAYZ — 9H Task 5 owns this row. |
| key revoke/rotate | UNVERIFIED | Binary present at /root/.local/bin/hermes (Hermes Agent v0.20.5); not yet driven against BAYZ — 9H Task 5 owns this row. |
| free-only routing | UNVERIFIED | Binary present at /root/.local/bin/hermes (Hermes Agent v0.20.5); not yet driven against BAYZ — 9H Task 5 owns this row. |

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
| `VERIFIED` | 13 |
| `PARTIAL` | 2 |
| `BLOCKED` | 0 |
| `UNVERIFIED` | 87 |
| `N/A` | 0 |

102 = 6 clients × 17 capabilities. Every non-`UNVERIFIED` cell is in the
**`generic-openai`** row and cites a numbered check in
`scripts/client-conformance.mjs`, which `tests/matrix-integrity.test.mjs` resolves on disk.

**No real client has been driven against BAYZ yet.** The `generic-openai` row proves the
protocol contract holds over real HTTP; it says nothing about how OpenCode, Antigravity, or
Hermes behave, and every Core 3 cell is still `UNVERIFIED`. The gate 9H Task 6 builds is
expected to block a release from this state.
