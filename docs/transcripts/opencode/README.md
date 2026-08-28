# OpenCode → BAYZ — real-client transcripts

Captured by `scripts/verify-opencode.mjs` (9H Task 4) against the **real `opencode` binary**
installed on this host — `/usr/local/bin/opencode`, v1.18.23 — running as a child process
against a real BAYZ listener with a real SQLite database, real envelope crypto, real
loopback provider origins, and a real HTTP CONNECT proxy.

Regenerate with `node scripts/verify-opencode.mjs`. It runs one real client process at a
time; each `opencode run` takes roughly 20 seconds, so the full suite is several minutes.
The script **exits non-zero if it claims a cell whose transcript is not on disk** — a
verdict is not evidence.

## Driving the real client found three defects. That is the point of this task.

None of the three was visible to the 55 generic protocol checks in
`scripts/client-conformance.mjs`, because none of them is a protocol violation. They are
mismatches between what BAYZ accepted and what a real agent client actually sends.

1. **`stream_options` was refused outright.** OpenCode sends
   `stream_options: {"include_usage": true}` on every request. The gateway's strict
   allow-list had no entry for it, so the entire request failed
   `invalid_request (unknown-key)` and **no real OpenCode session could reach a provider at
   all.** Fixed in `packages/gateway/src/normalize.ts`: validated rather than dropped, so
   `include_usage: false` — which BAYZ genuinely cannot honour, since usage feeds accounting
   — is refused instead of silently ignored.

2. **Streamed `tool_calls` were silently dropped.** `packages/router/src/chunk.ts` had
   always parsed them, and the non-streaming path had always rendered them, but the
   streaming renderer in `apps/server/src/routes/chat.ts` built a `content`-only delta. So a
   streaming client received `finish_reason: "tool_calls"` with no calls attached, treated it
   as an empty turn, and re-sent the identical request — **18 times** in the first capture
   before the run was killed. A client cannot recover from this: nothing in the response says
   a call was lost.

3. **The 1 KiB tool-description cap refused the client's payload.** OpenCode's `bash`
   description alone is 4,628 characters; `task` is 3,019 and `todowrite` 2,012. Agent
   clients put their whole usage contract in the description. The cap was set against
   hand-written examples, not a real client, and raised to 16 KiB per tool — with the
   aggregate 1 MiB `MAX_REQUEST_BYTES` bound (checked last, on the validated request) doing
   the work of actually limiting input.

Each fix has a regression test that pins the real measured numbers, so a future tightening
fails with the client that would break rather than passing review.

## The transcripts

| file | scenario | what it demonstrates |
| --- | --- | --- |
| `configure-authenticate.md` | wiring | the documented JSON config is accepted; a corrupted key is refused; **zero** `GET /v1/models` requests |
| `chat-stream.md` | chat + stream | `stream:true` by default, SSE frames rendered, usage in the final chunk |
| `tool-roundtrip.md` | tools | a streamed call reassembled by `index`, `bash` executed, `role:"tool"` result answered |
| `large-request.md` | large request | a 67,447-byte request served intact, not truncated |
| `cancel.md` | cancel | SIGINT mid-flight destroyed the upstream socket before the response completed |
| `error-surface-and-keys.md` | errors + keys | a legible one-line error, not a stack trace; rotation kills the old key; deletion locks the client out |
| `routing.md` | routing | a custom provider; a CONNECT proxy logging the origin authority; `routingMode:"combo"`; failover after the primary was killed |
| `free-only.md` | §25 free-only | `freeOnly` defaults true; a PAID-classified provider refused with **0 upstream requests**; an explicit opt-out then routes |

## What is not claimed

**`models.list` is `UNVERIFIED`, and stays that way.** OpenCode offers the models listed in
its own config `models` map and never calls `GET /v1/models`. A full `opencode models bayz`
run recorded zero requests to that endpoint, which `configure-authenticate.md` shows. The
command prints the right model, so promoting the cell would have been easy and wrong: BAYZ's
discovery endpoint was never exercised by this client. That is a fact about OpenCode, not a
defect in either side.

## Redaction

Transcripts are committed, so they are redacted deterministically. Secrets are replaced **by
name** — the admin token, the provider credential, the proxy password, the master key, and
every per-scenario client key — rather than by pattern-matching a shape, so a credential
cannot survive because it happened not to look like one. Ports, temp paths, UUIDs,
timestamps, and latencies are normalised so a re-run reproduces the same bytes instead of a
diff nobody reads. Sections longer than 4,000 characters are truncated **with the real total
stated**, because the client's own request body is ~30 KiB of system prompt and tool schemas.
