# Hermes Agent → BAYZ Router

`hermes` is present on this host: `/root/.local/bin/hermes` →
`/usr/local/lib/hermes-agent/venv/bin/hermes`, `--version` reports
**Hermes Agent v0.20.5 (2026.8.19)**.

> **This corrects the plan and spec.** Both the 9H plan and spec §12 recorded `hermes` as
> absent from this machine. It is present, and 9H Task 5 verified it for real.

## Verification status: VERIFIED, all 17 capabilities

**Hermes has been driven against BAYZ for real.** `scripts/verify-hermes.mjs` runs the actual
binary as a child process across nine scenarios and writes a transcript for each under
`docs/transcripts/hermes/`. Every cell in the `hermes` row of
[the compatibility matrix](../superpowers/2026-08-27-bayz-client-compatibility-matrix.md)
cites one.

| capability | status | evidence |
| --- | --- | --- |
| configure | VERIFIED | `docs/transcripts/hermes/configure-authenticate.md` |
| authenticate | VERIFIED | `docs/transcripts/hermes/configure-authenticate.md` |
| models.list | VERIFIED | `docs/transcripts/hermes/configure-authenticate.md` |
| chat | VERIFIED | `docs/transcripts/hermes/chat-stream.md` |
| stream | VERIFIED | `docs/transcripts/hermes/chat-stream.md` |
| tool call | VERIFIED | `docs/transcripts/hermes/tool-roundtrip.md` |
| tool result roundtrip | VERIFIED | `docs/transcripts/hermes/tool-roundtrip.md` |
| large request | VERIFIED | `docs/transcripts/hermes/large-request.md` |
| cancel | VERIFIED | `docs/transcripts/hermes/cancel.md` |
| error surface | VERIFIED | `docs/transcripts/hermes/error-surface-and-keys.md` |
| custom provider | VERIFIED | `docs/transcripts/hermes/routing.md` |
| proxy-bound route | VERIFIED | `docs/transcripts/hermes/routing.md` |
| combo | VERIFIED | `docs/transcripts/hermes/routing.md` |
| failover | VERIFIED | `docs/transcripts/hermes/routing.md` |
| restart/reconnect | VERIFIED | `docs/transcripts/hermes/restart-reconnect.md` |
| key revoke/rotate | VERIFIED | `docs/transcripts/hermes/error-surface-and-keys.md` |
| free-only routing | VERIFIED | `docs/transcripts/hermes/free-only.md` |

**Driving this client exposed a real BAYZ defect.** The message allow-list refused `name`,
which Hermes sends on every `role: "tool"` message (`{role, tool_call_id, name, content}`).
BAYZ delivered the tool call, Hermes executed it, and the **result was refused on the way
back** with `invalid_request (message-unknown-key)` — so a tool roundtrip was impossible for
this client. `name` is part of the OpenAI chat contract; it is now validated and bounded, and
deliberately not forwarded upstream because `tool_call_id` already identifies the call.

**`api_key: ${VAR}` in `config.yaml` is load-bearing.** Writing the key into `.env` alone is
not enough: the first probe did exactly that and Hermes answered
`HTTP 401: A valid API token is required` with **zero** requests reaching BAYZ. The YAML must
reference the variable, which is what the live file on this host does.

Unlike OpenCode, Hermes genuinely calls `GET /v1/models` — 10 discovery calls in a single
one-shot run — so `models.list` is verified here where it is `UNVERIFIED` for OpenCode.

To re-verify: `node scripts/verify-hermes.mjs`. It takes roughly ten minutes (one real client
run at a time, ~40 seconds each) and exits non-zero if any cell it claims lacks a transcript.
Every scenario uses a throwaway `HERMES_HOME` and `HOME`, so your live `~/.hermes` is never
read or written.

## Configuration

Config file: `~/.hermes/config.yaml` (`hermes config path` prints it).

Hermes reaches an OpenAI-compatible endpoint two ways, and the live file uses both together.

### The default model block

```yaml
model:
  default: probe-model
  provider: custom
  base_url: http://127.0.0.1:20128/v1
  api_mode: chat_completions
```

