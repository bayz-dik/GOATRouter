# OpenCode → BAYZ Router

`opencode` is present on this host: `/usr/local/bin/opencode` →
`/usr/local/lib/node_modules/opencode-ai/bin/opencode.exe`, `--version` reports **1.18.23**.

## Verification status: UNVERIFIED, all 17 capabilities

**OpenCode has not been driven against BAYZ.** Every cell in the `opencode` row of
[the compatibility matrix](../superpowers/2026-08-27-bayz-client-compatibility-matrix.md)
reads `UNVERIFIED`, and the reason recorded is exactly that: the binary is present, nothing
has been run.

The binary being installed is not evidence. 9H Task 4 owns the real verification — a real
`opencode` invocation against a real BAYZ listener, with transcripts under
`docs/transcripts/opencode/`, after which cells move individually with a
`transcript:` citation each.

What *is* proven is the protocol underneath: the generic OpenAI contract holds over real
HTTP (`scripts/client-conformance.mjs`, 55/55). OpenCode speaks that contract through
`@ai-sdk/openai-compatible`, so the configuration below is expected to work — **expected,
not verified**. If you run it and it works, that is worth a transcript; if it does not, that
is a `BLOCKED` cell and more valuable still.

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
`GET /v1/models` to discover them — which is why the `models.list` cell cannot be assumed
either way until Task 4 observes what OpenCode actually requests.

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

How OpenCode surfaces a 409 with that body — clean message, opaque error, or retry loop — is
**unobserved**, and is one of the things Task 4's `error surface` cell will record.

## Capabilities: what is unknown, and why it matters per cell

All seventeen are `UNVERIFIED`. These are the ones where OpenCode's behaviour, not BAYZ's,
is the open question:

| capability | the open question |
| --- | --- |
| configure | does OpenCode accept this provider block and reach BAYZ at all |
| authenticate | does it send `Authorization: Bearer` as BAYZ expects |
| models.list | does it ever call `GET /v1/models`, or rely solely on the `models` map |
| chat / stream | does it parse the response and SSE frames without complaint |
| tool call | does it handle `finish_reason: "tool_calls"` with `content: null` |
| tool result roundtrip | does it return `tool_call_id` matching the call |
| large request | how does it behave against the 128,000-character message bound |
| cancel | does Ctrl-C abort the HTTP request so BAYZ tears the upstream down |
| error surface | does a 409 `no_free_route` reach the user legibly |
| custom provider | does a `custom-openai` BAYZ provider serve it identically |
| proxy-bound route | unobserved end to end |
| combo / failover | does a mid-request failover stay invisible to it |
| restart/reconnect | does it recover across a BAYZ restart |
| key revoke/rotate | does it fail cleanly on a revoked key, or hang |
| free-only routing | does the 409 reach the user as a comprehensible refusal |

The BAYZ side of each is already covered by tests and smokes. What is missing is the
client's half, and only running OpenCode supplies it.

## Not claimed here

- No screenshot. None was taken.
- No transcript. `docs/transcripts/opencode/` does not exist yet; Task 4 creates it.
- No claim that any capability works. The configuration is documented; the outcome is not.
- No `opencode`-specific behaviour in BAYZ. There is none, by design.
