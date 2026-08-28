# Hermes Agent → BAYZ — real-client transcripts

Captured by `scripts/verify-hermes.mjs` (9H Task 5) against the **real `hermes` binary**
installed on this host — `/root/.local/bin/hermes`, Hermes Agent v0.20.5 — running as a child
process against a real BAYZ listener with a real SQLite database, real envelope crypto, real
loopback provider origins, and a real HTTP CONNECT proxy.

**Isolation matters more here than for OpenCode.** This agent *is* Hermes, so every scenario
runs in a throwaway `HERMES_HOME` **and** `HOME`. Redirecting `HERMES_HOME` alone would leave
some paths resolving under the real `$HOME`, and a stray write into `~/.hermes` could destroy
the session performing the verification. The operator's live config, sessions, and credentials
are never read or written.

Regenerate with `node scripts/verify-hermes.mjs` — roughly ten minutes, one real client
process at a time (Hermes loads plugins, skills, and a large tool registry before its first
request, so ~40 seconds per run is normal). The script **exits non-zero if it claims a cell
whose transcript is not on disk**.

## Driving this client found a fourth real defect

Task 4 found three against OpenCode. This one is different in kind, and worse: it broke the
tool roundtrip **after** the work had been done.

**`name` was refused on `role: "tool"` messages.** The message allow-list in
`packages/router/src/request.ts` permitted `role`, `content`, `tool_calls`, and
`tool_call_id`. Hermes sends `{role, tool_call_id, name, content}` — `name` is part of the
OpenAI chat contract. So BAYZ delivered the tool call, Hermes executed it, and the result was
rejected on the way back with `invalid_request (message-unknown-key)`. The client printed
`HTTP 400: … (stage: message-unknown-key)` and the turn died with the work already spent.

`name` is now validated and bounded (64 characters, matching the tool-name bound) and
deliberately **not forwarded** upstream: `tool_call_id` already identifies the call
unambiguously, so echoing a client-supplied string into the provider request would add
untrusted data for no gain. It is validated anyway — "we drop it" is not a reason to skip
bounding a value that still has to be parsed and held.

## Two configuration facts that cost a run each

**`api_key: ${VAR}` in `config.yaml` is load-bearing.** The first probe wrote the key only
into `.env` and Hermes answered `HTTP 401: A valid API token is required` with **zero**
requests reaching BAYZ — the credential was never sent. The YAML must reference the variable,
which is exactly what the live file on this host does.

**`-t` takes toolset names, not tool names.** The first tool scenario passed `-t execute_code`
— a tool — and Hermes answered `ignoring unknown --toolsets entries` and exited 2 before
sending a single request. That would have recorded both tool cells `BLOCKED` against BAYZ for
a mistake in the harness. `terminal` is a real toolset, read from
`/usr/local/lib/hermes-agent/toolsets.py`.

## The transcripts

| file | scenario | what it demonstrates |
| --- | --- | --- |
| `configure-authenticate.md` | wiring | the YAML config accepted; a corrupted key refused 401; **10** `GET /v1/models` calls served 200 |
| `chat-stream.md` | chat + stream | `stream:true` by default, SSE consumed, usage in the final chunk |
| `tool-roundtrip.md` | tools | 2 tool definitions advertised, the streamed call delivered, `role:"tool"` result answered |
| `large-request.md` | large request | a 95,047-byte request served intact |
| `cancel.md` | cancel | SIGINT mid-flight destroyed the upstream socket before the response completed |
| `error-surface-and-keys.md` | errors + keys | `HTTP <status>: <message>` reaches the user, not a traceback; rotation and revocation both bite |
| `routing.md` | routing | a custom provider; a CONNECT proxy logging the origin authority; `routingMode:"combo"`; failover |
| `free-only.md` | §25 free-only | `freeOnly` defaults true; a PAID-classified provider refused with **0 upstream requests**; opt-out then routes |

## Where this row differs from OpenCode's, and why

`models.list` is **`VERIFIED`** here and **`UNVERIFIED`** for OpenCode. Hermes genuinely calls
`GET /v1/models` — ten discovery calls in a single one-shot run, all served 200 — while
OpenCode reads the `models` map from its own config file and never touches the endpoint.
Neither is a defect; the surface is used by one client and not the other. Two verified rows
disagreeing on measured grounds is the matrix working as intended rather than a contradiction
to reconcile.

## What is not claimed

- **Nothing about `hermes chat` or the TUI.** Verification used `-z` one-shot mode, which is
  what a script or CI invocation would use. The interactive REPL was never driven.
- **Nothing about long multi-turn sessions** beyond the single tool roundtrip captured here.
- **No claim that Hermes prefers this config form.** Only the `config.yaml` + `.env`
  mechanism was exercised.

## Redaction

Secrets are replaced **by name** — admin token, provider credential, proxy password, master
key, and every per-scenario client key including the rotated one — never by pattern-matching a
shape, so a credential cannot survive because it happened not to look like one. Ports, temp
paths, UUIDs, timestamps, and latencies are normalised so a re-run reproduces the same bytes
instead of a diff nobody reads. Sections over 4,000 characters are truncated **with the real
total stated**.