| field | value | note |
| --- | --- | --- |
| `model.provider` | `custom` | selects the custom-endpoint path |
| `model.base_url` | `http://127.0.0.1:20128/v1` | **snake_case `base_url`** |
| `model.api_mode` | `chat_completions` | BAYZ implements chat-completions, not the responses API |
| `model.default` | a BAYZ model id | see [Model naming](#model-naming) |

### A named custom provider

```yaml
custom_providers:
  - name: BAYZ Local
    base_url: http://127.0.0.1:20128/v1
    model: probe-model
    api_mode: chat_completions
    models:
      probe-model: {}
      openai/gpt-4o: {}
```

`models` is a mapping whose **keys are bare BAYZ model ids**; an empty value `{}` is normal.
The live file on this host lists dozens of entries in exactly this form.

### The API key does not live in the YAML

Hermes reads it from the env file `~/.hermes/.env` (`hermes config env-path` prints the
path), under a variable derived from the endpoint host and port:

```text
HERMES_CUSTOM_127_0_0_1_20128_API_KEY=<64 hex chars>
```

That variable name is **read from the live `.env` on this machine**, not inferred. The
pattern is `HERMES_CUSTOM_<host-with-dots-and-colons-as-underscores>_<port>_API_KEY`, so a
deployment on `127.0.0.1:9999` would use `HERMES_CUSTOM_127_0_0_1_9999_API_KEY`. If your
BAYZ binds a different host or port, the variable name changes with it.

`hermes config set` / `get` manage config values; `hermes config show` prints the resolved
configuration. Do not paste the key into `config.yaml` when the `.env` mechanism exists — the
env file is the one place the key belongs.

## Model naming

Hermes uses the **bare BAYZ model id**, with no provider prefix — unlike OpenCode, which
prefixes with its own provider label. Whatever `GET /v1/models` returns is what goes in
`model.default`, in `custom_providers[].model`, in the `models` mapping keys, and after
`hermes -m`.

BAYZ ids may contain slashes (`openai/gpt-4o` is legal, matching
`^[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,126}[A-Za-z0-9])?$`), so a slash in the name is part of
the id rather than a separator Hermes adds.

## Creating the key

```bash
curl -sS -X POST http://127.0.0.1:20128/api/identities \
  -H "Authorization: Bearer $BAYZ_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"id":"hermes","displayName":"Hermes Agent",
       "scopes":["chat.completions","models.read"],"preset":"hermes"}'
```

The response carries `keyShownOnce: true` and the only copy of the key — put it in
`~/.hermes/.env` under the variable above. There is no recovery; only
`POST /api/identities/hermes/rotate`.

**`preset: "hermes"` changes nothing about how requests are served.** It seeds the default
scope set and labels the key. There is no client-name branching in any BAYZ runtime path.

## What to expect on the first run

**FREE-ONLY will probably refuse it.** A route created without an explicit `freeOnly` field
is free-only, and a model BAYZ has not classified as free is not free. Expect HTTP 409:

```json
{"error":{"code":"no_free_route","message":"no_free_route: no free model was available and this route may not spend money (stage: chat-free-only)","requestId":"req_…"}}
```

Publish the provider's catalogue (`POST /api/providers/<id>/catalogue`) so its models get
classified, or opt one route out with `PATCH /api/routes/<id>` `{"freeOnly": false}`.

**Observed:** Hermes prints this as a single `HTTP 409: no_free_route: …` line on stdout and
exits 0 — no retry loop, no traceback. `docs/transcripts/hermes/free-only.md` captures the
refusal and records that the paid origin received **zero** requests, so nothing could have
been spent before the refusal landed.

## Capabilities: what was observed per cell

All seventeen are `VERIFIED`; each row of the table at the top of this document cites its
transcript. Hermes is an agentic client, so the tool cells were the interesting ones:

| capability | what the real run showed |
| --- | --- |
| configure | the YAML config above reaches BAYZ; `api_key: ${VAR}` is required for the `.env` value to be sent |
| authenticate | the derived `.env` key authenticates; a corrupted key yields `HTTP 401: A valid API token is required` |
| models.list | it calls `GET /v1/models` — 10 discovery calls in one one-shot run, all served 200 |
| chat / stream | it requests `stream:true` by default and consumes the SSE frames |
| tool call | it advertises its toolset through BAYZ and receives the streamed call intact |
| tool result roundtrip | it returns `role:"tool"` with `tool_call_id` **and `name`** — the `name` key needed a BAYZ fix |
| large request | a 95,047-byte request is served intact |
| cancel | SIGINT aborts the request and BAYZ tears the upstream down |
| error surface | BAYZ's message reaches the user as `HTTP <status>: <message>`, not a traceback |
| custom provider | a custom `openai-compatible` provider serves it identically |
| proxy-bound route | the CONNECT proxy logged the origin authority — it genuinely tunnels |
| combo / failover | a mid-suite primary kill stayed invisible to the client |
| restart/reconnect | the same key works across a BAYZ restart on the same port |
| key revoke/rotate | the superseded key stops completing immediately; deletion locks the client out |
| free-only routing | the 409 is comprehensible and the paid origin was never called |

## Not claimed here

- No screenshot. None was taken; the transcripts are text.
- No claim about `hermes chat` (the interactive REPL) or the TUI. Verification used `-z`
  one-shot mode, which is what a script or CI would use.
- No claim about long multi-turn sessions beyond the tool roundtrip that was captured.
- No `hermes`-specific behaviour in BAYZ. There is none, by design — the preset seeds scopes
  and labels a key, nothing more.
