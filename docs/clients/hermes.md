# Hermes Agent → BAYZ Router

`hermes` is present on this host: `/root/.local/bin/hermes` →
`/usr/local/lib/hermes-agent/venv/bin/hermes`, `--version` reports
**Hermes Agent v0.20.5 (2026.8.19)**.

> **This corrects the plan and spec.** Both the 9H plan and spec §12 recorded `hermes` as
> absent from this machine. It is present. The row stays `UNVERIFIED` — presence is not
> verification — but 9H Task 5 can attempt it for real rather than only shipping a harness
> for some other host.

## Verification status: UNVERIFIED, all 17 capabilities

**Hermes has not been driven against BAYZ as a verified test.** Every cell in the `hermes`
row of [the compatibility matrix](../superpowers/2026-08-27-bayz-client-compatibility-matrix.md)
reads `UNVERIFIED`.

The configuration below was **read from the live `~/.hermes/config.yaml` on this machine**,
which already points at `http://127.0.0.1:20128/v1`. That is real evidence about the
*configuration form* — the field names and structure are not guessed. It is **not** evidence
that any capability works: no capability was exercised under controlled conditions, nothing
was captured, and a working config file is not a test result. 9H Task 5 owns the real
verification, with transcripts under `docs/transcripts/hermes/`.

What *is* proven is the protocol underneath: the generic OpenAI contract holds over real HTTP
(`scripts/client-conformance.mjs`, 55/55).

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

How Hermes surfaces that 409 is **unobserved** and is one of the things Task 5's
`error surface` cell will record.

## Capabilities: what is unknown

All seventeen are `UNVERIFIED`. Hermes is an agentic client, so the tool cells are the
interesting ones:

| capability | the open question |
| --- | --- |
| configure | does Hermes reach BAYZ with this config under controlled conditions |
| authenticate | is the `.env` key sent as `Authorization: Bearer` |
| models.list | does it call `GET /v1/models`, or rely on the `models` mapping |
| chat / stream | does it parse responses and SSE frames without complaint |
| tool call | does it handle `finish_reason: "tool_calls"` with `content: null` |
| tool result roundtrip | does it return `tool_call_id` matching the call, over many turns |
| large request | how does it behave against the 128,000-character message bound |
| cancel | does interrupting abort the HTTP request so BAYZ tears the upstream down |
| error surface | does a 409 `no_free_route` reach the user legibly |
| custom provider | does a `custom-openai` BAYZ provider serve it identically |
| proxy-bound route | unobserved end to end |
| combo / failover | does a mid-request failover stay invisible |
| restart/reconnect | does a long session survive a BAYZ restart |
| key revoke/rotate | does it fail cleanly on a revoked key, or hang |
| free-only routing | does the refusal reach the user comprehensibly |

The BAYZ half of each is already covered by tests and smokes. The client's half needs Hermes
run under controlled conditions with output captured.

## Not claimed here

- No screenshot. None was taken.
- No transcript. `docs/transcripts/hermes/` does not exist yet; Task 5 creates it.
- No claim that any capability works. The configuration form is evidenced by the live file;
  the outcomes are not.
- No `hermes`-specific behaviour in BAYZ. There is none, by design.
