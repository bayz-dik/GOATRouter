# OpenCode → GOAT ROUTER

`opencode` is present on this host: `/usr/local/bin/opencode` →
`/usr/local/lib/node_modules/opencode-ai/bin/opencode.exe`, `--version` reports **1.18.23**.

## Verification status: VERIFIED, 16 of 17 capabilities

**OpenCode has been driven against GOAT ROUTER for real.** `scripts/verify-opencode.mjs` runs the
actual binary as a child process — a real config file in an isolated HOME, real stdout and
stderr, a real BAYZ listener, real provider origins, a real HTTP CONNECT proxy — and writes
a transcript per scenario under `docs/transcripts/opencode/`. Every cell in the `opencode`
row of [the compatibility matrix](../superpowers/2026-08-27-bayz-client-compatibility-matrix.md)
cites one.

| capability | status | evidence |
| --- | --- | --- |
| configure | VERIFIED | `docs/transcripts/opencode/configure-authenticate.md` |
| authenticate | VERIFIED | `docs/transcripts/opencode/configure-authenticate.md` |
| models.list | UNVERIFIED | the client never calls `GET /v1/models` — see below |
| chat | VERIFIED | `docs/transcripts/opencode/chat-stream.md` |
| stream | VERIFIED | `docs/transcripts/opencode/chat-stream.md` |
| tool call | VERIFIED | `docs/transcripts/opencode/tool-roundtrip.md` |
| tool result roundtrip | VERIFIED | `docs/transcripts/opencode/tool-roundtrip.md` |
| large request | VERIFIED | `docs/transcripts/opencode/large-request.md` |
| cancel | VERIFIED | `docs/transcripts/opencode/cancel.md` |
| error surface | VERIFIED | `docs/transcripts/opencode/error-surface-and-keys.md` |
| custom provider | VERIFIED | `docs/transcripts/opencode/routing.md` |
| proxy-bound route | VERIFIED | `docs/transcripts/opencode/routing.md` |
| combo | VERIFIED | `docs/transcripts/opencode/routing.md` |
| failover | VERIFIED | `docs/transcripts/opencode/routing.md` |
| restart/reconnect | VERIFIED | `docs/transcripts/opencode/restart-reconnect.md` |
| key revoke/rotate | VERIFIED | `docs/transcripts/opencode/error-surface-and-keys.md` |
| free-only routing | VERIFIED | `docs/transcripts/opencode/free-only.md` |

**`models.list` is UNVERIFIED by measurement, not omission.** OpenCode offers the models
listed in the `models` map of its own config file and never calls `GET /v1/models`, so
BAYZ's discovery endpoint is not exercised by this client. `opencode models bayz` prints
`bayz/probe-model` without a single gateway request. The practical consequence for you: a
model must appear in your `models` map to be selectable, and adding a route in BAYZ does not
make it show up in OpenCode on its own.

**Driving the real client found three defects that 55 generic protocol checks did not.**
Recorded here because they are the reason to trust this row rather than a conformance run:
`stream_options` (which this client sends on every request) was refused outright; streamed
`tool_calls` were silently dropped, so the client re-sent the same request 18 times; and a
1 KiB tool-description cap refused its payload, whose `bash` description alone is 4,628
characters. All three are fixed, with regression tests.

To re-verify on your own machine: `node scripts/verify-opencode.mjs`. It takes several
minutes — one real client run at a time, roughly 20 seconds each — and exits non-zero if any
cell it claims lacks a transcript.

## Configuration

Config file: `~/.config/opencode/opencode.json`. The structure below was **read from the
existing file on this machine**, not composed from documentation.

OpenCode reaches an OpenAI-compatible endpoint through a named provider entry using the
`@ai-sdk/openai-compatible` npm package:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "bayz": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:20128/v1",
        "apiKey": "<64 hex chars from POST /api/identities>"
      },
      "models": {
        "probe-model": {
          "name": "probe-model"
        }
      }
    }
  },
  "model": "bayz/probe-model"
}
```

Field by field, all four confirmed against the live file:

| field | value | note |
| --- | --- | --- |
| `provider.<name>` | `bayz` | your label; it becomes the prefix in `model` |
| `provider.<name>.npm` | `@ai-sdk/openai-compatible` | the adapter OpenCode loads |
| `options.baseURL` | `http://127.0.0.1:20128/v1` | **camelCase `baseURL`**, not `base_url` |
| `options.apiKey` | the client key | **camelCase `apiKey`** |

### Model naming — two different forms, and mixing them up is the usual mistake

