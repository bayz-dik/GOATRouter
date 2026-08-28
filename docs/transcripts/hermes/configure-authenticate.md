# Hermes Agent → BAYZ — configure-authenticate

Captured by `scripts/verify-hermes.mjs` against the real `hermes` binary (v0.20.5) and a
real BAYZ listener, in a throwaway `HERMES_HOME` so the operator's live configuration was
never read or written. Secrets are redacted by name; ports, temp paths, UUIDs, and timings
are normalised so a re-run reproduces these bytes.

## Client version

```text
Hermes Agent v0.20.5 (2026.8.19) · upstream 25fcc8ad · local 349e6611 (+1 carried commit)
Install directory: /usr/local/lib/hermes-agent
Install method: git
Python: 3.11.16
OpenAI SDK: 2.24.0
Update available: 308 commits behind — run 'hermes update'
```

## config.yaml written (key referenced, not inlined)

```yaml
model:
  default: probe-model
  provider: custom
  base_url: http://127.0.0.1:<PORT>/v1
  api_key: ${HERMES_CUSTOM_127_0_0_1_33947_API_KEY}
  api_mode: chat_completions

custom_providers:
  - name: BAYZ Local
    base_url: http://127.0.0.1:<PORT>/v1
    model: probe-model
    api_mode: chat_completions
    key_env: HERMES_CUSTOM_127_0_0_1_33947_API_KEY
    models:
      probe-model: {}
```

## The .env variable name Hermes derives from host and port

```text
HERMES_CUSTOM_127_0_0_1_33947_API_KEY
```

## Valid key — stdout

```text
BAYZ-HERMES-OK
```

## Valid key — stderr

(empty)

## Valid key — exit

```text
code=0 signal=null
```

## Corrupted key — stdout

```text
HTTP 401: A valid API token is required
```

## Corrupted key — exit

```text
code=0 signal=null
```

## BAYZ gateway calls with response status

```text
GET /v1/props -> 404
GET /v1/models -> 200
GET /v1/models/probe-model -> 404
GET /v1/models -> 200
GET /v1/models/probe-model -> 404
GET /v1/models -> 200
POST /v1/chat/completions -> 400
POST /v1/chat/completions -> 200
GET /v1/props -> 401
GET /v1/models -> 401
GET /v1/models/probe-model -> 401
GET /v1/models -> 401
GET /v1/models/probe-model -> 401
GET /v1/models -> 401
POST /v1/chat/completions -> 401
POST /v1/chat/completions -> 401
POST /v1/chat/completions -> 401
```

## BAYZ usage rows

```json
[
 {
  "requestId": "req_<UUID>",
  "occurredAt": "<TIMESTAMP>",
  "routeId": "hm-route",
  "providerId": "hm-origin",
  "model": "probe-model",
  "routingMode": "direct",
  "outcome": "ok",
  "latencyMs":<MS>,
  "attempts": 1,
  "promptTokens": 5,
  "completionTokens": 6
 }
]
```