- Inside `provider.<name>.models`, the key is the **bare model id exactly as
  `GET /v1/models` returns it**. BAYZ invents no aliases.
- In the top-level `model` field (and in any agent's `model`), the form is
  **`<provider-name>/<model-id>`** — e.g. `bayz/probe-model`.

BAYZ model ids may themselves contain slashes (`openai/gpt-4o` is a legal id, matching
`^[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,126}[A-Za-z0-9])?$`), so a fully-qualified reference can
read `bayz/openai/gpt-4o`. The first segment is OpenCode's provider label; everything after
it is the model id BAYZ knows. The live file on this host does exactly this with
`9router/tabitoken-10/claude-opus-5-thinking`.

Every model you want must be listed under `models`. OpenCode does not call
`GET /v1/models` to discover them — measured, not assumed: a full `opencode models bayz` run
produced zero requests to that endpoint.

### `opencode auth`

`opencode auth login` and `opencode auth list` exist for managing provider credentials. Which
of the two mechanisms — `options.apiKey` in the config, or a credential stored by
`auth login` — OpenCode prefers for a custom `openai-compatible` provider is **not
documented here**, because it has not been observed on this host. The config-file form above
is what the live file uses.

## Creating the key

```bash
curl -sS -X POST http://127.0.0.1:20128/api/identities \
  -H "Authorization: Bearer $BAYZ_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"id":"opencode","displayName":"OpenCode",
       "scopes":["chat.completions","models.read"],"preset":"opencode"}'
```

The response carries `keyShownOnce: true` and the only copy of the key — paste it into
`options.apiKey`. There is no recovery; only
`POST /api/identities/opencode/rotate`.

**`preset: "opencode"` changes nothing about how requests are served.** It seeds the default
scope set and labels the key for the operator. There is no client-name branching in any
runtime path; BAYZ derives behaviour from the request path, `Accept` header, body shape, and
scopes.

## What to expect on the first run

**FREE-ONLY will probably refuse it.** A route created without an explicit `freeOnly` field
is free-only, and a model BAYZ has not classified as free is not free. Expect:

```json
{"error":{"code":"no_free_route","message":"no_free_route: no free model was available and this route may not spend money (stage: chat-free-only)","requestId":"req_…"}}
```

HTTP 409. BAYZ is refusing to spend money you did not authorise. Publish the provider's
catalogue (`POST /api/providers/<id>/catalogue`) so its models get classified, or opt one
route out with `PATCH /api/routes/<id>` `{"freeOnly": false}`.

**Observed:** OpenCode surfaces this as a one-line `Error: …` on stderr and exits non-zero —
no retry loop, no stack trace. `docs/transcripts/opencode/free-only.md` captures the refusal
and, more importantly, records that the paid origin received **zero** requests, so nothing
could have been spent before the refusal landed.

## Capabilities: what was observed per cell

Sixteen of seventeen are `VERIFIED` against the real client; each row of the table at the
top of this document cites its transcript. What was actually observed, where OpenCode's
behaviour rather than BAYZ's was the open question:

| capability | what the real run showed |
| --- | --- |
| configure | the provider block above is accepted and reaches BAYZ |
| authenticate | it sends `Authorization: Bearer <key>`; a corrupted key exits non-zero |
| models.list | it never calls `GET /v1/models` — it uses the `models` map alone |
| chat / stream | it requests `stream:true` by default and renders the SSE frames |
| tool call | it handles `finish_reason:"tool_calls"` and reassembles fragments by `index` |
| tool result roundtrip | it returns `role:"tool"` with a matching `tool_call_id` |
| large request | a 67,447-byte request is served intact |
| cancel | SIGINT aborts the HTTP request and BAYZ tears the upstream down |
| error surface | a 409 reaches the user as a legible one-line message |
| custom provider | a custom `openai-compatible` provider serves it identically |
| proxy-bound route | the CONNECT proxy logged the origin authority — it genuinely tunnels |
| combo / failover | a mid-suite primary kill stayed invisible to the client |
| restart/reconnect | the same key works across a BAYZ restart on the same port |
| key revoke/rotate | the superseded key fails immediately; deletion locks the client out |
| free-only routing | the 409 is comprehensible and the paid origin was never called |

## Not claimed here

- No screenshot. None was taken; the transcripts are text.
- No claim about `opencode auth login` versus `options.apiKey`. Only the config-file form
  was exercised.
- No claim that `models.list` works for this client. It is not used by it.
- No `opencode`-specific behaviour in BAYZ. There is none, by design — the preset seeds
  scopes and labels a key, nothing more.
